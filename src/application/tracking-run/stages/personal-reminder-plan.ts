import {
  PERSONAL_REMINDER_CAUSE_PLANNING_VERSION,
  type PersonalReminderCauseId,
} from "../../../domain/personal-reminder-causes.js";
import type { GitHubNodeId } from "../../../domain/types.js";
import { assertNonNullable } from "../../../util/index.js";
import { createPersonalReminderPlannedStageProof } from "../contracts/proofs.js";
import type { StageState } from "../contracts/run-core.js";
import type { ContentDigestPort } from "../contracts/content-digest-port.js";
import type { GraphReconciledRun } from "./graph-reconciliation.js";
import { planPersonalReminderAi } from "./personal-reminder-plan-ai.js";
import {
  canonicalPersonalReminderCausePlan,
  type PersonalReminderItemPlanning,
  type PersonalReminderPlan,
} from "./personal-reminder-plan-contracts.js";
import { createPersonalReminderPlanningContext } from "./personal-reminder-planning-input.js";
import { planPersonalReminderCauses } from "./personal-reminder-runtime-cause-plan.js";
import type { PersonalReminderCauseRuntimePlan } from "./personal-reminder-runtime-contracts.js";
import { reconfirmPreviousPersonalReminderClocks } from "./personal-reminder-clock-reconfirmation.js";

/** 個人催促の原因集合、厳密入力、再利用と実行順が確定したrun。 */
export type PersonalReminderPlannedRun = StageState<
  "personal_reminder_planned",
  Readonly<{
    approvedRepositories: GraphReconciledRun["data"]["approvedRepositories"];
    allowlistDigest: GraphReconciledRun["data"]["allowlistDigest"];
    sourceCatalog: GraphReconciledRun["data"]["sourceCatalog"];
    sourceRecords: Pick<
      GraphReconciledRun["data"]["collection"],
      | "evaluatedAt"
      | "enumeratedItems"
      | "details"
      | "observedItems"
      | "staleItems"
      | "collectionRepositories"
    > &
      Readonly<{
        relationCandidates: readonly GraphReconciledRun["data"]["facts"]["relations"][number]["candidate"][];
      }>;
    aiItems: GraphReconciledRun["data"]["aiItems"];
    finalItems: GraphReconciledRun["data"]["finalItems"];
    graph: GraphReconciledRun["data"]["graph"];
    finalGraphProjection: GraphReconciledRun["data"]["finalGraphProjection"];
    snapshotProjection: GraphReconciledRun["data"]["snapshotProjection"];
    candidateDependencyContexts: GraphReconciledRun["data"]["context"]["candidateRelations"];
    plan: PersonalReminderPlan;
  }>
>;

