import {
  isTerminalStatus,
  type NaturalLanguageDeadlineAssessmentState,
  type Evidence,
  type NotificationReasonCode,
  type NaturalLanguageImportanceAssessmentState,
  type SourceId,
  type Status,
  type WaitingOn,
} from "../domain/index.js";
import { type RelationCandidateAssessment } from "../graph/index.js";
import { assertNonNullable } from "../util/index.js";
import {
  CodexInvalidJsonError,
  CodexNonZeroExitError,
  CodexOutputSchemaValidationError,
  CodexOutputSemanticValidationError,
  CodexOutputValidationError,
  CodexRateLimitError,
  CodexTransportAliasError,
  CodexTimeoutError,
  type CodexNonZeroExitDiagnostic,
  type CodexOutputValidationDiagnostic,
} from "./errors.js";
import {
  classifyCodexConfidence,
  type CodexConfidenceClassification,
  type CodexConfidenceThresholds,
} from "./confidence.js";
import { type CodexAnalysisInput } from "./input.js";
import { type ValidatedCodexAnalysisOutput } from "./output-types.js";
import { validateCodexAnalysisOutput } from "./output-validation.js";
import { listNativeRelationConstraints } from "./semantic-validation.js";

const CODEX_OUTPUT_VALIDATION_ISSUE_DETAIL_LIMIT = 5;

/** Codexを利用できず決定論的判定へ縮退した理由。 */
export type CodexUnavailableReason =
  | "input_validation_failed"
  | "timeout"
  | "rate_limited"
  | "invalid_json"
  | "schema_validation_failed"
  | "semantic_validation_failed"
  | "service_unavailable"
  | "execution_failed";

/** Codex実行と二段階検証の結果。 */
export type CodexAnalysisAttempt =
  | Readonly<{
      status: "validated";
      output: ValidatedCodexAnalysisOutput;
    }>
  | Readonly<{
      status: "unavailable";
      reason: CodexUnavailableReason;
      errorType: string;
      diagnostic?: CodexNonZeroExitDiagnostic;
      validationDiagnostic?: CodexOutputValidationDiagnostic;
    }>;

/** Codexと統合する前の決定論的な状態判定。 */
export type DeterministicCodexDecision = Readonly<{
  determination: "determined" | "codex_candidate";
  status: Status;
  waitingOn: readonly WaitingOn[];
  nextAction: string;
  confidence: number;
  evidence: readonly Evidence[];
  uncertainties: readonly string[];
}>;

/** reducerが選んだ表示用状態判定。 */
export type ReducedCodexDecision = Readonly<{
  origin: "deterministic" | "codex";
  status: Status;
  waitingOn: readonly WaitingOn[];
  nextAction: string;
  confidence: number;
  evidence: readonly Evidence[];
  uncertainties: readonly string[];
}>;

/** Codex提案から作る通知候補。外部送信は行わない。 */
export type ReducedCodexNotification = Readonly<{
  recommended: boolean;
  reasonCode: NotificationReasonCode;
  reasonSummary: string;
  policy: CodexConfidenceClassification["notificationPolicy"];
  highPriorityEligible: boolean;
}>;

/** 全relation候補に対するCodex verdictの充足状態。 */
export type CodexRelationCoverage =
  | Readonly<{
      status: "complete";
    }>
  | Readonly<{
      status: "fallback";
      unresolvedCandidateIds: readonly string[];
    }>;

/** 検証済みCodex出力と決定論的判定のpure reducer結果。 */
export type CodexAnalysisReduction = Readonly<{
  decision: ReducedCodexDecision;
  displayMode: CodexConfidenceClassification["displayMode"];
  importanceAssessment: NaturalLanguageImportanceAssessmentState;
  deadlineAssessment: NaturalLanguageDeadlineAssessmentState;
  ai:
    | Readonly<{
        status: "available";
        confidenceLevel: CodexConfidenceClassification["level"];
        application:
          | "applied"
          | "deterministic_preserved"
          | "native_relation_preserved"
          | "low_confidence_fallback";
      }>
    | Readonly<{
        status: "unavailable";
        reason: CodexUnavailableReason;
        errorType: string;
      }>;
  relationAssessments: readonly RelationCandidateAssessment[];
  relationCoverage: CodexRelationCoverage;
  notification: ReducedCodexNotification;
}>;

