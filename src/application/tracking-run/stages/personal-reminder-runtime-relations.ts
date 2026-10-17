import type { PersonalReminderTargetScope } from "../../../codex/personal-reminder-input-contracts.js";
import type {
  PersonalReminderCauseId,
  PersonalReminderCauseSeed,
} from "../../../domain/personal-reminder-causes.js";
import type { GraphNodeId } from "../../../domain/types.js";
import type { ReconciledGraphEdge } from "../../../graph/index.js";
import { compareStrings } from "./personal-reminder-runtime-common.js";
import { contextItemByNodeId } from "./personal-reminder-runtime-context-values.js";
import type {
  PersonalReminderConnectedSeedRelations,
  PersonalReminderRuntimeActiveRelation,
  PersonalReminderRuntimeCandidateRelation,
  PersonalReminderRuntimeContext,
  PersonalReminderRuntimeCurrentSeed,
  PersonalReminderRuntimeGraph,
  PersonalReminderRuntimePlanningIndexes,
} from "./personal-reminder-runtime-contracts.js";

/** 両端点がopenか判定する。 */
export function endpointIsOpen(
  graph: PersonalReminderRuntimeGraph,
  relation: Readonly<{ fromNodeId: GraphNodeId; toNodeId: GraphNodeId }>,
): boolean {
  const fromState = graph.endpointStates.get(relation.fromNodeId);
  const toState = graph.endpointStates.get(relation.toNodeId);
  if (fromState == null || toState == null) {
    throw new TypeError("graph relationのendpoint stateがありません");
  }
  return fromState === "open" && toState === "open";
}

/** 端点状態が確定relationの利用を許すか判定する。 */
export function endpointStateAllowsRelation(
  graph: PersonalReminderRuntimeGraph,
  nodeId: GraphNodeId,
): boolean {
  const state = graph.endpointStates.get(nodeId);
  if (state == null) {
    throw new TypeError(`graph relationのendpoint stateがありません。対象: ${nodeId}`);
  }
  return state === "open" || state === "missing";
}

/** 端点状態が未確定relationの利用を許すか判定する。 */
export function relationEndpointsAllowPending(
  graph: PersonalReminderRuntimeGraph,
  endpointNodeIds: readonly [GraphNodeId, GraphNodeId],
): boolean {
  return (
    endpointStateAllowsRelation(graph, endpointNodeIds[0]) &&
    endpointStateAllowsRelation(graph, endpointNodeIds[1])
  );
}

/** active relationが最終graphで有効か判定する。 */
export function activeRelationIsEffective(
  graph: PersonalReminderRuntimeGraph,
  relation: ReconciledGraphEdge & Readonly<{ active: true }>,
): boolean {
  return endpointIsOpen(graph, relation);
}

/** relation候補が原因の範囲に影響するか判定する。 */
export function candidateAffectsCause(
  candidate: PersonalReminderRuntimeCandidateRelation,
  cause: PersonalReminderCauseSeed,
): boolean {
  const scopeNodeIds = seedScopeNodeIds(cause);
  return candidate.endpointNodeIds.some((nodeId) => scopeNodeIds.has(nodeId));
}

function scopeNodeIds(
  itemNodeId: GraphNodeId,
  scope: PersonalReminderTargetScope,
): ReadonlySet<GraphNodeId> {
  const nodeIds = new Set<GraphNodeId>([itemNodeId]);
  if (scope.kind !== "item") {
    for (const surface of scope.surfaces) {
      nodeIds.add(surface.nodeId);
    }
  }
  return nodeIds;
}

/** 原因seedの対象範囲に属するnode IDを取得する。 */
export function seedScopeNodeIds(seed: PersonalReminderCauseSeed): ReadonlySet<GraphNodeId> {
  return scopeNodeIds(seed.itemNodeId, seed.responsibility.scope);
}

/** 待機候補の対象範囲に属するnode IDを取得する。 */
export function optionTargetScopeNodeIds(
  option: Readonly<{
    itemNodeId: GraphNodeId;
    targetScope: PersonalReminderTargetScope;
  }>,
): ReadonlySet<GraphNodeId> {
  return scopeNodeIds(option.itemNodeId, option.targetScope);
}

/** 原因seedの責務範囲を待機候補の範囲へ変換する。 */
export function targetScopeForSeed(seed: PersonalReminderCauseSeed): PersonalReminderTargetScope {
  return seed.responsibility.scope;
}

