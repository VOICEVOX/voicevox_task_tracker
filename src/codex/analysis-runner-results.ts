import { hashCanonicalJson, parseSha256Hash } from "../canonical-json/index.js";
import type { DiagnosticsJsonValue } from "../diagnostics/error-serializer.js";
import { createUtcIsoDateTime, type AnalysisMetadata } from "../domain/index.js";
import { assertNonNullable } from "../util/index.js";
import {
  aiAnalysisElementGenerationSchema,
  type AiAnalysisElement,
  type AiAnalysisElementGeneration,
  type AiAnalysisElementResult,
} from "./analysis-elements.js";
import { AI_ANALYSIS_ELEMENT_REVISIONS } from "./generic-ai-definition.js";
import type {
  AiAnalysisRunElementResult,
  AiAnalysisRunFailure,
  AiAnalysisRunItemResult,
} from "./analysis-runner-contracts.js";
import type { AiAnalysisRunIdentity, PreparedAiAnalysisCandidate } from "./analysis-selection.js";
import { type AiCacheIdentity, type AiCacheKey } from "./cache.js";
import { recordCodexDiagnostic, type CodexDiagnosticsContext } from "./diagnostics.js";
import { CODEX_ELEMENT_OUTPUT_SCHEMA_VERSION } from "./element-output-schema.js";
import type { SchemaValidCodexElementOutput } from "./element-output.js";
import {
  CodexAttemptError,
  CodexNonZeroExitError,
  CodexOutputSchemaValidationError,
  CodexOutputSemanticValidationError,
  CodexOutputValidationError,
} from "./errors.js";
import type { CodexAnalysisInput } from "./input.js";
import { classifyCodexUnavailableReason } from "./reducer-execution.js";
import type { CodexSemanticValidationIssueCode } from "./semantic-validation-issues.js";
import { validateCodexAnalysisSemantics } from "./semantic-validation.js";

const CODEX_OUTPUT_VALIDATION_ISSUE_DETAIL_LIMIT = 5;

function candidateDiagnosticsContext(
  context: CodexDiagnosticsContext | undefined,
  candidateId: string,
): CodexDiagnosticsContext | undefined {
  if (context == null) {
    return undefined;
  }
  return Object.freeze({
    ...context,
    candidateId,
  });
}

function validationFailureEvent(error: unknown): string {
  if (error instanceof CodexOutputSchemaValidationError) {
    return "codex.output.schema_validation_failed";
  }
  if (error instanceof CodexOutputSemanticValidationError) {
    return "codex.output.semantic_validation_failed";
  }
  if (error instanceof CodexAttemptError) {
    return "codex.fallback";
  }
  return "codex.analysis.failed";
}

export async function recordCandidateFailure(
  context: CodexDiagnosticsContext | undefined,
  candidateId: string,
  error: unknown,
  phase: "execution" | "cache",
): Promise<void> {
  const candidateContext = candidateDiagnosticsContext(context, candidateId);
  const details: Record<string, DiagnosticsJsonValue> = {
    phase,
    errorType: error instanceof Error ? error.name : typeof error,
  };
  if (error instanceof CodexAttemptError) {
    details["attempt"] = error.attempts;
  }
  if (error instanceof CodexOutputValidationError) {
    details["issueCount"] = error.issues.length;
    details["issues"] = Object.freeze(
      error.issues.slice(0, CODEX_OUTPUT_VALIDATION_ISSUE_DETAIL_LIMIT).map((issue) =>
        Object.freeze({
          path: issue.path,
          code: issue.code,
        }),
      ),
    );
  }
  await recordCodexDiagnostic(candidateContext, validationFailureEvent(error), details, error);
}

export function createCacheIdentity(
  identity: AiAnalysisRunIdentity,
  elementCandidate: PreparedAiAnalysisCandidate["selectedElements"][number],
): AiCacheIdentity {
  return Object.freeze({
    ...identity,
    element: elementCandidate.element,
    revision: AI_ANALYSIS_ELEMENT_REVISIONS[elementCandidate.element],
    inputFingerprint: parseSha256Hash(elementCandidate.inputFingerprint),
    executionFingerprint: parseSha256Hash(elementCandidate.executionFingerprint),
  });
}

