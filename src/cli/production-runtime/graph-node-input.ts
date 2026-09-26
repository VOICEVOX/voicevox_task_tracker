import type { ExternalGhostNode, GraphNodeId, TrackedItemState } from "../../domain/index.js";
import type { GraphAnalysisNode } from "../../graph/index.js";
import { assertNonNullable } from "../../util/index.js";
import type { PendingTrackedItem } from "./contracts.js";

/** 追跡項目からグラフ解析ノードを構築する。 */
export function graphAnalysisNode(item: PendingTrackedItem): GraphAnalysisNode {
  return Object.freeze({
    kind: item.type,
    nodeId: item.nodeId,
    repositoryId: item.repositoryId,
    state: item.state,
    directNotification: "eligible",
  });
}

/** 有効状態を反映したグラフ解析ノードを構築する。 */
export function graphAnalysisNodeWithEffectiveState(
  item: PendingTrackedItem,
  stateByNodeId: ReadonlyMap<GraphNodeId, TrackedItemState>,
): GraphAnalysisNode {
  const node = graphAnalysisNode(item);
  const currentState = stateByNodeId.get(item.nodeId);
  assertNonNullable(
    currentState,
    `追跡項目のeffective graph状態がありません。対象: ${item.nodeId}`,
  );
  return Object.freeze({
    ...node,
    state: currentState,
  });
}

/** 外部参照からグラフ解析ノードを構築する。 */
export function externalGraphAnalysisNode(reference: ExternalGhostNode): GraphAnalysisNode {
  return Object.freeze({
    kind: reference.kind,
    nodeId: reference.nodeId,
    repositoryFullName: reference.repositoryFullName,
    state: reference.state,
    directNotification: reference.directNotification,
  });
}
