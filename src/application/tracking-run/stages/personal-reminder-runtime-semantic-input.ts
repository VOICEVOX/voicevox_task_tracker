import type {
  PersonalReminderAiItemContext,
  PersonalReminderAiRelationContext,
  PersonalReminderCauseSemanticInput,
  PersonalReminderDuplicateOption,
  PersonalReminderEvidenceRole,
  PersonalReminderPendingRelation,
  PersonalReminderWaitingOption,
} from "../../../codex/personal-reminder-input-contracts.js";
import { createPersonalReminderCauseSemanticInput } from "../../../codex/personal-reminder-input-core.js";
import type {
  PersonalReminderCauseSeed,
  PersonalReminderMissingInput,
} from "../../../domain/personal-reminder-causes.js";
import type { SourceId } from "../../../domain/source-id.js";
import type { GraphNodeId } from "../../../domain/types.js";
import { assertNonNullable } from "../../../util/index.js";
import { compareSourceIds, compareStrings } from "./personal-reminder-runtime-common.js";
import { addRuntimeSource } from "./personal-reminder-runtime-source-projection.js";
import type {
  PersonalReminderRuntimeContextItem,
  PersonalReminderRuntimeSource,
} from "./personal-reminder-runtime-contracts.js";
import {
  completenessForCause,
  sourceIdsForPendingRelations,
  sourceIdsForRelationContexts,
} from "./personal-reminder-runtime-relation-projection.js";
import {
  optionTargetScopeNodeIds,
  seedScopeNodeIds,
} from "./personal-reminder-runtime-relations.js";

