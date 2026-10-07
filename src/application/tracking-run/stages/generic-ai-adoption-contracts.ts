import type { AiAnalysisDependency } from "../../../domain/ai-analysis-dependencies.js";
import type {
  AiAnalysisElement,
  AiAnalysisElementApplication,
  AiAnalysisElementInputFingerprint,
  AiAnalysisElementMigrationResult,
  AiAnalysisElementReuseProof,
} from "../../../domain/ai-analysis-elements.js";
import type { AiAnalysisElementSourceGeneration } from "../../../domain/ai-analysis-source-generations.js";
import type { GitHubNodeId } from "../../../domain/types.js";

/** 保持値が現在の入力で検証済みと証明できない理由。 */
export type GenericAiUnverifiedReason =
  | "revision_mismatch"
  | "input_projection_mismatch"
  | "input_mismatch"
  | "dependency_mismatch"
  | "input_unavailable"
  | "proof_unknown";

/** 前回の採用値と現在入力との照合結果。 */
export type GenericAiRetainedValue = Readonly<{
  origin: "snapshot" | "migration";
  result: AiAnalysisElementMigrationResult;
  generation?: AiAnalysisElementSourceGeneration;
  proof: AiAnalysisElementReuseProof;
  currentness: "current" | "unverified";
  unverifiedReasons: readonly GenericAiUnverifiedReason[];
}>;

/** 採用された値と、その値を使う理由。 */
export type GenericAiAdoptedValue =
  | Readonly<{
      status: "ai";
      origin: "executed" | "cache" | "snapshot" | "migration";
      currentness: "current";
      reason:
        | "completed_result"
        | "snapshot_reuse"
        | "retained_after_failure"
        | "retained_after_deferred"
        | "retained_after_nonadoption"
        | "retained_while_disabled";
      result: AiAnalysisElementMigrationResult;
      generation?: AiAnalysisElementSourceGeneration;
      proof: AiAnalysisElementReuseProof;
      unverifiedReasons: readonly [];
    }>
  | Readonly<{
      status: "deterministic";
      currentness: "current";
      reason:
        | "not_required"
        | "deterministic_priority"
        | "state_inconsistent"
        | "ai_unavailable"
        | "disabled";
    }>
  | Readonly<{
      status: "unavailable";
      currentness: "not_applicable";
      reason: "failed" | "deferred" | "disabled" | "current_evaluation_not_adopted";
    }>;

/** 今回または保存済みの完了結果と証明。 */
export type GenericAiEvaluatedValue = Readonly<{
  origin: "executed" | "cache" | "snapshot";
  generation: AiAnalysisElementSourceGeneration;
  result: AiAnalysisElementMigrationResult;
  proof: AiAnalysisElementReuseProof;
}>;

/** 1要素の最終値から採用元と依存を逆引きできる記録。 */
export type GenericAiElementAdoption = Readonly<{
  element: AiAnalysisElement;
  revision: number;
  inputFingerprint?: AiAnalysisElementInputFingerprint;
  dependencyFingerprint?: AiAnalysisElementInputFingerprint;
  attemptStatus: "completed" | "failed" | "deferred" | "not_required" | "disabled";
  adopted: GenericAiAdoptedValue;
  retained?: GenericAiRetainedValue;
  evaluated?: GenericAiEvaluatedValue;
  producer:
    | Readonly<{
        kind: "ai";
        nodeId: GitHubNodeId;
        element: AiAnalysisElement;
        origin: "executed" | "cache" | "snapshot" | "migration";
      }>
    | Readonly<{ kind: "deterministic"; nodeId: GitHubNodeId; element: AiAnalysisElement }>
    | Readonly<{ kind: "unavailable"; nodeId: GitHubNodeId; element: AiAnalysisElement }>;
  application: AiAnalysisElementApplication;
  aiDependency: AiAnalysisDependency;
}>;

/** 一項目の9要素と今回の実行状態。 */
export type GenericAiItemAdoption = Readonly<{
  nodeId: GitHubNodeId;
  status: "used" | "failed" | "deferred" | "not_required" | "disabled";
  elements: Readonly<Record<AiAnalysisElement, GenericAiElementAdoption>>;
}>;
