import {
  buildSourceId,
  createGitHubNodeId,
  isTerminalStatus,
  parseSourceId,
  type NaturalLanguageDeadlineAssessmentState,
  type Evidence,
  type NotificationReasonCode,
  type NaturalLanguageImportanceAssessmentState,
  type SourceId,
  type Status,
  type WaitingOn,
} from "../domain/index.js";
import { type RelationCandidateAssessment, type RelationCandidateId } from "../graph/index.js";
import { assertNonNullable } from "../util/index.js";
import { z } from "zod";
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
import {
  AI_ANALYSIS_ELEMENTS,
  createAiAnalysisMigrationElementResultSchema,
  type AiAnalysisElementMigrationResult,
  type AiAnalysisElement,
  type AiAnalysisElementGeneration,
} from "../domain/ai-analysis-elements.js";
import { type CodexAnalysisInput } from "./input.js";
import { type CodexPreservedElements } from "./analysis-elements.js";
import { type CodexElementOutput } from "./semantic-validation.js";
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
      output: CodexElementOutput;
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
        elements: Readonly<
          Partial<
            Record<
              AiAnalysisElement,
              Readonly<{
                confidenceLevel: CodexConfidenceClassification["level"];
                application: "applied" | "preserved" | "deterministic_fallback";
              }>
            >
          >
        >;
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

/** 要素単位で保存するAI生成結果の集合。 */
export type AiAnalysisElementGenerationMap = Readonly<
  Partial<Record<AiAnalysisElement, AiAnalysisElementGeneration>>
>;

/** 要素別の実生成結果と保存済み結果を反映する入力。 */
export type ReduceAiAnalysisElementsInput = Readonly<{
  selectedElements: readonly AiAnalysisElement[];
  generatedElements: AiAnalysisElementGenerationMap;
  preservedElements: AiAnalysisElementGenerationMap;
}>;

/** 要素別AI生成結果を選択対象だけ更新し、選択外を保持した結果。 */
export type AiAnalysisElementsReduction = Readonly<{
  elements: AiAnalysisElementGenerationMap;
  generatedElements: readonly AiAnalysisElement[];
  missingElements: readonly AiAnalysisElement[];
}>;

/** 1件のCodex実行とfallback reducerをつなぐ入力。 */
export type RunCodexAnalysisWithFallbackInput = Readonly<{
  analysisInput: CodexAnalysisInput;
  deterministicDecision: DeterministicCodexDecision;
  confidenceThresholds: CodexConfidenceThresholds;
  preservedElements: CodexPreservedElements;
}>;

/** 1件のCodex実行へ注入する副作用境界。 */
export type RunCodexAnalysisWithFallbackDependencies = Readonly<{
  execute: (input: CodexAnalysisInput) => Promise<unknown>;
  recordFailure?: (error: unknown) => Promise<void>;
}>;

type CodexAnalysisFailureRecorder = (error: unknown) => Promise<void>;

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

function validateProbability(value: number, context: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError(`${context}は0以上1以下にしてください`);
  }
}

function createSourceIdTuple(sourceIds: readonly string[]): readonly [SourceId, ...SourceId[]] {
  const parsedSourceIds = sourceIds.map((sourceId) => {
    const parts = parseSourceId(sourceId);
    return buildSourceId(parts.kind, parts.originalId);
  });
  const [firstSourceId, ...remainingSourceIds] = parsedSourceIds;
  assertNonNullable(firstSourceId, "source IDが1件もありません");
  return Object.freeze([firstSourceId, ...remainingSourceIds]);
}

