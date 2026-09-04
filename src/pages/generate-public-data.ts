import {
  createLabelEffectsResolver,
  createUtcIsoDateTime,
  determineDeadlineLevel,
  isTerminalStatus,
  type Evidence,
  type LabelRule,
  type Relation,
  type TrackedItem,
  type NaturalLanguageDeadlineAssessmentState,
  type UtcIsoDateTime,
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
  resolveEvidenceSourceUrlForItem,
  type EvidenceSourceUrlMap,
} from "./evidence-source-url.js";
import { PublicDtoSemanticError } from "./errors.js";
import {
  createPublicDetailsDto,
  createPublicNotificationHistoryDto,
  comparePublicNotificationHistoryEntries,
  createPublicSummaryDto,
  type PublicDetailsDto,
  type PublicGraphEdgeDto,
  type PublicGraphNodeDto,
  type PublicItemHistoryEventDto,
  type PublicNotificationHistoryDto,
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
  notificationHistory: PublicNotificationHistoryDto;
  summarySize: PublicSummarySizeMeasurement;
}>;

type ResponsibilityHistoryValue = Extract<
  PublicItemHistoryEventDto,
  Readonly<{ kind: "responsibility_changed" }>
>["before"];
type PublicWaitingOn = PublicItemSummaryDto["waitingOn"][number];
type PublicCurrentImplementation = PublicItemSummaryDto["currentImplementations"][number];
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

