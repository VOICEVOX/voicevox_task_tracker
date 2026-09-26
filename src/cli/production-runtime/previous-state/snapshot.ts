import type { GitHubNodeId } from "../../../domain/index.js";
import type { SnapshotTrackedItem, StateSnapshot } from "../../../persistence/index.js";
import type { RuntimeState } from "../contracts.js";

export function previousSnapshot(state: RuntimeState): StateSnapshot | undefined {
  return state.snapshot.status === "available" ? state.snapshot.snapshot : undefined;
}

const previousTrackedItemsBySnapshot = new WeakMap<
  StateSnapshot,
  ReadonlyMap<GitHubNodeId, SnapshotTrackedItem>
>();

export function previousTrackedItemsByNodeId(
  state: RuntimeState,
): ReadonlyMap<GitHubNodeId, SnapshotTrackedItem> {
  const snapshot = previousSnapshot(state);
  if (snapshot == null) {
    return new Map();
  }
  const cached = previousTrackedItemsBySnapshot.get(snapshot);
  if (cached != null) {
    return cached;
  }
  const itemsByNodeId = new Map<GitHubNodeId, SnapshotTrackedItem>();
  for (const item of snapshot.items) {
    if (itemsByNodeId.has(item.nodeId)) {
      throw new TypeError(`前回snapshotの追跡項目が重複しています。対象: ${item.nodeId}`);
    }
    itemsByNodeId.set(item.nodeId, item);
  }
  previousTrackedItemsBySnapshot.set(snapshot, itemsByNodeId);
  return itemsByNodeId;
}

export function previousTrackedItem(
  state: RuntimeState,
  nodeId: GitHubNodeId,
): SnapshotTrackedItem | undefined {
  return previousTrackedItemsByNodeId(state).get(nodeId);
}