function relationConnectsScopes(
  relation: PersonalReminderRuntimeActiveRelation,
  leftNodeIds: ReadonlySet<GraphNodeId>,
  rightNodeIds: ReadonlySet<GraphNodeId>,
): boolean {
  return (
    (leftNodeIds.has(relation.fromNodeId) && rightNodeIds.has(relation.toNodeId)) ||
    (leftNodeIds.has(relation.toNodeId) && rightNodeIds.has(relation.fromNodeId))
  );
}

/** 原因seedとrelationの計画用索引を作る。 */
export function createPersonalReminderPlanningIndexes(
  context: PersonalReminderRuntimeContext,
  currentSeeds: readonly PersonalReminderRuntimeCurrentSeed[],
): PersonalReminderRuntimePlanningIndexes {
  const candidateRelationById = new Map<
    PersonalReminderRuntimeCandidateRelation["candidateId"],
    PersonalReminderRuntimeCandidateRelation
  >();
  for (const candidate of context.graph.candidateRelations) {
    if (!candidateRelationById.has(candidate.candidateId)) {
      candidateRelationById.set(candidate.candidateId, candidate);
    }
  }
  const activeRelationsByNodeId = new Map<GraphNodeId, PersonalReminderRuntimeActiveRelation[]>();
  for (const relation of context.graph.activeRelations) {
    const fromRelations = activeRelationsByNodeId.get(relation.fromNodeId);
    if (fromRelations == null) {
      activeRelationsByNodeId.set(relation.fromNodeId, [relation]);
    } else {
      fromRelations.push(relation);
    }
    if (relation.toNodeId === relation.fromNodeId) {
      continue;
    }
    const toRelations = activeRelationsByNodeId.get(relation.toNodeId);
    if (toRelations == null) {
      activeRelationsByNodeId.set(relation.toNodeId, [relation]);
    } else {
      toRelations.push(relation);
    }
  }

  const currentSeedByCauseId = new Map<
    PersonalReminderCauseId,
    PersonalReminderRuntimeCurrentSeed
  >();
  const currentSeedsByItemNodeId = new Map<GraphNodeId, PersonalReminderRuntimeCurrentSeed[]>();
  const currentSeedsByScopeNodeId = new Map<GraphNodeId, PersonalReminderRuntimeCurrentSeed[]>();
  for (const currentSeed of currentSeeds) {
    if (currentSeed.probe) {
      throw new TypeError(
        `終了probeをcurrent option indexへ追加できません。対象: ${currentSeed.seed.causeId}`,
      );
    }
    if (currentSeedByCauseId.has(currentSeed.seed.causeId)) {
      throw new TypeError(`current seed IDが重複しています。対象: ${currentSeed.seed.causeId}`);
    }
    currentSeedByCauseId.set(currentSeed.seed.causeId, currentSeed);
    const itemSeeds = currentSeedsByItemNodeId.get(currentSeed.seed.itemNodeId);
    if (itemSeeds == null) {
      currentSeedsByItemNodeId.set(currentSeed.seed.itemNodeId, [currentSeed]);
    } else {
      itemSeeds.push(currentSeed);
    }
    const nodeIds = seedScopeNodeIds(currentSeed.seed);
    for (const nodeId of nodeIds) {
      const scopedSeeds = currentSeedsByScopeNodeId.get(nodeId);
      if (scopedSeeds == null) {
        currentSeedsByScopeNodeId.set(nodeId, [currentSeed]);
      } else {
        scopedSeeds.push(currentSeed);
      }
    }
  }

  return Object.freeze({
    candidateRelationById,
    activeRelationsByNodeId: new Map(
      [...activeRelationsByNodeId].map(([nodeId, relations]) => [nodeId, Object.freeze(relations)]),
    ),
    currentSeedByCauseId,
    currentSeedsByItemNodeId: new Map(
      [...currentSeedsByItemNodeId].map(([nodeId, seeds]) => [nodeId, Object.freeze(seeds)]),
    ),
    currentSeedsByScopeNodeId: new Map(
      [...currentSeedsByScopeNodeId].map(([nodeId, seeds]) => [nodeId, Object.freeze(seeds)]),
    ),
  });
}

/** 原因seedと実行面のnode IDを集める。 */
export function scopeNodeIdsForSeed(seed: PersonalReminderCauseSeed): ReadonlySet<GraphNodeId> {
  return seedScopeNodeIds(seed);
}

