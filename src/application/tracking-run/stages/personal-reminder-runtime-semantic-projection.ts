import { serializeCanonicalJson } from "../../../canonical-json/value.js";
import type {
  PersonalReminderAiItemContext,
  PersonalReminderCauseSemanticInput,
} from "../../../codex/personal-reminder-input-contracts.js";
import type {
  PersonalReminderCauseSeed,
  PersonalReminderMissingInput,
} from "../../../domain/personal-reminder-causes.js";
import type { SourceId } from "../../../domain/source-id.js";
import type { Evidence, GraphNodeId } from "../../../domain/types.js";
import { assertNonNullable } from "../../../util/index.js";
import { activityForCause } from "./personal-reminder-runtime-activity.js";
import { compareStrings, evidenceIdentity } from "./personal-reminder-runtime-common.js";
import type {
  PersonalReminderCauseSemanticProjection,
  PersonalReminderRuntimeContext,
  PersonalReminderRuntimeContextItem,
  PersonalReminderRuntimeCurrentSeed,
  PersonalReminderRuntimePlanningIndexes,
  PersonalReminderRuntimeSource,
} from "./personal-reminder-runtime-contracts.js";
import { duplicateOptionsForCause } from "./personal-reminder-runtime-duplicate-options.js";
import {
  selectedPendingRelations,
  selectedRelationEdges,
} from "./personal-reminder-runtime-options.js";
import { waitingOptionsForCause } from "./personal-reminder-runtime-waiting-options.js";
import {
  activeRelationIsEffective,
  optionTargetScopeNodeIds,
} from "./personal-reminder-runtime-relations.js";
import {
  relationContextFromEdge,
  relationSourceProjectionForEdges,
} from "./personal-reminder-runtime-relation-projection.js";
import { createCauseSemanticInput } from "./personal-reminder-runtime-semantic-input.js";

/** 原因入力に利用する項目contextの索引を作る。 */
export function createGlobalItemContextIndex(
  context: PersonalReminderRuntimeContext,
): ReadonlyMap<GraphNodeId, PersonalReminderAiItemContext> {
  const itemContextsByNodeId = new Map<GraphNodeId, PersonalReminderAiItemContext>();
  const addContext = (itemContext: PersonalReminderAiItemContext): void => {
    const previous = itemContextsByNodeId.get(itemContext.nodeId);
    if (
      previous != null &&
      serializeCanonicalJson(previous) !== serializeCanonicalJson(itemContext)
    ) {
      if (previous.type === "external_reference" && itemContext.type !== "external_reference") {
        itemContextsByNodeId.set(itemContext.nodeId, itemContext);
        return;
      }
      if (previous.type !== "external_reference" && itemContext.type === "external_reference") {
        return;
      }
      throw new TypeError(`同じitem node IDに異なるcontextがあります。対象: ${itemContext.nodeId}`);
    }
    itemContextsByNodeId.set(itemContext.nodeId, itemContext);
  };
  for (const item of context.items) {
    addContext(item.itemContext);
    for (const related of item.relatedItemContexts) {
      addContext(related);
    }
    for (const external of item.externalItemContexts) {
      addContext(external);
    }
  }
  return itemContextsByNodeId;
}

/** 原因入力のsourceに対応する根拠記録を集める。 */
export function createCauseSourceEvidence(
  item: PersonalReminderRuntimeContextItem,
  globalSourcesById: ReadonlyMap<SourceId, PersonalReminderRuntimeSource>,
  semanticInput: PersonalReminderCauseSemanticInput,
  currentEvidenceBySourceId: ReadonlyMap<SourceId, readonly Evidence[]>,
  previousEvidenceBySourceId: ReadonlyMap<SourceId, readonly Evidence[]>,
  seed: PersonalReminderCauseSeed,
): readonly Evidence[] {
  const evidenceByIdentity = new Map<string, Evidence>();
  const semanticSourceIds = new Set(semanticInput.sources.map((source) => source.sourceId));
  for (const sourceId of [...new Set(seed.evidenceSourceIds)].sort(compareStrings)) {
    const currentEvidence = currentEvidenceBySourceId.get(sourceId) ?? [];
    const previousEvidence = previousEvidenceBySourceId.get(sourceId) ?? [];
    const seedEvidence = item.seedEvidence.filter((evidence) => evidence.sourceId === sourceId);
    for (const evidence of [...currentEvidence, ...previousEvidence, ...seedEvidence]) {
      evidenceByIdentity.set(evidenceIdentity(evidence), evidence);
    }
    if (
      currentEvidence.length !== 0 ||
      previousEvidence.length !== 0 ||
      seedEvidence.length !== 0
    ) {
      continue;
    }
    if (!globalSourcesById.has(sourceId) && !semanticSourceIds.has(sourceId)) {
      throw new TypeError(
        `個人催促causeのsource evidenceに必要なruntime sourceがありません。item: ${item.item.nodeId} cause: ${seed.causeId} source: ${sourceId}`,
      );
    }
    const evidence: Evidence = Object.freeze({
      sourceId,
      supports: "waiting_on",
      summary: `担当する対応: ${seed.action.summary}`,
    });
    evidenceByIdentity.set(evidenceIdentity(evidence), evidence);
  }
  return Object.freeze(
    [...evidenceByIdentity.values()].sort((left, right) =>
      compareStrings(evidenceIdentity(left), evidenceIdentity(right)),
    ),
  );
}

