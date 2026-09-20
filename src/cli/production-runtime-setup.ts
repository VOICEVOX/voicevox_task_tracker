import { stat } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  createCodexEnvironment,
  getCodexEnvironmentVariableAllowlist,
  type CodexProcessRunner,
} from "../codex/index.js";
import { type Config } from "../config/index.js";
import { parseGitHubAppCredentials, type GitHubAppCredentials } from "../github/index.js";
import {
  StateBranchConflictError,
  type StateBranchAdapter,
  type StatePersistenceConfiguration,
} from "../persistence/index.js";
import { assertNonNullable, UnreachableError } from "../util/index.js";
import { type OnlineCliCommand } from "./daily-transaction.js";
import { CliCodexAuthenticationError, CliCredentialsError, CliExecutableError } from "./errors.js";
import {
  assertSandboxManifestMatchesContext,
  assertSandboxOrigin,
  parseSandboxManifest,
  sandboxBranchForEnvironment,
  SANDBOX_MANIFEST_PATH,
  type SandboxManifest,
  type SandboxRunContext,
} from "./sandbox-context.js";

export type EnabledCodexCredentials = Readonly<{
  enabled: true;
  authentication: Config["ai"]["authentication"];
  environment: Readonly<Record<string, string>>;
}>;

export type RuntimeCodexCredentials =
  | Readonly<{
      enabled: false;
    }>
  | EnabledCodexCredentials;

export type RuntimeCredentials = Readonly<{
  github: GitHubAppCredentials;
  codex: RuntimeCodexCredentials;
  knownSecrets: readonly string[];
}>;

export type RuntimeExecutionTarget =
  | Readonly<{
      kind: "production";
      state: Config["state"];
    }>
  | Readonly<{
      kind: "sandbox";
      state: StatePersistenceConfiguration;
      manifest: SandboxManifest;
      context: SandboxRunContext;
    }>;

export type RuntimeTargetDependencies = Readonly<{
  repositoryPath: string;
  readSandboxContext?: (path: string) => Promise<SandboxRunContext>;
  createStateBranchAdapter: () => StateBranchAdapter;
}>;

export type CodexReadinessDependencies = Readonly<{
  repositoryPath: string;
  codexProcessRunner: CodexProcessRunner;
}>;

/** 必須の環境変数値を読み取る。 */
export function requireEnvironmentValue(
  environment: Readonly<NodeJS.ProcessEnv>,
  variableName: string,
): string {
  const value = environment[variableName];
  if (value == null || value.trim().length === 0) {
    throw new CliCredentialsError([variableName], {});
  }
  return value;
}

/** 必須の環境変数がすべて存在することを検証する。 */
export function requireEnvironmentVariables(
  environment: Readonly<NodeJS.ProcessEnv>,
  variableNames: readonly string[],
): void {
  const missingVariableNames = variableNames.filter((variableName) => {
    const value = environment[variableName];
    return value == null || value.trim().length === 0;
  });
  if (missingVariableNames.length > 0) {
    throw new CliCredentialsError(missingVariableNames, {});
  }
}

function readCodexCredentials(
  environment: Readonly<NodeJS.ProcessEnv>,
  config: Config,
): RuntimeCodexCredentials {
  if (!config.ai.enabled) {
    return Object.freeze({
      enabled: false,
    });
  }
  const authentication = config.ai.authentication;
  requireEnvironmentVariables(environment, getCodexEnvironmentVariableAllowlist(authentication));
  return Object.freeze({
    enabled: true,
    authentication,
    environment: createCodexEnvironment(authentication, environment),
  });
}

function codexKnownSecrets(credentials: RuntimeCodexCredentials): readonly string[] {
  if (!credentials.enabled) {
    return Object.freeze([]);
  }
  switch (credentials.authentication) {
    case "api-key": {
      const openAiApiKey = credentials.environment["OPENAI_API_KEY"];
      assertNonNullable(openAiApiKey, "組み立て済みCodex環境にOPENAI_API_KEYがありません");
      return Object.freeze([openAiApiKey]);
    }
    case "auth-json":
      return Object.freeze([]);
    default:
      throw new UnreachableError(credentials.authentication);
  }
}

/** 実行対象に必要な認証情報と既知secretを読み取る。 */
export function readRuntimeCredentials(
  environment: Readonly<NodeJS.ProcessEnv>,
  config: Config,
  command: OnlineCliCommand,
  executionTargetKind: RuntimeExecutionTarget["kind"],
): RuntimeCredentials {
  requireEnvironmentVariables(environment, ["GH_APP_ID", "GH_APP_PRIVATE_KEY"]);
  let github: GitHubAppCredentials;
  try {
    github = parseGitHubAppCredentials(environment);
  } catch (error: unknown) {
    const variableNames =
      error instanceof Error &&
      "variableNames" in error &&
      Array.isArray(error.variableNames) &&
      error.variableNames.every((value) => typeof value === "string")
        ? error.variableNames
        : ["GH_APP_ID", "GH_APP_PRIVATE_KEY"];
    throw new CliCredentialsError(variableNames, { cause: error });
  }
  const codex = readCodexCredentials(environment, config);
  const knownSecrets = [github.privateKey, ...codexKnownSecrets(codex)];
  if (config.notifications.discord.enabled && executionTargetKind === "production") {
    switch (command.kind) {
      case "daily":
      case "backfill":
        switch (command.notificationAction) {
          case "send":
            knownSecrets.push(
              requireEnvironmentValue(environment, config.notifications.discord.webhookSecretName),
              requireEnvironmentValue(
                environment,
                config.notifications.discord.operationsWebhookSecretName,
              ),
            );
            break;
          case "hold":
          case "acknowledge-current":
            knownSecrets.push(
              requireEnvironmentValue(
                environment,
                config.notifications.discord.operationsWebhookSecretName,
              ),
            );
            break;
          default:
            throw new UnreachableError(command.notificationAction);
        }
        break;
      case "dry-run":
      case "collect-analyze":
        break;
      default:
        throw new UnreachableError(command);
    }
  }
  return Object.freeze({
    github,
    codex,
    knownSecrets: Object.freeze(knownSecrets),
  });
}