function itemPlanning(
  run: GraphReconciledRun,
  plan: PersonalReminderCauseRuntimePlan,
): readonly PersonalReminderItemPlanning[] {
  const entryCauseIdsByNodeId = new Map<GitHubNodeId, PersonalReminderCauseId[]>();
  for (const entry of plan.entries) {
    const causeIds = entryCauseIdsByNodeId.get(entry.seed.itemNodeId) ?? [];
    causeIds.push(entry.seed.causeId);
    entryCauseIdsByNodeId.set(entry.seed.itemNodeId, causeIds);
  }
  const applicable = new Set(plan.applicableItemNodeIds);
  const unavailable = new Set(run.data.facts.unavailableConsumerNodeIds);
  const conflicts = new Set(plan.continuityConflicts.map((conflict) => conflict.itemNodeId));
  const previousByNodeId = new Map(
    run.core.personalReminderInput.previousItems.map((item) => [item.nodeId, item]),
  );
  const items: PersonalReminderItemPlanning[] = [];
  for (const item of run.data.finalItems) {
    const causeIds = Object.freeze([...(entryCauseIdsByNodeId.get(item.nodeId) ?? [])].sort());
    const base = Object.freeze({ itemNodeId: item.nodeId, causeIds });
    if (!applicable.has(item.nodeId)) {
      const previous = previousByNodeId.get(item.nodeId);
      assertNonNullable(previous, `個人催促計画外の前回項目がありません。対象: ${item.nodeId}`);
      const retainedCauseIds = Object.freeze(
        previous.personalReminderCauses.map((cause) => cause.causeId).sort(),
      );
      if (conflicts.has(item.nodeId)) {
        items.push(
          Object.freeze({
            itemNodeId: item.nodeId,
            causeIds: retainedCauseIds,
            status: "pending",
            reasons: Object.freeze(["continuity_conflict"] satisfies Extract<
              PersonalReminderItemPlanning,
              { status: "pending" }
            >["reasons"]),
            planning: Object.freeze({
              status: "pending",
              planningVersion: PERSONAL_REMINDER_CAUSE_PLANNING_VERSION,
            }),
          }),
        );
      } else if (item.state !== "open" && retainedCauseIds.length === 0) {
        items.push(
          Object.freeze({
            itemNodeId: item.nodeId,
            causeIds: retainedCauseIds,
            status: "excluded",
            planning: Object.freeze({
              status: "excluded",
              planningVersion: PERSONAL_REMINDER_CAUSE_PLANNING_VERSION,
              reason: "terminal_without_cause",
            }),
          }),
        );
      } else {
        items.push(
          Object.freeze({
            itemNodeId: item.nodeId,
            causeIds: retainedCauseIds,
            status: "pending",
            reasons: Object.freeze([
              unavailable.has(item.nodeId) ? "unavailable_consumer" : "retained_without_evaluation",
            ] satisfies Extract<PersonalReminderItemPlanning, { status: "pending" }>["reasons"]),
            planning: Object.freeze({
              status: "pending",
              planningVersion: PERSONAL_REMINDER_CAUSE_PLANNING_VERSION,
            }),
          }),
        );
      }
      continue;
    }
    const reasons: Extract<
      PersonalReminderItemPlanning,
      { status: "pending" }
    >["reasons"][number][] = [];
    if (plan.incompleteInputNodeIds.has(item.nodeId)) reasons.push("input_incomplete");
    if (plan.deferredStructuralEndNodeIds.has(item.nodeId)) reasons.push("deferred_structural_end");
    if (plan.unrecordedDependencyNodeIds.has(item.nodeId)) reasons.push("unrecorded_dependency");
    if (reasons.length !== 0) {
      items.push(
        Object.freeze({
          ...base,
          status: "pending",
          reasons: Object.freeze(reasons),
          planning: Object.freeze({
            status: "pending",
            planningVersion: PERSONAL_REMINDER_CAUSE_PLANNING_VERSION,
          }),
        }),
      );
      continue;
    }
    if (causeIds.length === 0 && item.state !== "open") {
      items.push(
        Object.freeze({
          ...base,
          status: "excluded",
          planning: Object.freeze({
            status: "excluded",
            planningVersion: PERSONAL_REMINDER_CAUSE_PLANNING_VERSION,
            reason: "terminal_without_cause",
          }),
        }),
      );
      continue;
    }
    const causeSetAiDependency = plan.causeSetAiDependencyByNodeId.get(item.nodeId);
    const causeSetSubjectChanges = plan.causeSetSubjectChangesByNodeId.get(item.nodeId);
    assertNonNullable(
      causeSetAiDependency,
      `個人催促原因集合のAI依存がありません。対象: ${item.nodeId}`,
    );
    assertNonNullable(
      causeSetSubjectChanges,
      `個人催促原因集合の主体変化がありません。対象: ${item.nodeId}`,
    );
    items.push(
      Object.freeze({
        ...base,
        status: "completed",
        planning: Object.freeze({
          status: "completed",
          planningVersion: PERSONAL_REMINDER_CAUSE_PLANNING_VERSION,
          observedAt: run.data.collection.evaluatedAt,
          causeSetAiDependency,
          causeSetSubjectChanges,
        }),
      }),
    );
  }
  return Object.freeze(items);
}

/** 最終graphだけから個人催促の全原因と評価入力を確定する。 */
export function planPersonalReminders(
  run: GraphReconciledRun,
  forcedGenericTarget: boolean,
  digest: ContentDigestPort,
): PersonalReminderPlannedRun {
  const currentRun = reconfirmPreviousPersonalReminderClocks(run);
  const planningInput = createPersonalReminderPlanningContext(currentRun);
  const causePlan = planPersonalReminderCauses(planningInput.context);
  const aiPlanning = planPersonalReminderAi(
    causePlan.entries,
    currentRun,
    forcedGenericTarget,
    digest,
  );
  const plan: PersonalReminderPlan = Object.freeze({
    causePlan: canonicalPersonalReminderCausePlan(causePlan),
    items: itemPlanning(currentRun, causePlan),
    causes: aiPlanning.causes,
    batches: aiPlanning.batches,
    ...(aiPlanning.preflightReservation == null
      ? {}
      : { preflightReservation: aiPlanning.preflightReservation }),
  });
  return Object.freeze({
    stage: "personal_reminder_planned",
    core: Object.freeze({ ...currentRun.core, aiBudget: aiPlanning.ledger }),
    data: Object.freeze({
      approvedRepositories: currentRun.data.approvedRepositories,
      allowlistDigest: currentRun.data.allowlistDigest,
      sourceCatalog: currentRun.data.sourceCatalog,
      sourceRecords: Object.freeze({
        evaluatedAt: currentRun.data.collection.evaluatedAt,
        enumeratedItems: currentRun.data.collection.enumeratedItems,
        details: currentRun.data.collection.details,
        observedItems: currentRun.data.collection.observedItems,
        staleItems: currentRun.data.collection.staleItems,
        collectionRepositories: currentRun.data.collection.collectionRepositories,
        relationCandidates: Object.freeze(
          currentRun.data.facts.relations.map((fact) => fact.candidate),
        ),
      }),
      aiItems: currentRun.data.aiItems,
      finalItems: currentRun.data.finalItems,
      graph: currentRun.data.graph,
      finalGraphProjection: currentRun.data.finalGraphProjection,
      snapshotProjection: currentRun.data.snapshotProjection,
      candidateDependencyContexts: currentRun.data.context.candidateRelations,
      plan,
    }),
    proof: createPersonalReminderPlannedStageProof(),
  });
}
