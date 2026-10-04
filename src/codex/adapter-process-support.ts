import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { serializeCanonicalJson } from "../canonical-json/index.js";
import { UnreachableError } from "../util/index.js";
import type { CodexAdapterConfiguration, CodexAdapterDependencies } from "./adapter-contracts.js";
import type { CodexAuthentication } from "./authentication.js";
import { CodexResourceError, CodexTemporaryWorkspaceError } from "./errors.js";
import { CODEX_AUTHENTICATION_PREFLIGHT_PROMPT } from "./preflight.js";
import type { CodexProcessRequest } from "./process-runner.js";
import { listCodexSemanticValidationIssueGlossary } from "./semantic-validation-issues.js";

export const CODEX_COMMAND = "codex";
const CODEX_TEMPORARY_DIRECTORY_PREFIX = "voicevox-task-tracker-codex-";
const SYSTEM_PROMPT_URL = new URL("../../prompts/codex-system.md", import.meta.url);
const SEMANTIC_CORRECTION_PROMPT_URL = new URL(
  "../../prompts/codex-semantic-correction.md",
  import.meta.url,
);
const PERSONAL_REMINDER_SYSTEM_PROMPT_URL = new URL(
  "../../prompts/personal-reminder-causes.md",
  import.meta.url,
);
const OUTPUT_LAST_MESSAGE_FILE_NAME = "last-message.json";

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

async function readFixedPrompt(promptUrl: URL, resource: string): Promise<string> {
  try {
    if (promptUrl.protocol === "file:") {
      return await readFile(promptUrl, "utf8");
    }
    if (promptUrl.protocol === "data:") {
      return await (await fetch(promptUrl)).text();
    }
    throw new TypeError(`固定資材のURLスキームに対応していません: ${promptUrl.protocol}`);
  } catch (error: unknown) {
    throw new CodexResourceError(resource, { cause: error });
  }
}

export async function readFixedSystemPrompt(): Promise<string> {
  return readFixedPrompt(SYSTEM_PROMPT_URL, "prompts/codex-system.md");
}

export async function readFixedSemanticCorrectionPrompt(): Promise<string> {
  return readFixedPrompt(SEMANTIC_CORRECTION_PROMPT_URL, "prompts/codex-semantic-correction.md");
}

export function createSemanticCorrectionSystemPrompt(
  systemPrompt: string,
  correctionPrompt: string,
): string {
  const glossary = serializeCanonicalJson(listCodexSemanticValidationIssueGlossary());
  return `${systemPrompt}\n\n${correctionPrompt}\n\n固定semantic issue glossary:\n${glossary}`;
}

export async function readFixedPersonalReminderPrompt(): Promise<string> {
  return readFixedPrompt(
    PERSONAL_REMINDER_SYSTEM_PROMPT_URL,
    "prompts/personal-reminder-causes.md",
  );
}

export async function writeOutputSchema(
  workingDirectory: string,
  schema: Readonly<Record<string, unknown>>,
  fileName: string,
  resource: string,
): Promise<string> {
  const outputSchemaPath = join(workingDirectory, fileName);
  try {
    await writeFile(outputSchemaPath, `${JSON.stringify(schema)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    return outputSchemaPath;
  } catch (error: unknown) {
    throw new CodexResourceError(resource, { cause: error });
  }
}

export async function createTemporaryWorkspace(): Promise<string> {
  try {
    return await mkdtemp(join(tmpdir(), CODEX_TEMPORARY_DIRECTORY_PREFIX));
  } catch (error: unknown) {
    throw new CodexTemporaryWorkspaceError("create", { cause: error });
  }
}

export function createProcessRequest(
  configuration: CodexAdapterConfiguration,
  dependencies: CodexAdapterDependencies,
  systemPrompt: string,
  inputJson: string,
  workingDirectory: string,
  outputSchemaPath: string,
): CodexProcessRequest {
  const outputLastMessagePath = join(workingDirectory, OUTPUT_LAST_MESSAGE_FILE_NAME);
  return {
    command: CODEX_COMMAND,
    arguments: [
      "exec",
      "--json",
      "--output-last-message",
      outputLastMessagePath,
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
      outputSchemaPath,
      "--color",
      "never",
      systemPrompt,
    ],
    workingDirectory,
    environment: Object.freeze({
      ...createCodexEnvironment(configuration.authentication, dependencies.environment),
      HOME: workingDirectory,
    }),
    standardInput: inputJson,
    timeoutMilliseconds: configuration.execution.timeoutSeconds * 1000,
  };
}

export function createAuthenticationPreflightProcessRequest(
  configuration: CodexAdapterConfiguration,
  dependencies: CodexAdapterDependencies,
  workingDirectory: string,
): CodexProcessRequest {
  return {
    command: CODEX_COMMAND,
    arguments: [
      "exec",
      "--json",
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
      "--color",
      "never",
      CODEX_AUTHENTICATION_PREFLIGHT_PROMPT,
    ],
    workingDirectory,
    environment: Object.freeze({
      ...createCodexEnvironment(configuration.authentication, dependencies.environment),
      HOME: workingDirectory,
    }),
    standardInput: "",
    timeoutMilliseconds: configuration.execution.timeoutSeconds * 1000,
  };
}