/** 1件のCodex実行とfallback reducerをつなぐ入力。 */
export type RunCodexAnalysisWithFallbackInput = Readonly<{
  analysisInput: CodexAnalysisInput;
  deterministicDecision: DeterministicCodexDecision;
  confidenceThresholds: CodexConfidenceThresholds;
}>;

/** 1件のCodex実行へ注入する副作用境界。 */
export type RunCodexAnalysisWithFallbackDependencies = Readonly<{
  execute: (input: CodexAnalysisInput) => Promise<unknown>;
}>;

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
    return error.exitCode != null && error.exitCode !== 0 && error.signal == null
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

function validateProbability(value: number, context: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError(`${context}は0以上1以下にしてください`);
  }
}

function createSourceIdTuple(sourceIds: readonly SourceId[]): readonly [SourceId, ...SourceId[]] {
  const [firstSourceId, ...remainingSourceIds] = sourceIds;
  assertNonNullable(firstSourceId, "source IDが1件もありません");
  return Object.freeze([firstSourceId, ...remainingSourceIds]);
}

function copyWaitingOn(waitingOn: readonly WaitingOn[]): readonly WaitingOn[] {
  return Object.freeze(
    waitingOn.map((value) =>
      Object.freeze({
        kind: value.kind,
        candidateId: value.candidateId,
        role: value.role,
        reasonSummary: value.reasonSummary,
        sourceIds: createSourceIdTuple(value.sourceIds),
        confidence: value.confidence,
      }),
    ),
  );
}

function copyEvidence(evidence: readonly Evidence[]): readonly Evidence[] {
  return Object.freeze(
    evidence.map((value) =>
      Object.freeze({
        sourceId: value.sourceId,
        supports: value.supports,
        summary: value.summary,
      }),
    ),
  );
}

function createDecision(
  origin: ReducedCodexDecision["origin"],
  value: Readonly<{
    status: Status;
    waitingOn: readonly WaitingOn[];
    nextAction: string;
    confidence: number;
    evidence: readonly Evidence[];
    uncertainties: readonly string[];
  }>,
  additionalUncertainty: string | undefined,
): ReducedCodexDecision {
  const uncertainties =
    additionalUncertainty == null
      ? value.uncertainties
      : [...value.uncertainties, additionalUncertainty];
  return Object.freeze({
    origin,
    status: value.status,
    waitingOn: copyWaitingOn(value.waitingOn),
    nextAction: value.nextAction,
    confidence: value.confidence,
    evidence: copyEvidence(value.evidence),
    uncertainties: Object.freeze([...new Set(uncertainties)].sort()),
  });
}

function validateDecision(value: DeterministicCodexDecision): void {
  validateProbability(value.confidence, "決定論的判定のconfidence");
  if (value.nextAction.trim().length === 0) {
    throw new TypeError("決定論的判定のnextActionは空にできません");
  }
  if (isTerminalStatus(value.status) && value.waitingOn.length !== 0) {
    throw new TypeError("terminal状態にwaitingOnを設定できません");
  }
  if (!isTerminalStatus(value.status) && value.waitingOn.length === 0) {
    throw new TypeError("継続中の状態にはwaitingOnが1件以上必要です");
  }
  for (const waitingOn of value.waitingOn) {
    validateProbability(waitingOn.confidence, "決定論的waitingOnのconfidence");
  }
}

function effectiveStateConfidence(output: ValidatedCodexAnalysisOutput): number {
  let confidence = output.confidence;
  for (const waitingOn of output.waitingOn) {
    confidence = Math.min(confidence, waitingOn.confidence);
  }
  return confidence;
}

function createRelationAssessments(
  output: ValidatedCodexAnalysisOutput,
): readonly RelationCandidateAssessment[] {
  return Object.freeze(
    output.relations.map((relation) =>
      Object.freeze({
        candidateId: relation.candidateId,
        currentNodeId: output.item.nodeId,
        verdict: relation.verdict,
        reasonSummary: relation.reasonSummary,
        sourceIds: createSourceIdTuple(relation.sourceIds),
        confidence: Math.min(output.confidence, relation.confidence),
      }),
    ),
  );
}

function createFallbackNotification(reasonSummary: string): ReducedCodexNotification {
  return Object.freeze({
    recommended: false,
    reasonCode: "none",
    reasonSummary,
    policy: "suppressed",
    highPriorityEligible: false,
  });
}

