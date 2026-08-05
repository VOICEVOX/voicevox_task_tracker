import {
  createLabelEffectsResolver,
  type Evidence,
  type LabelRule,
  type Relation,
  type Severity,
  type Status,
  type TrackedItem,
} from "../domain/index.js";
import {
  analyzeGraph,
  type AnalyzeGraphResult,
  type GraphAnalysisNode,
  type ReconciledGraphEdge,
  type RelationCandidateId,
} from "../graph/index.js";
import {
  createStateSnapshot,
  parseStateHistoryRecords,
  serializeStateHistoryRecords,
  type SnapshotRepository,
  type StateHistoryEdge,
  type StateHistoryRecord,
  type StateHistoryResponsibility,
  type StateSnapshot,
} from "../persistence/index.js";
import { assertNonNullable } from "../util/index.js";
import {
  createEvidenceSourceUrlMap,
  resolveEvidenceSourceUrl,
  type EvidenceSourceUrlMap,
} from "./evidence-source-url.js";
import { PublicDtoSemanticError } from "./errors.js";
import {
  createPublicDetailsDto,
  createPublicSummaryDto,
  type PublicDetailsDto,
  type PublicGraphEdgeDto,
  type PublicGraphHistoryEventDto,
  type PublicGraphNodeDto,
  type PublicItemHistoryEventDto,
  type PublicItemSummaryDto,
  type PublicSummaryDto,
} from "./public-dto.js";
import { assertPagesPublicSafety, type PagesPublicSafetyInput } from "./public-safety.js";
import { assertPublicSummarySize, type PublicSummarySizeMeasurement } from "./summary-size.js";

/** 初期表示へ含めるgraph node数の既定値。 */
export const DEFAULT_INITIAL_GRAPH_NODE_LIMIT = 500;

/** 公開DTO生成時のtimezone、ラベルルール、初期graph、summaryサイズ設定。 */
export type PublicDtoGenerationOptions = Readonly<{
  clusterByRepository: boolean;
  confidenceThresholds: PublicSummaryDto["confidenceThresholds"];
  labelRules: readonly LabelRule[];
  maxInitialGraphNodes: number;
  maxSummaryGzipBytes: number;
  timezone: PublicSummaryDto["timezone"];
}>;

/** 永続化済みstateから公開DTOを生成する入力。 */
export type GeneratePublicDataInput = PagesPublicSafetyInput &
  Readonly<{
    options: PublicDtoGenerationOptions;
  }>;

/** 初期表示用と詳細用に分割した公開DTOとsummary実測値。 */
export type GeneratedPublicData = Readonly<{
  summary: PublicSummaryDto;
  details: PublicDetailsDto;
  summarySize: PublicSummarySizeMeasurement;
}>;

type ResponsibilityHistoryValue = Extract<
  PublicItemHistoryEventDto,
  Readonly<{ kind: "responsibility_changed" }>
>["before"];
type SeverityHistoryValue = Extract<
  PublicItemHistoryEventDto,
  Readonly<{ kind: "severity_changed" }>
>["before"];
type EdgeHistoryValue = PublicGraphHistoryEventDto["before"];
type EvidenceSourceItem = Readonly<Pick<TrackedItem, "nodeId" | "url">>;

type PublicHistory = Readonly<{
  itemEventsByNodeId: ReadonlyMap<string, readonly PublicItemHistoryEventDto[]>;
  graphEvents: readonly PublicGraphHistoryEventDto[];
}>;

type PublicGraph = Readonly<{
  analysis: AnalyzeGraphResult;
  nodes: readonly PublicGraphNodeDto[];
  edges: readonly PublicGraphEdgeDto[];
  analysisEdgeIdToPublicEdgeId: ReadonlyMap<string, string>;
}>;

