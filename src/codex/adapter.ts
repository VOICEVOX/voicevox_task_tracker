import { constants } from "node:fs";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import type { DiagnosticsJsonValue } from "../diagnostics/error-serializer.js";
import { recordCodexDiagnostic, type CodexDiagnosticsContext } from "./diagnostics.js";
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
  type CodexApiErrorDiagnostic,
  type CodexProcessRequest,
  type CodexProcessResult,
  type CodexProcessRunner,
} from "./process-runner.js";
import { REASONING_EFFORTS } from "../domain/index.js";
import { UnreachableError } from "../util/index.js";
import { CODEX_AUTHENTICATION_PREFLIGHT_PROMPT } from "./preflight.js";
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
export const CODEX_AUTHENTICATIONS = ["api-key", "auth-json"] as const;

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

function parseCodexAdapterConfiguration(
  configurationValue: CodexAdapterConfiguration,
): CodexAdapterConfiguration {
  return codexAdapterConfigurationSchema.parse({
    authentication: configurationValue.authentication,
    model: configurationValue.model,
    execution: configurationValue.execution,
    retry: configurationValue.retry,
  });
}

/** Codex adapterへ注入する副作用境界。 */
export type CodexAdapterDependencies = Readonly<{
  environment: NodeJS.ProcessEnv;
  processRunner: CodexProcessRunner;
  runtime: Readonly<{
    sleep: (delayMilliseconds: number) => Promise<void>;
    random: () => number;
  }>;
  diagnostics?: CodexDiagnosticsContext;
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
      fileURLToPath(OUTPUT_SCHEMA_URL),
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

function createAuthenticationPreflightProcessRequest(
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
    environment: createCodexEnvironment(configuration.authentication, dependencies.environment),
    standardInput: "",
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
  stdoutApiError: CodexApiErrorDiagnostic | undefined,
): void {
  if (result.timedOut) {
    throw new CodexTimeoutError(attempts, request.timeoutMilliseconds);
  }
  if (result.exitCode === 0 && result.standardInputError != null) {
    throw new CodexProcessStartError(attempts, { cause: result.standardInputError });
  }
  if (stdoutApiError != null) {
    throw new CodexNonZeroExitError(attempts, result.exitCode, result.signal, stdoutApiError);
  }
  if (result.exitCode !== 0 || result.signal != null) {
    throw new CodexNonZeroExitError(attempts, result.exitCode, result.signal, result.apiError);
  }
}

function createSafeJsonParseCause(error: unknown): Error {
  const errorName = error instanceof Error ? error.name : typeof error;
  return new Error(`Codex最終メッセージのJSON解析に失敗しました。エラー種別: ${errorName}`, {
    cause: error,
  });
}

type LastMessageReadResult =
  | Readonly<{
      status: "read";
      source: string;
      value: unknown;
    }>
  | Readonly<{
      status: "read_failed" | "json_parse_failed";
      source: string;
      error: Error;
    }>;

async function readLastMessage(
  request: CodexProcessRequest,
  attempts: number,
): Promise<LastMessageReadResult> {
  const outputPathIndex = request.arguments.indexOf("--output-last-message");
  const outputPath = request.arguments.at(outputPathIndex + 1);
  if (outputPathIndex < 0 || outputPath == null) {
    throw new TypeError("Codex CLI引数に最終メッセージの出力先がありません");
  }

  let source: string;
  try {
    source = await readFile(outputPath, "utf8");
  } catch (error: unknown) {
    return {
      status: "read_failed",
      source: "",
      error: new CodexInvalidJsonError(attempts, { cause: error }),
    };
  }

  const parseJson: (value: string) => unknown = JSON.parse;
  try {
    return {
      status: "read",
      source,
      value: parseJson(source),
    };
  } catch (error: unknown) {
    return {
      status: "json_parse_failed",
      source,
      error: new CodexInvalidJsonError(attempts, {
        cause: createSafeJsonParseCause(error),
      }),
    };
  }
}

const CODEX_API_ERROR_VALUE_PATTERN = /^[A-Za-z0-9._:-]+$/u;
const codexJsonObjectSchema = z.record(z.string(), z.unknown());

type CodexStdoutInspection = Readonly<{
  apiError: CodexApiErrorDiagnostic | undefined;
  apiEvents: readonly ("turn.failed" | "error")[];
  parseErrors: readonly Error[];
}>;

function safeApiErrorValue(value: unknown): string | undefined {
  if (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 300 &&
    CODEX_API_ERROR_VALUE_PATTERN.test(value)
  ) {
    return value;
  }
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return value.toString();
  }
  return undefined;
}

