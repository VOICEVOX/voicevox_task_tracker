import {
  createLabelEffectsResolver,
  type Evidence,
  type GraphNodeId,
  type LabelRule,
  type Relation,
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
  type SnapshotRepository,
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

/** 検証済みsnapshotから公開DTOを生成する入力。 */
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

type PublicWaitingOn = PublicItemSummaryDto["waitingOn"][number];
type EvidenceSourceItem = Readonly<Pick<TrackedItem, "nodeId" | "url">>;

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

function validateOptions(options: PublicDtoGenerationOptions): void {
  if (!Number.isInteger(options.maxInitialGraphNodes) || options.maxInitialGraphNodes <= 0) {
    throw new PublicDtoSemanticError("maxInitialGraphNodesは正の整数にしてください");
  }
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

function createPublicLatestEventActor(
  latestEventActor: StateSnapshot["items"][number]["latestEventActor"],
): PublicDetailsDto["items"][number]["latestEventActor"] {
  if (latestEventActor.status === "absent") {
    return {
      status: latestEventActor.status,
    };
  }
  if (latestEventActor.actor.type === "system") {
    return {
      status: latestEventActor.status,
      actor: {
        type: latestEventActor.actor.type,
        name: latestEventActor.actor.name,
      },
    };
  }
  return {
    status: latestEventActor.status,
    actor: {
      type: latestEventActor.actor.type,
      login: latestEventActor.actor.login,
    },
  };
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
): PublicDetailsDto["items"][number]["evidence"][number] {
  return {
    summary: entry.summary,
    sourceUrl: resolveEvidenceSourceUrl(entry.sourceId, sourceItems, sourceOwnersById),
  };
}

function createPublicEvidence(
  evidence: readonly Evidence[],
  sourceItem: EvidenceSourceItem,
  sourceOwnersById: EvidenceSourceUrlMap,
): PublicDetailsDto["items"][number]["evidence"] {
  return evidence.map((entry) => createPublicEvidenceEntry(entry, [sourceItem], sourceOwnersById));
}

function createPublicGraphEdge(relation: Relation): PublicGraphEdgeDto {
  const fields = {
    id: relation.id,
    fromNodeId: relation.fromNodeId,
    toNodeId: relation.toNodeId,
    type: relation.type,
    provenance: relation.provenance,
    confidence: relation.confidence,
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
  };
}

function isFreshGraphRelation(
  relation: Relation,
  freshItemNodeIds: ReadonlySet<string>,
  externalReferenceNodeIds: ReadonlySet<string>,
): boolean {
  const fromIsFreshItem = freshItemNodeIds.has(relation.fromNodeId);
  const toIsFreshItem = freshItemNodeIds.has(relation.toNodeId);
  if (!fromIsFreshItem && !toIsFreshItem) {
    return false;
  }
  const fromIsEligible = fromIsFreshItem || externalReferenceNodeIds.has(relation.fromNodeId);
  const toIsEligible = toIsFreshItem || externalReferenceNodeIds.has(relation.toNodeId);
  return fromIsEligible && toIsEligible;
}

function createPublicGraph(snapshot: StateSnapshot): PublicGraph {
  const repositoriesById = new Map(
    snapshot.repositories.map((repository) => [repository.id, repository]),
  );
  const freshItemNodeIds = new Set<string>(
    snapshot.items.flatMap((item) => {
      const repository = repositoriesById.get(item.repositoryId);
      assertNonNullable(repository, `item ${item.nodeId}のrepositoryがありません`);
      return repository.freshness === "fresh" ? [item.nodeId] : [];
    }),
  );
  const externalReferenceNodeIds = new Set<string>(
    snapshot.externalReferences.map((reference) => reference.nodeId),
  );
  const graphNodeIds = new Set([
    ...snapshot.items.map((item) => item.nodeId),
    ...snapshot.externalReferences.map((reference) => reference.nodeId),
  ]);
  for (const relation of snapshot.relations) {
    if (!graphNodeIds.has(relation.fromNodeId) || !graphNodeIds.has(relation.toNodeId)) {
      throw new PublicDtoSemanticError(
        `relation ${relation.id}がsnapshotにないnodeを参照しています`,
      );
    }
  }

  const relations = snapshot.relations.filter((relation) =>
    isFreshGraphRelation(relation, freshItemNodeIds, externalReferenceNodeIds),
  );
  const graphExternalReferenceNodeIds = new Set<string>(
    relations.flatMap((relation) =>
      [relation.fromNodeId, relation.toNodeId].filter((nodeId) =>
        externalReferenceNodeIds.has(nodeId),
      ),
    ),
  );
  const items = snapshot.items.filter((item) => freshItemNodeIds.has(item.nodeId));
  const externalReferences = snapshot.externalReferences.filter((reference) =>
    graphExternalReferenceNodeIds.has(reference.nodeId),
  );
  const analysisEdges = relations.map(createAnalysisEdge);
  const analysisNodes: GraphAnalysisNode[] = [
    ...items.map((item) =>
      Object.freeze({
        kind: item.type,
        nodeId: item.nodeId,
        repositoryId: item.repositoryId,
        state: item.state,
        directNotification: "eligible",
      } satisfies GraphAnalysisNode),
    ),
    ...externalReferences.map((reference) =>
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
  const nodes: PublicGraphNodeDto[] = items.map((item) => ({
    nodeId: item.nodeId,
    kind: item.type,
    repositoryId: item.repositoryId,
    state: item.state,
    status: item.status,
    severity: item.severity,
  }));
  nodes.push(
    ...externalReferences.map((reference) => ({
      nodeId: reference.nodeId,
      kind: reference.kind,
      repositoryFullName: reference.repositoryFullName,
      displayReference: `${reference.repositoryFullName}#${reference.number.toString()}`,
      url: reference.url,
      title: reference.title,
      state: reference.state,
    })),
  );
  const edges = relations.map(createPublicGraphEdge);

  return Object.freeze({
    analysis,
    nodes: Object.freeze(nodes),
    edges: Object.freeze(edges),
  });
}

function createBlockersByNodeId(
  snapshot: StateSnapshot,
  graph: PublicGraph,
): ReadonlyMap<string, readonly string[]> {
  const graphNodeByNodeId = new Map(graph.nodes.map((node) => [node.nodeId, node]));
  const itemByNodeId = new Map<string, TrackedItem>(
    snapshot.items
      .filter((item) => {
        const graphNode = graphNodeByNodeId.get(item.nodeId);
        return graphNode != null && graphNode.kind !== "external_reference";
      })
      .map((item) => [item.nodeId, item]),
  );
  const blockersByNodeId = new Map<string, Set<string>>();
  for (const edge of graph.edges) {
    if (!edge.active || edge.type !== "blocks") {
      continue;
    }
    const blocker = graphNodeByNodeId.get(edge.fromNodeId);
    const blocked = itemByNodeId.get(edge.toNodeId);
    assertNonNullable(blocker, `blocks relation ${edge.id}のblockerがありません`);
    assertNonNullable(blocked, `blocks relation ${edge.id}のblocked itemがありません`);
    if (blocker.state !== "open" || blocked.state !== "open") {
      continue;
    }
    const blockers = blockersByNodeId.get(blocked.nodeId);
    if (blockers == null) {
      blockersByNodeId.set(blocked.nodeId, new Set([edge.fromNodeId]));
    } else {
      blockers.add(edge.fromNodeId);
    }
  }
  return new Map(
    [...blockersByNodeId.entries()].map(([nodeId, blockerNodeIds]) => [
      nodeId,
      Object.freeze([...blockerNodeIds].sort(compareStrings)),
    ]),
  );
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
    attention: {
      score: item.attention.score,
      level: item.attention.level,
    },
    priorityWeight,
    aiAnalysis: {
      status: item.aiAnalysis.status,
    },
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

function createEmptyDownstreamImpact(
  nodeId: GraphNodeId,
): AnalyzeGraphResult["downstreamImpacts"][number] {
  return {
    nodeId,
    openNodeCount: 0,
    repositoryCount: 0,
  };
}

function graphNodeAttentionScore(
  node: PublicGraphNodeDto,
  summaryByNodeId: ReadonlyMap<string, PublicItemSummaryDto>,
): number {
  if (node.kind === "external_reference") {
    return 0;
  }
  const summary = summaryByNodeId.get(node.nodeId);
  assertNonNullable(summary, `node ${node.nodeId}のsummaryがありません`);
  return summary.attention.score;
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
      const attentionOrder =
        graphNodeAttentionScore(right, summaryByNodeId) -
        graphNodeAttentionScore(left, summaryByNodeId);
      if (attentionOrder !== 0) {
        return attentionOrder;
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
    nodes: selectedNodes.map((node) =>
      node.kind === "external_reference"
        ? {
            nodeId: node.nodeId,
            kind: node.kind,
            displayReference: node.displayReference,
          }
        : {
            nodeId: node.nodeId,
            kind: node.kind,
          },
    ),
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

/** 検証済みsnapshotから副作用なしで公開DTOを生成する。 */
export function generatePublicData(input: GeneratePublicDataInput): GeneratedPublicData {
  assertPagesPublicSafety(input);
  validateOptions(input.options);
  const snapshot = createStateSnapshot(input.snapshot);
  const sourceOwnersById = createEvidenceSourceUrlMap(
    snapshot.items.flatMap((item) =>
      item.inputEvents.map((event) => ({
        ...event,
        itemNodeId: item.nodeId,
        itemUrl: item.url,
      })),
    ),
  );
  const graph = createPublicGraph(snapshot);
  const repositoriesById = new Map(
    snapshot.repositories.map((repository) => [repository.id, repository]),
  );
  const blockersByNodeId = createBlockersByNodeId(snapshot, graph);
  const resolveLabelEffects = createLabelEffectsResolver(input.options.labelRules);
  const impactByNodeId = new Map(
    graph.analysis.downstreamImpacts.map((impact) => [impact.nodeId, impact]),
  );
  const itemSummaries = snapshot.items.map((item) => {
    const repository = repositoriesById.get(item.repositoryId);
    assertNonNullable(repository, `item ${item.nodeId}のrepositoryがありません`);
    const impact =
      repository.freshness === "stale"
        ? createEmptyDownstreamImpact(item.nodeId)
        : impactByNodeId.get(item.nodeId);
    assertNonNullable(impact, `item ${item.nodeId}のdownstream impactがありません`);
    return createItemSummary(
      item,
      repository,
      repository.freshness === "stale"
        ? Object.freeze([])
        : (blockersByNodeId.get(item.nodeId) ?? Object.freeze([])),
      impact,
      resolveLabelEffects(`${repository.owner}/${repository.name}`, item.labels).priorityWeight,
    );
  });
  const repositories = snapshot.repositories.map((repository) => ({
    id: repository.id,
    name: repository.name,
    fullName: `${repository.owner}/${repository.name}`,
    freshness: {
      status: repository.freshness,
    },
  }));
  const summary = createPublicSummaryDto({
    schemaVersion: "5",
    runId: snapshot.run.id,
    generatedAt: snapshot.generatedAt,
    observedAt: latestRepositoryObservedAt(snapshot.repositories),
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
        latestEventActor: createPublicLatestEventActor(item.latestEventActor),
        labels: [...item.labels],
        reviewState: item.reviewState,
        checkState: item.checkState,
        evidence: createPublicEvidence(item.evidence, item, sourceOwnersById),
        uncertainties: [...item.uncertainties],
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
