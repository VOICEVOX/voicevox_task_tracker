import {
  createExternalReferenceNodeId,
  createGitHubNodeId,
  parseSourceId,
  type GraphNodeId,
  type ReplayItemHistoryResult,
  type SourceId,
  type UtcIsoDateTime,
} from "../domain/index.js";
import {
  type DependencyReplayEdge,
  type DependencyReplayInputEvent,
} from "../graph/dependency-replay-types.js";
import {
  type RelationCandidate,
  type RelationCandidateNode,
} from "../graph/relation-candidate-types.js";
import { type RelationMutation } from "../graph/relation-mutation.js";
import {
  type TemporalBlocksCurrentNode,
  type TemporalBlocksGraphReplayInput,
  type TemporalBlocksNodeStateHistory,
  type TemporalBlocksStateEpoch,
} from "../graph/temporal-blocks-graph-replay.js";
import {
  type CacheHistory,
  type GitHubItemCacheDocument,
  type GitHubItemCacheRelationCandidate,
  type GitHubItemCacheRelationMutationResult,
} from "../persistence/cache-documents.js";
import {
  type GitHubItemDetail,
  type GitHubReferencedItem,
  type GitHubTimelineEvent,
} from "./item-detail-types.js";
import {
  adaptGitHubRelationMutationSource,
  type GitHubRelationMutationSourceResult,
} from "./relation-mutation-adapter.js";

type RelationReference = Readonly<{
  repositoryOwner: string;
  repositoryName: string;
  itemType: "issue" | "pull_request" | null;
  number: number;
}>;

type RelationEndpoint = RelationReference &
  Readonly<{
    nodeId: GraphNodeId;
  }>;

type FreshRelationMutationResult = GitHubRelationMutationSourceResult;
type CachedRelationMutationResult = GitHubItemCacheRelationMutationResult;

/** fresh detailからtemporal blocks graph replay入力を作る項目。 */
export type FreshTemporalBlocksItem = Readonly<{
  detail: GitHubItemDetail;
  itemCreatedAt: UtcIsoDateTime;
  replay: ReplayItemHistoryResult;
}>;

/** fresh detailからtemporal blocks graph replay入力を作る引数。 */
export type FreshTemporalBlocksGraphInput = Readonly<{
  current: Readonly<{
    nodes: readonly TemporalBlocksCurrentNode[];
    canonicalBlocksEdges: readonly DependencyReplayEdge[];
  }>;
  relationCandidates: readonly RelationCandidate[];
  items: readonly FreshTemporalBlocksItem[];
}>;

/** cache文書からtemporal blocks graph replay入力を作る引数。 */
export type CachedTemporalBlocksGraphInput = Readonly<{
  current: Readonly<{
    nodes: readonly TemporalBlocksCurrentNode[];
    canonicalBlocksEdges: readonly DependencyReplayEdge[];
  }>;
  documents: readonly GitHubItemCacheDocument[];
}>;

/** fresh detailまたはcache文書からtemporal blocks graphへ渡す項目。 */
export type MixedTemporalBlocksGraphItem =
  | Readonly<{
      kind: "fresh";
      detail: GitHubItemDetail;
      itemCreatedAt: UtcIsoDateTime;
      replay: ReplayItemHistoryResult;
    }>
  | Readonly<{
      kind: "cached";
      document: GitHubItemCacheDocument;
    }>;

/** 追跡対象だけを含むと呼び出し側が保証した現在graph。 */
export type MixedTemporalBlocksGraphCurrent = Readonly<{
  scope: "eligible_tracked_items_only";
  nodes: readonly TemporalBlocksCurrentNode[];
  canonicalBlocksEdges: readonly DependencyReplayEdge[];
}>;

/** fresh detailとcache文書を混在させてtemporal blocks graphへ渡す引数。 */
export type MixedTemporalBlocksGraphInput = Readonly<{
  current: MixedTemporalBlocksGraphCurrent;
  notificationHistory: Readonly<{
    exactBlocksEdges: readonly DependencyReplayEdge[];
    relationCandidates: readonly RelationCandidate[];
  }>;
  relationCandidates: readonly RelationCandidate[];
  items: readonly MixedTemporalBlocksGraphItem[];
}>;

type RelationEventResolution =
  | Readonly<{
      status: "resolved";
      event: Extract<DependencyReplayInputEvent, { status: "resolved" }>;
    }>
  | Readonly<{
      status: "unknown";
    }>;

type RelationEventHistory =
  | Readonly<{
      status: "exact";
      events: readonly DependencyReplayInputEvent[];
    }>
  | Readonly<{
      status: "unknown";
    }>;

/** 関係mutationの時刻または端点を確定できなかった診断。 */
export type TemporalBlocksUnknownRelationMutation = Readonly<{
  originItemNodeId: GraphNodeId;
  contentSourceId: SourceId;
  reason:
    | "connection_unavailable"
    | "current_markdown_reference_definition"
    | "diff_null"
    | "deleted_edit"
    | "unsupported_diff_format"
    | "markdown_reference_definition"
    | "history_incomplete"
    | "current_mismatch"
    | "preexisting_relation"
    | "relation_endpoint_unavailable";
  sourceId?: SourceId;
  editedAt?: UtcIsoDateTime;
  sequence?: number;
}>;