function apiErrorValue(
  source: Readonly<Record<string, unknown>>,
  field: string,
): string | undefined {
  return safeApiErrorValue(source[field]);
}

function inspectCodexStdout(source: string): CodexStdoutInspection {
  const apiEvents: ("turn.failed" | "error")[] = [];
  const parseErrors: Error[] = [];
  let apiError: CodexApiErrorDiagnostic | undefined;
  for (const [index, line] of source.split(/\r?\n/u).entries()) {
    if (line.trim().length === 0) {
      continue;
    }
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (error: unknown) {
      parseErrors.push(
        new Error(`Codex --json stdoutのJSONL解析に失敗しました。行: ${(index + 1).toString()}`, {
          cause: error,
        }),
      );
      continue;
    }
    const objectResult = codexJsonObjectSchema.safeParse(value);
    if (!objectResult.success) {
      continue;
    }
    const eventType = objectResult.data["type"] ?? objectResult.data["event"];
    if (eventType !== "turn.failed" && eventType !== "error") {
      continue;
    }
    apiEvents.push(eventType);
    const nested = codexJsonObjectSchema.safeParse(objectResult.data["error"]);
    const errorObject = nested.success ? nested.data : objectResult.data;
    const type = apiErrorValue(errorObject, "type");
    const code = apiErrorValue(errorObject, "code");
    const status = apiErrorValue(errorObject, "status");
    apiError ??= Object.freeze({
      type: type ?? eventType,
      ...(code == null ? {} : { code }),
      ...(status == null ? {} : { status }),
    });
  }
  return Object.freeze({
    apiError,
    apiEvents: Object.freeze(apiEvents),
    parseErrors: Object.freeze(parseErrors),
  });
}

function normalizedProcessOutput(value: string | undefined, name: string): string {
  if (value == null) {
    return "";
  }
  if (typeof value !== "string") {
    throw new TypeError(`Codex process resultの${name}は文字列にしてください`);
  }
  return value;
}

function safeApiErrorDetails(
  apiError: CodexApiErrorDiagnostic | undefined,
): Readonly<Record<string, DiagnosticsJsonValue>> | undefined {
  if (apiError == null) {
    return undefined;
  }
  const details: Record<string, DiagnosticsJsonValue> = {};
  if (apiError.type != null) {
    details["type"] = apiError.type;
  }
  if (apiError.code != null) {
    details["code"] = apiError.code;
  }
  if (apiError.status != null) {
    details["status"] = apiError.status;
  }
  return Object.freeze(details);
}

function attemptDetails(
  configuration: CodexAdapterConfiguration,
  attempts: number,
  request: CodexProcessRequest | undefined,
  processResult: CodexProcessResult | undefined,
  stdout: string,
  stderr: string,
  lastMessage: string,
  apiError: CodexApiErrorDiagnostic | undefined,
  outcome: "success" | "failure",
): Readonly<Record<string, DiagnosticsJsonValue>> {
  const details: Record<string, DiagnosticsJsonValue> = {
    attempt: attempts,
    command: CODEX_COMMAND,
    model: configuration.model,
    timeoutMilliseconds:
      request?.timeoutMilliseconds ?? configuration.execution.timeoutSeconds * 1000,
    timedOut: processResult?.timedOut ?? false,
    exitCode: processResult?.exitCode ?? null,
    signal: processResult?.signal ?? null,
    timeout: processResult?.timedOut ?? false,
    stdout,
    stderr,
    lastMessage,
    outcome,
  };
  const safeApiError = safeApiErrorDetails(apiError);
  if (safeApiError != null) {
    details["apiError"] = safeApiError;
  }
  if (request != null) {
    details["arguments"] = Object.freeze(
      request.arguments.map((argument, index) =>
        index === request.arguments.length - 1 ? "<system-prompt>" : argument,
      ),
    );
    details["workingDirectory"] = request.workingDirectory;
    details["standardInputCharacters"] = request.standardInput.length;
  }
  return details;
}

