import {
  codexAdapterConfigurationSchema,
  type CodexAdapterConfiguration,
  type CodexAdapterDependencies,
} from "./adapter-contracts.js";
import { rm } from "node:fs/promises";

import type {
  AiBudgetAttemptKind,
  AiBudgetCharge,
} from "../application/tracking-run/contracts/ai-budget-ledger.js";
import type { PersonalReminderPlannedBatch } from "../application/tracking-run/stages/personal-reminder-plan-contracts.js";
import { hashCanonicalJson, serializeCanonicalJson } from "../canonical-json/index.js";
import type { DiagnosticsJsonValue } from "../diagnostics/error-serializer.js";
import {
  CODEX_COMMAND,
  createAuthenticationPreflightProcessRequest,
  createProcessRequest,
  createSemanticCorrectionSystemPrompt,
  createTemporaryWorkspace,
  readFixedPersonalReminderPrompt,
  readFixedSemanticCorrectionPrompt,
  readFixedSystemPrompt,
  writeOutputSchema,
} from "./adapter-process-support.js";
import {
  PERMANENT_CODEX_API_ERROR_TYPES,
  inspectCodexStdout,
  mergeCodexApiErrors,
  normalizedProcessOutput,
  readLastMessage,
  safeApiErrorDetails,
  type CodexStdoutInspection,
  type LastMessageReadResult,
} from "./adapter-process-output.js";
import {
  CodexAttemptBudgetExceededError,
  type CodexInitialAttemptTicket,
} from "./attempt-budget.js";
import { estimateAiInputCost } from "./budget.js";
import { recordCodexDiagnostic } from "./diagnostics.js";
import { createCodexElementOutputSchema } from "./element-output-schema.js";
import {
  CodexAttemptError,
  CodexNonZeroExitError,
  CodexProcessStartError,
  CodexRateLimitError,
  CodexTemporaryWorkspaceError,
  CodexTimeoutError,
} from "./errors.js";
import {
  createCodexAnalysisInput,
  serializeCodexAnalysisInput,
  type CodexAnalysisInput,
} from "./input.js";
import { createPersonalReminderAiInput } from "./personal-reminder-input.js";
import {
  createPersonalReminderAiOutputSchema,
  type PersonalReminderAiOutputJsonSchema,
} from "./personal-reminder-output-schema.js";
import {
  validatePersonalReminderAiOutput,
  type SchemaValidPersonalReminderAiOutput,
} from "./personal-reminder-output.js";
import { CODEX_AUTHENTICATION_PREFLIGHT_PROMPT } from "./preflight.js";
import {
  type CodexApiErrorDiagnostic,
  type CodexProcessRequest,
  type CodexProcessResult,
} from "./process-runner.js";
import { type CodexElementOutput } from "./semantic-validation.js";
import {
  executeCodexAnalysisWithTransportAliases,
  serializeCodexSemanticCorrectionEnvelope,
  type CodexSemanticGenerationContext,
  type CodexSemanticGenerationObserver,
} from "./transport-alias.js";

export {
  createCodexEnvironment,
  getCodexEnvironmentVariableAllowlist,
} from "./adapter-process-support.js";

const OUTPUT_SCHEMA_FILE_NAME = "codex-element-output.schema.json";
const PERSONAL_REMINDER_OUTPUT_SCHEMA_FILE_NAME = "personal-reminder-output.schema.json";
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

function parseCodexAdapterConfiguration(
  configurationValue: CodexAdapterConfiguration,
): CodexAdapterConfiguration {
  return codexAdapterConfigurationSchema.parse({
    authentication: configurationValue.authentication,
    model: configurationValue.model,
    inputCostUsdPerMillionTokens: configurationValue.inputCostUsdPerMillionTokens,
    execution: configurationValue.execution,
    retry: configurationValue.retry,
  });
}

type AttemptOutcome =
  | Readonly<{
      success: true;
      value: unknown;
    }>
  | Readonly<{
      success: false;
      error: unknown;
    }>;

async function runProcess(
  request: CodexProcessRequest,
  dependencies: CodexAdapterDependencies,
  attempts: number,
  kind: AiBudgetAttemptKind,
  ownerId: string,
  charge: AiBudgetCharge,
  initialTicket: CodexInitialAttemptTicket | undefined,
  onProcessAttemptStarted: (() => void) | undefined,
): Promise<CodexProcessResult> {
  dependencies.attemptBudget.beginAttempt(initialTicket, kind, ownerId, charge);
  onProcessAttemptStarted?.();
  try {
    return await dependencies.processRunner(request);
  } catch (error: unknown) {
    if (error instanceof CodexAttemptBudgetExceededError) {
      throw error;
    }
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
    throw new CodexNonZeroExitError(
      attempts,
      result.exitCode,
      result.signal,
      mergeCodexApiErrors(stdoutApiError, result.apiError),
    );
  }
  if (result.exitCode !== 0 || result.signal != null) {
    throw new CodexNonZeroExitError(
      attempts,
      result.exitCode,
      result.signal,
      mergeCodexApiErrors(stdoutApiError, result.apiError),
    );
  }
}