/** temporal blocks graph replayへ渡す入力と、確定不能な局所診断。 */
export type TemporalBlocksGraphReplayAdapterResult = Readonly<{
  input: TemporalBlocksGraphReplayInput;
  unknownRelationMutations: readonly TemporalBlocksUnknownRelationMutation[];
}>;

type CacheCandidateNode = Readonly<{
  nodeId: string;
  repositoryOwner: string;
  repositoryName: string;
  number: number;
  scope: "organization" | "external_public";
  kind: "issue" | "pull_request" | "external_reference";
  githubItemType?: "issue" | "pull_request";
}>;

function createUnknownRelationMutation(
  originItemNodeId: GraphNodeId,
  contentSourceId: SourceId,
  reason: TemporalBlocksUnknownRelationMutation["reason"],
  metadata: Readonly<{
    sourceId: SourceId | null;
    editedAt: UtcIsoDateTime | null;
    sequence: number | null;
  }>,
): TemporalBlocksUnknownRelationMutation {
  const diagnostic: {
    originItemNodeId: GraphNodeId;
    contentSourceId: SourceId;
    reason: TemporalBlocksUnknownRelationMutation["reason"];
    sourceId?: SourceId;
    editedAt?: UtcIsoDateTime;
    sequence?: number;
  } = { originItemNodeId, contentSourceId, reason };
  if (metadata.sourceId != null) {
    diagnostic.sourceId = metadata.sourceId;
  }
  if (metadata.editedAt != null) {
    diagnostic.editedAt = metadata.editedAt;
  }
  if (metadata.sequence != null) {
    diagnostic.sequence = metadata.sequence;
  }
  return Object.freeze(diagnostic);
}