function attemptFailureEvent(error: unknown): string {
  if (error instanceof CodexProcessStartError) {
    return "codex.process.start_failed";
  }
  if (error instanceof CodexTimeoutError) {
    return "codex.process.timeout";
  }
  if (error instanceof CodexNonZeroExitError) {
    return "codex.process.non_zero_exit";
  }
  if (error instanceof CodexInvalidJsonError) {
    return "codex.last_message.failed";
  }
  return "codex.attempt.failed";
}

async function executeAttempt(
  configuration: CodexAdapterConfiguration,
  dependencies: CodexAdapterDependencies,
  systemPrompt: string,
  inputJson: string,
  attempts: number,
): Promise<unknown> {
  const diagnostics = dependencies.diagnostics;
  await recordCodexDiagnostic(diagnostics, "codex.attempt.started", {
    attempt: attempts,
    command: CODEX_COMMAND,
    model: configuration.model,
    timeoutMilliseconds: configuration.execution.timeoutSeconds * 1000,
    standardInputCharacters: inputJson.length,
  });

  let workingDirectory: string | undefined;
  let request: CodexProcessRequest | undefined;
  let processResult: CodexProcessResult | undefined;
  let stdout = "";
  let stderr = "";
  let lastMessage = "";
  let stdoutInspection: CodexStdoutInspection = Object.freeze({
    apiError: undefined,
    apiEvents: Object.freeze([]),
    parseErrors: Object.freeze([]),
  });
  let lastMessageResult: LastMessageReadResult | undefined;
  let outcome: AttemptOutcome = {
    success: false,
    error: new Error("Codex attemptが実行されませんでした"),
  };
  try {
    workingDirectory = await createTemporaryWorkspace();
    request = createProcessRequest(
      configuration,
      dependencies,
      systemPrompt,
      inputJson,
      workingDirectory,
    );
    processResult = await runProcess(request, dependencies.processRunner, attempts);
    stdout = normalizedProcessOutput(processResult.stdout, "stdout");
    stderr = normalizedProcessOutput(processResult.stderr, "stderr");
    stdoutInspection = inspectCodexStdout(stdout);
    if (diagnostics == null) {
      assertSuccessfulProcess(processResult, request, attempts, stdoutInspection.apiError);
    }
    lastMessageResult = await readLastMessage(request, attempts);
    lastMessage = lastMessageResult.source;
    if (diagnostics != null) {
      assertSuccessfulProcess(processResult, request, attempts, stdoutInspection.apiError);
    }
    if (lastMessageResult.status !== "read") {
      throw lastMessageResult.error;
    }
    outcome = {
      success: true,
      value: lastMessageResult.value,
    };
  } catch (error: unknown) {
    outcome = {
      success: false,
      error,
    };
  }

  if (workingDirectory != null) {
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
      outcome = {
        success: false,
        error: new CodexTemporaryWorkspaceError("cleanup", {
          cause: new AggregateError(causes, message),
        }),
      };
    }
  }

  for (const parseError of stdoutInspection.parseErrors) {
    await recordCodexDiagnostic(
      diagnostics,
      "codex.stdout.json_parse_failed",
      {
        attempt: attempts,
      },
      parseError,
    );
  }
  for (const apiEvent of stdoutInspection.apiEvents) {
    const apiEventDetails: Record<string, DiagnosticsJsonValue> = {
      attempt: attempts,
      apiEvent,
    };
    const safeApiError = safeApiErrorDetails(stdoutInspection.apiError);
    if (safeApiError != null) {
      apiEventDetails["apiError"] = safeApiError;
    }
    if (outcome.success) {
      await recordCodexDiagnostic(
        diagnostics,
        `codex.stdout.${apiEvent.replaceAll(".", "_")}`,
        apiEventDetails,
      );
    } else {
      await recordCodexDiagnostic(
        diagnostics,
        `codex.stdout.${apiEvent.replaceAll(".", "_")}`,
        apiEventDetails,
        outcome.error,
      );
    }
  }
  if (lastMessageResult?.status === "read_failed") {
    await recordCodexDiagnostic(
      diagnostics,
      "codex.last_message.read_failed",
      {
        attempt: attempts,
      },
      lastMessageResult.error,
    );
  }
  if (lastMessageResult?.status === "json_parse_failed") {
    await recordCodexDiagnostic(
      diagnostics,
      "codex.last_message.json_parse_failed",
      {
        attempt: attempts,
      },
      lastMessageResult.error,
    );
  }
  if (!outcome.success) {
    await recordCodexDiagnostic(
      diagnostics,
      attemptFailureEvent(outcome.error),
      attemptDetails(
        configuration,
        attempts,
        request,
        processResult,
        stdout,
        stderr,
        lastMessage,
        stdoutInspection.apiError ?? processResult?.apiError,
        "failure",
      ),
      outcome.error,
    );
    await recordCodexDiagnostic(
      diagnostics,
      "codex.attempt.completed",
      attemptDetails(
        configuration,
        attempts,
        request,
        processResult,
        stdout,
        stderr,
        lastMessage,
        stdoutInspection.apiError ?? processResult?.apiError,
        "failure",
      ),
      outcome.error,
    );
    throw outcome.error;
  }
  await recordCodexDiagnostic(
    diagnostics,
    "codex.attempt.completed",
    attemptDetails(
      configuration,
      attempts,
      request,
      processResult,
      stdout,
      stderr,
      lastMessage,
      stdoutInspection.apiError ?? processResult?.apiError,
      "success",
    ),
  );
  return outcome.value;
}

