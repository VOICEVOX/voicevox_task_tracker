import {
  type ExternalGhostNode,
  type GraphNodeId,
  type TrackedItemState,
} from "../domain/index.js";
import { StateSnapshotSemanticError } from "./errors.js";
import type {
  SnapshotGraphNodeStateObservation,
  SnapshotTrackedItem,
  StateSnapshot,
} from "./snapshot-contracts.js";

export function compareStrings(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

export function assertUnique(values: readonly string[], description: string): void {
  if (new Set(values).size !== values.length) {
    throw new StateSnapshotSemanticError(`${description}が重複しています`);
  }
}

export function assertUtcDateTime(value: string, description: string): void {
  if (new Date(value).toISOString() !== value) {
    throw new StateSnapshotSemanticError(`${description}はUTCへ正規化してください`);
  }
}

type SnapshotGraphStateSource = Readonly<{
  items: readonly Pick<SnapshotTrackedItem, "nodeId" | "state">[];
  externalReferences: readonly Pick<ExternalGhostNode, "nodeId" | "state">[];
  graphNodeStateObservations?: readonly SnapshotGraphNodeStateObservation[];
}>;

export function effectiveGraphStateByNodeId(
  snapshot: SnapshotGraphStateSource,
): ReadonlyMap<GraphNodeId, TrackedItemState> {
  const stateByNodeId = new Map<GraphNodeId, TrackedItemState>();
  for (const item of snapshot.items) {
    stateByNodeId.set(item.nodeId, item.state);
  }
  for (const reference of snapshot.externalReferences) {
    stateByNodeId.set(reference.nodeId, reference.state);
  }
  for (const observation of snapshot.graphNodeStateObservations ?? []) {
    stateByNodeId.set(observation.nodeId, observation.state);
  }
  return stateByNodeId;
}

export function effectiveGraphStateForNode(
  stateByNodeId: ReadonlyMap<GraphNodeId, TrackedItemState>,
  nodeId: GraphNodeId,
): TrackedItemState {
  const state = stateByNodeId.get(nodeId);
  if (state == null) {
    throw new StateSnapshotSemanticError(`graph nodeの状態がありません。対象: ${nodeId}`);
  }
  return state;
}

/** snapshotに保存されたgraph用状態観測を反映したnode状態を返す。 */
export function snapshotEffectiveGraphStateByNodeId(
  snapshot: StateSnapshot,
): ReadonlyMap<GraphNodeId, TrackedItemState> {
  return effectiveGraphStateByNodeId(snapshot);
}