function compareStrings(left: string, right: string): -1 | 0 | 1 {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function compareNumbers(left: number, right: number): -1 | 0 | 1 {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function compareDependencyEvents(
  left: DependencyReplayInputEvent,
  right: DependencyReplayInputEvent,
): -1 | 0 | 1 {
  const occurredAtOrder = compareStrings(left.occurredAt, right.occurredAt);
  if (occurredAtOrder !== 0) {
    return occurredAtOrder;
  }
  const sequenceOrder = compareNumbers(left.sequence, right.sequence);
  if (sequenceOrder !== 0) {
    return sequenceOrder;
  }
  const sourceOrder = compareStrings(left.sourceId, right.sourceId);
  if (sourceOrder !== 0) {
    return sourceOrder;
  }
  const originOrder = compareStrings(left.originItemNodeId, right.originItemNodeId);
  if (originOrder !== 0) {
    return originOrder;
  }
  if (left.status !== right.status) {
    return left.status === "resolved" ? -1 : 1;
  }
  if (left.status === "resolved" && right.status === "resolved") {
    const fromOrder = compareStrings(left.fromNodeId, right.fromNodeId);
    if (fromOrder !== 0) {
      return fromOrder;
    }
    const toOrder = compareStrings(left.toNodeId, right.toNodeId);
    if (toOrder !== 0) {
      return toOrder;
    }
    return left.action === right.action ? 0 : left.action === "added" ? -1 : 1;
  }
  if (left.status !== "unresolved" || right.status !== "unresolved") {
    throw new TypeError("依存関係イベントのstatusが不正です");
  }
  if (left.action !== right.action) {
    return left.action === "added" ? -1 : 1;
  }
  return left.direction === right.direction ? 0 : left.direction === "blocked_by" ? -1 : 1;
}

function createSequenceMap(
  events: readonly Readonly<{ sourceId: SourceId; sequence: number }>[],
): ReadonlyMap<SourceId, number> {
  const sequences = new Map<SourceId, number>();
  for (const event of events) {
    if (sequences.has(event.sourceId)) {
      throw new TypeError(`同じsource IDのイベントが重複しています。対象: ${event.sourceId}`);
    }
    sequences.set(event.sourceId, event.sequence);
  }
  return sequences;
}

function epochSequence(
  sourceIds: readonly SourceId[],
  sequences: ReadonlyMap<SourceId, number>,
): number {
  const values = sourceIds.flatMap((sourceId) => {
    const sequence = sequences.get(sourceId);
    return sequence == null ? [] : [sequence];
  });
  return values.length === 0 ? 0 : Math.min(...values);
}

function createSourceIdTuple(sourceIds: readonly SourceId[]): readonly [SourceId, ...SourceId[]] {
  if (new Set(sourceIds).size !== sourceIds.length) {
    throw new TypeError("temporal blocks state epochのsource IDが重複しています");
  }
  const [firstSourceId, ...remainingSourceIds] = sourceIds;
  if (firstSourceId == null) {
    throw new TypeError("temporal blocks state epochのsource IDがありません");
  }
  const tuple: [SourceId, ...SourceId[]] = [firstSourceId, ...remainingSourceIds];
  return Object.freeze(tuple);
}

function compareUnknownRelationMutations(
  left: TemporalBlocksUnknownRelationMutation,
  right: TemporalBlocksUnknownRelationMutation,
): -1 | 0 | 1 {
  const originOrder = compareStrings(left.originItemNodeId, right.originItemNodeId);
  if (originOrder !== 0) {
    return originOrder;
  }
  const leftEditedAt = left.editedAt;
  const rightEditedAt = right.editedAt;
  if (leftEditedAt == null && rightEditedAt != null) {
    return 1;
  }
  if (leftEditedAt != null && rightEditedAt == null) {
    return -1;
  }
  if (leftEditedAt != null && rightEditedAt != null) {
    const editedAtOrder = compareStrings(leftEditedAt, rightEditedAt);
    if (editedAtOrder !== 0) {
      return editedAtOrder;
    }
  }
  const leftSequence = left.sequence;
  const rightSequence = right.sequence;
  if (leftSequence == null && rightSequence != null) {
    return 1;
  }
  if (leftSequence != null && rightSequence == null) {
    return -1;
  }
  if (leftSequence != null && rightSequence != null) {
    const sequenceOrder = compareNumbers(leftSequence, rightSequence);
    if (sequenceOrder !== 0) {
      return sequenceOrder;
    }
  }
  const sourceOrder = compareStrings(left.sourceId ?? "", right.sourceId ?? "");
  if (sourceOrder !== 0) {
    return sourceOrder;
  }
  const contentSourceOrder = compareStrings(left.contentSourceId, right.contentSourceId);
  if (contentSourceOrder !== 0) {
    return contentSourceOrder;
  }
  return compareStrings(left.reason, right.reason);
}

function mapStateEpoch(
  epoch: Readonly<{
    state: TemporalBlocksStateEpoch["state"];
    occurredAt: UtcIsoDateTime;
    sourceIds: readonly SourceId[];
  }>,
  sequences: ReadonlyMap<SourceId, number>,
): TemporalBlocksStateEpoch {
  return Object.freeze({
    state: epoch.state,
    occurredAt: epoch.occurredAt,
    sourceIds: createSourceIdTuple(epoch.sourceIds),
    sequence: epochSequence(epoch.sourceIds, sequences),
  });
}

function mapStateHistory(
  nodeId: GraphNodeId,
  replay: ReplayItemHistoryResult,
  sequences: ReadonlyMap<SourceId, number>,
): TemporalBlocksNodeStateHistory {
  if (replay.stateEpochs.status === "unknown") {
    return Object.freeze({
      nodeId,
      history: {
        status: "unknown",
        reason: "history_unavailable",
      },
    });
  }
  return Object.freeze({
    nodeId,
    history: {
      status: "exact",
      epochs: Object.freeze(
        replay.stateEpochs.value.map((epoch) => mapStateEpoch(epoch, sequences)),
      ),
    },
  });
}

function mapCacheStateHistory(
  document: GitHubItemCacheDocument,
  sequences: ReadonlyMap<SourceId, number>,
): TemporalBlocksNodeStateHistory {
  const replay = document.replay;
  if (replay.stateEpochs.status === "unknown") {
    return Object.freeze({
      nodeId: document.nodeId,
      history: {
        status: "unknown",
        reason: "history_unavailable",
      },
    });
  }
  return Object.freeze({
    nodeId: document.nodeId,
    history: {
      status: "exact",
      epochs: Object.freeze(
        replay.stateEpochs.value.map((epoch) => mapStateEpoch(epoch, sequences)),
      ),
    },
  });
}

function assertCurrentState(
  currentNodes: readonly TemporalBlocksCurrentNode[],
  nodeId: GraphNodeId,
  state: TemporalBlocksCurrentNode["state"],
): void {
  const currentNode = currentNodes.find((candidate) => candidate.nodeId === nodeId);
  if (currentNode == null) {
    throw new TypeError(`temporal blocks graphのcurrent nodeがありません。対象: ${nodeId}`);
  }
  if (currentNode.state !== state) {
    throw new TypeError(`temporal blocks graphのcurrent stateが一致しません。対象: ${nodeId}`);
  }
}

function isDependencyEvent(event: GitHubTimelineEvent): event is Extract<
  GitHubTimelineEvent,
  {
    kind: "blocked_by_added" | "blocked_by_removed" | "blocking_added" | "blocking_removed";
  }
> {
  return (
    event.kind === "blocked_by_added" ||
    event.kind === "blocked_by_removed" ||
    event.kind === "blocking_added" ||
    event.kind === "blocking_removed"
  );
}

function dependencyEventDirection(
  event: Extract<
    GitHubTimelineEvent,
    {
      kind: "blocked_by_added" | "blocked_by_removed" | "blocking_added" | "blocking_removed";
    }
  >,
): "blocked_by" | "blocking" {
  return event.kind === "blocked_by_added" || event.kind === "blocked_by_removed"
    ? "blocked_by"
    : "blocking";
}

function dependencyEventAction(
  event: Extract<
    GitHubTimelineEvent,
    {
      kind: "blocked_by_added" | "blocked_by_removed" | "blocking_added" | "blocking_removed";
    }
  >,
): "added" | "removed" {
  return event.kind === "blocked_by_added" || event.kind === "blocking_added" ? "added" : "removed";
}

function dependencyRelatedItem(
  event: Extract<
    GitHubTimelineEvent,
    {
      kind: "blocked_by_added" | "blocked_by_removed" | "blocking_added" | "blocking_removed";
    }
  >,
): GitHubReferencedItem | null | Readonly<{ status: "unavailable" }> {
  if ("blockingIssue" in event) {
    return event.blockingIssue;
  }
  if ("blockedIssue" in event) {
    return event.blockedIssue;
  }
  throw new TypeError("依存関係イベントの相手項目がありません");
}

function adaptFreshDependencyEvent(
  originItemNodeId: GraphNodeId,
  event: Extract<
    GitHubTimelineEvent,
    {
      kind: "blocked_by_added" | "blocked_by_removed" | "blocking_added" | "blocking_removed";
    }
  >,
): DependencyReplayInputEvent {
  const direction = dependencyEventDirection(event);
  const action = dependencyEventAction(event);
  const relatedItem = dependencyRelatedItem(event);
  if (relatedItem == null || "status" in relatedItem) {
    return Object.freeze({
      status: "unresolved",
      sourceId: event.sourceId,
      originItemNodeId,
      direction,
      action,
      occurredAt: event.occurredAt,
      sequence: event.sequence,
      reason: "related_node_unavailable",
    });
  }
  const fromNodeId = direction === "blocked_by" ? relatedItem.nodeId : originItemNodeId;
  const toNodeId = direction === "blocked_by" ? originItemNodeId : relatedItem.nodeId;
  return Object.freeze({
    status: "resolved",
    sourceId: event.sourceId,
    originItemNodeId,
    fromNodeId,
    toNodeId,
    action,
    occurredAt: event.occurredAt,
    sequence: event.sequence,
  });
}

function adaptFreshDependencyEvents(
  originItemNodeId: GraphNodeId,
  events: readonly GitHubTimelineEvent[],
): readonly DependencyReplayInputEvent[] {
  return Object.freeze(
    events
      .filter(isDependencyEvent)
      .map((event) => adaptFreshDependencyEvent(originItemNodeId, event)),
  );
}

function adaptCacheDependencyEvents(
  nodeId: GraphNodeId,
  history: CacheHistory,
): RelationEventHistory {
  if (history.status !== "complete") {
    return Object.freeze({ status: "unknown" });
  }
  const events: DependencyReplayInputEvent[] = [];
  for (const event of history.events) {
    if (
      event.kind !== "blocked_by_added" &&
      event.kind !== "blocked_by_removed" &&
      event.kind !== "blocking_added" &&
      event.kind !== "blocking_removed"
    ) {
      continue;
    }
    const direction =
      event.kind === "blocked_by_added" || event.kind === "blocked_by_removed"
        ? "blocked_by"
        : "blocking";
    const action =
      event.kind === "blocked_by_added" || event.kind === "blocking_added" ? "added" : "removed";
    if (event.relatedNodeIds.length === 0) {
      events.push(
        Object.freeze({
          status: "unresolved",
          sourceId: event.sourceId,
          originItemNodeId: nodeId,
          direction,
          action,
          occurredAt: event.occurredAt,
          sequence: event.sequence,
          reason: "related_node_unavailable",
        }),
      );
      continue;
    }
    if (event.relatedNodeIds.length !== 1) {
      return Object.freeze({ status: "unknown" });
    }
    const relatedNodeId = event.relatedNodeIds[0];
    if (relatedNodeId == null || relatedNodeId === nodeId) {
      return Object.freeze({ status: "unknown" });
    }
    events.push(
      Object.freeze({
        status: "resolved",
        sourceId: event.sourceId,
        originItemNodeId: nodeId,
        fromNodeId: direction === "blocked_by" ? relatedNodeId : nodeId,
        toNodeId: direction === "blocked_by" ? nodeId : relatedNodeId,
        action,
        occurredAt: event.occurredAt,
        sequence: event.sequence,
      }),
    );
  }
  return Object.freeze({
    status: "exact",
    events: Object.freeze(events),
  });
}

function relationNodeReference(node: RelationCandidateNode): RelationEndpoint {
  return Object.freeze({
    nodeId: node.nodeId,
    repositoryOwner: node.repositoryOwner,
    repositoryName: node.repositoryName,
    itemType: node.kind === "external_reference" ? node.githubItemType : node.kind,
    number: node.number,
  });
}

function cacheRelationNodeReference(node: CacheCandidateNode): RelationEndpoint {
  if (node.scope === "organization") {
    if (node.kind === "external_reference") {
      throw new TypeError("organization relation nodeのkindが不正です");
    }
    return Object.freeze({
      nodeId: createGitHubNodeId(node.nodeId),
      repositoryOwner: node.repositoryOwner,
      repositoryName: node.repositoryName,
      itemType: node.kind,
      number: node.number,
    });
  }
  if (node.githubItemType == null) {
    throw new TypeError("cache relation nodeのGitHub item種別がありません");
  }
  return Object.freeze({
    nodeId: createExternalReferenceNodeId(node.nodeId),
    repositoryOwner: node.repositoryOwner,
    repositoryName: node.repositoryName,
    itemType: node.githubItemType,
    number: node.number,
  });
}

function relationNodes(
  relation: RelationCandidate["relation"],
): readonly [RelationCandidateNode, RelationCandidateNode] {
  switch (relation.type) {
    case "blocks":
      return [relation.blocker, relation.blocked];
    case "parent_of":
      return [relation.parent, relation.subtask];
    case "implements":
      return [relation.implementation, relation.target];
    case "unclassified":
      return [relation.referencing, relation.referenced];
  }
}

function cacheRelationNodes(
  relation: GitHubItemCacheRelationCandidate["relation"],
): readonly [CacheCandidateNode, CacheCandidateNode] {
  switch (relation.type) {
    case "blocks":
      return [relation.blocker, relation.blocked];
    case "parent_of":
      return [relation.parent, relation.subtask];
    case "implements":
      return [relation.implementation, relation.target];
    case "unclassified":
      return [relation.referencing, relation.referenced];
  }
}

function relationReferenceMatches(left: RelationReference, right: RelationReference): boolean {
  return (
    left.repositoryOwner.toLowerCase() === right.repositoryOwner.toLowerCase() &&
    left.repositoryName.toLowerCase() === right.repositoryName.toLowerCase() &&
    left.number === right.number &&
    (left.itemType == null || right.itemType === left.itemType)
  );
}

function relationEndpointMatches(left: RelationEndpoint, right: RelationReference): boolean {
  return relationReferenceMatches(left, right);
}

function edgeKey(edge: DependencyReplayEdge): string {
  return `${edge.fromNodeId}\u0000${edge.toNodeId}`;
}

function compareEdges(left: DependencyReplayEdge, right: DependencyReplayEdge): -1 | 0 | 1 {
  const fromOrder = compareStrings(left.fromNodeId, right.fromNodeId);
  return fromOrder === 0 ? compareStrings(left.toNodeId, right.toNodeId) : fromOrder;
}

function relationMutationEvent(
  originItemNodeId: GraphNodeId,
  mutation: Pick<RelationMutation, "relation" | "action" | "editedAt" | "sourceId" | "sequence">,
  endpoints: readonly RelationEndpoint[],
  canonicalEdges: readonly DependencyReplayEdge[],
  historicalExactBlocksEdges: readonly DependencyReplayEdge[],
): RelationEventResolution {
  const targetNodeIds = new Set(
    endpoints
      .filter(
        (endpoint) =>
          endpoint.nodeId !== originItemNodeId &&
          relationEndpointMatches(endpoint, mutation.relation),
      )
      .map((endpoint) => endpoint.nodeId),
  );
  const preferredEdges =
    mutation.action === "removed" ? historicalExactBlocksEdges : canonicalEdges;
  const fallbackEdges = mutation.action === "removed" ? canonicalEdges : historicalExactBlocksEdges;
  const matchingEdges = (edges: readonly DependencyReplayEdge[]): readonly DependencyReplayEdge[] =>
    edges.filter((edge) =>
      edge.fromNodeId === originItemNodeId
        ? targetNodeIds.has(edge.toNodeId)
        : edge.toNodeId === originItemNodeId && targetNodeIds.has(edge.fromNodeId),
    );
  const preferredMatches = matchingEdges(preferredEdges);
  const possibleEdges =
    preferredMatches.length === 0 ? matchingEdges(fallbackEdges) : preferredMatches;
  const edgeKeys = new Set(possibleEdges.map(edgeKey));
  if (edgeKeys.size !== 1) {
    return Object.freeze({ status: "unknown" });
  }
  const edge = possibleEdges[0];
  if (edge == null) {
    return Object.freeze({ status: "unknown" });
  }
  return Object.freeze({
    status: "resolved",
    event: Object.freeze({
      status: "resolved",
      sourceId: mutation.sourceId,
      originItemNodeId,
      fromNodeId: edge.fromNodeId,
      toNodeId: edge.toNodeId,
      action: mutation.action,
      occurredAt: mutation.editedAt,
      sequence: mutation.sequence,
    }),
  });
}

function assertRelationMutationSourceKind(contentSourceId: SourceId): void {
  const kind = parseSourceId(contentSourceId).kind;
  if (kind !== "github_item_body" && kind !== "github_issue_comment") {
    throw new TypeError(`relation mutationのcontent source kindが不正です。対象: ${kind}`);
  }
}

function createRelationMutationHistory(
  originItemNodeId: GraphNodeId,
  results: readonly FreshRelationMutationResult[],
  endpoints: readonly RelationEndpoint[],
  canonicalEdges: readonly DependencyReplayEdge[],
  historicalExactBlocksEdges: readonly DependencyReplayEdge[],
  unknownRelationMutations: TemporalBlocksUnknownRelationMutation[],
): RelationEventHistory {
  const events: DependencyReplayInputEvent[] = [];
  for (const sourceResult of results) {
    if (sourceResult.result.status !== "available") {
      unknownRelationMutations.push(
        createUnknownRelationMutation(
          originItemNodeId,
          sourceResult.contentSourceId,
          sourceResult.result.reason,
          {
            sourceId: sourceResult.result.sourceId ?? null,
            editedAt: sourceResult.result.editedAt ?? null,
            sequence: sourceResult.result.sequence ?? null,
          },
        ),
      );
      continue;
    }
    if (sourceResult.result.temporalKnowledge.status !== "exact") {
      unknownRelationMutations.push(
        createUnknownRelationMutation(
          originItemNodeId,
          sourceResult.contentSourceId,
          sourceResult.result.temporalKnowledge.reason,
          { sourceId: null, editedAt: null, sequence: null },
        ),
      );
      continue;
    }
    for (const mutation of sourceResult.result.mutations) {
      const resolved = relationMutationEvent(
        originItemNodeId,
        mutation,
        endpoints,
        canonicalEdges,
        historicalExactBlocksEdges,
      );
      if (resolved.status === "unknown") {
        unknownRelationMutations.push(
          createUnknownRelationMutation(
            originItemNodeId,
            sourceResult.contentSourceId,
            "relation_endpoint_unavailable",
            {
              sourceId: mutation.sourceId,
              editedAt: mutation.editedAt,
              sequence: mutation.sequence,
            },
          ),
        );
        continue;
      }
      events.push(resolved.event);
    }
  }
  return Object.freeze({ status: "exact", events: Object.freeze(events) });
}

function createCachedRelationMutationHistory(
  originItemNodeId: GraphNodeId,
  results: readonly CachedRelationMutationResult[],
  endpoints: readonly RelationEndpoint[],
  canonicalEdges: readonly DependencyReplayEdge[],
  historicalExactBlocksEdges: readonly DependencyReplayEdge[],
  unknownRelationMutations: TemporalBlocksUnknownRelationMutation[],
): RelationEventHistory {
  const events: DependencyReplayInputEvent[] = [];
  for (const result of results) {
    assertRelationMutationSourceKind(result.contentSourceId);
    if (result.status !== "available") {
      unknownRelationMutations.push(
        createUnknownRelationMutation(originItemNodeId, result.contentSourceId, result.reason, {
          sourceId: result.sourceId ?? null,
          editedAt: result.editedAt ?? null,
          sequence: result.sequence ?? null,
        }),
      );
      continue;
    }
    if (result.temporalKnowledge.status !== "exact") {
      unknownRelationMutations.push(
        createUnknownRelationMutation(
          originItemNodeId,
          result.contentSourceId,
          result.temporalKnowledge.reason,
          {
            sourceId: null,
            editedAt: null,
            sequence: null,
          },
        ),
      );
      continue;
    }
    for (const mutation of result.mutations) {
      const resolved = relationMutationEvent(
        originItemNodeId,
        mutation,
        endpoints,
        canonicalEdges,
        historicalExactBlocksEdges,
      );
      if (resolved.status === "unknown") {
        unknownRelationMutations.push(
          createUnknownRelationMutation(
            originItemNodeId,
            result.contentSourceId,
            "relation_endpoint_unavailable",
            {
              sourceId: mutation.sourceId,
              editedAt: mutation.editedAt,
              sequence: mutation.sequence,
            },
          ),
        );
        continue;
      }
      events.push(resolved.event);
    }
  }
  return Object.freeze({ status: "exact", events: Object.freeze(events) });
}

function createRelationEndpoints(
  candidates: readonly RelationCandidate[],
): readonly RelationEndpoint[] {
  return Object.freeze(
    candidates.flatMap((candidate) =>
      relationNodes(candidate.relation).map((node) => relationNodeReference(node)),
    ),
  );
}

function createCacheRelationEndpoints(
  candidates: readonly GitHubItemCacheRelationCandidate[],
): readonly RelationEndpoint[] {
  return Object.freeze(
    candidates.flatMap((candidate) =>
      cacheRelationNodes(candidate.relation).map((node) => cacheRelationNodeReference(node)),
    ),
  );
}

function relationSourceSignature(event: DependencyReplayInputEvent): string {
  return JSON.stringify(["relation", event.originItemNodeId, event.occurredAt, event.sequence]);
}

function relationEventSignature(event: DependencyReplayInputEvent): string {
  if (event.status === "resolved") {
    return JSON.stringify([
      event.status,
      event.sourceId,
      event.originItemNodeId,
      event.fromNodeId,
      event.toNodeId,
      event.action,
      event.occurredAt,
      event.sequence,
    ]);
  }
  return JSON.stringify([
    event.status,
    event.sourceId,
    event.originItemNodeId,
    event.direction,
    event.action,
    event.occurredAt,
    event.sequence,
    event.reason,
  ]);
}

function mergeRelationHistories(
  histories: readonly RelationEventHistory[],
  unknownRelationMutations: readonly TemporalBlocksUnknownRelationMutation[],
): TemporalBlocksGraphReplayInput["relationHistory"] {
  const sourceSignatures = new Map<SourceId, string>();
  const sourceActionsByEdge = new Map<SourceId, Map<string, "added" | "removed">>();
  const eventsBySignature = new Map<string, DependencyReplayInputEvent>();
  for (const history of histories) {
    if (history.status !== "exact") {
      continue;
    }
    for (const event of history.events) {
      const sourceSignature = relationSourceSignature(event);
      const existingSourceSignature = sourceSignatures.get(event.sourceId);
      if (existingSourceSignature != null && existingSourceSignature !== sourceSignature) {
        throw new TypeError(
          `同じsource IDが異なる関係イベントを指しています。対象: ${event.sourceId}`,
        );
      }
      sourceSignatures.set(event.sourceId, sourceSignature);
      if (event.status === "resolved") {
        const edgeActions =
          sourceActionsByEdge.get(event.sourceId) ?? new Map<string, "added" | "removed">();
        const key = edgeKey(event);
        const existingAction = edgeActions.get(key);
        if (existingAction != null && existingAction !== event.action) {
          throw new TypeError(
            `同じsource IDの同じedgeでactionが衝突しています。対象: ${event.sourceId}`,
          );
        }
        edgeActions.set(key, event.action);
        sourceActionsByEdge.set(event.sourceId, edgeActions);
      }
      const eventSignature = relationEventSignature(event);
      if (!eventsBySignature.has(eventSignature)) {
        eventsBySignature.set(eventSignature, event);
      }
    }
  }
  const events = [...eventsBySignature.values()].sort(compareDependencyEvents);
  if (histories.some((history) => history.status === "unknown")) {
    return Object.freeze({
      status: "unknown",
      reason: "history_unavailable",
    });
  }
  return Object.freeze({
    status: "exact",
    mutations: Object.freeze(events),
    localUnknowns: Object.freeze(
      [...new Set(unknownRelationMutations.map((mutation) => mutation.originItemNodeId))]
        .sort(compareStrings)
        .map((originItemNodeId) => Object.freeze({ originItemNodeId })),
    ),
  });
}

function assertUniqueStateHistoryNodes(histories: readonly TemporalBlocksNodeStateHistory[]): void {
  const nodeIds = new Set<GraphNodeId>();
  for (const history of histories) {
    if (nodeIds.has(history.nodeId)) {
      throw new TypeError(
        `temporal blocks graphのstate historyが重複しています。対象: ${history.nodeId}`,
      );
    }
    nodeIds.add(history.nodeId);
  }
}

type TemporalBlocksGraphCurrent = Readonly<{
  nodes: readonly TemporalBlocksCurrentNode[];
  canonicalBlocksEdges: readonly DependencyReplayEdge[];
}>;

function validateCurrentGraph(current: TemporalBlocksGraphCurrent): void {
  const nodeIds = new Set<GraphNodeId>();
  for (const node of current.nodes) {
    if (nodeIds.has(node.nodeId)) {
      throw new TypeError(
        `temporal blocks graphのcurrent nodeが重複しています。対象: ${node.nodeId}`,
      );
    }
    nodeIds.add(node.nodeId);
  }
  const edgeKeys = new Set<string>();
  for (const edge of current.canonicalBlocksEdges) {
    if (!nodeIds.has(edge.fromNodeId) || !nodeIds.has(edge.toNodeId)) {
      throw new TypeError("temporal blocks graphのcurrent edgeが存在しないnodeを参照しています");
    }
    if (edge.fromNodeId === edge.toNodeId) {
      throw new TypeError("temporal blocks graphのcurrent edgeは同じnodeを接続できません");
    }
    const key = edgeKey(edge);
    if (edgeKeys.has(key)) {
      throw new TypeError(`temporal blocks graphのcurrent edgeが重複しています。対象: ${key}`);
    }
    edgeKeys.add(key);
  }
}

function assertMixedCurrentScope(scope: unknown): asserts scope is "eligible_tracked_items_only" {
  if (scope !== "eligible_tracked_items_only") {
    throw new TypeError("temporal blocks graphのcurrent scopeが不正です");
  }
}

function normalizeMixedCurrent(
  current: MixedTemporalBlocksGraphCurrent,
): TemporalBlocksGraphCurrent {
  assertMixedCurrentScope(current.scope);
  validateCurrentGraph(current);
  return Object.freeze({
    nodes: Object.freeze(
      [...current.nodes].sort((left, right) => compareStrings(left.nodeId, right.nodeId)),
    ),
    canonicalBlocksEdges: Object.freeze([...current.canonicalBlocksEdges].sort(compareEdges)),
  });
}

function assertUniqueInputEventSources(sources: readonly TemporalBlocksGraphSource[]): void {
  const sourceIds = new Set<SourceId>();
  const addSourceId = (sourceId: SourceId): void => {
    if (sourceIds.has(sourceId)) {
      throw new TypeError(`同じsource IDのイベントが重複しています。対象: ${sourceId}`);
    }
    sourceIds.add(sourceId);
  };
  for (const source of sources) {
    if (source.kind === "fresh") {
      for (const event of source.detail.timeline) {
        addSourceId(event.sourceId);
      }
      continue;
    }
    if (source.document.history.status === "complete") {
      for (const event of source.document.history.events) {
        addSourceId(event.sourceId);
      }
    }
  }
}

type TemporalBlocksGraphSource = MixedTemporalBlocksGraphItem;

function createGraphInput(
  current: TemporalBlocksGraphCurrent,
  historicalExactBlocksEdges: readonly DependencyReplayEdge[],
  relationCandidates: readonly RelationCandidate[],
  historicalExactRelationCandidates: readonly RelationCandidate[],
  cacheRelationCandidates: readonly GitHubItemCacheRelationCandidate[],
  sources: readonly TemporalBlocksGraphSource[],
): TemporalBlocksGraphReplayAdapterResult {
  const stateHistories: TemporalBlocksNodeStateHistory[] = [];
  const relationHistories: RelationEventHistory[] = [];
  const unknownRelationMutations: TemporalBlocksUnknownRelationMutation[] = [];
  const endpoints = Object.freeze([
    ...createRelationEndpoints(relationCandidates),
    ...createRelationEndpoints(historicalExactRelationCandidates),
    ...createCacheRelationEndpoints(cacheRelationCandidates),
  ]);
  assertUniqueInputEventSources(sources);
  const stateHistoryNodeIds = new Set<GraphNodeId>();
  for (const source of sources) {
    if (source.kind === "fresh") {
      if (stateHistoryNodeIds.has(source.detail.nodeId)) {
        throw new TypeError(
          `temporal blocks graphのfresh item node IDが重複しています。対象: ${source.detail.nodeId}`,
        );
      }
      stateHistoryNodeIds.add(source.detail.nodeId);
      assertCurrentState(current.nodes, source.detail.nodeId, source.replay.currentState);
      const sequences = createSequenceMap(source.detail.timeline);
      stateHistories.push(mapStateHistory(source.detail.nodeId, source.replay, sequences));
      relationHistories.push({
        status: "exact",
        events: adaptFreshDependencyEvents(source.detail.nodeId, source.detail.timeline),
      });
      const mutationResults = [
        adaptGitHubRelationMutationSource({
          kind: "item_body",
          contentSourceId: source.detail.bodySourceId,
          contentCreatedAt: source.itemCreatedAt,
          currentMarkdown: source.detail.body,
          history: source.detail.bodyUserContentEdits,
        }),
        ...source.detail.comments.map((comment) =>
          adaptGitHubRelationMutationSource({
            kind: "issue_comment",
            contentSourceId: comment.sourceId,
            contentCreatedAt: comment.createdAt,
            currentMarkdown: comment.body,
            history: comment.userContentEdits,
          }),
        ),
      ];
      relationHistories.push(
        createRelationMutationHistory(
          source.detail.nodeId,
          mutationResults,
          endpoints,
          current.canonicalBlocksEdges,
          historicalExactBlocksEdges,
          unknownRelationMutations,
        ),
      );
      continue;
    }

    if (stateHistoryNodeIds.has(source.document.nodeId)) {
      throw new TypeError(
        `temporal blocks graphのcache item node IDが重複しています。対象: ${source.document.nodeId}`,
      );
    }
    stateHistoryNodeIds.add(source.document.nodeId);
    assertCurrentState(current.nodes, source.document.nodeId, source.document.replay.currentState);
    const sequences = createSequenceMap(
      source.document.history.status === "complete" ? source.document.history.events : [],
    );
    stateHistories.push(mapCacheStateHistory(source.document, sequences));
    relationHistories.push(
      adaptCacheDependencyEvents(source.document.nodeId, source.document.history),
    );
    relationHistories.push(
      createCachedRelationMutationHistory(
        source.document.nodeId,
        source.document.relationMutations,
        endpoints,
        current.canonicalBlocksEdges,
        historicalExactBlocksEdges,
        unknownRelationMutations,
      ),
    );
  }
  assertUniqueStateHistoryNodes(stateHistories);
  const sortedStateHistories = Object.freeze(
    [...stateHistories].sort((left, right) => compareStrings(left.nodeId, right.nodeId)),
  );
  const sortedUnknownRelationMutations = Object.freeze(
    [...unknownRelationMutations].sort(compareUnknownRelationMutations),
  );
  return Object.freeze({
    input: Object.freeze({
      current,
      nodeStateHistories: sortedStateHistories,
      relationHistory: mergeRelationHistories(relationHistories, sortedUnknownRelationMutations),
    }),
    unknownRelationMutations: sortedUnknownRelationMutations,
  });
}

function createFreshSource(item: FreshTemporalBlocksItem): MixedTemporalBlocksGraphItem {
  return Object.freeze({
    kind: "fresh",
    detail: item.detail,
    itemCreatedAt: item.itemCreatedAt,
    replay: item.replay,
  });
}

function createCachedSource(document: GitHubItemCacheDocument): MixedTemporalBlocksGraphItem {
  return Object.freeze({ kind: "cached", document });
}

function createFreshInput(
  input: FreshTemporalBlocksGraphInput,
): TemporalBlocksGraphReplayAdapterResult {
  validateCurrentGraph(input.current);
  return createGraphInput(
    input.current,
    [],
    input.relationCandidates,
    [],
    [],
    input.items.map(createFreshSource),
  );
}

function createCacheInput(
  input: CachedTemporalBlocksGraphInput,
): TemporalBlocksGraphReplayAdapterResult {
  const candidates = input.documents.flatMap((document) => document.relationCandidates);
  validateCurrentGraph(input.current);
  return createGraphInput(
    input.current,
    [],
    [],
    [],
    candidates,
    input.documents.map(createCachedSource),
  );
}

function createMixedInput(
  input: MixedTemporalBlocksGraphInput,
): TemporalBlocksGraphReplayAdapterResult {
  const current = normalizeMixedCurrent(input.current);
  const cacheRelationCandidates = input.items.flatMap((item) =>
    item.kind === "cached" ? item.document.relationCandidates : [],
  );
  return createGraphInput(
    current,
    input.notificationHistory.exactBlocksEdges,
    input.relationCandidates,
    input.notificationHistory.relationCandidates,
    cacheRelationCandidates,
    input.items,
  );
}

/** fresh GitHub detailからtemporal blocks graph replay入力を正規化する。 */
export function adaptFreshTemporalBlocksGraph(
  input: FreshTemporalBlocksGraphInput,
): TemporalBlocksGraphReplayAdapterResult {
  return createFreshInput(input);
}

/** rawを含まないGitHub item cacheからtemporal blocks graph replay入力を正規化する。 */
export function adaptCachedTemporalBlocksGraph(
  input: CachedTemporalBlocksGraphInput,
): TemporalBlocksGraphReplayAdapterResult {
  return createCacheInput(input);
}

/** fresh detailとcache文書を一つのtemporal blocks graph replay入力へ正規化する。 */
export function adaptMixedTemporalBlocksGraph(
  input: MixedTemporalBlocksGraphInput,
): TemporalBlocksGraphReplayAdapterResult {
  return createMixedInput(input);
}
