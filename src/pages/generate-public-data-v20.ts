import { createLabelEffectsResolver, type LabelRule } from "../domain/index.js";
import { createStateSnapshot, type SnapshotRepository } from "../persistence/index.js";
import { assertNonNullable } from "../util/index.js";
import { PublicDtoSemanticError } from "./errors.js";
import { createEvidenceSourceUrlMap } from "./evidence-source-url.js";
import { createPublicEvidence } from "./generate-public-data-evidence.js";
import { createInitialGraph, createPublicGraph } from "./generate-public-data-graph.js";
import {
  createPublicHistory,
  publicDtoGeneratedAt,
  validateHistoryRecords,
} from "./generate-public-data-history.js";
import {
  assertPublicSummaryDetailsCurrentResponses,
  createCurrentImplementationsByIssueNodeId,
  createDisplayReferencesByNodeId,
  createItemSummary,
  createPublicDeadlineDetails,
  createPublicLatestEventActor,
} from "./generate-public-data-items.js";
import { createPublicNotificationHistory } from "./generate-public-data-notification-history.js";
import {
  createPersonalReminderResponses,
  personalReminderCausePlanningStatus,
} from "./generate-public-data-reminders.js";
import type {
  PublicDetailsDto,
  PublicNotificationHistoryDto,
  PublicSummaryDto,
} from "./public-dto-contracts.js";
import { PUBLIC_DTO_SCHEMA_VERSION } from "./public-dto-primitives.js";
import { createPublicDetailsDto, createPublicSummaryDto } from "./public-dto.js";
import {
  assertPagesOutputPublicSafety,
  assertPagesPublicSafety,
  type PagesPublicSafetyInput,
} from "./public-safety.js";
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

function validateOptions(options: PublicDtoGenerationOptions): void {
  if (!Number.isInteger(options.maxInitialGraphNodes) || options.maxInitialGraphNodes <= 0) {
    throw new PublicDtoSemanticError("maxInitialGraphNodesは正の整数にしてください");
  }
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
  const projection = snapshot.finalGraphProjection;
  if (input.options.timezone !== projection.timezone) {
    throw new PublicDtoSemanticError("公開設定のtimezoneがsnapshotの確定値と一致しません");
  }
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
  const displayReferencesByNodeId = createDisplayReferencesByNodeId(snapshot);
  const currentImplementationsByIssueNodeId = createCurrentImplementationsByIssueNodeId(
    snapshot,
    repositoriesById,
    displayReferencesByNodeId,
  );
  const projectedItemsByNodeId = new Map(projection.items.map((item) => [item.nodeId, item]));
  const resolveLabelEffects = createLabelEffectsResolver(input.options.labelRules);
  const impactByNodeId = new Map(
    projection.nodes.map((node) => [
      node.nodeId,
      { nodeId: node.nodeId, ...node.downstreamImpact },
    ]),
  );
  const itemSummaries = snapshot.items.map((item) => {
    const repository = repositoriesById.get(item.repositoryId);
    const impact = impactByNodeId.get(item.nodeId);
    const projectedItem = projectedItemsByNodeId.get(item.nodeId);
    assertNonNullable(repository, `item ${item.nodeId}のrepositoryがありません`);
    assertNonNullable(impact, `item ${item.nodeId}のdownstream impactがありません`);
    assertNonNullable(projectedItem, `item ${item.nodeId}の最終graph投影がありません`);
    const personalReminderResponses = createPersonalReminderResponses(
      item,
      snapshot.items,
      sourceOwnersById,
    );
    return createItemSummary(
      item,
      repository,
      currentImplementationsByIssueNodeId.get(item.nodeId) ?? Object.freeze([]),
      personalReminderResponses.responses,
      personalReminderResponses.currentResponsesUnverified,
      personalReminderResponses.currentResponseSubjectChanges,
      personalReminderCausePlanningStatus(item),
      displayReferencesByNodeId,
      projectedItem,
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
    schemaVersion: PUBLIC_DTO_SCHEMA_VERSION,
    runId: snapshot.run.id,
    generatedAt,
    observedAt: latestRepositoryObservedAt(snapshot.repositories),
    timezone: projection.timezone,
    ai: {
      ...snapshot.ai,
    },
    confidenceThresholds: {
      ...input.options.confidenceThresholds,
    },
    repositories,
    items: itemSummaries,
    graph: createInitialGraph(graph, itemSummaries, projection, input.options.maxInitialGraphNodes),
  });
  const details = createPublicDetailsDto({
    schemaVersion: PUBLIC_DTO_SCHEMA_VERSION,
    runId: snapshot.run.id,
    generatedAt,
    items: snapshot.items.map((item, index) => {
      const summaryItem = itemSummaries[index];
      const projectedItem = projectedItemsByNodeId.get(item.nodeId);
      assertNonNullable(summaryItem, `item ${item.nodeId}のsummaryがありません`);
      assertNonNullable(projectedItem, `item ${item.nodeId}の最終graph投影がありません`);
      return {
        summary: summaryItem,
        blockerUnverifiedReasons: projectedItem.blockerUnverifiedReasons.map((entry) => ({
          nodeId: entry.nodeId,
          reasons: [...entry.reasons],
        })),
        deadline: createPublicDeadlineDetails(item.deadlineAssessment, projectedItem.deadlineLevel),
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
      frontierNodeIds: [...projection.frontierNodeIds],
    },
  });
  assertPublicSummaryDetailsCurrentResponses(summary, details);
  assertPagesOutputPublicSafety(input, [summary, details, notificationHistory]);
  const summarySize = assertPublicSummarySize(summary, input.options.maxSummaryGzipBytes);

  return Object.freeze({
    summary,
    details,
    notificationHistory,
    summarySize,
  });
}
