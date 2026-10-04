import {
  CodexInvalidJsonError,
  CodexNonZeroExitError,
  CodexOutputSchemaValidationError,
  CodexOutputSemanticValidationError,
  CodexOutputValidationError,
  CodexRateLimitError,
  CodexTimeoutError,
  CodexTransportAliasError,
  type CodexNonZeroExitDiagnostic,
  type CodexOutputValidationDiagnostic,
} from "./errors.js";
import { type CodexAnalysisInput } from "./input.js";
import { validateCodexAnalysisOutput } from "./output-validation.js";
import type {
  CodexAnalysisAttempt,
  CodexAnalysisFailureRecorder,
  CodexUnavailableReason,
} from "./reducer-contracts.js";
import { CODEX_OUTPUT_VALIDATION_ISSUE_DETAIL_LIMIT } from "./reducer-contracts.js";

function httpStatusFromError(error: unknown): number | undefined {
  if (typeof error !== "object" || error == null) {
    return undefined;
  }
  if ("status" in error && typeof error.status === "number") {
    return error.status;
  }
  if (
    "response" in error &&
    typeof error.response === "object" &&
    error.response != null &&
    "status" in error.response &&
    typeof error.response.status === "number"
  ) {
    return error.response.status;
  }
  return undefined;
}

function errorType(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

/** Codex実行または検証エラーを表示可能なfallback理由へ分類する。 */
export function classifyCodexUnavailableReason(error: unknown): CodexUnavailableReason {
  if (error instanceof CodexTimeoutError) {
    return "timeout";
  }
  if (error instanceof CodexRateLimitError || httpStatusFromError(error) === 429) {
    return "rate_limited";
  }
  if (error instanceof CodexInvalidJsonError) {
    return "invalid_json";
  }
  if (error instanceof CodexOutputSchemaValidationError) {
    return "schema_validation_failed";
  }
  if (error instanceof CodexOutputSemanticValidationError) {
    return "semantic_validation_failed";
  }
  if (error instanceof CodexNonZeroExitError) {
    return (error.exitCode != null && error.exitCode !== 0 && error.signal == null) ||
      (error.apiError != null && error.exitCode === 0 && error.signal == null)
      ? "execution_failed"
      : "service_unavailable";
  }
  const httpStatus = httpStatusFromError(error);
  if (httpStatus != null && httpStatus >= 500 && httpStatus <= 599) {
    return "service_unavailable";
  }
  return "execution_failed";
}

function nonZeroExitDiagnostic(error: unknown): CodexNonZeroExitDiagnostic | undefined {
  if (!(error instanceof CodexNonZeroExitError)) {
    return undefined;
  }
  return Object.freeze({
    exitCode: error.exitCode,
    apiError: error.apiError,
  });
}

function outputValidationDiagnostic(error: unknown): CodexOutputValidationDiagnostic | undefined {
  if (!(error instanceof CodexOutputValidationError)) {
    return undefined;
  }
  return Object.freeze({
    issueCount: error.issues.length,
    issues: Object.freeze(
      error.issues.slice(0, CODEX_OUTPUT_VALIDATION_ISSUE_DETAIL_LIMIT).map((issue) =>
        Object.freeze({
          path: issue.path,
          code: issue.code,
        }),
      ),
    ),
  });
}

/** Codexを実行してschema検証とsemantic検証を行い、失敗を値として返す。 */
export async function executeValidatedCodexAnalysis(
  input: CodexAnalysisInput,
  execute: (input: CodexAnalysisInput) => Promise<unknown>,
  recordFailure?: CodexAnalysisFailureRecorder,
): Promise<CodexAnalysisAttempt> {
  try {
    const output = await execute(input);
    return Object.freeze({
      status: "validated",
      output: validateCodexAnalysisOutput(output, input),
    });
  } catch (error: unknown) {
    if (error instanceof CodexTransportAliasError) {
      throw error;
    }
    if (recordFailure != null) {
      await recordFailure(error);
    }
    const diagnostic = nonZeroExitDiagnostic(error);
    const validationDiagnostic = outputValidationDiagnostic(error);
    return Object.freeze({
      status: "unavailable",
      reason: classifyCodexUnavailableReason(error),
      errorType: errorType(error),
      ...(diagnostic == null ? {} : { diagnostic }),
      ...(validationDiagnostic == null ? {} : { validationDiagnostic }),
    });
  }
}