function preflightAttemptDetails(
  configuration: CodexAdapterConfiguration,
  attempts: number,
  request: CodexProcessRequest | undefined,
  processResult: CodexProcessResult | undefined,
  stdout: string,
  stderr: string,
  apiError: CodexApiErrorDiagnostic | undefined,
  outcome: "success" | "failure",
): Readonly<Record<string, DiagnosticsJsonValue>> {
  const details: Record<string, DiagnosticsJsonValue> = {
    attempt: attempts,
    command: CODEX_COMMAND,
    model: configuration.model,
    timeoutMilliseconds:
      request?.timeoutMilliseconds ?? configuration.execution.timeoutSeconds * 1000,
    timedOut: processResult?.timedOut ?? false,
    exitCode: processResult?.exitCode ?? null,
    signal: processResult?.signal ?? null,
    timeout: processResult?.timedOut ?? false,
    stdout,
    stderr,
    standardInputCharacters: 0,
    outcome,
  };
  const safeApiError = safeApiErrorDetails(apiError);
  if (safeApiError != null) {
    details["apiError"] = safeApiError;
  }
  if (request != null) {
    details["arguments"] = Object.freeze(
      request.arguments.map((argument, index) =>
        index === request.arguments.length - 1 ? "<authentication-preflight-prompt>" : argument,
      ),
    );
    details["workingDirectory"] = request.workingDirectory;
  }
  return details;
}

