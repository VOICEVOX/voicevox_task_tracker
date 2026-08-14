import { constants } from "node:fs";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import {
  CodexAttemptError,
  CodexInvalidJsonError,
  CodexNonZeroExitError,
  CodexProcessStartError,
  CodexRateLimitError,
  CodexResourceError,
  CodexTemporaryWorkspaceError,
  CodexTimeoutError,
} from "./errors.js";
import {
  type CodexAnalysisInput,
  createCodexAnalysisInput,
  serializeCodexAnalysisInput,
} from "./input.js";
import { type ValidatedCodexAnalysisOutput } from "./output-types.js";
import {
  type CodexProcessRequest,
  type CodexProcessResult,
  type CodexProcessRunner,
} from "./process-runner.js";
import { REASONING_EFFORTS } from "../domain/index.js";
import { UnreachableError } from "../util/index.js";
import { executeCodexAnalysisWithTransportAliases } from "./transport-alias.js";

const CODEX_COMMAND = "codex";
const CODEX_TEMPORARY_DIRECTORY_PREFIX = "voicevox-task-tracker-codex-";
const SYSTEM_PROMPT_URL = new URL("../../prompts/codex-system.md", import.meta.url);
const OUTPUT_SCHEMA_URL = new URL("../../schemas/codex-analysis.schema.json", import.meta.url);
const OUTPUT_LAST_MESSAGE_FILE_NAME = "last-message.json";
const MAX_TIMEOUT_SECONDS = Math.floor(Number.MAX_SAFE_INTEGER / 1000);
const TEMPORARY_PROCESS_ERROR_CODES = new Set([
  "EAGAIN",
  "EBUSY",
  "ECONNRESET",
  "EMFILE",
  "ENFILE",
  "ENOMEM",
  "EPIPE",
  "ETIMEDOUT",
]);

/** Codex adapterが利用できる認証方式の一覧。 */
export const CODEX_AUTHENTICATIONS: readonly ["api-key", "auth-json"] = ["api-key", "auth-json"];

const codexAuthenticationSchema = z.enum(CODEX_AUTHENTICATIONS);

/** Codex adapterが利用する認証方式。 */
export type CodexAuthentication = z.output<typeof codexAuthenticationSchema>;

/** 認証方式に応じてCodex subprocessへ渡せる環境変数名を返す。 */
export function getCodexEnvironmentVariableAllowlist(
  authentication: CodexAuthentication,
): readonly string[] {
  switch (authentication) {
    case "api-key":
      return Object.freeze(["HOME", "OPENAI_API_KEY", "PATH"]);
    case "auth-json":
      return Object.freeze(["CODEX_HOME", "HOME", "PATH"]);
    default:
      throw new UnreachableError(authentication);
  }
}

const codexAdapterConfigurationSchema = z.strictObject({
  authentication: codexAuthenticationSchema,
  model: z.string().min(1, "modelは空にできません"),
  execution: z.strictObject({
    timeoutSeconds: z.number().int().positive().max(MAX_TIMEOUT_SECONDS),
    maxAttempts: z.number().int().positive(),
    sandbox: z.literal("read-only"),
    approvalPolicy: z.literal("never"),
    reasoningEffort: z.enum(REASONING_EFFORTS),
  }),
  retry: z
    .strictObject({
      initialDelaySeconds: z.number().nonnegative(),
      maxDelaySeconds: z.number().nonnegative(),
    })
    .refine((retry) => retry.initialDelaySeconds <= retry.maxDelaySeconds, {
      message: "Codex retryの初期待機時間は最大待機時間以下にしてください",
    }),
});

/** Codex adapterのモデルと隔離実行設定。 */
export type CodexAdapterConfiguration = z.output<typeof codexAdapterConfigurationSchema>;

/** Codex adapterへ注入する副作用境界。 */
export type CodexAdapterDependencies = Readonly<{
  environment: NodeJS.ProcessEnv;
  processRunner: CodexProcessRunner;
  runtime: Readonly<{
    sleep: (delayMilliseconds: number) => Promise<void>;
    random: () => number;
  }>;
}>;

type AttemptOutcome =
  | Readonly<{
      success: true;
      value: unknown;
    }>
  | Readonly<{
      success: false;
      error: unknown;
    }>;

/** 認証方式に応じてCodex subprocessへ渡す環境を組み立てる。 */
export function createCodexEnvironment(
  authentication: CodexAuthentication,
  sourceEnvironment: Readonly<NodeJS.ProcessEnv>,
): Readonly<Record<string, string>> {
  const environment: Record<string, string> = {};
  for (const variableName of getCodexEnvironmentVariableAllowlist(authentication)) {
    const value = sourceEnvironment[variableName];
    if (value == null || value.trim().length === 0) {
      throw new TypeError(`Codex subprocess用の${variableName}がありません`);
    }
    environment[variableName] = value;
  }
  return Object.freeze(environment);
}

