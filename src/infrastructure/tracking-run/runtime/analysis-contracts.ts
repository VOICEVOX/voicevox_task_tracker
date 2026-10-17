import type { PreparedRun } from "../../../application/tracking-run/prepare-run.js";
import type {
  CollectedRun,
  collectRunItems,
} from "../../../application/tracking-run/stages/collection.js";
import type { DeterministicallyAnalyzedRun } from "../../../application/tracking-run/stages/deterministic.js";
import type { GenericAiAdoptedRun } from "../../../application/tracking-run/stages/generic-ai-adoption.js";
import type { GenericAiExecutedRun } from "../../../application/tracking-run/stages/generic-ai-execution.js";
import type { GenericAiPlannedRun } from "../../../application/tracking-run/stages/generic-ai-plan-contracts.js";
import type { GraphReconciledRun } from "../../../application/tracking-run/stages/graph-reconciliation.js";
import type { InventoryCollectedRun } from "../../../application/tracking-run/stages/inventory.js";
import type { PersonalReminderExecutedRun } from "../../../application/tracking-run/stages/personal-reminder-execution.js";
import type { PersonalReminderFinalizedRun } from "../../../application/tracking-run/stages/personal-reminder-finalization.js";
import type { PersonalReminderPlannedRun } from "../../../application/tracking-run/stages/personal-reminder-plan.js";
import type { PublicationValidatedRun } from "../../../publication/publication-plan-contracts.js";
import type { RunMetrics } from "../../../publication/run-report.js";
import type { RunInvocation } from "../run-invocation.js";
import type { RuntimeConfiguration, RuntimeState } from "./contracts.js";

export type CanonicalCollectedItems = Awaited<
  ReturnType<typeof collectRunItems>
>["data"]["collection"];

/** 一つのrunに閉じたadapter設定と永続化session。 */
export type AnalysisRuntimeContext = Readonly<{
  invocation: RunInvocation;
  configuration: RuntimeConfiguration;
  state: RuntimeState;
}>;

/** 業務段階の確定値をreportへ集計する境界。 */
export type AnalysisProgress = Readonly<{
  record: (
    metrics: Partial<RunMetrics>,
    diagnostics: readonly string[],
    status: "success" | "fallback",
  ) => void;
  readMetrics: () => RunMetrics;
  readDiagnostics: () => readonly string[];
}>;

/** 隣接するcanonical stageだけを受け渡す解析adapter。 */
export type AnalysisStages = Readonly<{
  inventoryCollected: (prepared: PreparedRun) => Promise<InventoryCollectedRun>;
  collected: (inventory: InventoryCollectedRun) => Promise<CollectedRun<CanonicalCollectedItems>>;
  deterministicallyAnalyzed: (
    collected: CollectedRun<CanonicalCollectedItems>,
  ) => Promise<DeterministicallyAnalyzedRun>;
  genericAiPlanned: (analyzed: DeterministicallyAnalyzedRun) => Promise<GenericAiPlannedRun>;
  genericAiExecuted: (planned: GenericAiPlannedRun) => Promise<GenericAiExecutedRun>;
  genericAiAdopted: (executed: GenericAiExecutedRun) => Promise<GenericAiAdoptedRun>;
  graphReconciled: (adopted: GenericAiAdoptedRun) => Promise<GraphReconciledRun>;
  personalReminderPlanned: (graph: GraphReconciledRun) => Promise<PersonalReminderPlannedRun>;
  personalReminderExecuted: (
    planned: PersonalReminderPlannedRun,
  ) => Promise<PersonalReminderExecutedRun>;
  personalReminderFinalized: (
    executed: PersonalReminderExecutedRun,
  ) => Promise<PersonalReminderFinalizedRun>;
  validated: (finalized: PersonalReminderFinalizedRun) => Promise<PublicationValidatedRun>;
}>;