/** 原因seedから意味入力の投影を作る。 */
export function createCauseSemanticProjection(
  input: Readonly<{
    context: PersonalReminderRuntimeContext;
    item: PersonalReminderRuntimeContextItem;
    globalSourcesById: ReadonlyMap<SourceId, PersonalReminderRuntimeSource>;
    globalCausalSourcesByNodeId: ReadonlyMap<GraphNodeId, readonly PersonalReminderRuntimeSource[]>;
    globalItemContextsByNodeId: ReadonlyMap<GraphNodeId, PersonalReminderAiItemContext>;
    seed: PersonalReminderCauseSeed;
    currentSeed: PersonalReminderRuntimeCurrentSeed;
    currentSeeds: readonly PersonalReminderRuntimeCurrentSeed[];
    planningIndexes: PersonalReminderRuntimePlanningIndexes;
  }>,
): PersonalReminderCauseSemanticProjection {
  const relationEdges = selectedRelationEdges(input.context, input.seed, input.planningIndexes);
  const pendingRelations = selectedPendingRelations(input.context, input.seed);
  const waitingProjection = waitingOptionsForCause(
    input.context,
    input.item,
    input.globalSourcesById,
    input.seed,
    relationEdges,
    input.currentSeed,
    input.planningIndexes,
  );
  const duplicateProjection = duplicateOptionsForCause(
    input.context,
    input.globalSourcesById,
    input.currentSeed,
    input.planningIndexes,
  );
  const duplicateRelationIds = new Set(
    duplicateProjection.options.flatMap((option) => option.relationIds),
  );
  const duplicateRelationEdges = input.context.graph.activeRelations.filter(
    (relation) =>
      duplicateRelationIds.has(relation.id) &&
      activeRelationIsEffective(input.context.graph, relation),
  );
  const relationEdgesForInput = [
    ...new Map(
      [...relationEdges, ...duplicateRelationEdges].map((relation) => [relation.id, relation]),
    ).values(),
  ].sort((left, right) => compareStrings(left.id, right.id));
  const relations = relationEdgesForInput.map(relationContextFromEdge);
  const relationSources = relationSourceProjectionForEdges(
    relationEdgesForInput,
    input.globalSourcesById,
  );
  const optionSources = [...waitingProjection.sources, ...duplicateProjection.sources];
  const targetScopeNodeIds = new Set<GraphNodeId>();
  for (const option of [...waitingProjection.options, ...duplicateProjection.options]) {
    for (const nodeId of optionTargetScopeNodeIds(option)) {
      targetScopeNodeIds.add(nodeId);
    }
  }
  const additionalItemContexts = [...targetScopeNodeIds].sort(compareStrings).map((nodeId) => {
    const itemContext = input.globalItemContextsByNodeId.get(nodeId);
    assertNonNullable(itemContext, `target scopeのitem contextがありません。対象: ${nodeId}`);
    return itemContext;
  });
  const activityProjection = activityForCause(
    input.item,
    input.seed,
    input.currentSeed.previousCause,
    input.context.evaluatedAt,
    input.currentSeeds,
  );
  const relationMissing: readonly PersonalReminderMissingInput[] =
    relationSources.missingSourceIds.length === 0 ? [] : ["relation_evidence"];
  const additionalMissing: readonly PersonalReminderMissingInput[] = [
    ...waitingProjection.missing,
    ...activityProjection.missing,
    ...relationMissing,
  ];
  const semanticInput = createCauseSemanticInput(
    input.item,
    input.globalSourcesById,
    input.globalCausalSourcesByNodeId,
    input.globalItemContextsByNodeId,
    input.seed,
    relations,
    pendingRelations,
    waitingProjection.options,
    duplicateProjection.options,
    relationSources.sources,
    optionSources,
    additionalItemContexts,
    additionalMissing,
  );
  return Object.freeze({
    currentSeed: input.currentSeed,
    relationEdges,
    pendingRelations,
    waitingProjection,
    duplicateProjection,
    relations,
    relationSources,
    optionSources,
    additionalItemContexts,
    activityProjection,
    semanticInput,
  });
}
