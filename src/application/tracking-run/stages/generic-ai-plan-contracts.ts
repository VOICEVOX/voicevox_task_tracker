import type { AnalysisImpactDecisionForDiagnostics } from "../../../codex/analysis-element-dependencies.js";
import type { AnalysisElementPlanning } from "../../../codex/element-planning.js";
import type {
  AiAnalysisRunIdentity,
  AiAnalysisTarget,
  PreparedAiAnalysisCandidate,
} from "../../../codex/analysis-selection.js";
import type { AiAnalysisElement } from "../../../domain/ai-analysis-elements.js";
import type { GitHubNodeId } from "../../../domain/types.js";
import type {
  TrackedItemAiAnalysisCurrentElements,
  TrackedItemAiAnalysisMigrationAdoptedElements,
} from "../../../domain/tracked-item-ai-analysis.js";
import type { StageState } from "../contracts/run-core.js";
import type { FinalSnapshotPlanProjection } from "../contracts/final-snapshot.js";
import type { DeterministicallyAnalyzedRun } from "./deterministic.js";
import type { GenericAiElementPlan } from "./generic-ai-cache-plan.js";
import type { GenericAiBudgetPlan } from "./generic-ai-budget-plan.js";

/** 1項目の全要素と実行用候補を保持する。 */
export type GenericAiItemPlan = Readonly<{
  nodeId: GitHubNodeId;
  selectedElements: readonly AiAnalysisElement[];
  elements: readonly GenericAiElementPlan[];
  planning: AnalysisElementPlanning;
  previousAdopted: TrackedItemAiAnalysisMigrationAdoptedElements;
  previousEvaluated: TrackedItemAiAnalysisCurrentElements;
  deterministicStatePriority: boolean;
  candidate: PreparedAiAnalysisCandidate;
  executionCandidate?: PreparedAiAnalysisCandidate;
}>;

/** 汎用AIの全項目について確定した候補と入力。 */
export type GenericAiInputFailurePlan = Readonly<{
  candidateId: GitHubNodeId;
  reason: "input_validation_failed";
  errorType: string;
  previousAdopted: TrackedItemAiAnalysisMigrationAdoptedElements;
  previousEvaluated: TrackedItemAiAnalysisCurrentElements;
}>;

/** 汎用AIの全項目について確定した候補と入力。 */
export type GenericAiPlan = Readonly<{
  identity: AiAnalysisRunIdentity;
  aiEnabled: boolean;
  minimumConfidence: number;
  target?: AiAnalysisTarget;
  items: readonly GenericAiItemPlan[];
  budget: GenericAiBudgetPlan;
  failures: readonly GenericAiInputFailurePlan[];
  analysisImpactDecisions: readonly Readonly<{
    candidateId: string;
    element: AiAnalysisElement;
    role: "adopted" | "evaluated";
    decision: AnalysisImpactDecisionForDiagnostics;
  }>[];
}>;

/** 汎用AIの候補、厳密な意味入力、再利用判断が確定したrun。 */
export type GenericAiPlannedRun = StageState<
  "generic_ai_planned",
  {
    approvedRepositories: DeterministicallyAnalyzedRun["data"]["approvedRepositories"];
    allowlistDigest: DeterministicallyAnalyzedRun["data"]["allowlistDigest"];
    collection: DeterministicallyAnalyzedRun["data"]["collection"];
    sourceCatalog: DeterministicallyAnalyzedRun["data"]["sourceCatalog"];
    facts: DeterministicallyAnalyzedRun["data"]["facts"];
    plan: GenericAiPlan;
    snapshotPlan: FinalSnapshotPlanProjection;
  }
>;