function copyWaitingOn(
  waitingOn: readonly Readonly<{
    kind: WaitingOn["kind"];
    candidateId: string;
    role: WaitingOn["role"];
    reasonSummary: string;
    sourceIds: readonly string[];
    confidence: number;
  }>[],
): readonly WaitingOn[] {
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

type ElementResultSource = CodexElementOutput | CodexPreservedElements;

type ElementResultSelection = Readonly<{
  result: AiAnalysisElementMigrationResult | undefined;
  classification: CodexConfidenceClassification | undefined;
  application: "applied" | "preserved" | "deterministic_fallback";
}>;

const relationCandidateIdSchema = z.templateLiteral(["rel:", z.string()]);

function resultForElement(
  source: ElementResultSource,
  element: AiAnalysisElement,
): AiAnalysisElementMigrationResult | undefined {
  switch (element) {
    case "status":
      return source.status;
    case "waitingOn":
      return source.waitingOn;
    case "nextAction":
      return source.nextAction;
    case "relations":
      return source.relations;
    case "progress":
      return source.progress;
    case "importance":
      return source.importance;
    case "deadline":
      return source.deadline;
    case "notification":
      return source.notification;
  }
}

function validatePreservedElementKeys(values: CodexPreservedElements): void {
  const knownElements = new Set<string>(AI_ANALYSIS_ELEMENTS);
  for (const element of Object.keys(values)) {
    if (!knownElements.has(element)) {
      throw new TypeError(`保持するAI判定要素が不正です。対象: ${element}`);
    }
  }
}

/** 要素内部のconfidenceを含めた実効confidenceを算出する。 */
export function effectiveElementConfidence(
  element: AiAnalysisElement,
  result: AiAnalysisElementMigrationResult,
): number {
  switch (element) {
    case "waitingOn": {
      const parsed = createAiAnalysisMigrationElementResultSchema("waitingOn").parse(result);
      return parsed.value.reduce(
        (minimum, candidate) => Math.min(minimum, candidate.confidence),
        parsed.confidence,
      );
    }
    case "relations": {
      const parsed = createAiAnalysisMigrationElementResultSchema("relations").parse(result);
      return parsed.value.reduce(
        (minimum, candidate) => Math.min(minimum, candidate.confidence),
        parsed.confidence,
      );
    }
    case "progress": {
      const parsed = createAiAnalysisMigrationElementResultSchema("progress").parse(result);
      return Math.min(parsed.confidence, parsed.value.confidence);
    }
    case "status":
    case "nextAction":
    case "importance":
    case "deadline":
    case "notification":
      return result.confidence;
  }
}

function classificationForSelection(
  element: AiAnalysisElement,
  selection: ElementResultSelection,
  confidenceThresholds: CodexConfidenceThresholds,
): CodexConfidenceClassification | undefined {
  if (selection.classification != null) {
    return selection.classification;
  }
  if (selection.application !== "preserved" || selection.result == null) {
    return undefined;
  }
  return classifyCodexConfidence(
    effectiveElementConfidence(element, selection.result),
    confidenceThresholds,
  );
}

function selectElementResult(
  element: AiAnalysisElement,
  selectedElements: ReadonlySet<string>,
  attempt: CodexAnalysisAttempt,
  preservedElements: CodexPreservedElements,
  confidenceThresholds: CodexConfidenceThresholds,
): ElementResultSelection {
  const preserved = resultForElement(preservedElements, element);
  if (!selectedElements.has(element)) {
    return Object.freeze({
      result: preserved,
      classification: undefined,
      application: preserved == null ? "deterministic_fallback" : "preserved",
    });
  }

  if (attempt.status === "unavailable") {
    return Object.freeze({
      result: preserved,
      classification: undefined,
      application: preserved == null ? "deterministic_fallback" : "preserved",
    });
  }

  const generated = resultForElement(attempt.output, element);
  if (generated == null) {
    throw new TypeError(`検証済みCodex出力の${element}がありません`);
  }
  const classification = classifyCodexConfidence(
    effectiveElementConfidence(element, generated),
    confidenceThresholds,
  );
  if (classification.level === "low") {
    return Object.freeze({
      result: preserved,
      classification,
      application: preserved == null ? "deterministic_fallback" : "preserved",
    });
  }
  return Object.freeze({
    result: generated,
    classification,
    application: "applied",
  });
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
  result: AiAnalysisElementMigrationResult | undefined,
): NaturalLanguageImportanceAssessmentState {
  if (result == null) {
    return createUnavailableImportanceAssessment();
  }
  const parsed = createAiAnalysisMigrationElementResultSchema("importance").parse(result);
  return Object.freeze({
    status: "available",
    value: Object.freeze({
      significantFeature: parsed.value.significantFeature,
      futureRisk: parsed.value.futureRisk,
      rationale: parsed.value.rationale,
    }),
  });
}

function createDeadlineAssessment(
  result: AiAnalysisElementMigrationResult | undefined,
): NaturalLanguageDeadlineAssessmentState {
  if (result == null) {
    return createUnavailableDeadlineAssessment();
  }
  const parsed = createAiAnalysisMigrationElementResultSchema("deadline").parse(result);
  return Object.freeze({
    status: "available",
    value: Object.freeze({
      date: parsed.value.date,
      rationale: parsed.value.rationale,
    }),
  });
}

function createCodexNotification(
  selection: ElementResultSelection,
  confidenceThresholds: CodexConfidenceThresholds,
): ReducedCodexNotification {
  if (selection.result == null) {
    return createFallbackNotification("notification要素の有効な判定がありません");
  }
  const parsed = createAiAnalysisMigrationElementResultSchema("notification").parse(
    selection.result,
  );
  const classification =
    selection.classification ?? classifyCodexConfidence(parsed.confidence, confidenceThresholds);
  return Object.freeze({
    recommended: parsed.value.recommended,
    reasonCode: parsed.value.reasonCode,
    reasonSummary: parsed.value.reasonSummary,
    policy: classification.notificationPolicy,
    highPriorityEligible:
      parsed.value.recommended && classification.notificationPolicy === "eligible",
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

function relationCandidateId(value: string): RelationCandidateId {
  return relationCandidateIdSchema.parse(value);
}

function createRelationAssessments(
  result: AiAnalysisElementMigrationResult,
  currentNodeId: string,
): readonly RelationCandidateAssessment[] {
  const parsed = createAiAnalysisMigrationElementResultSchema("relations").parse(result);
  const nodeId = createGitHubNodeId(currentNodeId);
  return Object.freeze(
    parsed.value.map((relation) =>
      Object.freeze({
        candidateId: relationCandidateId(relation.candidateId),
        currentNodeId: nodeId,
        verdict: relation.verdict,
        reasonSummary: relation.reasonSummary,
        sourceIds: createSourceIdTuple(relation.sourceIds),
        confidence: Math.min(parsed.confidence, relation.confidence),
      }),
    ),
  );
}

function createElementEvidence(
  result: AiAnalysisElementMigrationResult,
  supports: Evidence["supports"],
): readonly Evidence[] {
  return Object.freeze(
    result.evidence.map((evidence) =>
      Object.freeze({
        sourceId: createSourceIdTuple([evidence.sourceId])[0],
        supports,
        summary: evidence.summary,
      }),
    ),
  );
}

function createElementApplications(
  selections: ReadonlyMap<AiAnalysisElement, ElementResultSelection>,
  deterministicStatePriority: boolean,
): Readonly<
  Partial<
    Record<
      AiAnalysisElement,
      Readonly<{
        confidenceLevel: CodexConfidenceClassification["level"];
        application: "applied" | "preserved" | "deterministic_fallback";
      }>
    >
  >
> {
  const applications: Partial<
    Record<
      AiAnalysisElement,
      Readonly<{
        confidenceLevel: CodexConfidenceClassification["level"];
        application: "applied" | "preserved" | "deterministic_fallback";
      }>
    >
  > = {};
  for (const [element, selection] of selections) {
    if (selection.classification == null) {
      continue;
    }
    const statePriority =
      deterministicStatePriority &&
      (element === "status" || element === "waitingOn" || element === "nextAction");
    applications[element] = Object.freeze({
      confidenceLevel: selection.classification.level,
      application: statePriority ? "deterministic_fallback" : selection.application,
    });
  }
  return Object.freeze(applications);
}

function stateDisplayMode(
  selections: readonly (readonly [AiAnalysisElement, ElementResultSelection])[],
  deterministicStatePriority: boolean,
  confidenceThresholds: CodexConfidenceThresholds,
): CodexConfidenceClassification["displayMode"] {
  if (deterministicStatePriority) {
    return "confirmed";
  }
  const stateClassifications = selections
    .filter(
      ([, selection]) =>
        selection.application === "applied" || selection.application === "preserved",
    )
    .map(([element, selection]) =>
      classificationForSelection(element, selection, confidenceThresholds),
    )
    .filter(
      (classification): classification is CodexConfidenceClassification => classification != null,
    );
  if (stateClassifications.length === 0) {
    return "fallback";
  }
  if (stateClassifications.some((classification) => classification.level === "low")) {
    return "fallback";
  }
  if (stateClassifications.some((classification) => classification.level === "medium")) {
    return "estimated";
  }
  return "confirmed";
}

function validateStateValues(status: Status, waitingOn: readonly WaitingOn[]): void {
  if (isTerminalStatus(status) && waitingOn.length !== 0) {
    throw new TypeError("統合後のterminal状態にwaitingOnを設定できません");
  }
  if (!isTerminalStatus(status) && waitingOn.length === 0) {
    throw new TypeError("統合後の継続中状態にはwaitingOnが1件以上必要です");
  }
}

function createStateDecision(
  deterministicDecision: DeterministicCodexDecision,
  selections: ReadonlyMap<AiAnalysisElement, ElementResultSelection>,
  deterministicStatePriority: boolean,
  confidenceThresholds: CodexConfidenceThresholds,
): ReducedCodexDecision {
  const statusSelection = selections.get("status");
  const waitingOnSelection = selections.get("waitingOn");
  const nextActionSelection = selections.get("nextAction");
  assertNonNullable(statusSelection, "status要素の選択結果がありません");
  assertNonNullable(waitingOnSelection, "waitingOn要素の選択結果がありません");
  assertNonNullable(nextActionSelection, "nextAction要素の選択結果がありません");

  const statusResult =
    statusSelection.result == null
      ? undefined
      : createAiAnalysisMigrationElementResultSchema("status").parse(statusSelection.result);
  const waitingOnResult =
    waitingOnSelection.result == null
      ? undefined
      : createAiAnalysisMigrationElementResultSchema("waitingOn").parse(waitingOnSelection.result);
  const nextActionResult =
    nextActionSelection.result == null
      ? undefined
      : createAiAnalysisMigrationElementResultSchema("nextAction").parse(
          nextActionSelection.result,
        );

  const status = deterministicStatePriority ? deterministicDecision.status : statusResult?.value;
  const waitingOn = deterministicStatePriority
    ? deterministicDecision.waitingOn
    : waitingOnResult?.value;
  const nextAction = deterministicStatePriority
    ? deterministicDecision.nextAction
    : nextActionResult?.value;
  const reducedStatus = status ?? deterministicDecision.status;
  const reducedWaitingOn =
    waitingOn == null ? deterministicDecision.waitingOn : copyWaitingOn(waitingOn);
  const reducedNextAction = nextAction ?? deterministicDecision.nextAction;
  validateStateValues(reducedStatus, reducedWaitingOn);

  const aiStateApplied =
    !deterministicStatePriority &&
    [statusSelection, waitingOnSelection, nextActionSelection].some(
      (selection) => selection.application === "applied" || selection.application === "preserved",
    );
  const aiStateSelections: readonly (readonly [AiAnalysisElement, ElementResultSelection])[] = [
    ["status", statusSelection],
    ["waitingOn", waitingOnSelection],
    ["nextAction", nextActionSelection],
  ];
  const resultEvidence: Evidence[] = [];
  for (const [element, selection] of aiStateSelections) {
    if (
      selection.result == null ||
      (selection.application !== "applied" && selection.application !== "preserved")
    ) {
      continue;
    }
    const supports = element === "waitingOn" ? "waiting_on" : "status";
    resultEvidence.push(...createElementEvidence(selection.result, supports));
  }
  const evidence =
    aiStateApplied && resultEvidence.length > 0
      ? Object.freeze(resultEvidence)
      : deterministicDecision.evidence;
  const aiStateResultConfidences = aiStateSelections
    .filter(
      ([, selection]) =>
        selection.result != null &&
        (selection.application === "applied" || selection.application === "preserved"),
    )
    .map(([element, selection]) => {
      if (selection.result == null) {
        throw new TypeError(`${element}要素の採用結果がありません`);
      }
      return effectiveElementConfidence(element, selection.result);
    });
  const stateConfidence =
    aiStateResultConfidences.length === 0
      ? deterministicDecision.confidence
      : Math.min(...aiStateResultConfidences);
  const uncertainties = [...deterministicDecision.uncertainties];
  for (const [, selection] of aiStateSelections) {
    if (
      (selection.application === "applied" || selection.application === "preserved") &&
      selection.result != null
    ) {
      uncertainties.push(...selection.result.uncertainties);
    }
  }
  if (
    aiStateApplied &&
    aiStateSelections.some(
      ([element, selection]) =>
        classificationForSelection(element, selection, confidenceThresholds)?.level === "medium",
    )
  ) {
    uncertainties.push("Codexによる推定表示です");
  }
  if (
    !deterministicStatePriority &&
    [statusSelection, waitingOnSelection, nextActionSelection].some(
      (selection) =>
        selection.classification?.level === "low" &&
        selection.application === "deterministic_fallback",
    )
  ) {
    uncertainties.push("Codex判定のconfidenceが低いため決定論的判定へ縮退しました");
  }

  return createDecision(
    aiStateApplied ? "codex" : "deterministic",
    {
      status: reducedStatus,
      waitingOn: reducedWaitingOn,
      nextAction: reducedNextAction,
      confidence: aiStateApplied ? stateConfidence : deterministicDecision.confidence,
      evidence,
      uncertainties,
    },
    undefined,
  );
}

function reduceUnavailableCodexAnalysis(
  deterministicDecision: DeterministicCodexDecision,
  relationCandidateIds: readonly string[],
  reason: CodexUnavailableReason,
  errorType: string,
  preservedElements: CodexPreservedElements,
): CodexAnalysisReduction {
  const uncertainty = unavailableUncertainty(reason);
  const importanceAssessment = createImportanceAssessment(preservedElements.importance);
  const deadlineAssessment = createDeadlineAssessment(preservedElements.deadline);
  return Object.freeze({
    decision: createDecision("deterministic", deterministicDecision, uncertainty),
    displayMode: "fallback",
    importanceAssessment,
    deadlineAssessment,
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
    Object.freeze({}),
  );
}

/** 検証済みCodex出力を要素別の保存済み値と統合するpure reducer。 */
export function reduceCodexAnalysis(
  analysisInput: CodexAnalysisInput,
  deterministicDecision: DeterministicCodexDecision,
  attempt: CodexAnalysisAttempt,
  confidenceThresholds: CodexConfidenceThresholds,
  preservedElements: CodexPreservedElements,
): CodexAnalysisReduction {
  validateDecision(deterministicDecision);
  validatePreservedElementKeys(preservedElements);
  const selectedElements = new Set<string>(analysisInput.selectedElements);
  const selections = new Map<AiAnalysisElement, ElementResultSelection>();
  for (const element of AI_ANALYSIS_ELEMENTS) {
    selections.set(
      element,
      selectElementResult(
        element,
        selectedElements,
        attempt,
        preservedElements,
        confidenceThresholds,
      ),
    );
  }

  if (attempt.status === "unavailable") {
    const unavailable = reduceUnavailableCodexAnalysis(
      deterministicDecision,
      analysisInput.candidates.relations.map((candidate) => candidate.id),
      attempt.reason,
      attempt.errorType,
      preservedElements,
    );
    const relationSelection = selections.get("relations");
    assertNonNullable(relationSelection, "relations要素の選択結果がありません");
    const relationAssessments =
      relationSelection.result == null
        ? Object.freeze([])
        : createRelationAssessments(relationSelection.result, analysisInput.item.nodeId);
    const relationCoverage =
      relationSelection.result == null
        ? unavailable.relationCoverage
        : (Object.freeze({ status: "complete" }) satisfies CodexRelationCoverage);
    const deterministicStatePriority =
      deterministicDecision.determination === "determined" ||
      listNativeRelationConstraints(analysisInput).some(
        (constraint) => constraint.verdict === "current_is_blocked_by_target",
      );
    const importanceSelection = selections.get("importance");
    const deadlineSelection = selections.get("deadline");
    const notificationSelection = selections.get("notification");
    const statusSelection = selections.get("status");
    const waitingOnSelection = selections.get("waitingOn");
    const nextActionSelection = selections.get("nextAction");
    assertNonNullable(importanceSelection, "importance要素の選択結果がありません");
    assertNonNullable(deadlineSelection, "deadline要素の選択結果がありません");
    assertNonNullable(notificationSelection, "notification要素の選択結果がありません");
    assertNonNullable(statusSelection, "status要素の選択結果がありません");
    assertNonNullable(waitingOnSelection, "waitingOn要素の選択結果がありません");
    assertNonNullable(nextActionSelection, "nextAction要素の選択結果がありません");
    const stateSelections: readonly (readonly [AiAnalysisElement, ElementResultSelection])[] = [
      ["status", statusSelection],
      ["waitingOn", waitingOnSelection],
      ["nextAction", nextActionSelection],
    ];
    return Object.freeze({
      ...unavailable,
      decision: createStateDecision(
        deterministicDecision,
        selections,
        deterministicStatePriority,
        confidenceThresholds,
      ),
      displayMode: stateDisplayMode(
        stateSelections,
        deterministicStatePriority,
        confidenceThresholds,
      ),
      importanceAssessment: createImportanceAssessment(importanceSelection.result),
      deadlineAssessment: createDeadlineAssessment(deadlineSelection.result),
      notification:
        notificationSelection.result == null
          ? unavailable.notification
          : createCodexNotification(notificationSelection, confidenceThresholds),
      relationAssessments,
      relationCoverage,
    });
  }

  const deterministicStatePriority =
    deterministicDecision.determination === "determined" ||
    listNativeRelationConstraints(analysisInput).some(
      (constraint) => constraint.verdict === "current_is_blocked_by_target",
    );
  const decision = createStateDecision(
    deterministicDecision,
    selections,
    deterministicStatePriority,
    confidenceThresholds,
  );
  const importanceSelection = selections.get("importance");
  const deadlineSelection = selections.get("deadline");
  const notificationSelection = selections.get("notification");
  const relationSelection = selections.get("relations");
  assertNonNullable(importanceSelection, "importance要素の選択結果がありません");
  assertNonNullable(deadlineSelection, "deadline要素の選択結果がありません");
  assertNonNullable(notificationSelection, "notification要素の選択結果がありません");
  assertNonNullable(relationSelection, "relations要素の選択結果がありません");

  const relationAssessments =
    relationSelection.result == null
      ? Object.freeze([])
      : createRelationAssessments(relationSelection.result, analysisInput.item.nodeId);
  const relationCoverage =
    relationSelection.result == null
      ? unresolvedRelationCoverage(
          analysisInput.candidates.relations.map((candidate) => candidate.id),
        )
      : (Object.freeze({ status: "complete" }) satisfies CodexRelationCoverage);
  const statusSelection = selections.get("status");
  const waitingOnSelection = selections.get("waitingOn");
  const nextActionSelection = selections.get("nextAction");
  assertNonNullable(statusSelection, "status要素の選択結果がありません");
  assertNonNullable(waitingOnSelection, "waitingOn要素の選択結果がありません");
  assertNonNullable(nextActionSelection, "nextAction要素の選択結果がありません");
  const stateSelections: readonly (readonly [AiAnalysisElement, ElementResultSelection])[] = [
    ["status", statusSelection],
    ["waitingOn", waitingOnSelection],
    ["nextAction", nextActionSelection],
  ];
  const applications = createElementApplications(selections, deterministicStatePriority);
  const notification = createCodexNotification(notificationSelection, confidenceThresholds);
  return Object.freeze({
    decision,
    displayMode: stateDisplayMode(
      stateSelections,
      deterministicStatePriority,
      confidenceThresholds,
    ),
    importanceAssessment: createImportanceAssessment(importanceSelection.result),
    deadlineAssessment: createDeadlineAssessment(deadlineSelection.result),
    ai: Object.freeze({
      status: "available",
      elements: applications,
    }),
    relationAssessments,
    relationCoverage,
    notification,
  });
}

/** Codex実行、二段階検証、要素別fallback reducerを1件分実行する。 */
export async function runCodexAnalysisWithFallback(
  input: RunCodexAnalysisWithFallbackInput,
  dependencies: RunCodexAnalysisWithFallbackDependencies,
): Promise<CodexAnalysisReduction> {
  const attempt = await executeValidatedCodexAnalysis(
    input.analysisInput,
    dependencies.execute,
    dependencies.recordFailure,
  );
  return reduceCodexAnalysis(
    input.analysisInput,
    input.deterministicDecision,
    attempt,
    input.confidenceThresholds,
    input.preservedElements,
  );
}

function validateElementGenerationMap(
  values: AiAnalysisElementGenerationMap,
  context: string,
): void {
  const knownElements = new Set<string>(AI_ANALYSIS_ELEMENTS);
  for (const element of Object.keys(values)) {
    if (!knownElements.has(element)) {
      throw new TypeError(`${context}に未知の要素があります。対象: ${element}`);
    }
  }
}

function validateSelectedElements(selectedElements: readonly AiAnalysisElement[]): Set<string> {
  const knownElements = new Set<string>(AI_ANALYSIS_ELEMENTS);
  const selected = new Set<string>();
  for (const element of selectedElements) {
    if (!knownElements.has(element)) {
      throw new TypeError(`選択したAI判定要素が不正です。対象: ${element}`);
    }
    if (selected.has(element)) {
      throw new TypeError(`選択したAI判定要素が重複しています。対象: ${element}`);
    }
    selected.add(element);
  }
  return selected;
}

/** 要素別の成功結果だけを反映し、選択外の保存済み結果を保持する。 */
export function reduceAiAnalysisElements(
  input: ReduceAiAnalysisElementsInput,
): AiAnalysisElementsReduction {
  const selected = validateSelectedElements(input.selectedElements);
  validateElementGenerationMap(input.generatedElements, "実生成結果");
  validateElementGenerationMap(input.preservedElements, "保持する保存済み生成結果");

  const elements: Partial<Record<AiAnalysisElement, AiAnalysisElementGeneration>> = {};
  let generatedCount = 0;
  for (const element of AI_ANALYSIS_ELEMENTS) {
    const generated = input.generatedElements[element];
    const preserved = input.preservedElements[element];
    if (selected.has(element)) {
      if (generated != null) {
        if (preserved != null) {
          throw new TypeError(`生成結果と保持結果を同時に指定できません。対象: ${element}`);
        }
        elements[element] = generated;
        generatedCount += 1;
      } else if (preserved != null) {
        elements[element] = preserved;
      }
      continue;
    }
    if (generated != null) {
      throw new TypeError(`選択外の要素に実生成結果があります。対象: ${element}`);
    }
    if (preserved != null) {
      elements[element] = preserved;
    }
  }

  if (generatedCount !== 0 && generatedCount !== selected.size) {
    throw new TypeError("選択したAI判定要素の生成結果を一括で反映できません");
  }

  const generatedElements = Object.freeze(
    input.selectedElements.filter((element) => input.generatedElements[element] != null),
  );
  const missingElements = Object.freeze(
    input.selectedElements.filter((element) => input.generatedElements[element] == null),
  );
  return Object.freeze({
    elements: Object.freeze(elements),
    generatedElements,
    missingElements,
  });
}