export function resultForElement(
  output: SchemaValidCodexElementOutput,
  element: AiAnalysisElement,
): AiAnalysisElementResult {
  function requiredResult<T>(value: T | undefined, message: string): T {
    assertNonNullable(value, message);
    return value;
  }

  switch (element) {
    case "status":
      return requiredResult(output.status, "検証済みCodex出力のstatusがありません");
    case "waitingOn":
      return requiredResult(output.waitingOn, "検証済みCodex出力のwaitingOnがありません");
    case "nextAction":
      return requiredResult(output.nextAction, "検証済みCodex出力のnextActionがありません");
    case "relations":
      return requiredResult(output.relations, "検証済みCodex出力のrelationsがありません");
    case "progress":
      return requiredResult(output.progress, "検証済みCodex出力のprogressがありません");
    case "importance":
      return requiredResult(output.importance, "検証済みCodex出力のimportanceがありません");
    case "deadline":
      return requiredResult(output.deadline, "検証済みCodex出力のdeadlineがありません");
    case "notification":
      return requiredResult(output.notification, "検証済みCodex出力のnotificationがありません");
    case "selfCommitment":
      return requiredResult(output.selfCommitment, "検証済みCodex出力のselfCommitmentがありません");
    default:
      throw new TypeError(`未知のAI判定要素です。対象: ${String(element)}`);
  }
}

export function assertOutputItemMatchesInput(
  output: SchemaValidCodexElementOutput,
  input: CodexAnalysisInput,
): void {
  if (output.item.nodeId === input.item.nodeId && output.item.url === input.item.url) {
    return;
  }
  throw new CodexOutputSemanticValidationError([
    Object.freeze({
      path: "/item",
      code: "item_mismatch" satisfies CodexSemanticValidationIssueCode,
      message: "Codex出力のitemが入力対象と一致しません",
    }),
  ]);
}

export function validateComposedOutput(
  input: CodexAnalysisInput,
  elements: readonly AiAnalysisRunElementResult[],
): SchemaValidCodexElementOutput {
  const value: Record<string, unknown> = {
    schemaVersion: CODEX_ELEMENT_OUTPUT_SCHEMA_VERSION,
    item: {
      nodeId: input.item.nodeId,
      url: input.item.url,
    },
  };
  for (const element of elements) {
    value[element.element] = element.generation.result;
  }
  return validateCodexAnalysisSemantics(value, input);
}

export function createElementGeneration(
  candidate: PreparedAiAnalysisCandidate,
  elementCandidate: PreparedAiAnalysisCandidate["selectedElements"][number],
  result: AiAnalysisElementResult,
  identity: AiAnalysisRunIdentity,
  generatedAt: string,
): AiAnalysisElementGeneration {
  const metadata = Object.freeze({
    ...identity,
    revision: AI_ANALYSIS_ELEMENT_REVISIONS[elementCandidate.element],
    inputFingerprint: parseSha256Hash(elementCandidate.inputFingerprint),
    executionFingerprint: parseSha256Hash(elementCandidate.executionFingerprint),
    promptFingerprint: parseSha256Hash(candidate.promptFingerprint),
    outputHash: hashCanonicalJson(result),
    generatedAt: createUtcIsoDateTime(generatedAt),
  }) satisfies AnalysisMetadata;
  return aiAnalysisElementGenerationSchema.parse({
    metadata,
    result,
  });
}

export function createRunElementResult(
  element: AiAnalysisElement,
  origin: "cache" | "executed",
  cacheKey: AiCacheKey,
  generation: AiAnalysisElementGeneration,
): AiAnalysisRunElementResult {
  return Object.freeze({
    element,
    origin,
    cacheKey,
    generation,
  });
}

export function createRunItemResult(
  candidateId: string,
  elements: readonly AiAnalysisRunElementResult[],
  complete: boolean,
): AiAnalysisRunItemResult {
  if (elements.length === 0) {
    throw new TypeError(`AI分析結果の要素がありません。対象: ${candidateId}`);
  }
  const hasCache = elements.some((value) => value.origin === "cache");
  const hasExecuted = elements.some((value) => value.origin === "executed");
  const origin = hasCache && hasExecuted ? "mixed" : hasCache ? "cache" : "executed";
  return Object.freeze({
    candidateId,
    origin,
    complete,
    elements: Object.freeze([...elements]),
  });
}

export function createFailure(error: unknown, candidateId: string): AiAnalysisRunFailure {
  const diagnostic =
    error instanceof CodexNonZeroExitError
      ? Object.freeze({
          exitCode: error.exitCode,
          apiError: error.apiError,
        })
      : undefined;
  const validationDiagnostic =
    error instanceof CodexOutputValidationError
      ? Object.freeze({
          issueCount: error.issues.length,
          issues: Object.freeze(
            error.issues.slice(0, CODEX_OUTPUT_VALIDATION_ISSUE_DETAIL_LIMIT).map((issue) =>
              Object.freeze({
                path: issue.path,
                code: issue.code,
              }),
            ),
          ),
        })
      : undefined;
  return Object.freeze({
    candidateId,
    reason: classifyCodexUnavailableReason(error),
    errorType: error instanceof Error ? error.name : typeof error,
    ...(diagnostic == null ? {} : { diagnostic }),
    ...(validationDiagnostic == null ? {} : { validationDiagnostic }),
  });
}
