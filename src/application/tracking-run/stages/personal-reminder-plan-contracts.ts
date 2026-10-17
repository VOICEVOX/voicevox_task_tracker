import type { AiAnalysisElementInputFingerprint } from "../../../domain/ai-analysis-elements.js";
import type { AiAnalysisPriority } from "../../../codex/analysis-selection.js";
import type {
  PersonalReminderCauseId,
  PersonalReminderCausePlanning,
  PersonalReminderDeferredReason,
} from "../../../domain/personal-reminder-causes.js";
import type { GitHubNodeId } from "../../../domain/types.js";
import type { PreviousPersonalReminderAiCacheEntry } from "../contracts/previous-state.js";
import type {
  PersonalReminderAiInput,
  PersonalReminderCauseSemanticInput,
  PreparedPersonalReminderAiBatch,
} from "../../../codex/personal-reminder-input-contracts.js";
import type { AiBudgetReservation } from "../contracts/ai-budget-ledger.js";
import type {
  PersonalReminderCauseRuntimePlan,
  PersonalReminderCauseRuntimePlanEntry,
  PersonalReminderRuntimeActivity,
} from "./personal-reminder-runtime-contracts.js";

type CanonicalActivity = Omit<PersonalReminderRuntimeActivity, "actionabilityStartByAction"> &
  Readonly<{
    actionabilityStartByAction: readonly (readonly [
      Parameters<PersonalReminderRuntimeActivity["actionabilityStartByAction"]["get"]>[0],
      ReturnType<PersonalReminderRuntimeActivity["actionabilityStartByAction"]["get"]>,
    ])[];
  }>;

/** 個人催促の原因入力と前回連続性を配列だけで保持する。 */
export type CanonicalPersonalReminderCausePlan = Readonly<
  Omit<
    PersonalReminderCauseRuntimePlan,
    | "entries"
    | "preservedEvidenceByNodeId"
    | "incompleteInputNodeIds"
    | "deferredStructuralEndNodeIds"
    | "unrecordedDependencyNodeIds"
    | "causeSetAiDependencyByNodeId"
    | "causeSetSubjectChangesByNodeId"
  > & {
    entries: readonly (Omit<PersonalReminderCauseRuntimePlanEntry, "activity"> &
      Readonly<{ activity: CanonicalActivity }>)[];
    preservedEvidenceByNodeId: readonly (readonly [
      GitHubNodeId,
      PersonalReminderCauseRuntimePlan["preservedEvidenceByNodeId"] extends ReadonlyMap<
        GitHubNodeId,
        infer Value
      >
        ? Value
        : never,
    ])[];
    incompleteInputNodeIds: readonly GitHubNodeId[];
    deferredStructuralEndNodeIds: readonly GitHubNodeId[];
    unrecordedDependencyNodeIds: readonly GitHubNodeId[];
    causeSetAiDependencyByNodeId: readonly (readonly [
      GitHubNodeId,
      PersonalReminderCauseRuntimePlan["causeSetAiDependencyByNodeId"] extends ReadonlyMap<
        GitHubNodeId,
        infer Value
      >
        ? Value
        : never,
    ])[];
    causeSetSubjectChangesByNodeId: readonly (readonly [
      GitHubNodeId,
      PersonalReminderCauseRuntimePlan["causeSetSubjectChangesByNodeId"] extends ReadonlyMap<
        GitHubNodeId,
        infer Value
      >
        ? Value
        : never,
    ])[];
  }
>;

/** 原因の実行必要性と再利用または延期の確定結果。 */
export type PersonalReminderCauseDecision = Readonly<{
  causeId: PersonalReminderCauseId;
  itemNodeId: GitHubNodeId;
  exactInput: PersonalReminderCauseSemanticInput;
  fingerprint: AiAnalysisElementInputFingerprint;
}> &
  (
    | Readonly<{ choice: "deterministic"; reason: "fixed_assessment" }>
    | Readonly<{ choice: "snapshot_reuse"; reason: "current_completed_assessment" }>
    | Readonly<{
        choice: "cache_hit";
        reason: "current_input_cached";
        entry: PreviousPersonalReminderAiCacheEntry;
      }>
    | Readonly<{
        choice: "execute";
        reason: "cache_miss";
        batchId: string;
        priority: AiAnalysisPriority;
      }>
    | Readonly<{
        choice: "deferred";
        reason: PersonalReminderDeferredReason | "ai_disabled" | "forced_generic_target";
      }>
  );

