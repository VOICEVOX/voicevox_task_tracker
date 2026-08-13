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
  contentSourceId: SourceId,
  reason: TemporalBlocksUnknownRelationMutation["reason"],
  metadata: Readonly<{
    sourceId: SourceId | null;
    editedAt: UtcIsoDateTime | null;
    sequence: number | null;
  }>,
): TemporalBlocksUnknownRelationMutation {
  const diagnostic: {
    contentSourceId: SourceId;
    reason: TemporalBlocksUnknownRelationMutation["reason"];
    sourceId?: SourceId;
    editedAt?: UtcIsoDateTime;
    sequence?: number;
  } = { contentSourceId, reason };
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
  return compareStrings(left.originItemNodeId, right.originItemNodeId);
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

function relationMutationEvent(
  originItemNodeId: GraphNodeId,
  mutation: Pick<RelationMutation, "relation" | "action" | "editedAt" | "sourceId" | "sequence">,
  endpoints: readonly RelationEndpoint[],
  canonicalEdges: readonly DependencyReplayEdge[],
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
  const possibleEdges = canonicalEdges.filter((edge) =>
    edge.fromNodeId === originItemNodeId
      ? targetNodeIds.has(edge.toNodeId)
      : edge.toNodeId === originItemNodeId && targetNodeIds.has(edge.fromNodeId),
  );
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

function relationMutationSourceIsSupported(contentSourceId: SourceId): boolean {
  const kind = parseSourceId(contentSourceId).kind;
  return kind === "github_item_body" || kind === "github_issue_comment";
}

function createRelationMutationHistory(
  originItemNodeId: GraphNodeId,
  results: readonly FreshRelationMutationResult[],
  endpoints: readonly RelationEndpoint[],
  canonicalEdges: readonly DependencyReplayEdge[],
  unknownRelationMutations: TemporalBlocksUnknownRelationMutation[],
): RelationEventHistory {
  const events: DependencyReplayInputEvent[] = [];
  for (const sourceResult of results) {
    if (sourceResult.kind !== "item_body" && sourceResult.kind !== "issue_comment") {
      continue;
    }
    if (sourceResult.result.status !== "available") {
      unknownRelationMutations.push(
        createUnknownRelationMutation(sourceResult.contentSourceId, sourceResult.result.reason, {
          sourceId: sourceResult.result.sourceId ?? null,
          editedAt: sourceResult.result.editedAt ?? null,
          sequence: sourceResult.result.sequence ?? null,
        }),
      );
      continue;
    }
    if (sourceResult.result.temporalKnowledge.status !== "exact") {
      unknownRelationMutations.push(
        createUnknownRelationMutation(
          sourceResult.contentSourceId,
          sourceResult.result.temporalKnowledge.reason,
          { sourceId: null, editedAt: null, sequence: null },
        ),
      );
      continue;
    }
    for (const mutation of sourceResult.result.mutations) {
      const resolved = relationMutationEvent(originItemNodeId, mutation, endpoints, canonicalEdges);
      if (resolved.status === "unknown") {
        unknownRelationMutations.push(
          createUnknownRelationMutation(
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
  unknownRelationMutations: TemporalBlocksUnknownRelationMutation[],
): RelationEventHistory {
  const events: DependencyReplayInputEvent[] = [];
  for (const result of results) {
    if (!relationMutationSourceIsSupported(result.contentSourceId)) {
      const kind = parseSourceId(result.contentSourceId).kind;
      if (kind === "github_pull_request_review_comment") {
        continue;
      }
      continue;
    }
    if (result.status !== "available") {
      unknownRelationMutations.push(
        createUnknownRelationMutation(result.contentSourceId, result.reason, {
          sourceId: result.sourceId ?? null,
          editedAt: result.editedAt ?? null,
          sequence: result.sequence ?? null,
        }),
      );
      continue;
    }
    if (result.temporalKnowledge.status !== "exact") {
      unknownRelationMutations.push(
        createUnknownRelationMutation(result.contentSourceId, result.temporalKnowledge.reason, {
          sourceId: null,
          editedAt: null,
          sequence: null,
        }),
      );
      continue;
    }
    for (const mutation of result.mutations) {
      const resolved = relationMutationEvent(originItemNodeId, mutation, endpoints, canonicalEdges);
      if (resolved.status === "unknown") {
        unknownRelationMutations.push(
          createUnknownRelationMutation(result.contentSourceId, "relation_endpoint_unavailable", {
            sourceId: mutation.sourceId,
            editedAt: mutation.editedAt,
            sequence: mutation.sequence,
          }),
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
    candidates
      .filter((candidate) => candidate.relation.type === "blocks")
      .flatMap((candidate) =>
        relationNodes(candidate.relation).map((node) => relationNodeReference(node)),
      ),
  );
}

function createCacheRelationEndpoints(
  candidates: readonly GitHubItemCacheRelationCandidate[],
): readonly RelationEndpoint[] {
  return Object.freeze(
    candidates
      .filter((candidate) => candidate.relation.type === "blocks")
      .flatMap((candidate) =>
        cacheRelationNodes(candidate.relation).map((node) => cacheRelationNodeReference(node)),
      ),
  );
}

function mergeRelationHistories(
  histories: readonly RelationEventHistory[],
): TemporalBlocksGraphReplayInput["relationHistory"] {
  if (histories.some((history) => history.status === "unknown")) {
    return Object.freeze({
      status: "unknown",
      reason: "history_unavailable",
    });
  }
  const events = histories.flatMap((history) => (history.status === "exact" ? history.events : []));
  return Object.freeze({
    status: "exact",
    mutations: Object.freeze([...events].sort(compareDependencyEvents)),
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

function createFreshInput(
  input: FreshTemporalBlocksGraphInput,
): TemporalBlocksGraphReplayAdapterResult {
  const stateHistories: TemporalBlocksNodeStateHistory[] = [];
  const relationHistories: RelationEventHistory[] = [];
  const unknownRelationMutations: TemporalBlocksUnknownRelationMutation[] = [];
  const endpoints = createRelationEndpoints(input.relationCandidates);
  const stateHistoryNodeIds = new Set<GraphNodeId>();
  for (const item of input.items) {
    if (stateHistoryNodeIds.has(item.detail.nodeId)) {
      throw new TypeError(`fresh detailのnode IDが重複しています。対象: ${item.detail.nodeId}`);
    }
    stateHistoryNodeIds.add(item.detail.nodeId);
    assertCurrentState(input.current.nodes, item.detail.nodeId, item.replay.currentState);
    const sequences = createSequenceMap(item.detail.timeline);
    stateHistories.push(mapStateHistory(item.detail.nodeId, item.replay, sequences));
    relationHistories.push({
      status: "exact",
      events: adaptFreshDependencyEvents(item.detail.nodeId, item.detail.timeline),
    });
    const mutationResults = [
      adaptGitHubRelationMutationSource({
        kind: "item_body",
        contentSourceId: item.detail.bodySourceId,
        contentCreatedAt: item.itemCreatedAt,
        currentMarkdown: item.detail.body,
        history: item.detail.bodyUserContentEdits,
      }),
      ...item.detail.comments.map((comment) =>
        adaptGitHubRelationMutationSource({
          kind: "issue_comment",
          contentSourceId: comment.sourceId,
          contentCreatedAt: comment.createdAt,
          currentMarkdown: comment.body,
          history: comment.userContentEdits,
        }),
      ),
    ];
    const mutationHistory = createRelationMutationHistory(
      item.detail.nodeId,
      mutationResults,
      endpoints,
      input.current.canonicalBlocksEdges,
      unknownRelationMutations,
    );
    relationHistories.push(mutationHistory);
  }
  assertUniqueStateHistoryNodes(stateHistories);
  const sortedUnknownRelationMutations = Object.freeze(
    [...unknownRelationMutations].sort(compareUnknownRelationMutations),
  );
  return Object.freeze({
    input: Object.freeze({
      current: input.current,
      nodeStateHistories: Object.freeze(stateHistories),
      relationHistory: mergeRelationHistories(relationHistories),
    }),
    unknownRelationMutations: sortedUnknownRelationMutations,
  });
}

function createCacheInput(
  input: CachedTemporalBlocksGraphInput,
): TemporalBlocksGraphReplayAdapterResult {
  const stateHistories: TemporalBlocksNodeStateHistory[] = [];
  const relationHistories: RelationEventHistory[] = [];
  const unknownRelationMutations: TemporalBlocksUnknownRelationMutation[] = [];
  const candidates = input.documents.flatMap((document) => document.relationCandidates);
  const endpoints = createCacheRelationEndpoints(candidates);
  const stateHistoryNodeIds = new Set<GraphNodeId>();
  for (const document of input.documents) {
    if (stateHistoryNodeIds.has(document.nodeId)) {
      throw new TypeError(`cache itemのnode IDが重複しています。対象: ${document.nodeId}`);
    }
    stateHistoryNodeIds.add(document.nodeId);
    assertCurrentState(input.current.nodes, document.nodeId, document.replay.currentState);
    const sequences = createSequenceMap(
      document.history.status === "complete" ? document.history.events : [],
    );
    stateHistories.push(mapCacheStateHistory(document, sequences));
    relationHistories.push(adaptCacheDependencyEvents(document.nodeId, document.history));
    relationHistories.push(
      createCachedRelationMutationHistory(
        document.nodeId,
        document.relationMutations,
        endpoints,
        input.current.canonicalBlocksEdges,
        unknownRelationMutations,
      ),
    );
  }
  assertUniqueStateHistoryNodes(stateHistories);
  const sortedUnknownRelationMutations = Object.freeze(
    [...unknownRelationMutations].sort(compareUnknownRelationMutations),
  );
  return Object.freeze({
    input: Object.freeze({
      current: input.current,
      nodeStateHistories: Object.freeze(stateHistories),
      relationHistory: mergeRelationHistories(relationHistories),
    }),
    unknownRelationMutations: sortedUnknownRelationMutations,
  });
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