/** 対象範囲に接続する有効relationを取得する。 */
export function relationsIncidentToScope(
  indexes: PersonalReminderRuntimePlanningIndexes,
  nodeIds: ReadonlySet<GraphNodeId>,
): readonly PersonalReminderRuntimeActiveRelation[] {
  const relationsById = new Map<string, PersonalReminderRuntimeActiveRelation>();
  for (const nodeId of nodeIds) {
    for (const relation of indexes.activeRelationsByNodeId.get(nodeId) ?? []) {
      relationsById.set(relation.id, relation);
    }
  }
  return Object.freeze([...relationsById.values()]);
}

/** 原因seedに接続する有効relationを取得する。 */
export function connectedSeedRelations(
  indexes: PersonalReminderRuntimePlanningIndexes,
  seed: PersonalReminderCauseSeed,
  relations: readonly PersonalReminderRuntimeActiveRelation[],
  subject: PersonalReminderRuntimeCurrentSeed,
): ReadonlyMap<PersonalReminderCauseId, PersonalReminderConnectedSeedRelations> {
  const seedNodeIds = scopeNodeIdsForSeed(seed);
  const relationsByCauseId = new Map<
    PersonalReminderCauseId,
    Readonly<{
      currentSeed: PersonalReminderRuntimeCurrentSeed;
      relationsById: Map<string, PersonalReminderRuntimeActiveRelation>;
    }>
  >();
  for (const relation of relations) {
    const candidateSeeds: PersonalReminderRuntimeCurrentSeed[] = [];
    if (seedNodeIds.has(relation.fromNodeId)) {
      candidateSeeds.push(...(indexes.currentSeedsByScopeNodeId.get(relation.toNodeId) ?? []));
    }
    if (seedNodeIds.has(relation.toNodeId)) {
      candidateSeeds.push(...(indexes.currentSeedsByScopeNodeId.get(relation.fromNodeId) ?? []));
    }
    for (const candidate of candidateSeeds) {
      if (
        candidate.seed.causeId === seed.causeId ||
        (subject.draftIdentity != null && candidate.draftIdentity === subject.draftIdentity)
      ) {
        continue;
      }
      if (!relationConnectsScopes(relation, seedNodeIds, scopeNodeIdsForSeed(candidate.seed))) {
        continue;
      }
      const existing = relationsByCauseId.get(candidate.seed.causeId);
      if (existing == null) {
        relationsByCauseId.set(
          candidate.seed.causeId,
          Object.freeze({
            currentSeed: candidate,
            relationsById: new Map([[relation.id, relation]]),
          }),
        );
      } else {
        existing.relationsById.set(relation.id, relation);
      }
    }
  }
  return new Map(
    [...relationsByCauseId]
      .sort(([left], [right]) => compareStrings(left, right))
      .map(([causeId, value]) => [
        causeId,
        Object.freeze({
          currentSeed: value.currentSeed,
          relations: Object.freeze(
            [...value.relationsById.values()].sort((left, right) =>
              compareStrings(left.id, right.id),
            ),
          ),
        }),
      ]),
  );
}

function seedRepresentsImplementsSource(
  context: PersonalReminderRuntimeContext,
  seed: PersonalReminderCauseSeed,
  relation: ReconciledGraphEdge & Readonly<{ active: true }>,
): boolean {
  if (relation.type !== "implements") {
    return false;
  }
  const item = contextItemByNodeId(context, seed.itemNodeId);
  return item?.item.type === "pull_request" && relation.fromNodeId === seed.itemNodeId;
}

/** 重複候補から正本となる原因seedを選ぶ。 */
export function duplicateCanonicalSeed(
  context: PersonalReminderRuntimeContext,
  left: PersonalReminderRuntimeCurrentSeed,
  right: PersonalReminderRuntimeCurrentSeed,
  relations: readonly (ReconciledGraphEdge & Readonly<{ active: true }>)[],
): PersonalReminderRuntimeCurrentSeed {
  const implementsRelation = relations.find((relation) => relation.type === "implements");
  if (implementsRelation != null) {
    const leftIsImplementation = seedRepresentsImplementsSource(
      context,
      left.seed,
      implementsRelation,
    );
    const rightIsImplementation = seedRepresentsImplementsSource(
      context,
      right.seed,
      implementsRelation,
    );
    if (leftIsImplementation !== rightIsImplementation) {
      return leftIsImplementation ? left : right;
    }
  }
  return compareStrings(left.seed.causeId, right.seed.causeId) <= 0 ? left : right;
}