function publicDtoGeneratedAt(
  records: readonly StateHistoryRecord[],
  snapshot: StateSnapshot,
): UtcIsoDateTime {
  let generatedAt = snapshot.generatedAt;
  for (const record of records) {
    for (const event of record.events) {
      if (event.kind !== "notification_sent") {
        continue;
      }
      if (record.runId !== snapshot.run.id) {
        if (event.sentAt > snapshot.generatedAt) {
          throw new PublicDtoSemanticError(
            "別runの通知送信時刻がsnapshot生成時刻より新しくなっています",
          );
        }
        continue;
      }
      if (event.sentAt > generatedAt) {
        generatedAt = createUtcIsoDateTime(event.sentAt);
      }
    }
  }
  return generatedAt;
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
      waitingOn: value.waitingOn.map((waitingOn) => ({
        kind: waitingOn.kind,
        candidateId: waitingOn.candidateId,
        role: waitingOn.role,
      })),
    },
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
        case "notification_sent": {
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

function createPublicNotificationHistory(
  records: readonly StateHistoryRecord[],
  repositoryAllowlist: PagesPublicSafetyInput["repositoryAllowlist"],
  repositoryInventory: readonly PagesPublicSafetyInput["repositoryInventory"][number][],
  runId: string,
  generatedAt: UtcIsoDateTime,
): PublicNotificationHistoryDto {
  const allowlistById = new Map<string, PagesPublicSafetyInput["repositoryAllowlist"][number]>(
    repositoryAllowlist.map((repository) => [repository.id, repository]),
  );
  if (allowlistById.size !== repositoryAllowlist.length) {
    throw new PublicDtoSemanticError("通知履歴の公開allowlistにrepository IDの重複があります");
  }
  const inventoryById = new Map<string, PagesPublicSafetyInput["repositoryInventory"][number]>(
    repositoryInventory.map((repository) => [repository.id, repository]),
  );
  if (inventoryById.size !== repositoryInventory.length) {
    throw new PublicDtoSemanticError("通知履歴のrepository inventoryにIDの重複があります");
  }
  const notifications: PublicNotificationHistoryDto["notifications"] = [];
  for (const record of records) {
    for (const event of record.events) {
      if (event.kind !== "notification_sent") {
        continue;
      }
      if (event.waitingOn.status === "not_recorded") {
        continue;
      }
      if (event.reasons.some((reason) => reason.threshold.status === "not_recorded")) {
        continue;
      }
      const repository = inventoryById.get(event.repositoryId);
      if (repository == null) {
        throw new PublicDtoSemanticError(
          `通知履歴のrepository ${event.repositoryId}をinventoryから解決できません`,
        );
      }
      if (repository.visibility !== "public" || repository.archived || repository.disabled) {
        throw new PublicDtoSemanticError(
          `通知履歴のrepository ${event.repositoryId}は公開対象ではありません`,
        );
      }
      const allowlistedRepository = allowlistById.get(event.repositoryId);
      if (allowlistedRepository == null) {
        throw new PublicDtoSemanticError(
          `通知履歴のrepository ${event.repositoryId}が公開allowlistにありません`,
        );
      }
      if (
        allowlistedRepository.owner !== repository.owner ||
        allowlistedRepository.name !== repository.name
      ) {
        throw new PublicDtoSemanticError(
          `通知履歴のrepository ${event.repositoryId}のidentityが一致しません`,
        );
      }
      notifications.push({
        item: {
          nodeId: event.itemNodeId,
          type: event.type,
          repositoryId: event.repositoryId,
          displayReference: event.displayReference,
          number: event.number,
          title: event.title,
          url: event.url,
        },
        waitingOn: event.waitingOn.values.map((waitingOn) => ({ ...waitingOn })),
        reasons: [...event.reasons],
        sentAt: event.sentAt,
      });
    }
  }
  notifications.sort(comparePublicNotificationHistoryEntries);
  return createPublicNotificationHistoryDto({
    schemaVersion: "4",
    runId,
    generatedAt,
    notifications,
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
  currentSourceItem: EvidenceSourceItem,
  allSourceItems: readonly EvidenceSourceItem[],
  sourceOwnersById: EvidenceSourceUrlMap,
): PublicDetailsDto["items"][number]["evidence"][number] {
  return {
    summary: entry.summary,
    sourceUrl: resolveEvidenceSourceUrlForItem(
      entry.sourceId,
      currentSourceItem,
      allSourceItems,
      sourceOwnersById,
    ),
  };
}

function createPublicEvidence(
  evidence: readonly Evidence[],
  currentSourceItem: EvidenceSourceItem,
  allSourceItems: readonly EvidenceSourceItem[],
  sourceOwnersById: EvidenceSourceUrlMap,
): PublicDetailsDto["items"][number]["evidence"] {
  return evidence.map((entry) =>
    createPublicEvidenceEntry(entry, currentSourceItem, allSourceItems, sourceOwnersById),
  );
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

function createPublicGraph(snapshot: StateSnapshot): PublicGraph {
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
  const edges = snapshot.relations.map(createPublicGraphEdge);

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

function createCurrentImplementationsByIssueNodeId(
  snapshot: StateSnapshot,
  repositoriesById: ReadonlyMap<string, SnapshotRepository>,
): ReadonlyMap<string, readonly PublicCurrentImplementation[]> {
  const itemsByNodeId = new Map<string, StateSnapshot["items"][number]>(
    snapshot.items.map((item) => [item.nodeId, item]),
  );
  const externalNodeIds = new Set<string>(
    snapshot.externalReferences.map((reference) => reference.nodeId),
  );
  const implementationsByIssueNodeId = new Map<string, Map<string, PublicCurrentImplementation>>();
  for (const relation of snapshot.relations) {
    if (!relation.active || relation.type !== "implements" || relation.provenance !== "native") {
      continue;
    }
    if (externalNodeIds.has(relation.fromNodeId) || externalNodeIds.has(relation.toNodeId)) {
      continue;
    }
    const implementation = itemsByNodeId.get(relation.fromNodeId);
    const targetIssue = itemsByNodeId.get(relation.toNodeId);
    assertNonNullable(implementation, `implements relation ${relation.id}の実装項目がありません`);
    assertNonNullable(targetIssue, `implements relation ${relation.id}の対象項目がありません`);
    if (implementation.type !== "pull_request" || targetIssue.type !== "issue") {
      continue;
    }
    if (implementation.state === "open" && isTerminalStatus(implementation.status)) {
      throw new PublicDtoSemanticError(
        `implements relation ${relation.id}の実装PRはGitHub stateがopenなのにterminal statusです`,
      );
    }
    if (targetIssue.state === "open" && isTerminalStatus(targetIssue.status)) {
      throw new PublicDtoSemanticError(
        `implements relation ${relation.id}の対象IssueはGitHub stateがopenなのにterminal statusです`,
      );
    }
    if (implementation.state !== "open" || targetIssue.state !== "open") {
      continue;
    }
    const implementationRepository = repositoriesById.get(implementation.repositoryId);
    const targetRepository = repositoriesById.get(targetIssue.repositoryId);
    assertNonNullable(
      implementationRepository,
      `implements relation ${relation.id}の実装repositoryがありません`,
    );
    assertNonNullable(
      targetRepository,
      `implements relation ${relation.id}の対象repositoryがありません`,
    );
    if (implementationRepository.freshness !== "fresh" || targetRepository.freshness !== "fresh") {
      continue;
    }
    const implementations = implementationsByIssueNodeId.get(targetIssue.nodeId);
    const currentImplementation: PublicCurrentImplementation = {
      nodeId: implementation.nodeId,
      repositoryId: implementation.repositoryId,
      displayReference: implementation.displayReference,
      number: implementation.number,
      url: implementation.url,
      title: implementation.title,
      status: implementation.status,
      waitingOn: implementation.waitingOn.map(createPublicWaitingOn),
      nextAction: implementation.nextAction,
    };
    if (implementations == null) {
      implementationsByIssueNodeId.set(
        targetIssue.nodeId,
        new Map([[implementation.nodeId, currentImplementation]]),
      );
      continue;
    }
    if (!implementations.has(implementation.nodeId)) {
      implementations.set(implementation.nodeId, currentImplementation);
    }
  }
  return new Map(
    [...implementationsByIssueNodeId.entries()].map(([issueNodeId, implementations]) => [
      issueNodeId,
      Object.freeze(
        [...implementations.values()].sort((left, right) =>
          compareStrings(left.nodeId, right.nodeId),
        ),
      ),
    ]),
  );
}

function createItemSummary(
  item: StateSnapshot["items"][number],
  repository: SnapshotRepository,
  currentImplementations: readonly PublicCurrentImplementation[],
  blockerNodeIds: readonly string[],
  downstreamImpact: AnalyzeGraphResult["downstreamImpacts"][number],
  priorityWeight: number,
  evaluatedAt: UtcIsoDateTime,
  timezone: string,
): PublicItemSummaryDto {
  return {
    nodeId: item.nodeId,
    type: item.type,
    repositoryId: item.repositoryId,
    displayReference: item.displayReference,
    number: item.number,
    url: item.url,
    title: item.title,
    deadline: createPublicDeadlineSummary(item.deadlineAssessment, evaluatedAt, timezone),
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
    currentImplementations: [...currentImplementations],
  };
}

function createPublicDeadlineSummary(
  assessment: NaturalLanguageDeadlineAssessmentState,
  evaluatedAt: UtcIsoDateTime,
  timezone: string,
): PublicItemSummaryDto["deadline"] {
  if (assessment.status === "not_available") {
    return {
      status: "not_available",
    };
  }
  return {
    status: "available",
    date: assessment.value.date,
    level: determineDeadlineLevel({
      deadlineDate: assessment.value.date,
      evaluatedAt,
      timezone,
    }),
  };
}

function createPublicDeadlineDetails(
  assessment: NaturalLanguageDeadlineAssessmentState,
  evaluatedAt: UtcIsoDateTime,
  timezone: string,
): PublicDetailsDto["items"][number]["deadline"] {
  if (assessment.status === "not_available") {
    return {
      status: "not_available",
    };
  }
  return {
    status: "available",
    date: assessment.value.date,
    level: determineDeadlineLevel({
      deadlineDate: assessment.value.date,
      evaluatedAt,
      timezone,
    }),
    rationale: assessment.value.rationale,
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

function requiredInitialGraphNodes(
  graph: PublicGraph,
  items: readonly PublicItemSummaryDto[],
): readonly PublicGraphNodeDto[] {
  const summaryItemNodeIds = new Set(items.map((item) => item.nodeId));
  const graphNodesByNodeId = new Map(graph.nodes.map((node) => [node.nodeId, node]));
  const waitingOnItemCandidateIds = new Set<string>();
  for (const item of items) {
    const waitingOnValues = [
      ...item.waitingOn,
      ...item.currentImplementations.flatMap((implementation) => implementation.waitingOn),
    ];
    for (const waitingOn of waitingOnValues) {
      if (waitingOn.kind === "item") {
        waitingOnItemCandidateIds.add(waitingOn.candidateId);
      }
    }
  }
  const requiredNodes: PublicGraphNodeDto[] = [];
  for (const candidateId of waitingOnItemCandidateIds) {
    if (summaryItemNodeIds.has(candidateId)) {
      continue;
    }
    const graphNode = graphNodesByNodeId.get(candidateId);
    if (graphNode == null) {
      throw new PublicDtoSemanticError(`waitingOn項目 ${candidateId}の公開graph nodeがありません`);
    }
    if (graphNode.kind !== "external_reference") {
      throw new PublicDtoSemanticError(
        `waitingOn項目 ${candidateId}はexternal_referenceではありません`,
      );
    }
    requiredNodes.push(graphNode);
  }
  return Object.freeze(requiredNodes);
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
  const requiredNodes = requiredInitialGraphNodes(graph, items);
  if (requiredNodes.length > maxInitialGraphNodes) {
    throw new PublicDtoSemanticError(
      `waitingOnの必須external_reference node数 ${requiredNodes.length.toString()} がinitial graph上限 ${maxInitialGraphNodes.toString()}を超えています`,
    );
  }
  const rankedNodes = [...graph.nodes].sort((left, right) => {
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
  });
  const requiredNodeIds = new Set(requiredNodes.map((node) => node.nodeId));
  const selectedNodes = [
    ...requiredNodes,
    ...rankedNodes
      .filter((node) => !requiredNodeIds.has(node.nodeId))
      .slice(0, maxInitialGraphNodes - requiredNodes.length),
  ].sort((left, right) => compareStrings(left.nodeId, right.nodeId));
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

/** 永続化済みsnapshotと履歴から副作用なしで公開DTOを生成する。 */
export function generatePublicData(input: GeneratePublicDataInput): GeneratedPublicData {
  assertPagesPublicSafety(input);
  validateOptions(input.options);
  const snapshot = createStateSnapshot(input.snapshot);
  const historyRecords = validateHistoryRecords(input.historyRecords, snapshot.generatedAt);
  const generatedAt = publicDtoGeneratedAt(historyRecords, snapshot);
  const history = createPublicHistory(historyRecords);
  const notificationHistory = createPublicNotificationHistory(
    historyRecords,
    input.repositoryAllowlist,
    input.repositoryInventory,
    snapshot.run.id,
    generatedAt,
  );
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
  const currentImplementationsByIssueNodeId = createCurrentImplementationsByIssueNodeId(
    snapshot,
    repositoriesById,
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
      currentImplementationsByIssueNodeId.get(item.nodeId) ?? Object.freeze([]),
      blockersByNodeId.get(item.nodeId) ?? Object.freeze([]),
      impact,
      resolveLabelEffects(`${repository.owner}/${repository.name}`, item.labels).priorityWeight,
      snapshot.generatedAt,
      input.options.timezone,
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
    schemaVersion: "8",
    runId: snapshot.run.id,
    generatedAt,
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
    schemaVersion: "8",
    runId: snapshot.run.id,
    generatedAt,
    items: snapshot.items.map((item, index) => {
      const summaryItem = itemSummaries[index];
      assertNonNullable(summaryItem, `item ${item.nodeId}のsummaryがありません`);
      return {
        summary: summaryItem,
        deadline: createPublicDeadlineDetails(
          item.deadlineAssessment,
          snapshot.generatedAt,
          input.options.timezone,
        ),
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
        evidence: createPublicEvidence(item.evidence, item, snapshot.items, sourceOwnersById),
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
    notificationHistory,
    summarySize,
  });
}