/** 同じ項目の原因に送る確定済みAI transportと共有予算予約。 */
export type PersonalReminderPlannedBatch = Readonly<{
  id: string;
  itemNodeId: GitHubNodeId;
  causeIds: readonly PersonalReminderCauseId[];
  input: PersonalReminderAiInput;
  normalizedInput: string;
  inputCharacters: number;
  batchInputFingerprint: AiAnalysisElementInputFingerprint;
  refs: Readonly<{
    items: MapEntries<PreparedPersonalReminderAiBatch["refs"]["items"]>;
    relations: MapEntries<PreparedPersonalReminderAiBatch["refs"]["relations"]>;
    sources: MapEntries<PreparedPersonalReminderAiBatch["refs"]["sources"]>;
  }>;
  reservation: AiBudgetReservation;
}>;

type MapEntries<MapType> =
  MapType extends ReadonlyMap<infer Key, infer Value> ? readonly (readonly [Key, Value])[] : never;

/** 項目の原因列挙が完了したか、保持が必要かを表す。 */
export type PersonalReminderItemPlanning = Readonly<{
  itemNodeId: GitHubNodeId;
  causeIds: readonly PersonalReminderCauseId[];
}> &
  (
    | Readonly<{
        status: "completed";
        planning: Extract<PersonalReminderCausePlanning, { status: "completed" }>;
      }>
    | Readonly<{
        status: "excluded";
        planning: Extract<PersonalReminderCausePlanning, { status: "excluded" }>;
      }>
    | Readonly<{
        status: "pending";
        reasons: readonly (
          | "input_incomplete"
          | "deferred_structural_end"
          | "unrecorded_dependency"
          | "continuity_conflict"
          | "unavailable_consumer"
          | "retained_without_evaluation"
        )[];
        planning: Extract<PersonalReminderCausePlanning, { status: "pending" }>;
      }>
  );

/** 原因集合、厳密入力、再利用と予算割当の唯一の計画。 */
export type PersonalReminderPlan = Readonly<{
  causePlan: CanonicalPersonalReminderCausePlan;
  items: readonly PersonalReminderItemPlanning[];
  causes: readonly PersonalReminderCauseDecision[];
  batches: readonly PersonalReminderPlannedBatch[];
  preflightReservation?: AiBudgetReservation;
}>;

function sortedEntries<Key extends string, Value>(
  values: ReadonlyMap<Key, Value>,
): readonly (readonly [Key, Value])[] {
  return Object.freeze(
    [...values.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]): readonly [Key, Value] => Object.freeze([key, value])),
  );
}

/** pure plannerの索引を不変の配列へ固定する。 */
export function canonicalPersonalReminderCausePlan(
  plan: PersonalReminderCauseRuntimePlan,
): CanonicalPersonalReminderCausePlan {
  return Object.freeze({
    entries: Object.freeze(
      plan.entries.map((entry) =>
        Object.freeze({
          ...entry,
          activity: Object.freeze({
            ...entry.activity,
            actionabilityStartByAction: sortedEntries(entry.activity.actionabilityStartByAction),
          }),
        }),
      ),
    ),
    applicableItemNodeIds: plan.applicableItemNodeIds,
    preservedCauses: plan.preservedCauses,
    preservedEvidenceByNodeId: sortedEntries(plan.preservedEvidenceByNodeId),
    continuityConflicts: plan.continuityConflicts,
    endedCauseIds: plan.endedCauseIds,
    pendingCauseIds: plan.pendingCauseIds,
    incompleteInputNodeIds: Object.freeze([...plan.incompleteInputNodeIds].sort()),
    deferredStructuralEndNodeIds: Object.freeze([...plan.deferredStructuralEndNodeIds].sort()),
    unrecordedDependencyNodeIds: Object.freeze([...plan.unrecordedDependencyNodeIds].sort()),
    causeSetAiDependencyByNodeId: sortedEntries(plan.causeSetAiDependencyByNodeId),
    causeSetSubjectChangesByNodeId: sortedEntries(plan.causeSetSubjectChangesByNodeId),
  });
}
