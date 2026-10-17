import type {
  PersonalReminderCauseSemanticInput,
  PersonalReminderPendingRelation,
} from "../../../codex/personal-reminder-input-contracts.js";
import type {
  PersonalReminderCause,
  PersonalReminderCauseAssessment,
  PersonalReminderCauseId,
  PersonalReminderCauseSeed,
} from "../../../domain/personal-reminder-causes.js";
import type { PreviousPersonalReminderCauses } from "../../../domain/personal-reminder-planning.js";
import { relationAffectsPersonalReminderCause } from "../../../domain/personal-reminder-planning.js";
import { assertNonNullable } from "../../../util/index.js";
import { compareStrings } from "./personal-reminder-runtime-common.js";
import type {
  PersonalReminderCauseNewDraftIdCollision,
  PersonalReminderRuntimeActiveRelation,
  PersonalReminderRuntimeContext,
  PersonalReminderRuntimeContextItem,
  PersonalReminderRuntimeCurrentSeed,
  PersonalReminderRuntimePlanningIndexes,
} from "./personal-reminder-runtime-contracts.js";
import { negativeWorkCandidateEndpoints } from "./personal-reminder-runtime-negative-candidates.js";
import { pendingRelationContext } from "./personal-reminder-runtime-relation-projection.js";
import {
  candidateAffectsCause,
  endpointStateAllowsRelation,
  relationEndpointsAllowPending,
  relationsIncidentToScope,
  scopeNodeIdsForSeed,
} from "./personal-reminder-runtime-relations.js";

/** 前回原因をIDで引ける索引にする。 */
export function previousCauseById(
  previous: PreviousPersonalReminderCauses,
): ReadonlyMap<PersonalReminderCauseId, PersonalReminderCause> {
  const causes = new Map<PersonalReminderCauseId, PersonalReminderCause>();
  for (const cause of previous.causes) {
    if (causes.has(cause.causeId)) {
      throw new TypeError(`前回cause IDが重複しています。対象: ${cause.causeId}`);
    }
    causes.set(cause.causeId, cause);
  }
  return causes;
}

/** 新規候補ID競合の前回原因を検証する。 */
export function assertNewDraftIdCollisionPreviousCauses(
  item: PersonalReminderRuntimeContextItem,
  conflict: PersonalReminderCauseNewDraftIdCollision,
): void {
  if (conflict.itemNodeId !== item.item.nodeId) {
    throw new TypeError(`new_draft ID衝突のitem node IDが一致しません。対象: ${item.item.nodeId}`);
  }
  for (const causeId of conflict.previousCauseIds) {
    const previousCause = item.previous.causes.find((cause) => cause.causeId === causeId);
    assertNonNullable(
      previousCause,
      `new_draft ID衝突のprevious causeがありません。対象: ${causeId}`,
    );
    if (previousCause.itemNodeId !== item.item.nodeId) {
      throw new TypeError(`new_draft ID衝突のprevious cause所有者が一致しません。対象: ${causeId}`);
    }
  }
}

/** 原因に必要な確定relationを選ぶ。 */
export function selectedRelationEdges(
  context: PersonalReminderRuntimeContext,
  seed: PersonalReminderCauseSeed,
  indexes: PersonalReminderRuntimePlanningIndexes,
): readonly PersonalReminderRuntimeActiveRelation[] {
  const relations = relationsIncidentToScope(indexes, scopeNodeIdsForSeed(seed));
  return Object.freeze(
    relations
      .filter((relation) => relationAffectsPersonalReminderCause(relation, seed))
      .filter(
        (relation) =>
          endpointStateAllowsRelation(context.graph, relation.fromNodeId) &&
          endpointStateAllowsRelation(context.graph, relation.toNodeId),
      )
      .sort((left, right) => compareStrings(left.id, right.id)),
  );
}

/** 原因に影響する未確定relationを選ぶ。 */
export function selectedPendingRelations(
  context: PersonalReminderRuntimeContext,
  seed: PersonalReminderCauseSeed,
): readonly PersonalReminderPendingRelation[] {
  const candidateById = new Map(
    context.graph.candidateRelations.map((candidate) => [candidate.candidateId, candidate]),
  );
  const pending: PersonalReminderPendingRelation[] = [];
  for (const resolution of context.graph.candidateResolutions) {
    if (resolution.status !== "pending") {
      continue;
    }
    const candidate = candidateById.get(resolution.candidateId);
    assertNonNullable(
      candidate,
      `pending relation candidateがありません。対象: ${resolution.candidateId}`,
    );
    if (
      candidateAffectsCause(candidate, seed) &&
      negativeWorkCandidateEndpoints(context, candidate) == null &&
      relationEndpointsAllowPending(context.graph, candidate.endpointNodeIds)
    ) {
      pending.push(pendingRelationContext(candidate, resolution));
    }
  }
  return Object.freeze(
    pending.sort((left, right) => compareStrings(left.candidateId, right.candidateId)),
  );
}

/** 決定論的に確定できる原因評価を作る。 */
export function deterministicAssessment(
  item: PersonalReminderRuntimeContextItem,
  seed: PersonalReminderCauseSeed,
  semanticInput: PersonalReminderCauseSemanticInput,
  origin: PersonalReminderRuntimeCurrentSeed["origin"],
): PersonalReminderCauseAssessment | undefined {
  if (
    origin !== "current_draft" ||
    seed.responsibility.authority !== "fixed" ||
    semanticInput.relations.length !== 0 ||
    semanticInput.pendingRelations.length !== 0 ||
    semanticInput.waitingOptions.length !== 0 ||
    semanticInput.duplicateOptions.length !== 0 ||
    semanticInput.completeness.status !== "complete" ||
    item.localDecision.aiAnalysisElementNecessities.status !== "not_required" ||
    item.localDecision.aiAnalysisElementNecessities.waitingOn !== "not_required" ||
    item.localDecision.aiAnalysisElementNecessities.nextAction !== "not_required"
  ) {
    return undefined;
  }
  const sourceIds = seed.evidenceSourceIds.filter((sourceId) =>
    semanticInput.sources.some((source) => source.sourceId === sourceId),
  );
  return {
    verdict: "actionable",
    references: {
      nodeIds: [seed.itemNodeId],
      relationIds: [],
      sourceIds,
      reasonSummary: "決定論的な責務と実行可能性が確認されています",
    },
    confidence: 1,
  };
}