function parseSandboxManifestBytes(bytes: Uint8Array): SandboxManifest {
  return parseSandboxManifest(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
}

/** productionまたはsandboxの実行対象を解決する。 */
export async function resolveRuntimeTarget(
  dependencies: RuntimeTargetDependencies,
  config: Config,
  command: OnlineCliCommand,
): Promise<RuntimeExecutionTarget> {
  const sandboxContextPath = command.kind === "daily" ? command.sandboxContextPath : undefined;
  if (sandboxContextPath == null) {
    return Object.freeze({
      kind: "production",
      state: config.state,
    });
  }
  if (command.kind !== "daily") {
    throw new TypeError("sandbox contextはdaily commandでだけ指定できます");
  }
  if (command.notificationAction !== "hold") {
    throw new TypeError("sandbox実行のnotification-actionはholdにしてください");
  }
  const readSandboxContext = dependencies.readSandboxContext;
  if (readSandboxContext == null) {
    throw new TypeError("sandbox contextの読み取りadapterがありません");
  }
  const context = await readSandboxContext(
    resolve(dependencies.repositoryPath, sandboxContextPath),
  );
  const branch = sandboxBranchForEnvironment(context.environmentId);
  const stateAdapter = dependencies.createStateBranchAdapter();
  const head = await stateAdapter.resolveHead(branch);
  if (head.status === "missing") {
    throw new StateBranchConflictError();
  }
  if (head.revision !== context.baseStateRevision) {
    throw new StateBranchConflictError();
  }
  const manifestResult = await stateAdapter.readFile(head.revision, SANDBOX_MANIFEST_PATH);
  if (manifestResult.status === "missing") {
    throw new TypeError("sandbox environment manifestがありません");
  }
  const manifest = parseSandboxManifestBytes(manifestResult.bytes);
  assertSandboxManifestMatchesContext(manifest, context);
  assertNonNullable(
    stateAdapter.resolveRepositoryRevision,
    "checkout repositoryのcommit SHA取得adapterがありません",
  );
  const repositoryRevision = await stateAdapter.resolveRepositoryRevision();
  if (repositoryRevision !== context.codeRevision) {
    throw new TypeError("sandbox contextとcheckout repositoryのcommit SHAが一致しません");
  }
  assertNonNullable(stateAdapter.resolveOriginUrls, "origin URL取得adapterがありません");
  const originUrls = await stateAdapter.resolveOriginUrls();
  for (const originUrl of [...originUrls.fetchUrls, ...originUrls.pushUrls]) {
    assertSandboxOrigin(originUrl);
  }
  const state = Object.freeze({
    ...config.state,
    branch,
  }) satisfies StatePersistenceConfiguration;
  return Object.freeze({
    kind: "sandbox",
    state,
    manifest,
    context,
  });
}

async function assertCodexAuthenticationAvailable(
  credentials: EnabledCodexCredentials,
): Promise<void> {
  switch (credentials.authentication) {
    case "api-key":
      return;
    case "auth-json": {
      const codexHome = credentials.environment["CODEX_HOME"];
      assertNonNullable(codexHome, "組み立て済みCodex環境にCODEX_HOMEがありません");
      try {
        const authJsonStat = await stat(join(codexHome, "auth.json"));
        if (!authJsonStat.isFile()) {
          throw new TypeError("CODEX_HOME直下のauth.jsonがファイルではありません");
        }
      } catch (error: unknown) {
        throw new CliCodexAuthenticationError({ cause: error });
      }
      return;
    }
    default:
      throw new UnreachableError(credentials.authentication);
  }
}

async function assertCodexCliAvailable(
  dependencies: CodexReadinessDependencies,
  environment: Readonly<Record<string, string>>,
): Promise<void> {
  let result: Awaited<ReturnType<CodexProcessRunner>>;
  try {
    result = await dependencies.codexProcessRunner({
      command: "codex",
      arguments: ["--version"],
      workingDirectory: dependencies.repositoryPath,
      environment,
      standardInput: "",
      timeoutMilliseconds: 10_000,
    });
  } catch (error: unknown) {
    throw new CliExecutableError("codex", { cause: error });
  }
  if (result.timedOut || result.exitCode !== 0 || result.signal != null) {
    throw new CliExecutableError("codex", {
      cause: new Error("Codex CLIのversion確認が正常終了しませんでした"),
    });
  }
}

/** Codexの認証情報とCLIが実行可能であることを順に確認する。 */
export async function assertCodexRuntimeReady(
  dependencies: CodexReadinessDependencies,
  credentials: EnabledCodexCredentials,
): Promise<void> {
  await assertCodexAuthenticationAvailable(credentials);
  await assertCodexCliAvailable(dependencies, credentials.environment);
}