function compareStrings(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function compareHistoryRecords(left: StateHistoryRecord, right: StateHistoryRecord): number {
  const recordedAtOrder = compareStrings(left.recordedAt, right.recordedAt);
  if (recordedAtOrder !== 0) {
    return recordedAtOrder;
  }
  return compareStrings(left.runId, right.runId);
}

function validateOptions(options: PublicDtoGenerationOptions): void {
  if (typeof options.clusterByRepository !== "boolean") {
    throw new PublicDtoSemanticError("clusterByRepositoryはbooleanにしてください");
  }
  if (!Number.isInteger(options.maxInitialGraphNodes) || options.maxInitialGraphNodes <= 0) {
    throw new PublicDtoSemanticError("maxInitialGraphNodesは正の整数にしてください");
  }
}

function validateHistoryRecords(
  records: readonly StateHistoryRecord[],
  generatedAt: string,
): readonly StateHistoryRecord[] {
  if (records.length === 0) {
    return Object.freeze([]);
  }
  const validated = parseStateHistoryRecords(serializeStateHistoryRecords(records));
  const runIds = validated.map((record) => record.runId);
  if (new Set(runIds).size !== runIds.length) {
    throw new PublicDtoSemanticError("history recordのrun IDが重複しています");
  }
  if (validated.some((record) => record.recordedAt > generatedAt)) {
    throw new PublicDtoSemanticError("snapshot生成後のhistory recordを公開できません");
  }
  return Object.freeze([...validated].sort(compareHistoryRecords));
}

function responsibilityHistoryValue(
  value: StateHistoryResponsibility | undefined,
): ResponsibilityHistoryValue {
  if (value == null) {
    return {
      state: "absent",
    };
  }
  return {
    state: "present",
    value: {
      status: value.status,
      waitingOn: value.waitingOn.map((waitingOn) => ({
        ...waitingOn,
        sourceIds: [...waitingOn.sourceIds],
      })),
    },
  };
}

function severityHistoryValue(value: Severity | undefined): SeverityHistoryValue {
  if (value == null) {
    return {
      state: "absent",
    };
  }
  return {
    state: "present",
    value,
  };
}

function edgeHistoryValue(value: StateHistoryEdge | undefined): EdgeHistoryValue {
  if (value == null) {
    return {
      state: "absent",
    };
  }
  return {
    state: "present",
    value: {
      ...value,
      evidence: value.evidence.map((entry) => ({ ...entry })),
    },
  };
}

function appendItemHistoryEvent(
  eventsByNodeId: Map<string, PublicItemHistoryEventDto[]>,
  nodeId: string,
  event: PublicItemHistoryEventDto,
): void {
  const events = eventsByNodeId.get(nodeId);
  if (events == null) {
    eventsByNodeId.set(nodeId, [event]);
    return;
  }
  events.push(event);
}

function createPublicHistory(records: readonly StateHistoryRecord[]): PublicHistory {
  const responsibilities = new Map<string, StateHistoryResponsibility>();
  const severities = new Map<string, Severity>();
  const edges = new Map<string, StateHistoryEdge>();
  const itemEventsByNodeId = new Map<string, PublicItemHistoryEventDto[]>();
  const graphEvents: PublicGraphHistoryEventDto[] = [];

  for (const record of records) {
    for (const event of record.events) {
      switch (event.kind) {
        case "responsibility_set": {
          const before = responsibilities.get(event.nodeId);
          const historyEvent: PublicItemHistoryEventDto = {
            kind: "responsibility_changed",
            runId: record.runId,
            recordedAt: record.recordedAt,
            before: responsibilityHistoryValue(before),
            after: responsibilityHistoryValue(event.value),
          };
          responsibilities.set(event.nodeId, event.value);
          appendItemHistoryEvent(itemEventsByNodeId, event.nodeId, historyEvent);
          break;
        }
        case "responsibility_removed": {
          const before = responsibilities.get(event.nodeId);
          if (before == null) {
            throw new PublicDtoSemanticError(
              `責務履歴の削除対象がありません。node ID: ${event.nodeId}`,
            );
          }
          const historyEvent: PublicItemHistoryEventDto = {
            kind: "responsibility_changed",
            runId: record.runId,
            recordedAt: record.recordedAt,
            before: responsibilityHistoryValue(before),
            after: responsibilityHistoryValue(undefined),
          };
          responsibilities.delete(event.nodeId);
          appendItemHistoryEvent(itemEventsByNodeId, event.nodeId, historyEvent);
          break;
        }
        case "severity_set": {
          const before = severities.get(event.nodeId);
          const historyEvent: PublicItemHistoryEventDto = {
            kind: "severity_changed",
            runId: record.runId,
            recordedAt: record.recordedAt,
            before: severityHistoryValue(before),
            after: severityHistoryValue(event.value),
          };
          severities.set(event.nodeId, event.value);
          appendItemHistoryEvent(itemEventsByNodeId, event.nodeId, historyEvent);
          break;
        }
        case "severity_removed": {
          const before = severities.get(event.nodeId);
          if (before == null) {
            throw new PublicDtoSemanticError(
              `severity履歴の削除対象がありません。node ID: ${event.nodeId}`,
            );
          }
          const historyEvent: PublicItemHistoryEventDto = {
            kind: "severity_changed",
            runId: record.runId,
            recordedAt: record.recordedAt,
            before: severityHistoryValue(before),
            after: severityHistoryValue(undefined),
          };
          severities.delete(event.nodeId);
          appendItemHistoryEvent(itemEventsByNodeId, event.nodeId, historyEvent);
          break;
        }
        case "edge_set": {
          const before = edges.get(event.relationId);
          const historyEvent: PublicGraphHistoryEventDto = {
            kind: "edge_changed",
            runId: record.runId,
            recordedAt: record.recordedAt,
            relationId: event.relationId,
            before: edgeHistoryValue(before),
            after: edgeHistoryValue(event.value),
          };
          edges.set(event.relationId, event.value);
          graphEvents.push(historyEvent);
          break;
        }
        case "edge_removed": {
          const before = edges.get(event.relationId);
          if (before == null) {
            throw new PublicDtoSemanticError(
              `edge履歴の削除対象がありません。relation ID: ${event.relationId}`,
            );
          }
          const historyEvent: PublicGraphHistoryEventDto = {
            kind: "edge_changed",
            runId: record.runId,
            recordedAt: record.recordedAt,
            relationId: event.relationId,
            before: edgeHistoryValue(before),
            after: edgeHistoryValue(undefined),
          };
          edges.delete(event.relationId);
          graphEvents.push(historyEvent);
          break;
        }
        case "repository_excluded": {
          break;
        }
      }
    }
  }

  return Object.freeze({
    itemEventsByNodeId: new Map(
      [...itemEventsByNodeId.entries()].map(([nodeId, events]) => [
        nodeId,
        Object.freeze([...events]),
      ]),
    ),
    graphEvents: Object.freeze(graphEvents),
  });
}

function analysisEdgeId(index: number): RelationCandidateId {
  return `rel:public-dto:${index.toString()}`;
}

function createAnalysisEdge(relation: Relation, index: number): ReconciledGraphEdge {
  const fields = {
    id: analysisEdgeId(index),
    fromNodeId: relation.fromNodeId,
    toNodeId: relation.toNodeId,
    type: relation.type,
    provenance: relation.provenance,
    confidence: relation.confidence,
    evidence: relation.evidence,
    authoritative: relation.provenance === "native",
    contradictions: relation.contradictions.map((contradiction) => ({
      verdict: contradiction.verdict,
      confidence: contradiction.confidence,
      evidence: [],
    })),
    firstSeenAt: relation.firstSeenAt,
    lastConfirmedAt: relation.lastConfirmedAt,
  };
  if (relation.active) {
    return {
      ...fields,
      active: true,
    };
  }
  return {
    ...fields,
    active: false,
    removedAt: relation.removedAt,
  };
}

function createPublicEvidenceEntry(
  entry: Evidence,
  sourceItems: readonly EvidenceSourceItem[],
  sourceOwnersById: EvidenceSourceUrlMap,
): PublicGraphEdgeDto["evidence"][number] {
  return {
    sourceId: entry.sourceId,
    supports: entry.supports,
    summary: entry.summary,
    sourceUrl: resolveEvidenceSourceUrl(entry.sourceId, sourceItems, sourceOwnersById),
  };
}

function createPublicEvidence(
  evidence: readonly Evidence[],
  sourceItem: EvidenceSourceItem,
  sourceOwnersById: EvidenceSourceUrlMap,
): PublicGraphEdgeDto["evidence"] {
  return evidence.map((entry) => createPublicEvidenceEntry(entry, [sourceItem], sourceOwnersById));
}

function createPublicGraphEvidence(
  relation: Relation,
  itemByNodeId: ReadonlyMap<string, TrackedItem>,
  sourceOwnersById: EvidenceSourceUrlMap,
): PublicGraphEdgeDto["evidence"] {
  const sourceItems: TrackedItem[] = [];
  const fromItem = itemByNodeId.get(relation.fromNodeId);
  const toItem = itemByNodeId.get(relation.toNodeId);
  if (fromItem != null) {
    sourceItems.push(fromItem);
  }
  if (toItem != null) {
    sourceItems.push(toItem);
  }
  return relation.evidence.map((entry) =>
    createPublicEvidenceEntry(entry, sourceItems, sourceOwnersById),
  );
}

function createPublicGraphEdge(
  relation: Relation,
  itemByNodeId: ReadonlyMap<string, TrackedItem>,
  sourceOwnersById: EvidenceSourceUrlMap,
): PublicGraphEdgeDto {
  const fields = {
    id: relation.id,
    fromNodeId: relation.fromNodeId,
    toNodeId: relation.toNodeId,
    type: relation.type,
    provenance: relation.provenance,
    confidence: relation.confidence,
    evidence: createPublicGraphEvidence(relation, itemByNodeId, sourceOwnersById),
    contradictions: relation.contradictions.map((contradiction) => ({
      verdict: contradiction.verdict,
      confidence: contradiction.confidence,
    })),
    firstSeenAt: relation.firstSeenAt,
    lastConfirmedAt: relation.lastConfirmedAt,
  };
  if (relation.active) {
    return {
      ...fields,
      active: true,
    };
  }
  return {
    ...fields,
    active: false,
    removedAt: relation.removedAt,
  };
}

function createPublicGraph(
  snapshot: StateSnapshot,
  sourceOwnersById: EvidenceSourceUrlMap,
): PublicGraph {
  const itemByNodeId = new Map<string, TrackedItem>(
    snapshot.items.map((item) => [item.nodeId, item]),
  );
  const graphNodeIds = new Set([
    ...itemByNodeId.keys(),
    ...snapshot.externalReferences.map((reference) => reference.nodeId),
  ]);
  for (const relation of snapshot.relations) {
    if (!graphNodeIds.has(relation.fromNodeId) || !graphNodeIds.has(relation.toNodeId)) {
      throw new PublicDtoSemanticError(
        `relation ${relation.id}がsnapshotにないnodeを参照しています`,
      );
    }
  }

  const analysisEdges = snapshot.relations.map(createAnalysisEdge);
  const analysisEdgeIdToPublicEdgeId = new Map(
    analysisEdges.map((edge, index) => {
      const relation = snapshot.relations[index];
      assertNonNullable(relation, `analysis edge ${edge.id}の公開edgeがありません`);
      return [edge.id, relation.id];
    }),
  );
  const analysisNodes: GraphAnalysisNode[] = [
    ...snapshot.items.map((item) =>
      Object.freeze({
        kind: item.type,
        nodeId: item.nodeId,
        repositoryId: item.repositoryId,
        state: item.state,
        directNotification: "eligible",
      } satisfies GraphAnalysisNode),
    ),
    ...snapshot.externalReferences.map((reference) =>
      Object.freeze({
        kind: reference.kind,
        nodeId: reference.nodeId,
        repositoryFullName: reference.repositoryFullName,
        state: reference.state,
        directNotification: reference.directNotification,
      } satisfies GraphAnalysisNode),
    ),
  ];
  const analysis = analyzeGraph({
    current: {
      nodes: analysisNodes,
      edges: analysisEdges,
    },
    previous: {
      availability: "unavailable",
    },
  });
  const nodes: PublicGraphNodeDto[] = snapshot.items.map((item) => ({
    nodeId: item.nodeId,
    kind: item.type,
    repositoryId: item.repositoryId,
    state: item.state,
    status: item.status,
    severity: item.severity,
  }));
  nodes.push(
    ...snapshot.externalReferences.map((reference) => ({
      nodeId: reference.nodeId,
      kind: reference.kind,
      repositoryFullName: reference.repositoryFullName,
      displayReference: `${reference.repositoryFullName}#${reference.number.toString()}`,
      url: reference.url,
      title: reference.title,
      state: reference.state,
    })),
  );
  const edges = snapshot.relations.map((relation) =>
    createPublicGraphEdge(relation, itemByNodeId, sourceOwnersById),
  );

  return Object.freeze({
    analysis,
    nodes: Object.freeze(nodes),
    edges: Object.freeze(edges),
    analysisEdgeIdToPublicEdgeId,
  });
}

function publicEdgeId(
  analysisEdgeIdToPublicEdgeId: ReadonlyMap<string, string>,
  analysisEdgeIdValue: string,
): string {
  const edgeId = analysisEdgeIdToPublicEdgeId.get(analysisEdgeIdValue);
  assertNonNullable(edgeId, `analysis edge ${analysisEdgeIdValue}の公開edge IDがありません`);
  return edgeId;
}

function createBlockersByNodeId(snapshot: StateSnapshot): ReadonlyMap<string, readonly string[]> {
  const itemByNodeId = new Map<string, TrackedItem>(
    snapshot.items.map((item) => [item.nodeId, item]),
  );
  const graphStateByNodeId = new Map<string, TrackedItem["state"]>();
  for (const item of snapshot.items) {
    graphStateByNodeId.set(item.nodeId, item.state);
  }
  for (const reference of snapshot.externalReferences) {
    graphStateByNodeId.set(reference.nodeId, reference.state);
  }
  const blockersByNodeId = new Map<string, Set<string>>();
  for (const relation of snapshot.relations) {
    if (!relation.active || relation.type !== "blocks") {
      continue;
    }
    const blockerState = graphStateByNodeId.get(relation.fromNodeId);
    const blocked = itemByNodeId.get(relation.toNodeId);
    assertNonNullable(blockerState, `blocks relation ${relation.id}のblockerがありません`);
    assertNonNullable(blocked, `blocks relation ${relation.id}のblocked itemがありません`);
    if (blockerState !== "open" || blocked.state !== "open") {
      continue;
    }
    const blockers = blockersByNodeId.get(blocked.nodeId);
    if (blockers == null) {
      blockersByNodeId.set(blocked.nodeId, new Set([relation.fromNodeId]));
    } else {
      blockers.add(relation.fromNodeId);
    }
  }
  return new Map(
    [...blockersByNodeId.entries()].map(([nodeId, blockerNodeIds]) => [
      nodeId,
      Object.freeze([...blockerNodeIds].sort(compareStrings)),
    ]),
  );
}

function createRepositoryFreshness(
  repository: SnapshotRepository,
):
  | Readonly<{ status: "fresh" }>
  | Readonly<{ status: "stale"; failedAt: SnapshotRepository["observedAt"] }> {
  if (repository.freshness === "fresh") {
    return {
      status: "fresh",
    };
  }
  return {
    status: "stale",
    failedAt: repository.failedAt,
  };
}

function createItemSummary(
  item: StateSnapshot["items"][number],
  repository: SnapshotRepository,
  blockerNodeIds: readonly string[],
  downstreamImpact: AnalyzeGraphResult["downstreamImpacts"][number],
  priorityWeight: number,
): PublicItemSummaryDto {
  return {
    nodeId: item.nodeId,
    type: item.type,
    repositoryId: item.repositoryId,
    displayReference: item.displayReference,
    number: item.number,
    url: item.url,
    title: item.title,
    milestone:
      item.milestone == null
        ? null
        : {
            ...item.milestone,
          },
    state: item.state,
    author:
      item.author.status === "unavailable"
        ? {
            ...item.author,
          }
        : {
            ...item.author,
            actor: {
              ...item.author.actor,
            },
          },
    assignees: item.assignees.map((assignee) => ({
      ...assignee,
    })),
    status: item.status,
    waitingOn: item.waitingOn.map((waitingOn) => ({
      ...waitingOn,
      sourceIds: [...waitingOn.sourceIds],
    })),
    primaryWaitingOn: {
      ...item.primaryWaitingOn,
    },
    nextAction: item.nextAction,
    severity: item.severity,
    importance: {
      score: item.importance.score,
      level: item.importance.level,
    },
    priorityWeight,
    confidence: item.confidence,
    githubUpdatedAt: item.githubUpdatedAt,
    stallSince: item.stallSince,
    observedAt: item.observedAt,
    repositoryFreshness: repository.freshness,
    blockerNodeIds: [...blockerNodeIds],
    downstreamImpact: {
      ...downstreamImpact,
    },
  };
}

function severityRank(severity: Severity): number {
  switch (severity) {
    case "none":
      return 0;
    case "watch":
      return 1;
    case "urgent":
      return 2;
    case "critical":
      return 3;
  }
}

function graphNodeSeverity(node: PublicGraphNodeDto): Severity {
  return node.kind === "external_reference" ? "none" : node.severity;
}

function graphNodeImpact(
  node: PublicGraphNodeDto,
  impactByNodeId: ReadonlyMap<string, AnalyzeGraphResult["downstreamImpacts"][number]>,
): Readonly<{
  openNodeCount: number;
  repositoryCount: number;
}> {
  const impact = impactByNodeId.get(node.nodeId);
  assertNonNullable(impact, `node ${node.nodeId}のimpactがありません`);
  return impact;
}

function createInitialGraph(
  graph: PublicGraph,
  items: readonly PublicItemSummaryDto[],
  components: PublicDetailsDto["graph"]["components"],
  repositoryClusters: PublicDetailsDto["graph"]["repositoryClusters"],
  cycles: PublicDetailsDto["graph"]["cycles"],
  clusterByRepository: boolean,
  maxInitialGraphNodes: number,
): PublicSummaryDto["graph"] {
  const summaryByNodeId = new Map(items.map((item) => [item.nodeId, item]));
  const impactByNodeId = new Map<string, AnalyzeGraphResult["downstreamImpacts"][number]>(
    graph.analysis.downstreamImpacts.map((impact) => [impact.nodeId, impact]),
  );
  const selectedNodes = [...graph.nodes]
    .sort((left, right) => {
      const severityOrder =
        severityRank(graphNodeSeverity(right)) - severityRank(graphNodeSeverity(left));
      if (severityOrder !== 0) {
        return severityOrder;
      }
      const leftImpact = graphNodeImpact(left, impactByNodeId);
      const rightImpact = graphNodeImpact(right, impactByNodeId);
      const impactOrder = rightImpact.openNodeCount - leftImpact.openNodeCount;
      if (impactOrder !== 0) {
        return impactOrder;
      }
      const leftSummary = summaryByNodeId.get(left.nodeId);
      const rightSummary = summaryByNodeId.get(right.nodeId);
      if (left.kind === "external_reference" || right.kind === "external_reference") {
        if (left.kind === right.kind) {
          return compareStrings(left.nodeId, right.nodeId);
        }
        return left.kind === "external_reference" ? 1 : -1;
      }
      assertNonNullable(leftSummary, `node ${left.nodeId}のsummaryがありません`);
      assertNonNullable(rightSummary, `node ${right.nodeId}のsummaryがありません`);
      const stallOrder = compareStrings(leftSummary.stallSince, rightSummary.stallSince);
      if (stallOrder !== 0) {
        return stallOrder;
      }
      return compareStrings(left.nodeId, right.nodeId);
    })
    .slice(0, maxInitialGraphNodes)
    .sort((left, right) => compareStrings(left.nodeId, right.nodeId));
  const selectedNodeIds = new Set(selectedNodes.map((node) => node.nodeId));
  const selectedEdges = graph.edges
    .filter(
      (edge) =>
        edge.active && selectedNodeIds.has(edge.fromNodeId) && selectedNodeIds.has(edge.toNodeId),
    )
    .map((edge) => ({
      id: edge.id,
      fromNodeId: edge.fromNodeId,
      toNodeId: edge.toNodeId,
      type: edge.type,
    }));

  return {
    nodes: selectedNodes,
    edges: selectedEdges,
    components: components.map((component) => {
      const nodeIds = new Set(component.nodeIds);
      return {
        id: component.id,
        nodeCount: component.nodeIds.length,
        repositoryIds: [...component.repositoryIds],
        edgeCount: component.edgeIds.length,
        frontierCount: graph.analysis.actionableFrontier.filter((nodeId) => nodeIds.has(nodeId))
          .length,
        cycleCount: cycles.filter((cycle) => cycle.nodeIds.every((nodeId) => nodeIds.has(nodeId)))
          .length,
      };
    }),
    clusterByRepository,
    repositoryClusters: repositoryClusters.map((cluster) => {
      const nodeIds = new Set(cluster.nodeIds);
      return {
        repositoryId: cluster.repositoryId,
        nodeCount: cluster.nodeIds.length,
        edgeCount: cluster.edgeIds.length,
        frontierCount: graph.analysis.actionableFrontier.filter((nodeId) => nodeIds.has(nodeId))
          .length,
        cycleCount: cycles.filter((cycle) => cycle.nodeIds.every((nodeId) => nodeIds.has(nodeId)))
          .length,
      };
    }),
    frontierNodeIds: graph.analysis.actionableFrontier.filter((nodeId) =>
      selectedNodeIds.has(nodeId),
    ),
    cycles: graph.analysis.dependencyCycles
      .filter((cycle) => cycle.nodeIds.every((nodeId) => selectedNodeIds.has(nodeId)))
      .map((cycle) => ({
        id: cycle.id,
        nodeIds: [...cycle.nodeIds],
        edgeIds: cycle.edges.map((edge) =>
          publicEdgeId(graph.analysisEdgeIdToPublicEdgeId, edge.id),
        ),
      })),
    maxNodes: maxInitialGraphNodes,
    omittedNodeCount: graph.nodes.length - selectedNodes.length,
  };
}

function createStatusCounts(
  items: readonly StateSnapshot["items"][number][],
): Record<Status, number> {
  const counts: Record<Status, number> = {
    new_untriaged: 0,
    needs_maintainer_decision: 0,
    waiting_for_review: 0,
    waiting_for_author: 0,
    waiting_for_assignee: 0,
    blocked: 0,
    waiting_for_automation: 0,
    ready_to_merge: 0,
    in_progress: 0,
    unknown: 0,
    terminal_merged: 0,
    terminal_completed: 0,
    terminal_not_planned: 0,
  };
  for (const item of items) {
    counts[item.status] += 1;
  }
  return counts;
}

function createSeverityCounts(
  items: readonly StateSnapshot["items"][number][],
): Record<Severity, number> {
  const counts: Record<Severity, number> = {
    none: 0,
    watch: 0,
    urgent: 0,
    critical: 0,
  };
  for (const item of items) {
    counts[item.severity] += 1;
  }
  return counts;
}

function latestRepositoryObservedAt(repositories: readonly SnapshotRepository[]): string {
  const firstRepository = repositories[0];
  assertNonNullable(firstRepository, "公開DTOには1件以上のrepositoryが必要です");
  return repositories.reduce(
    (latest, repository) => (repository.observedAt > latest ? repository.observedAt : latest),
    firstRepository.observedAt,
  );
}

/** 永続化済みsnapshotと履歴から副作用なしで公開DTOを生成する。 */
export function generatePublicData(input: GeneratePublicDataInput): GeneratedPublicData {
  assertPagesPublicSafety(input);
  validateOptions(input.options);
  const snapshot = createStateSnapshot(input.snapshot);
  const historyRecords = validateHistoryRecords(input.historyRecords, snapshot.generatedAt);
  const history = createPublicHistory(historyRecords);
  const sourceOwnersById = createEvidenceSourceUrlMap(
    snapshot.items.flatMap((item) =>
      item.inputEvents.map((event) => ({
        ...event,
        itemNodeId: item.nodeId,
        itemUrl: item.url,
      })),
    ),
  );
  const graph = createPublicGraph(snapshot, sourceOwnersById);
  const repositoriesById = new Map(
    snapshot.repositories.map((repository) => [repository.id, repository]),
  );
  const blockersByNodeId = createBlockersByNodeId(snapshot);
  const resolveLabelEffects = createLabelEffectsResolver(input.options.labelRules);
  const impactByNodeId = new Map(
    graph.analysis.downstreamImpacts.map((impact) => [impact.nodeId, impact]),
  );
  const itemSummaries = snapshot.items.map((item) => {
    const repository = repositoriesById.get(item.repositoryId);
    const impact = impactByNodeId.get(item.nodeId);
    assertNonNullable(repository, `item ${item.nodeId}のrepositoryがありません`);
    assertNonNullable(impact, `item ${item.nodeId}のdownstream impactがありません`);
    return createItemSummary(
      item,
      repository,
      blockersByNodeId.get(item.nodeId) ?? Object.freeze([]),
      impact,
      resolveLabelEffects(`${repository.owner}/${repository.name}`, item.labels).priorityWeight,
    );
  });
  const itemCountByRepositoryId = new Map<string, number>();
  for (const item of snapshot.items) {
    itemCountByRepositoryId.set(
      item.repositoryId,
      (itemCountByRepositoryId.get(item.repositoryId) ?? 0) + 1,
    );
  }
  const repositories = snapshot.repositories.map((repository) => ({
    id: repository.id,
    owner: repository.owner,
    name: repository.name,
    fullName: `${repository.owner}/${repository.name}`,
    observedAt: repository.observedAt,
    freshness: createRepositoryFreshness(repository),
    itemCount: itemCountByRepositoryId.get(repository.id) ?? 0,
  }));
  const components = graph.analysis.connectedComponents.map((component) => {
    const repositoryIds = [
      ...new Set(
        component.nodeIds.flatMap((nodeId) => {
          const item = snapshot.items.find((candidate) => candidate.nodeId === nodeId);
          return item == null ? [] : [item.repositoryId];
        }),
      ),
    ].sort(compareStrings);
    if (repositoryIds.length === 0) {
      throw new PublicDtoSemanticError(`component ${component.id}にOrganization内itemがありません`);
    }
    return {
      id: component.id,
      nodeIds: [...component.nodeIds],
      repositoryIds,
      edgeIds: component.edges.map((edge) =>
        publicEdgeId(graph.analysisEdgeIdToPublicEdgeId, edge.id),
      ),
    };
  });
  const repositoryClusters: PublicDetailsDto["graph"]["repositoryClusters"] = input.options
    .clusterByRepository
    ? snapshot.repositories.flatMap((repository) => {
        const nodeIds = snapshot.items
          .filter((item) => item.repositoryId === repository.id)
          .map((item) => item.nodeId);
        if (nodeIds.length === 0) {
          return [];
        }
        const nodeIdSet = new Set<string>(nodeIds);
        return [
          {
            repositoryId: repository.id,
            nodeIds,
            edgeIds: graph.edges
              .filter(
                (edge) =>
                  edge.active && nodeIdSet.has(edge.fromNodeId) && nodeIdSet.has(edge.toNodeId),
              )
              .map((edge) => edge.id),
          },
        ];
      })
    : [];
  const cycles = graph.analysis.dependencyCycles.map((cycle) => ({
    id: cycle.id,
    nodeIds: [...cycle.nodeIds],
    edgeIds: cycle.edges.map((edge) => publicEdgeId(graph.analysisEdgeIdToPublicEdgeId, edge.id)),
  }));
  const summary = createPublicSummaryDto({
    schemaVersion: "3",
    runId: snapshot.run.id,
    generatedAt: snapshot.generatedAt,
    observedAt: latestRepositoryObservedAt(snapshot.repositories),
    trackingStartAt:
      snapshot.trackingStartAt.status === "fixed"
        ? snapshot.trackingStartAt.value
        : snapshot.generatedAt,
    timezone: input.options.timezone,
    ai: {
      ...snapshot.ai,
    },
    confidenceThresholds: {
      ...input.options.confidenceThresholds,
    },
    aggregates: {
      repositoryCount: snapshot.repositories.length,
      itemCount: snapshot.items.length,
      activeEdgeCount: snapshot.relations.filter((relation) => relation.active).length,
      componentCount: components.length,
      frontierCount: graph.analysis.actionableFrontier.length,
      cycleCount: cycles.length,
      unknownItemCount: snapshot.items.filter(
        (item) =>
          item.status === "unknown" ||
          item.waitingOn.some((waitingOn) => waitingOn.kind === "unknown"),
      ).length,
      staleRepositoryCount: snapshot.repositories.filter(
        (repository) => repository.freshness === "stale",
      ).length,
      staleItemCount: snapshot.items.filter((item) => {
        const repository = repositoriesById.get(item.repositoryId);
        assertNonNullable(repository, `item ${item.nodeId}のrepositoryがありません`);
        return repository.freshness === "stale";
      }).length,
      statusCounts: createStatusCounts(snapshot.items),
      severityCounts: createSeverityCounts(snapshot.items),
    },
    repositories,
    items: itemSummaries,
    graph: createInitialGraph(
      graph,
      itemSummaries,
      components,
      repositoryClusters,
      cycles,
      input.options.clusterByRepository,
      input.options.maxInitialGraphNodes,
    ),
  });
  const details = createPublicDetailsDto({
    schemaVersion: "3",
    runId: snapshot.run.id,
    generatedAt: snapshot.generatedAt,
    items: snapshot.items.map((item, index) => {
      const summaryItem = itemSummaries[index];
      assertNonNullable(summaryItem, `item ${item.nodeId}のsummaryがありません`);
      return {
        summary: summaryItem,
        importanceFactors: item.importance.factors.map((factor) => ({
          ...factor,
        })),
        timestamps: {
          createdAt: item.createdAt,
          githubUpdatedAt: item.githubUpdatedAt,
          lastHumanActivityAt: item.lastHumanActivityAt,
          lastProgressAt: item.lastProgressAt,
          statusSince: item.statusSince,
          ownerSince: item.ownerSince,
          stallSince: item.stallSince,
          observedAt: item.observedAt,
        },
        latestEventActor:
          item.latestEventActor.status === "absent"
            ? {
                ...item.latestEventActor,
              }
            : {
                ...item.latestEventActor,
                actor: {
                  ...item.latestEventActor.actor,
                },
              },
        labels: [...item.labels],
        reviewState: item.reviewState,
        checkState: item.checkState,
        aiAnalysis: {
          ...item.aiAnalysis,
        },
        inputEvents: item.inputEvents.map((event) => ({
          ...event,
        })),
        evidence: createPublicEvidence(item.evidence, item, sourceOwnersById),
        uncertainties: [...item.uncertainties],
        history: [...(history.itemEventsByNodeId.get(item.nodeId) ?? [])],
      };
    }),
    graph: {
      nodes: graph.nodes,
      edges: graph.edges,
      components,
      repositoryClusters,
      frontierNodeIds: [...graph.analysis.actionableFrontier],
      cycles,
      downstreamImpacts: graph.analysis.downstreamImpacts.map((impact) => ({
        ...impact,
      })),
      history: history.graphEvents,
    },
  });
  const summarySize = assertPublicSummarySize(summary, input.options.maxSummaryGzipBytes);

  return Object.freeze({
    summary,
    details,
    summarySize,
  });
}