function attemptDetails(
  configuration: CodexAdapterConfiguration,
  attempts: number,
  semanticGeneration: number,
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
    semanticGeneration,
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

async function executeAttempt(
  configuration: CodexAdapterConfiguration,
  dependencies: CodexAdapterDependencies,
  systemPrompt: string,
  inputJson: string,
  outputSchema: Readonly<Record<string, unknown>>,
  outputSchemaFileName: string,
  outputSchemaResource: string,
  attempts: number,
  generation: number,
  observer: CodexSemanticGenerationObserver | undefined,
): Promise<unknown> {
  const diagnostics = dependencies.diagnostics;
  const processStarted = { value: false };
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
  let apiError: CodexApiErrorDiagnostic | undefined;
  let lastMessageResult: LastMessageReadResult | undefined;
  let outcome: AttemptOutcome = {
    success: false,
    error: new Error("Codex attemptが実行されませんでした"),
  };
  try {
    workingDirectory = await createTemporaryWorkspace();
    const outputSchemaPath = await writeOutputSchema(
      workingDirectory,
      outputSchema,
      outputSchemaFileName,
      outputSchemaResource,
    );
    request = createProcessRequest(
      configuration,
      dependencies,
      systemPrompt,
      inputJson,
      workingDirectory,
      outputSchemaPath,
    );
    const owner = dependencies.attemptOwner;
    if (owner == null) {
      throw new TypeError("Codex実試行の予算所有者がありません");
    }
    const kind: AiBudgetAttemptKind =
      owner.kind === "generic"
        ? generation > 1
          ? attempts > 1
            ? "generic_semantic_correction_transport_retry"
            : "generic_semantic_correction"
          : attempts > 1
            ? "generic_transport_retry"
            : "generic_initial"
        : attempts > 1
          ? "personal_transport_retry"
          : "personal_initial";
    const cost = estimateAiInputCost(
      request.standardInput,
      configuration.inputCostUsdPerMillionTokens,
    );
    processResult = await runProcess(
      request,
      dependencies,
      attempts,
      kind,
      owner.id,
      Object.freeze({
        inputCharacters: Array.from(request.standardInput).length,
        estimatedInputTokens: cost.estimatedInputTokens,
        estimatedCostUsd: cost.estimatedCostUsd,
      }),
      attempts === 1 && generation === 1 ? dependencies.initialAttemptTicket : undefined,
      () => {
        processStarted.value = true;
        observer?.onProcessAttemptStarted(generation, attempts);
      },
    );
    stdout = normalizedProcessOutput(processResult.stdout, "stdout");
    stderr = normalizedProcessOutput(processResult.stderr, "stderr");
    stdoutInspection = inspectCodexStdout(stdout);
    apiError = mergeCodexApiErrors(stdoutInspection.apiError, processResult.apiError);
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

  if (!processStarted.value) {
    if (!outcome.success) {
      throw outcome.error;
    }
    throw new TypeError("Codex processの開始前に成功結果が確定しました");
  }

  for (const parseError of stdoutInspection.parseErrors) {
    await recordCodexDiagnostic(
      diagnostics,
      "codex.stdout.json_parse_failed",
      {
        attempt: attempts,
        semanticGeneration: generation,
      },
      parseError,
    );
  }
  for (const apiEvent of stdoutInspection.apiEvents) {
    const apiEventDetails: Record<string, DiagnosticsJsonValue> = {
      attempt: attempts,
      semanticGeneration: generation,
      apiEvent,
    };
    const safeApiError = safeApiErrorDetails(apiError);
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
        semanticGeneration: generation,
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
        semanticGeneration: generation,
      },
      lastMessageResult.error,
    );
  }
  if (!outcome.success) {
    await recordCodexDiagnostic(
      diagnostics,
      "codex.attempt.completed",
      attemptDetails(
        configuration,
        attempts,
        generation,
        request,
        processResult,
        stdout,
        stderr,
        lastMessage,
        apiError,
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
      generation,
      request,
      processResult,
      stdout,
      stderr,
      lastMessage,
      apiError,
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
  const processStarted = { value: false };
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
  let apiError: CodexApiErrorDiagnostic | undefined;
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
    const cost = estimateAiInputCost(
      CODEX_AUTHENTICATION_PREFLIGHT_PROMPT,
      configuration.inputCostUsdPerMillionTokens,
    );
    processResult = await runProcess(
      request,
      dependencies,
      attempts,
      attempts === 1 ? "authentication_preflight" : "authentication_preflight_transport_retry",
      "authentication",
      Object.freeze({
        inputCharacters: Array.from(CODEX_AUTHENTICATION_PREFLIGHT_PROMPT).length,
        estimatedInputTokens: cost.estimatedInputTokens,
        estimatedCostUsd: cost.estimatedCostUsd,
      }),
      attempts === 1 ? dependencies.initialAttemptTicket : undefined,
      () => {
        processStarted.value = true;
      },
    );
    stdout = normalizedProcessOutput(processResult.stdout, "stdout");
    stderr = normalizedProcessOutput(processResult.stderr, "stderr");
    stdoutInspection = inspectCodexStdout(stdout);
    apiError = mergeCodexApiErrors(stdoutInspection.apiError, processResult.apiError);
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

  if (!processStarted.value) {
    if (!outcome.success) {
      throw outcome.error;
    }
    throw new TypeError("Codex認証preflightの開始前に成功結果が確定しました");
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
    const safeApiError = safeApiErrorDetails(apiError);
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
      apiError,
      "failure",
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
      apiError,
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

function isPermanentCodexApiError(apiError: CodexApiErrorDiagnostic): boolean {
  if (apiError.type != null && PERMANENT_CODEX_API_ERROR_TYPES.has(apiError.type)) {
    return true;
  }
  if (apiError.code != null && PERMANENT_CODEX_API_ERROR_TYPES.has(apiError.code)) {
    return true;
  }
  if (apiError.status == null) {
    return false;
  }
  const status = Number(apiError.status);
  if (!Number.isSafeInteger(status) || status < 400 || status > 499) {
    return false;
  }
  return status !== 408 && status !== 409 && status !== 429;
}

function isTemporaryAttemptError(error: CodexAttemptError): boolean {
  if (error instanceof CodexTimeoutError || error instanceof CodexRateLimitError) {
    return true;
  }
  if (error instanceof CodexProcessStartError) {
    const code = processErrorCode(error.cause);
    return code != null && TEMPORARY_PROCESS_ERROR_CODES.has(code);
  }
  if (error instanceof CodexNonZeroExitError) {
    if (error.signal != null) {
      return true;
    }
    if (error.apiError == null) {
      return false;
    }
    return !isPermanentCodexApiError(error.apiError);
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

type CodexExecutionInput = Readonly<{
  configuration: CodexAdapterConfiguration;
  dependencies: CodexAdapterDependencies;
  systemPrompt: string;
  inputJson: string;
  outputSchema: Readonly<Record<string, unknown>>;
  outputSchemaFileName: string;
  outputSchemaResource: string;
  generation: number;
  observer?: CodexSemanticGenerationObserver;
}>;

async function executeWithRetries(input: CodexExecutionInput): Promise<unknown> {
  for (let attempts = 1; ; attempts += 1) {
    try {
      return await executeAttempt(
        input.configuration,
        input.dependencies,
        input.systemPrompt,
        input.inputJson,
        input.outputSchema,
        input.outputSchemaFileName,
        input.outputSchemaResource,
        attempts,
        input.generation,
        input.observer,
      );
    } catch (error: unknown) {
      if (!(error instanceof CodexAttemptError)) {
        throw error;
      }
      if (
        !isTemporaryAttemptError(error) ||
        attempts === input.configuration.execution.maxAttempts
      ) {
        throw error;
      }
      await waitBeforeRetry(attempts, input.configuration, input.dependencies);
    }
  }
}

async function executeRawCodexAnalysis(
  input: CodexAnalysisInput,
  configurationValue: CodexAdapterConfiguration,
  dependencies: CodexAdapterDependencies,
  context: CodexSemanticGenerationContext,
): Promise<unknown> {
  const configuration = parseCodexAdapterConfiguration(configurationValue);
  const validatedInput = createCodexAnalysisInput(input);
  const systemPrompt = await readFixedSystemPrompt();
  const correctionPrompt = await readFixedSemanticCorrectionPrompt();
  const outputSchema = createCodexElementOutputSchema(validatedInput.selectedElements);
  let inputJson: string;
  let generationSystemPrompt: string;
  if (context.generation === 1) {
    inputJson = serializeCodexAnalysisInput(validatedInput);
    generationSystemPrompt = systemPrompt;
  } else {
    inputJson = serializeCodexSemanticCorrectionEnvelope(
      validatedInput,
      context.previousOutput,
      context.generation,
      context.issues,
    );
    generationSystemPrompt = createSemanticCorrectionSystemPrompt(systemPrompt, correctionPrompt);
  }
  return executeWithRetries({
    configuration,
    dependencies,
    systemPrompt: generationSystemPrompt,
    inputJson,
    outputSchema,
    outputSchemaFileName: OUTPUT_SCHEMA_FILE_NAME,
    outputSchemaResource: "要素別Codex出力schema",
    generation: context.generation,
    ...(dependencies.semanticGenerationObserver == null
      ? {}
      : { observer: dependencies.semanticGenerationObserver }),
  });
}

async function executeRawPersonalReminderAnalysis(
  inputJson: string,
  configurationValue: CodexAdapterConfiguration,
  dependencies: CodexAdapterDependencies,
): Promise<unknown> {
  const configuration = parseCodexAdapterConfiguration(configurationValue);
  const systemPrompt = await readFixedPersonalReminderPrompt();
  const outputSchema: PersonalReminderAiOutputJsonSchema = createPersonalReminderAiOutputSchema();
  return executeWithRetries({
    configuration,
    dependencies,
    systemPrompt,
    inputJson,
    outputSchema,
    outputSchemaFileName: PERSONAL_REMINDER_OUTPUT_SCHEMA_FILE_NAME,
    outputSchemaResource: "個人催促AI出力schema",
    generation: 1,
  });
}

/** Codex認証を空の一時directoryでpreflightし、実行失敗を呼び出し側へ伝播する。 */
export async function executeCodexAuthenticationPreflight(
  configurationValue: CodexAdapterConfiguration,
  dependencies: CodexAdapterDependencies,
): Promise<void> {
  const configuration = parseCodexAdapterConfiguration(configurationValue);
  let previousAttemptError: CodexAttemptError | undefined;

  for (let attempts = 1; ; attempts += 1) {
    try {
      await executeAuthenticationPreflightAttempt(configuration, dependencies, attempts);
      return;
    } catch (error: unknown) {
      if (error instanceof CodexAttemptBudgetExceededError && previousAttemptError != null) {
        throw previousAttemptError;
      }
      if (!(error instanceof CodexAttemptError)) {
        throw error;
      }
      if (!isTemporaryAttemptError(error) || attempts === configuration.execution.maxAttempts) {
        throw error;
      }
      previousAttemptError = error;
      await waitBeforeRetry(attempts, configuration, dependencies);
    }
  }
}

/** Codexを隔離実行し、IDをcanonical形式へ戻した検証済み出力を返す。 */
export async function executeCodexAnalysis(
  input: CodexAnalysisInput,
  configurationValue: CodexAdapterConfiguration,
  dependencies: CodexAdapterDependencies,
): Promise<CodexElementOutput> {
  const configuration = parseCodexAdapterConfiguration(configurationValue);
  const ownedDependencies = Object.freeze({
    ...dependencies,
    attemptOwner: Object.freeze({ kind: "generic" as const, id: input.item.nodeId }),
  });
  return executeCodexAnalysisWithTransportAliases(
    input,
    (transportInput, context) =>
      executeRawCodexAnalysis(transportInput, configuration, ownedDependencies, context),
    {
      maxSemanticGenerations: configuration.execution.maxSemanticGenerations,
      ...(dependencies.semanticGenerationObserver == null
        ? {}
        : { observer: dependencies.semanticGenerationObserver }),
    },
  );
}

/** 個人催促AIを隔離実行し、専用schemaで検証した出力を返す。 */
export async function executeCodexPersonalReminderAnalysis(
  batch: PersonalReminderPlannedBatch,
  configurationValue: CodexAdapterConfiguration,
  dependencies: CodexAdapterDependencies,
): Promise<SchemaValidPersonalReminderAiOutput> {
  const validatedInput = createPersonalReminderAiInput(batch.input);
  const inputJson = `${serializeCanonicalJson(validatedInput)}\n`;
  if (
    inputJson !== batch.normalizedInput ||
    batch.id !== `personal-reminder-batch:${hashCanonicalJson(validatedInput)}`
  ) {
    throw new TypeError(`個人催促AIの計画済み輸送入力が一致しません。対象: ${batch.id}`);
  }
  const ownedDependencies = Object.freeze({
    ...dependencies,
    attemptOwner: Object.freeze({
      kind: "personal" as const,
      id: batch.id,
    }),
  });
  const output = await executeRawPersonalReminderAnalysis(
    batch.normalizedInput,
    configurationValue,
    ownedDependencies,
  );
  return validatePersonalReminderAiOutput(output, validatedInput.item);
}