async function readFixedSystemPrompt(): Promise<string> {
  try {
    return await readFile(fileURLToPath(SYSTEM_PROMPT_URL), "utf8");
  } catch (error: unknown) {
    throw new CodexResourceError("prompts/codex-system.md", { cause: error });
  }
}

async function assertOutputSchemaIsReadable(): Promise<void> {
  try {
    await access(fileURLToPath(OUTPUT_SCHEMA_URL), constants.R_OK);
  } catch (error: unknown) {
    throw new CodexResourceError("schemas/codex-analysis.schema.json", { cause: error });
  }
}

async function createTemporaryWorkspace(): Promise<string> {
  try {
    return await mkdtemp(join(tmpdir(), CODEX_TEMPORARY_DIRECTORY_PREFIX));
  } catch (error: unknown) {
    throw new CodexTemporaryWorkspaceError("create", { cause: error });
  }
}

function createProcessRequest(
  configuration: CodexAdapterConfiguration,
  dependencies: CodexAdapterDependencies,
  systemPrompt: string,
  inputJson: string,
  workingDirectory: string,
): CodexProcessRequest {
  const outputLastMessagePath = join(workingDirectory, OUTPUT_LAST_MESSAGE_FILE_NAME);
  return {
    command: CODEX_COMMAND,
    arguments: [
      "exec",
      "--strict-config",
      "--ignore-user-config",
      "--ignore-rules",
      "--ephemeral",
      "--skip-git-repo-check",
      "--model",
      configuration.model,
      "-s",
      configuration.execution.sandbox,
      "-c",
      `approval_policy="${configuration.execution.approvalPolicy}"`,
      "-c",
      `model_reasoning_effort="${configuration.execution.reasoningEffort}"`,
      "-C",
      workingDirectory,
      "--output-schema",
      fileURLToPath(OUTPUT_SCHEMA_URL),
      "--output-last-message",
      outputLastMessagePath,
      "--color",
      "never",
      systemPrompt,
    ],
    workingDirectory,
    environment: createCodexEnvironment(configuration.authentication, dependencies.environment),
    standardInput: inputJson,
    timeoutMilliseconds: configuration.execution.timeoutSeconds * 1000,
  };
}

async function runProcess(
  request: CodexProcessRequest,
  processRunner: CodexProcessRunner,
  attempts: number,
): Promise<CodexProcessResult> {
  try {
    return await processRunner(request);
  } catch (error: unknown) {
    throw new CodexProcessStartError(attempts, { cause: error });
  }
}

function assertSuccessfulProcess(
  result: CodexProcessResult,
  request: CodexProcessRequest,
  attempts: number,
): void {
  if (result.timedOut) {
    throw new CodexTimeoutError(attempts, request.timeoutMilliseconds);
  }
  if (result.exitCode !== 0 || result.signal != null) {
    throw new CodexNonZeroExitError(attempts, result.exitCode, result.signal, result.apiError);
  }
}

function createSafeJsonParseCause(error: unknown): Error {
  const errorName = error instanceof Error ? error.name : typeof error;
  return new Error(`Codex最終メッセージのJSON解析に失敗しました。エラー種別: ${errorName}`);
}

async function readLastMessage(request: CodexProcessRequest, attempts: number): Promise<unknown> {
  const outputPathIndex = request.arguments.indexOf("--output-last-message");
  const outputPath = request.arguments.at(outputPathIndex + 1);
  if (outputPathIndex < 0 || outputPath == null) {
    throw new TypeError("Codex CLI引数に最終メッセージの出力先がありません");
  }

  let source: string;
  try {
    source = await readFile(outputPath, "utf8");
  } catch (error: unknown) {
    throw new CodexInvalidJsonError(attempts, { cause: error });
  }

  const parseJson: (value: string) => unknown = JSON.parse;
  try {
    return parseJson(source);
  } catch (error: unknown) {
    throw new CodexInvalidJsonError(attempts, {
      cause: createSafeJsonParseCause(error),
    });
  }
}

