import {
  type AiAnalysisElement,
  type AiAnalysisElementGeneration,
} from "../domain/ai-analysis-elements.js";
import { type AiAnalysisElementSourceGeneration } from "../domain/ai-analysis-source-generations.js";
import {
  type Evidence,
  type NaturalLanguageDeadlineAssessmentState,
  type NaturalLanguageImportanceAssessmentState,
  type NotificationReasonCode,
  type Status,
  type WaitingOn,
} from "../domain/index.js";
import { type RelationCandidateAssessment } from "../graph/index.js";
import { type CodexPreservedElements } from "./analysis-elements.js";
import {
  type CodexConfidenceClassification,
  type CodexConfidenceThresholds,
} from "./confidence.js";
import { type CodexNonZeroExitDiagnostic, type CodexOutputValidationDiagnostic } from "./errors.js";
import { type CodexAnalysisInput } from "./input.js";
import { type CodexElementOutput } from "./semantic-validation.js";

export const CODEX_OUTPUT_VALIDATION_ISSUE_DETAIL_LIMIT = 5;

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

export type CodexAnalysisElementApplications = Readonly<
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

/** 検証済みCodex出力と決定論的判定のpure reducer結果。 */
export type CodexAnalysisReduction = Readonly<{
  decision: ReducedCodexDecision;
  displayMode: CodexConfidenceClassification["displayMode"];
  importanceAssessment: NaturalLanguageImportanceAssessmentState;
  deadlineAssessment: NaturalLanguageDeadlineAssessmentState;
  ai:
    | Readonly<{
        status: "available";
        elements: CodexAnalysisElementApplications;
      }>
    | Readonly<{
        status: "unavailable";
        reason: CodexUnavailableReason;
        errorType: string;
        elements: CodexAnalysisElementApplications;
      }>;
  relationAssessments: readonly RelationCandidateAssessment[];
  relationCoverage: CodexRelationCoverage;
  notification: ReducedCodexNotification;
}>;

/** 要素単位で保存するAI生成結果の集合。 */
export type AiAnalysisElementGenerationMap = Readonly<
  Partial<Record<AiAnalysisElement, AiAnalysisElementGeneration>>
>;

/** 要素単位で保存する現行または旧形式のAI生成結果の集合。 */
export type AiAnalysisElementSourceGenerationMap = Readonly<
  Partial<Record<AiAnalysisElement, AiAnalysisElementSourceGeneration>>
>;

/** 要素別の実生成結果と保存済み結果を反映する入力。 */
export type ReduceAiAnalysisElementsInput = Readonly<{
  selectedElements: readonly AiAnalysisElement[];
  generatedElements: AiAnalysisElementGenerationMap;
  preservedElements: AiAnalysisElementSourceGenerationMap;
}>;

/** 要素別AI生成結果を選択対象だけ更新し、選択外を保持した結果。 */
export type AiAnalysisElementsReduction = Readonly<{
  elements: AiAnalysisElementSourceGenerationMap;
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

export type CodexAnalysisFailureRecorder = (error: unknown) => Promise<void>;