/** 原因の対象範囲と根拠から厳密な意味入力を作る。 */
export function createCauseSemanticInput(
  item: PersonalReminderRuntimeContextItem,
  globalSourcesById: ReadonlyMap<SourceId, PersonalReminderRuntimeSource>,
  globalCausalSourcesByNodeId: ReadonlyMap<GraphNodeId, readonly PersonalReminderRuntimeSource[]>,
  globalItemContextsByNodeId: ReadonlyMap<GraphNodeId, PersonalReminderAiItemContext>,
  seed: PersonalReminderCauseSeed,
  relationContexts: readonly PersonalReminderAiRelationContext[],
  pendingRelations: readonly PersonalReminderPendingRelation[],
  waitingOptions: readonly PersonalReminderWaitingOption[],
  duplicateOptions: readonly PersonalReminderDuplicateOption[],
  relationSources: readonly PersonalReminderRuntimeSource[],
  optionSources: readonly PersonalReminderRuntimeSource[],
  additionalItemContexts: readonly PersonalReminderAiItemContext[],
  additionalMissing: readonly PersonalReminderMissingInput[],
): PersonalReminderCauseSemanticInput {
  const seedScope = seedScopeNodeIds(seed);
  const itemContextNodeIds = new Set(seedScope);
  for (const relation of relationContexts) {
    itemContextNodeIds.add(relation.fromNodeId);
    itemContextNodeIds.add(relation.toNodeId);
  }
  for (const relation of pendingRelations) {
    const [firstEndpoint, secondEndpoint] = relation.endpointNodeIds;
    itemContextNodeIds.add(firstEndpoint);
    itemContextNodeIds.add(secondEndpoint);
  }
  for (const option of [...waitingOptions, ...duplicateOptions]) {
    for (const nodeId of optionTargetScopeNodeIds(option)) {
      itemContextNodeIds.add(nodeId);
    }
  }
  for (const context of additionalItemContexts) {
    itemContextNodeIds.add(context.nodeId);
  }
  const seedSourceIds = new Set(seed.evidenceSourceIds);
  const nonSeedRequiredSourceIds = new Set<SourceId>([
    ...sourceIdsForRelationContexts(relationContexts),
    ...sourceIdsForPendingRelations(pendingRelations),
    ...waitingOptions.flatMap((option) => option.evidenceSourceIds),
    ...duplicateOptions.flatMap((option) => option.evidenceSourceIds),
  ]);
  const relationEvidenceSourceIds = new Set<SourceId>([
    ...sourceIdsForRelationContexts(relationContexts),
    ...sourceIdsForPendingRelations(pendingRelations),
  ]);
  const requiredSourceIds = new Set<SourceId>([...seedSourceIds, ...nonSeedRequiredSourceIds]);
  const allSources = new Map<SourceId, PersonalReminderRuntimeSource>();
  for (const source of item.sources) {
    addRuntimeSource(allSources, source);
  }
  for (const source of relationSources) {
    if (!allSources.has(source.source.sourceId)) {
      addRuntimeSource(allSources, source);
    }
  }
  for (const source of optionSources) {
    if (!allSources.has(source.source.sourceId)) {
      addRuntimeSource(allSources, source);
    }
  }
  for (const sourceId of requiredSourceIds) {
    const source = globalSourcesById.get(sourceId);
    if (source != null) {
      addRuntimeSource(allSources, source);
    }
  }
  const requiredSourceOwnerNodeIds = new Set<GraphNodeId>();
  for (const sourceId of requiredSourceIds) {
    const source = globalSourcesById.get(sourceId);
    if (source != null) {
      requiredSourceOwnerNodeIds.add(source.source.itemNodeId);
      itemContextNodeIds.add(source.source.itemNodeId);
    }
  }
  const availableContextNodeIds = new Set(
    [
      item.itemContext,
      ...item.relatedItemContexts,
      ...item.externalItemContexts,
      ...additionalItemContexts,
    ].map((context) => context.nodeId),
  );
  for (const nodeId of requiredSourceOwnerNodeIds) {
    if (globalItemContextsByNodeId.has(nodeId)) {
      availableContextNodeIds.add(nodeId);
    }
  }
  for (const nodeId of itemContextNodeIds) {
    if (!availableContextNodeIds.has(nodeId)) {
      continue;
    }
    for (const source of globalCausalSourcesByNodeId.get(nodeId) ?? []) {
      addRuntimeSource(allSources, source);
    }
  }
  const sourceById = allSources;
  for (const sourceId of seedSourceIds) {
    const source = sourceById.get(sourceId);
    if (
      source != null &&
      (source.source.kind === "push" || source.source.kind === "commit_added") &&
      !source.causalPush &&
      !nonSeedRequiredSourceIds.has(sourceId)
    ) {
      requiredSourceIds.delete(sourceId);
    }
  }
  const missingSeedSourceIds = new Set<SourceId>();
  const missingRelationEvidenceSourceIds = new Set<SourceId>();
  const sources = [...allSources.values()]
    .filter((entry) => {
      if (
        requiredSourceIds.has(entry.source.sourceId) ||
        (entry.causalPush &&
          itemContextNodeIds.has(entry.source.itemNodeId) &&
          availableContextNodeIds.has(entry.source.itemNodeId))
      ) {
        return true;
      }
      if (!availableContextNodeIds.has(entry.source.itemNodeId)) {
        return false;
      }
      if (
        entry.source.kind === "push" ||
        entry.source.kind === "commit_added" ||
        entry.source.kind === "check_run" ||
        entry.source.kind === "commit_status"
      ) {
        return false;
      }
      return seedScope.has(entry.source.itemNodeId);
    })
    .map((entry) => entry.source);
  for (const sourceId of requiredSourceIds) {
    if (!sourceById.has(sourceId)) {
      if (relationEvidenceSourceIds.has(sourceId)) {
        missingRelationEvidenceSourceIds.add(sourceId);
        continue;
      }
      if (seedSourceIds.has(sourceId) && !nonSeedRequiredSourceIds.has(sourceId)) {
        missingSeedSourceIds.add(sourceId);
        continue;
      }
      throw new TypeError(`causeに必要なsourceがありません。対象: ${sourceId}`);
    }
  }
  const sourceIds = new Set(sources.map((source) => source.sourceId));
  for (const sourceId of requiredSourceIds) {
    if (!sourceIds.has(sourceId)) {
      if (relationEvidenceSourceIds.has(sourceId)) {
        missingRelationEvidenceSourceIds.add(sourceId);
        continue;
      }
      if (missingSeedSourceIds.has(sourceId)) {
        continue;
      }
      throw new TypeError(`causeに必要なsourceが公開入力へ投影されていません。対象: ${sourceId}`);
    }
  }
  const evidenceScopesBySourceId = new Map<SourceId, Set<PersonalReminderEvidenceRole>>();
  for (const scope of item.evidenceScopes) {
    if (!sourceIds.has(scope.sourceId)) {
      continue;
    }
    evidenceScopesBySourceId.set(scope.sourceId, new Set(scope.roles));
  }
  for (const source of relationSources) {
    if (!sourceIds.has(source.source.sourceId)) {
      continue;
    }
    const roles = evidenceScopesBySourceId.get(source.source.sourceId) ?? new Set();
    for (const role of source.roles) {
      roles.add(role);
    }
    evidenceScopesBySourceId.set(source.source.sourceId, roles);
  }
  for (const relation of pendingRelations) {
    for (const sourceId of relation.evidenceSourceIds) {
      const source = sourceById.get(sourceId);
      if (source == null) {
        missingRelationEvidenceSourceIds.add(sourceId);
        continue;
      }
      if (!sourceIds.has(sourceId)) {
        continue;
      }
      const roles = evidenceScopesBySourceId.get(sourceId) ?? new Set();
      roles.add("relation");
      for (const role of source.roles) {
        roles.add(role);
      }
      evidenceScopesBySourceId.set(sourceId, roles);
    }
  }
  for (const source of optionSources) {
    if (!sourceIds.has(source.source.sourceId)) {
      continue;
    }
    const roles = evidenceScopesBySourceId.get(source.source.sourceId) ?? new Set();
    for (const role of source.roles) {
      roles.add(role);
    }
    evidenceScopesBySourceId.set(source.source.sourceId, roles);
  }
  const evidenceScopes = [...evidenceScopesBySourceId.entries()]
    .sort(([left], [right]) => compareSourceIds(left, right))
    .map(([sourceId, roles]) => {
      const sortedRoles = [...roles].sort(compareStrings);
      const firstRole = sortedRoles[0];
      assertNonNullable(firstRole, `source roleがありません。対象: ${sourceId}`);
      return {
        sourceId,
        roles: [firstRole, ...sortedRoles.slice(1)],
      };
    });
  if (sources.length === 0 || evidenceScopes.length === 0) {
    throw new TypeError(`causeのsource role投影がありません。対象: ${seed.causeId}`);
  }
  const itemContextsByNodeId = new Map(
    [
      item.itemContext,
      ...item.relatedItemContexts,
      ...item.externalItemContexts,
      ...additionalItemContexts,
    ]
      .filter((value) => itemContextNodeIds.has(value.nodeId))
      .map((value) => [value.nodeId, value]),
  );
  for (const nodeId of requiredSourceOwnerNodeIds) {
    const itemContext = globalItemContextsByNodeId.get(nodeId);
    if (itemContext != null) {
      itemContextsByNodeId.set(nodeId, itemContext);
    }
  }
  const items = [...itemContextsByNodeId.values()];
  const missing: PersonalReminderMissingInput[] = [...additionalMissing];
  const itemContextIds = new Set(items.map((value) => value.nodeId));
  const externalContextNodeIds = new Set(
    item.externalItemContexts.map((context) => context.nodeId),
  );
  const addMissing = (value: PersonalReminderMissingInput): void => {
    if (!missing.includes(value)) {
      missing.push(value);
    }
  };
  for (const nodeId of requiredSourceOwnerNodeIds) {
    if (!itemContextIds.has(nodeId)) {
      addMissing("related_item");
    }
  }
  if (missingRelationEvidenceSourceIds.size !== 0) {
    addMissing("relation_evidence");
  }
  for (const relation of relationContexts) {
    const missingEndpoint = [relation.fromNodeId, relation.toNodeId].find(
      (nodeId) => !itemContextIds.has(nodeId),
    );
    if (missingEndpoint != null) {
      addMissing("related_item");
      const endpointState = item.endpointStates.get(missingEndpoint);
      if (endpointState == null) {
        throw new TypeError(`relation endpointのstateがありません。対象: ${missingEndpoint}`);
      }
      if (endpointState !== "missing") {
        addMissing("related_timeline");
      }
    }
    if (
      externalContextNodeIds.has(relation.fromNodeId) ||
      externalContextNodeIds.has(relation.toNodeId)
    ) {
      const externalNodeId = externalContextNodeIds.has(relation.fromNodeId)
        ? relation.fromNodeId
        : relation.toNodeId;
      const externalContext = item.externalItemContexts.find(
        (context) => context.nodeId === externalNodeId,
      );
      if (externalContext?.type !== "external_reference") {
        throw new TypeError(`外部参照contextがありません。対象: ${externalNodeId}`);
      }
      if (externalContext.state === "open") {
        addMissing("related_timeline");
      }
    }
  }
  for (const relation of pendingRelations) {
    const endpointNodeIds = relation.endpointNodeIds;
    const hasMissingEndpoint = endpointNodeIds.some((nodeId) => !itemContextIds.has(nodeId));
    if (hasMissingEndpoint) {
      addMissing("related_item");
      addMissing("relation_evidence");
    }
    const externalNodeId = endpointNodeIds.find((nodeId) => externalContextNodeIds.has(nodeId));
    if (externalNodeId != null) {
      const externalContext = item.externalItemContexts.find(
        (context) => context.nodeId === externalNodeId,
      );
      if (externalContext?.type !== "external_reference") {
        throw new TypeError(`外部参照contextがありません。対象: ${externalNodeId}`);
      }
      if (externalContext.state === "open") {
        addMissing("related_timeline");
      }
    }
  }
  if (missingSeedSourceIds.size !== 0) {
    addMissing("item_timeline");
  }
  const input = {
    cause: {
      causeId: seed.causeId,
      itemNodeId: seed.itemNodeId,
      reasonCode: seed.reasonCode,
      responsible: seed.responsible,
      responsibility: seed.responsibility,
      action: seed.action,
    },
    completeness: completenessForCause(item, pendingRelations, missing),
    items,
    relations: [...relationContexts],
    pendingRelations: [...pendingRelations],
    sources,
    evidenceScopes,
    waitingOptions: [...waitingOptions],
    duplicateOptions: [...duplicateOptions],
  } satisfies PersonalReminderCauseSemanticInput;
  return createPersonalReminderCauseSemanticInput(input);
}
