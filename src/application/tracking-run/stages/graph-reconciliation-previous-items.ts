import type { GitHubNodeId } from "../../../domain/index.js";
import type {
  PreviousSnapshotProjection,
  PreviousTrackedItem,
} from "../contracts/previous-state.js";
import type { GraphWorkingSnapshot, GraphWorkingState } from "./graph-reconciliation-contracts.js";

/** 前回state投影から段階内の項目索引を作る。 */
export function graphWorkingState(previous: PreviousSnapshotProjection): GraphWorkingState {
  if (previous.status !== "available") {
    return Object.freeze({
      previousSnapshot: previous,
      snapshot: previous,
      itemsByNodeId: new Map(),
    });
  }
  const { trackedItems, ...fields } = previous;
  const itemsByNodeId = new Map<GitHubNodeId, PreviousTrackedItem>();
  for (const item of trackedItems) {
    if (itemsByNodeId.has(item.nodeId)) {
      throw new TypeError(`前回snapshotの追跡項目が重複しています。対象: ${item.nodeId}`);
    }
    itemsByNodeId.set(item.nodeId, item);
  }
  return Object.freeze({
    previousSnapshot: previous,
    snapshot: Object.freeze({ ...fields, items: trackedItems }),
    itemsByNodeId,
  });
}

/** 前回snapshotが存在する場合だけ返す。 */
export function previousSnapshot(state: GraphWorkingState): GraphWorkingSnapshot | undefined {
  return state.snapshot.status === "available" ? state.snapshot : undefined;
}

/** 前回追跡項目をIDで引く索引を作る。 */
export function previousTrackedItemsByNodeId(
  state: GraphWorkingState,
): ReadonlyMap<GitHubNodeId, PreviousTrackedItem> {
  return state.itemsByNodeId;
}

/** 前回追跡項目が存在する場合だけ返す。 */
export function previousTrackedItem(
  state: GraphWorkingState,
  nodeId: GitHubNodeId,
): PreviousTrackedItem | undefined {
  return state.itemsByNodeId.get(nodeId);
}