function createUnavailableImportanceAssessment(): NaturalLanguageImportanceAssessmentState {
  return Object.freeze({
    status: "not_available",
  });
}

function createUnavailableDeadlineAssessment(): NaturalLanguageDeadlineAssessmentState {
  return Object.freeze({
    status: "not_available",
  });
}

function createImportanceAssessment(
  output: ValidatedCodexAnalysisOutput,
  classification: CodexConfidenceClassification,
): NaturalLanguageImportanceAssessmentState {
  if (classification.level === "low") {
    return createUnavailableImportanceAssessment();
  }
  return Object.freeze({
    status: "available",
    value: Object.freeze({
      significantFeature: output.importance.significantFeature,
      futureRisk: output.importance.futureRisk,
      rationale: output.importance.rationale,
    }),
  });
}

function createDeadlineAssessment(
  output: ValidatedCodexAnalysisOutput,
  classification: CodexConfidenceClassification,
): NaturalLanguageDeadlineAssessmentState {
  if (classification.level === "low") {
    return createUnavailableDeadlineAssessment();
  }
  return Object.freeze({
    status: "available",
    value: Object.freeze({
      level: output.deadline.level,
      rationale: output.deadline.rationale,
    }),
  });
}

function createCodexNotification(
  output: ValidatedCodexAnalysisOutput,
  confidence: CodexConfidenceClassification,
): ReducedCodexNotification {
  return Object.freeze({
    recommended: output.notification.recommended,
    reasonCode: output.notification.reasonCode,
    reasonSummary: output.notification.reasonSummary,
    policy: confidence.notificationPolicy,
    highPriorityEligible:
      output.notification.recommended && confidence.notificationPolicy === "eligible",
  });
}

function unavailableUncertainty(reason: CodexUnavailableReason): string {
  switch (reason) {
    case "input_validation_failed":
      return "Codex入力の検証に失敗したため決定論的判定だけを表示しています";
    case "timeout":
      return "Codexがtimeoutしたため決定論的判定だけを表示しています";
    case "rate_limited":
      return "Codexがrate limitに達したため決定論的判定だけを表示しています";
    case "invalid_json":
      return "Codex出力がJSONではないため決定論的判定だけを表示しています";
    case "schema_validation_failed":
      return "Codex出力がJSON Schemaに適合しないため決定論的判定だけを表示しています";
    case "semantic_validation_failed":
      return "Codex出力がsemantic検証に失敗したため決定論的判定だけを表示しています";
    case "service_unavailable":
      return "Codex serviceを利用できないため決定論的判定だけを表示しています";
    case "execution_failed":
      return "Codex分析を利用できないため決定論的判定だけを表示しています";
  }
}

function unresolvedRelationCoverage(
  relationCandidateIds: readonly string[],
): CodexRelationCoverage {
  return Object.freeze({
    status: "fallback",
    unresolvedCandidateIds: Object.freeze([...relationCandidateIds]),
  });
}

function reduceUnavailableCodexAnalysis(
  deterministicDecision: DeterministicCodexDecision,
  relationCandidateIds: readonly string[],
  reason: CodexUnavailableReason,
  errorType: string,
): CodexAnalysisReduction {
  const uncertainty = unavailableUncertainty(reason);
  return Object.freeze({
    decision: createDecision("deterministic", deterministicDecision, uncertainty),
    displayMode: "fallback",
    importanceAssessment: createUnavailableImportanceAssessment(),
    deadlineAssessment: createUnavailableDeadlineAssessment(),
    ai: Object.freeze({
      status: "unavailable",
      reason,
      errorType,
    }),
    relationAssessments: Object.freeze([]),
    relationCoverage: unresolvedRelationCoverage(relationCandidateIds),
    notification: createFallbackNotification(uncertainty),
  });
}

/** Codex入力の検証失敗を決定論的判定へ縮退する。 */
export function reduceCodexInputValidationFailure(
  deterministicDecision: DeterministicCodexDecision,
  relationCandidateIds: readonly string[],
  errorType: string,
): CodexAnalysisReduction {
  validateDecision(deterministicDecision);
  return reduceUnavailableCodexAnalysis(
    deterministicDecision,
    relationCandidateIds,
    "input_validation_failed",
    errorType,
  );
}