async function executeAttempt(
  configuration: CodexAdapterConfiguration,
  dependencies: CodexAdapterDependencies,
  systemPrompt: string,
  inputJson: string,
  attempts: number,
): Promise<unknown> {
  const workingDirectory = await createTemporaryWorkspace();
  let outcome: AttemptOutcome;
  try {
    const request = createProcessRequest(
      configuration,
      dependencies,
      systemPrompt,
      inputJson,
      workingDirectory,
    );
    const result = await runProcess(request, dependencies.processRunner, attempts);
    assertSuccessfulProcess(result, request, attempts);
    outcome = {
      success: true,
      value: await readLastMessage(request, attempts),
    };
  } catch (error: unknown) {
    outcome = {
      success: false,
      error,
    };
  }

  try {
    await rm(workingDirectory, {
      recursive: true,
      force: true,
    });
  } catch (cleanupError: unknown) {
    const causes = outcome.success ? [cleanupError] : [outcome.error, cleanupError];
    const message = outcome.success
      ? "Codex用の一時作業ディレクトリを削除できませんでした"
      : "Codex実行後に一時作業ディレクトリを削除できませんでした";
    throw new CodexTemporaryWorkspaceError("cleanup", {
      cause: new AggregateError(causes, message),
    });
  }

  if (!outcome.success) {
    throw outcome.error;
  }
  return outcome.value;
}

function processErrorCode(error: unknown): string | undefined {
  if (
    typeof error === "object" &&
    error != null &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code;
  }
  return undefined;
}

function isTemporaryAttemptError(error: CodexAttemptError): boolean {
  if (
    error instanceof CodexTimeoutError ||
    error instanceof CodexRateLimitError ||
    error instanceof CodexInvalidJsonError
  ) {
    return true;
  }
  if (error instanceof CodexProcessStartError) {
    const code = processErrorCode(error.cause);
    return code != null && TEMPORARY_PROCESS_ERROR_CODES.has(code);
  }
  if (error instanceof CodexNonZeroExitError) {
    return error.signal != null;
  }
  return false;
}

function calculateBackoffMilliseconds(
  retryNumber: number,
  configuration: CodexAdapterConfiguration,
  random: () => number,
): number {
  const randomValue = random();
  if (!Number.isFinite(randomValue) || randomValue < 0 || randomValue >= 1) {
    throw new TypeError("Codex retryのrandomは0以上1未満を返してください");
  }
  const initialMilliseconds = configuration.retry.initialDelaySeconds * 1000;
  const maximumMilliseconds = configuration.retry.maxDelaySeconds * 1000;
  const exponentialMilliseconds = Math.min(
    maximumMilliseconds,
    initialMilliseconds * 2 ** (retryNumber - 1),
  );
  return Math.ceil(exponentialMilliseconds * (0.5 + randomValue * 0.5));
}

async function waitBeforeRetry(
  retryNumber: number,
  configuration: CodexAdapterConfiguration,
  dependencies: CodexAdapterDependencies,
): Promise<void> {
  const delayMilliseconds = calculateBackoffMilliseconds(
    retryNumber,
    configuration,
    dependencies.runtime.random,
  );
  try {
    await dependencies.runtime.sleep(delayMilliseconds);
  } catch (error: unknown) {
    throw new TypeError("Codex retryの待機に失敗しました", {
      cause: error,
    });
  }
}

async function executeRawCodexAnalysis(
  input: CodexAnalysisInput,
  configurationValue: CodexAdapterConfiguration,
  dependencies: CodexAdapterDependencies,
): Promise<unknown> {
  const configuration = codexAdapterConfigurationSchema.parse({
    authentication: configurationValue.authentication,
    model: configurationValue.model,
    execution: configurationValue.execution,
    retry: configurationValue.retry,
  });
  const validatedInput = createCodexAnalysisInput(input);
  const inputJson = serializeCodexAnalysisInput(validatedInput);
  const systemPrompt = await readFixedSystemPrompt();
  await assertOutputSchemaIsReadable();

  for (let attempts = 1; ; attempts += 1) {
    try {
      return await executeAttempt(configuration, dependencies, systemPrompt, inputJson, attempts);
    } catch (error: unknown) {
      if (!(error instanceof CodexAttemptError)) {
        throw error;
      }
      if (!isTemporaryAttemptError(error) || attempts === configuration.execution.maxAttempts) {
        throw error;
      }
      await waitBeforeRetry(attempts, configuration, dependencies);
    }
  }
}

/** Codexを隔離実行し、IDをcanonical形式へ戻した検証済み出力を返す。 */
export async function executeCodexAnalysis(
  input: CodexAnalysisInput,
  configurationValue: CodexAdapterConfiguration,
  dependencies: CodexAdapterDependencies,
): Promise<ValidatedCodexAnalysisOutput> {
  return executeCodexAnalysisWithTransportAliases(input, (transportInput) =>
    executeRawCodexAnalysis(transportInput, configurationValue, dependencies),
  );
}
