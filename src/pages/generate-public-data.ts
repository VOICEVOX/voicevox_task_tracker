import {
  createLabelEffectsResolver,
  type Evidence,
  type LabelRule,
  type Relation,
  type Severity,
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
type PublicWaitingOn = PublicItemSummaryDto["waitingOn"][number];
type EvidenceSourceItem = Readonly<Pick<TrackedItem, "nodeId" | "url">>;

type PublicHistory = Readonly<{
  itemEventsByNodeId: ReadonlyMap<string, readonly PublicItemHistoryEventDto[]>;
}>;

type PublicGraph = Readonly<{
  analysis: AnalyzeGraphResult;
  nodes: readonly PublicGraphNodeDto[];
  edges: readonly PublicGraphEdgeDto[];
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

function createPublicWaitingOn(waitingOn: PublicWaitingOn): PublicWaitingOn {
  return {
    kind: waitingOn.kind,
    candidateId: waitingOn.candidateId,
    role: waitingOn.role,
    reasonSummary: waitingOn.reasonSummary,
    confidence: waitingOn.confidence,
  };
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
      waitingOn: value.waitingOn.map(createPublicWaitingOn),
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
  const itemEventsByNodeId = new Map<string, PublicItemHistoryEventDto[]>();

  for (const record of records) {
    for (const event of record.events) {
      switch (event.kind) {
        case "responsibility_set": {
          const before = responsibilities.get(event.nodeId);
          const historyEvent: PublicItemHistoryEventDto = {
            kind: "responsibility_changed",
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
            recordedAt: record.recordedAt,
            before: responsibilityHistoryValue(before),
            after: responsibilityHistoryValue(undefined),
          };
          responsibilities.delete(event.nodeId);
          appendItemHistoryEvent(itemEventsByNodeId, event.nodeId, historyEvent);
          break;
        }
        case "severity_set":
        case "severity_removed":
        case "edge_set":
        case "edge_removed": {
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
  });
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
    waitingOn: item.waitingOn.map(createPublicWaitingOn),
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
  return {
    nodes: selectedNodes,
    maxNodes: maxInitialGraphNodes,
  };
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
  const repositories = snapshot.repositories.map((repository) => ({
    id: repository.id,
    owner: repository.owner,
    name: repository.name,
    fullName: `${repository.owner}/${repository.name}`,
    observedAt: repository.observedAt,
    freshness: createRepositoryFreshness(repository),
  }));
  const summary = createPublicSummaryDto({
    schemaVersion: "5",
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
    repositories,
    items: itemSummaries,
    graph: createInitialGraph(graph, itemSummaries, input.options.maxInitialGraphNodes),
  });
  const details = createPublicDetailsDto({
    schemaVersion: "5",
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
          stallSince: item.stallSince,
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
      frontierNodeIds: [...graph.analysis.actionableFrontier],
    },
  });
  const summarySize = assertPublicSummarySize(summary, input.options.maxSummaryGzipBytes);

  return Object.freeze({
    summary,
    details,
    summarySize,
  });
}
