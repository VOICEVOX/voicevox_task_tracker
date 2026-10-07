import type {
  ExternalGhostNode,
  GitHubNodeId,
  GraphNodeId,
  TrackedItemState,
  UtcIsoDateTime,
} from "../../../domain/index.js";
import type { EnumeratedGitHubItem } from "../../../github/item-enumeration.js";
import type { GraphAnalysisNode, RelationCandidate } from "../../../graph/index.js";
import { assertNonNullable } from "../../../util/index.js";
import type {
  GraphNodeStateObservation,
  GraphWorkingState,
  PendingGraphTrackedItem,
} from "./graph-reconciliation-contracts.js";
import { currentNativeCandidateStateByStaleNodeId } from "./collection-relation-index.js";

function graphAnalysisStateForEnumeratedItem(item: EnumeratedGitHubItem): TrackedItemState {
  if (item.state === "open") {
    return "open";
  }
  if (item.type === "pull_request" && item.mergeStatus === "merged") {
    return "merged";
  }
  return "closed";
}

/** 関係候補だけにある列挙項目からグラフ解析ノードを構築する。 */
export function candidateOnlyGraphAnalysisNode(item: EnumeratedGitHubItem): GraphAnalysisNode {
  return Object.freeze({
    kind: item.type,
    nodeId: item.nodeId,
    repositoryId: item.repositoryId,
    state: graphAnalysisStateForEnumeratedItem(item),
    directNotification: "not_eligible",
  });
}

type CurrentEffectiveGraphState = Readonly<{
  stateByNodeId: ReadonlyMap<GraphNodeId, TrackedItemState>;
  observations: readonly GraphNodeStateObservation[];
  currentNativeStateObservations: readonly GraphNodeStateObservation[];
}>;

/** 今回の観測と前回の観測から有効なグラフ状態を構築する。 */
export function currentEffectiveGraphState(
  state: GraphWorkingState,
  items: readonly PendingGraphTrackedItem[],
  externalReferences: readonly ExternalGhostNode[],
  candidates: readonly RelationCandidate[],
  staleNodeIds: ReadonlySet<GitHubNodeId>,
  observedAt: UtcIsoDateTime,
): CurrentEffectiveGraphState {
  const currentNativeStates = currentNativeCandidateStateByStaleNodeId(candidates, staleNodeIds);
  const previousObservationsByNodeId = new Map(
    (state.snapshot.status === "available" ? state.snapshot.graphNodeStateObservations : []).map(
      (observation) => [observation.nodeId, observation],
    ),
  );
  const stateByNodeId = new Map<GraphNodeId, TrackedItemState>();
  const observations: GraphNodeStateObservation[] = [];
  const currentNativeStateObservations: GraphNodeStateObservation[] = [];
  for (const item of items) {
    let effectiveState = item.state;
    let effectiveObservedAt: UtcIsoDateTime | undefined;
    if (staleNodeIds.has(item.nodeId)) {
      const currentNativeState = currentNativeStates.get(item.nodeId);
      const previousObservation = previousObservationsByNodeId.get(item.nodeId);
      if (currentNativeState != null) {
        effectiveState = currentNativeState;
        effectiveObservedAt = observedAt;
        currentNativeStateObservations.push(
          Object.freeze({
            nodeId: item.nodeId,
            state: currentNativeState,
            observedAt,
          }),
        );
      } else if (previousObservation != null) {
        effectiveState = previousObservation.state;
        effectiveObservedAt = previousObservation.observedAt;
      }
    }
    if (item.type === "issue" && effectiveState === "merged") {
      throw new TypeError(`Issueのeffective graph状態をmergedにはできません。対象: ${item.nodeId}`);
    }
    stateByNodeId.set(item.nodeId, effectiveState);
    if (effectiveState === item.state) {
      continue;
    }
    assertNonNullable(
      effectiveObservedAt,
      `item状態と異なるeffective graph状態の観測時刻がありません。対象: ${item.nodeId}`,
    );
    observations.push(
      Object.freeze({
        nodeId: item.nodeId,
        state: effectiveState,
        observedAt: effectiveObservedAt,
      }),
    );
  }
  for (const reference of externalReferences) {
    stateByNodeId.set(reference.nodeId, reference.state);
  }
  return Object.freeze({
    stateByNodeId,
    observations: Object.freeze(
      observations.sort((left, right) => left.nodeId.localeCompare(right.nodeId)),
    ),
    currentNativeStateObservations: Object.freeze(
      currentNativeStateObservations.sort((left, right) => left.nodeId.localeCompare(right.nodeId)),
    ),
  });
}
