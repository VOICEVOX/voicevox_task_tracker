import { hashCanonicalJson, serializeCanonicalJson } from "../canonical-json/index.js";
import { determineDeadlineLevel, type TrackedItemState } from "../domain/index.js";
import { createFinalGraphProjection } from "../graph/final-graph-projection.js";
import { StateSnapshotSemanticError } from "./errors.js";
import type { StateSnapshot } from "./snapshot-v20-contracts.js";

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertOrderedUnique(values: readonly string[], description: string): void {
  for (let index = 1; index < values.length; index += 1) {
    const previous = values[index - 1];
    const current = values[index];
    if (previous == null || current == null || compareStrings(previous, current) >= 0) {
      throw new StateSnapshotSemanticError(`${description}の順序または重複が不正です`);
    }
  }
}

/** 保存済み公開graph投影の参照、値、現在性をsnapshotと照合する。 */
export function assertFinalGraphProjectionSemantics(
  snapshot: Omit<StateSnapshot, "schemaVersion">,
): void {
  const projection = snapshot.finalGraphProjection;
  if (hashCanonicalJson(projection) !== snapshot.finalGraphProjectionDigest) {
    throw new StateSnapshotSemanticError("最終graph投影のdigestが一致しません");
  }
  if (projection.evaluatedAt !== snapshot.generatedAt) {
    throw new StateSnapshotSemanticError("最終graph投影の判定時刻がsnapshotと一致しません");
  }
  try {
    new Intl.DateTimeFormat("en", { timeZone: projection.timezone });
  } catch (error: unknown) {
    throw new StateSnapshotSemanticError("最終graph投影のtimezoneが不正です", { cause: error });
  }
  const itemByNodeId = new Map<string, StateSnapshot["items"][number]>(
    snapshot.items.map((item) => [item.nodeId, item]),
  );
  const graphNodeIds = new Set<string>([
    ...snapshot.items.map((item) => item.nodeId),
    ...snapshot.externalReferences.map((reference) => reference.nodeId),
  ]);
  assertOrderedUnique(
    projection.nodes.map((node) => node.nodeId),
    "最終graph投影のnode",
  );
  if (
    projection.nodes.length !== graphNodeIds.size ||
    projection.nodes.some((node) => !graphNodeIds.has(node.nodeId))
  ) {
    throw new StateSnapshotSemanticError("最終graph投影のnode集合がsnapshotと一致しません");
  }
  const effectiveStates = new Map<string, TrackedItemState>([
    ...snapshot.items.map((item): [string, TrackedItemState] => [item.nodeId, item.state]),
    ...snapshot.externalReferences.map((reference): [string, TrackedItemState] => [
      reference.nodeId,
      reference.state,
    ]),
    ...snapshot.graphNodeStateObservations.map((observation): [string, TrackedItemState] => [
      observation.nodeId,
      observation.state,
    ]),
  ]);
  const openNodeCount = [...effectiveStates.values()].filter((state) => state === "open").length;
  for (const node of projection.nodes) {
    if (node.effectiveState !== effectiveStates.get(node.nodeId)) {
      throw new StateSnapshotSemanticError(
        `最終graph投影のeffective stateが一致しません。対象: ${node.nodeId}`,
      );
    }
    if (
      node.downstreamImpact.openNodeCount > Math.max(0, openNodeCount - 1) ||
      node.downstreamImpact.repositoryCount > node.downstreamImpact.openNodeCount ||
      (node.effectiveState !== "open" &&
        (node.downstreamImpact.openNodeCount !== 0 || node.downstreamImpact.repositoryCount !== 0))
    ) {
      throw new StateSnapshotSemanticError(
        `最終graph投影のdownstream impactが不正です。対象: ${node.nodeId}`,
      );
    }
  }
  assertOrderedUnique(projection.frontierNodeIds, "最終graph投影のfrontier");
  const cycleNodeIds = new Set<string>();
  const relationById = new Map(snapshot.relations.map((relation) => [relation.id, relation]));
  assertOrderedUnique(
    projection.dependencyCycles.map((cycle) => cycle.id),
    "最終graph投影のcycle",
  );
  for (const cycle of projection.dependencyCycles) {
    assertOrderedUnique(cycle.nodeIds, `cycle ${cycle.id}のnode`);
    assertOrderedUnique(cycle.edgeIds, `cycle ${cycle.id}のedge`);
    const nodes = new Set(cycle.nodeIds);
    if (cycle.nodeIds.some((nodeId) => !graphNodeIds.has(nodeId))) {
      throw new StateSnapshotSemanticError(`cycle ${cycle.id}にsnapshot外のnodeがあります`);
    }
    for (const nodeId of cycle.nodeIds) {
      if (cycleNodeIds.has(nodeId)) {
        throw new StateSnapshotSemanticError(`cycle node ${nodeId}が重複しています`);
      }
      cycleNodeIds.add(nodeId);
    }
    for (const edgeId of cycle.edgeIds) {
      const relation = relationById.get(edgeId);
      if (
        relation == null ||
        !relation.active ||
        relation.type !== "blocks" ||
        !nodes.has(relation.fromNodeId) ||
        !nodes.has(relation.toNodeId)
      ) {
        throw new StateSnapshotSemanticError(`cycle ${cycle.id}のedgeが不正です。対象: ${edgeId}`);
      }
    }
  }
  const blockedNodeIds = new Set<string>(
    snapshot.relations
      .filter(
        (relation) =>
          relation.active &&
          relation.type === "blocks" &&
          effectiveStates.get(relation.fromNodeId) === "open" &&
          effectiveStates.get(relation.toNodeId) === "open",
      )
      .map((relation) => relation.toNodeId),
  );
  const expectedFrontier = snapshot.items
    .filter(
      (item) =>
        effectiveStates.get(item.nodeId) === "open" &&
        !blockedNodeIds.has(item.nodeId) &&
        !cycleNodeIds.has(item.nodeId),
    )
    .map((item) => item.nodeId)
    .sort(compareStrings);
  if (
    serializeCanonicalJson(projection.frontierNodeIds) !== serializeCanonicalJson(expectedFrontier)
  ) {
    throw new StateSnapshotSemanticError("最終graph投影のfrontierがrelationと一致しません");
  }
  assertOrderedUnique(
    projection.items.map((item) => item.nodeId),
    "最終graph投影のitem",
  );
  if (
    projection.items.length !== snapshot.items.length ||
    projection.items.some((item) => !itemByNodeId.has(item.nodeId))
  ) {
    throw new StateSnapshotSemanticError("最終graph投影のitem集合がsnapshotと一致しません");
  }
  const expectedItems = snapshot.items.map((item) => ({
    ...item,
    deadlineLevel:
      item.deadlineAssessment.status === "not_available"
        ? "none"
        : determineDeadlineLevel({
            deadlineDate: item.deadlineAssessment.value.date,
            evaluatedAt: projection.evaluatedAt,
            timezone: projection.timezone,
          }),
  }));
  const expectedProjection = createFinalGraphProjection({
    evaluatedAt: projection.evaluatedAt,
    timezone: projection.timezone,
    items: expectedItems,
    staleRepositoryIds: new Set(
      snapshot.repositories
        .filter((repository) => repository.freshness === "stale")
        .map((repository) => repository.id),
    ),
    relations: snapshot.relations,
    effectiveStateByNodeId: [...effectiveStates],
    analysis: {
      dependencyCycles: [],
      actionableFrontier: [],
      downstreamImpacts: projection.nodes.map((node) => ({
        nodeId: node.nodeId,
        ...node.downstreamImpact,
      })),
    },
  });
  if (
    serializeCanonicalJson(expectedProjection.items) !== serializeCanonicalJson(projection.items)
  ) {
    throw new StateSnapshotSemanticError("最終graph投影の項目値がsnapshotと一致しません");
  }
}