async function executeAuthenticationPreflightAttempt(
  configuration: CodexAdapterConfiguration,
  dependencies: CodexAdapterDependencies,
  attempts: number,
): Promise<void> {
  const diagnostics = dependencies.diagnostics;
  await recordCodexDiagnostic(diagnostics, "codex.authentication_preflight.attempt.started", {
    attempt: attempts,
    command: CODEX_COMMAND,
    model: configuration.model,
    timeoutMilliseconds: configuration.execution.timeoutSeconds * 1000,
    standardInputCharacters: 0,
  });

  let workingDirectory: string | undefined;
  let request: CodexProcessRequest | undefined;
  let processResult: CodexProcessResult | undefined;
  let stdout = "";
  let stderr = "";
  let stdoutInspection: CodexStdoutInspection = Object.freeze({
    apiError: undefined,
    apiEvents: Object.freeze([]),
    parseErrors: Object.freeze([]),
  });
  let outcome: AttemptOutcome = {
    success: false,
    error: new Error("Codex認証preflightが実行されませんでした"),
  };
  try {
    workingDirectory = await createTemporaryWorkspace();
    request = createAuthenticationPreflightProcessRequest(
      configuration,
      dependencies,
      workingDirectory,
    );
    processResult = await runProcess(request, dependencies.processRunner, attempts);
    stdout = normalizedProcessOutput(processResult.stdout, "stdout");
    stderr = normalizedProcessOutput(processResult.stderr, "stderr");
    stdoutInspection = inspectCodexStdout(stdout);
    assertSuccessfulProcess(processResult, request, attempts, stdoutInspection.apiError);
    outcome = {
      success: true,
      value: undefined,
    };
  } catch (error: unknown) {
    outcome = {
      success: false,
      error,
    };
  }

  if (workingDirectory != null) {
    try {
      await rm(workingDirectory, {
        recursive: true,
        force: true,
      });
    } catch (cleanupError: unknown) {
      const causes = outcome.success ? [cleanupError] : [outcome.error, cleanupError];
      const message = outcome.success
        ? "Codex認証preflight用の一時作業ディレクトリを削除できませんでした"
        : "Codex認証preflight実行後に一時作業ディレクトリを削除できませんでした";
      outcome = {
        success: false,
        error: new CodexTemporaryWorkspaceError("cleanup", {
          cause: new AggregateError(causes, message),
        }),
      };
    }
  }

  for (const parseError of stdoutInspection.parseErrors) {
    await recordCodexDiagnostic(
      diagnostics,
      "codex.stdout.json_parse_failed",
      {
        attempt: attempts,
      },
      parseError,
    );
  }
  for (const apiEvent of stdoutInspection.apiEvents) {
    const apiEventDetails: Record<string, DiagnosticsJsonValue> = {
      attempt: attempts,
      apiEvent,
    };
    const safeApiError = safeApiErrorDetails(stdoutInspection.apiError ?? processResult?.apiError);
    if (safeApiError != null) {
      apiEventDetails["apiError"] = safeApiError;
    }
    if (outcome.success) {
      await recordCodexDiagnostic(
        diagnostics,
        `codex.stdout.${apiEvent.replaceAll(".", "_")}`,
        apiEventDetails,
      );
    } else {
      await recordCodexDiagnostic(
        diagnostics,
        `codex.stdout.${apiEvent.replaceAll(".", "_")}`,
        apiEventDetails,
        outcome.error,
      );
    }
  }
  if (!outcome.success) {
    const details = preflightAttemptDetails(
      configuration,
      attempts,
      request,
      processResult,
      stdout,
      stderr,
      stdoutInspection.apiError ?? processResult?.apiError,
      "failure",
    );
    await recordCodexDiagnostic(
      diagnostics,
      attemptFailureEvent(outcome.error),
      details,
      outcome.error,
    );
    await recordCodexDiagnostic(
      diagnostics,
      "codex.authentication_preflight.attempt.completed",
      details,
      outcome.error,
    );
    throw outcome.error;
  }

  await recordCodexDiagnostic(
    diagnostics,
    "codex.authentication_preflight.attempt.completed",
    preflightAttemptDetails(
      configuration,
      attempts,
      request,
      processResult,
      stdout,
      stderr,
      stdoutInspection.apiError ?? processResult?.apiError,
      "success",
    ),
  );
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
  const configuration = parseCodexAdapterConfiguration(configurationValue);
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

/** Codex認証を空の一時directoryでpreflightし、実行失敗を呼び出し側へ伝播する。 */
export async function executeCodexAuthenticationPreflight(
  configurationValue: CodexAdapterConfiguration,
  dependencies: CodexAdapterDependencies,
): Promise<void> {
  const configuration = parseCodexAdapterConfiguration(configurationValue);

  for (let attempts = 1; ; attempts += 1) {
    try {
      await executeAuthenticationPreflightAttempt(configuration, dependencies, attempts);
      return;
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