/** 検証済みCodex出力だけを決定論的判定へ統合するpure reducer。 */
export function reduceCodexAnalysis(
  analysisInput: CodexAnalysisInput,
  deterministicDecision: DeterministicCodexDecision,
  attempt: CodexAnalysisAttempt,
  confidenceThresholds: CodexConfidenceThresholds,
): CodexAnalysisReduction {
  validateDecision(deterministicDecision);

  if (attempt.status === "unavailable") {
    return reduceUnavailableCodexAnalysis(
      deterministicDecision,
      analysisInput.candidates.relations.map((candidate) => candidate.id),
      attempt.reason,
      attempt.errorType,
    );
  }

  const stateConfidence = effectiveStateConfidence(attempt.output);
  const classification = classifyCodexConfidence(stateConfidence, confidenceThresholds);
  const importanceAssessment = createImportanceAssessment(attempt.output, classification);
  const deadlineAssessment = createDeadlineAssessment(attempt.output, classification);
  const relationAssessments = createRelationAssessments(attempt.output);
  const completeCoverage = Object.freeze({
    status: "complete",
  }) satisfies CodexRelationCoverage;

  if (deterministicDecision.determination === "determined") {
    return Object.freeze({
      decision: createDecision("deterministic", deterministicDecision, undefined),
      displayMode: "confirmed",
      importanceAssessment,
      deadlineAssessment,
      ai: Object.freeze({
        status: "available",
        confidenceLevel: classification.level,
        application: "deterministic_preserved",
      }),
      relationAssessments,
      relationCoverage: completeCoverage,
      notification: createFallbackNotification(
        "決定論的判定を優先するためCodexの通知提案は使用しません",
      ),
    });
  }

  const hasNativeBlocker = listNativeRelationConstraints(analysisInput).some(
    (constraint) => constraint.verdict === "current_is_blocked_by_target",
  );
  if (hasNativeBlocker) {
    return Object.freeze({
      decision: createDecision("deterministic", deterministicDecision, undefined),
      displayMode: "confirmed",
      importanceAssessment,
      deadlineAssessment,
      ai: Object.freeze({
        status: "available",
        confidenceLevel: classification.level,
        application: "native_relation_preserved",
      }),
      relationAssessments,
      relationCoverage: completeCoverage,
      notification: createFallbackNotification(
        "GitHub native relationを優先するためCodexの通知提案は使用しません",
      ),
    });
  }

  if (classification.level === "low") {
    const uncertainty = "Codex判定のconfidenceが低いため決定論的判定へ縮退しました";
    return Object.freeze({
      decision: createDecision("deterministic", deterministicDecision, uncertainty),
      displayMode: classification.displayMode,
      importanceAssessment,
      deadlineAssessment,
      ai: Object.freeze({
        status: "available",
        confidenceLevel: classification.level,
        application: "low_confidence_fallback",
      }),
      relationAssessments,
      relationCoverage: completeCoverage,
      notification: createFallbackNotification(uncertainty),
    });
  }

  const additionalUncertainty =
    classification.level === "medium" ? "Codexによる推定表示です" : undefined;
  return Object.freeze({
    decision: createDecision(
      "codex",
      {
        status: attempt.output.status,
        waitingOn: attempt.output.waitingOn,
        nextAction: attempt.output.nextAction,
        confidence: stateConfidence,
        evidence: attempt.output.evidence,
        uncertainties: attempt.output.uncertainties,
      },
      additionalUncertainty,
    ),
    displayMode: classification.displayMode,
    importanceAssessment,
    deadlineAssessment,
    ai: Object.freeze({
      status: "available",
      confidenceLevel: classification.level,
      application: "applied",
    }),
    relationAssessments,
    relationCoverage: completeCoverage,
    notification: createCodexNotification(attempt.output, classification),
  });
}

/** Codex実行、二段階検証、fallback reducerを1件分実行する。 */
export async function runCodexAnalysisWithFallback(
  input: RunCodexAnalysisWithFallbackInput,
  dependencies: RunCodexAnalysisWithFallbackDependencies,
): Promise<CodexAnalysisReduction> {
  const attempt = await executeValidatedCodexAnalysis(input.analysisInput, dependencies.execute);
  return reduceCodexAnalysis(
    input.analysisInput,
    input.deterministicDecision,
    attempt,
    input.confidenceThresholds,
  );
}
