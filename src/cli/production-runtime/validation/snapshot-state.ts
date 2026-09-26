import type { AiAnalysisRunIdentity } from "../../../codex/index.js";
import type { Config } from "../../../config/index.js";
import { calculateAttention, type GitHubNodeId, type Relation } from "../../../domain/index.js";
import type { EnumeratedGitHubItem } from "../../../github/index.js";
import type { ReconciledGraphEdge } from "../../../graph/index.js";
import {
  createStateSnapshot,
  assertPersonalReminderEvidenceClosure,
  assertPersonalReminderEvidenceRecordsClosure,
  createPersonalReminderEvidenceSourceIndex,
  type SnapshotAiState,
  type SnapshotAnalysisPlanFingerprint,
  type SnapshotCollectionItem,
  type SnapshotCollectionRepository,
  type SnapshotRepository,
  type StateSnapshot,
} from "../../../persistence/index.js";
import { assertNonNullable } from "../../../util/index.js";
import type { DailyRunInvocation } from "../../daily-transaction.js";
import {
  analysisPlanFingerprintForItem,
  createAiAnalysisRunIdentity,
} from "../analysis-identity.js";
import type {
  CodexAnalysis,
  CollectedItems,
  GraphResult,
  PendingTrackedItem,
  PersonalReminderAnalysis,
  ReducedAnalysis,
  RepositoryInventory,
  RuntimeConfiguration,
  RuntimeState,
} from "../contracts.js";
import { previousCollectionItemsByNodeId } from "../previous-state/collection.js";
import { previousSnapshot } from "../previous-state/snapshot.js";
import { pendingSnapshotTrackingStartAt } from "../tracking-start-at.js";
import { deadlineLevelForAssessment } from "./snapshot-item-ai-dependencies.js";
import { snapshotItems } from "./snapshot-items.js";

function toStateRelation(edge: ReconciledGraphEdge): Relation {
  const fields = {
    id: edge.id,
    fromNodeId: edge.fromNodeId,
    toNodeId: edge.toNodeId,
    type: edge.type,
    provenance: edge.provenance,
    confidence: edge.confidence,
    evidence: edge.evidence,
    contradictions: Object.freeze(
      edge.contradictions.map((contradiction) =>
        Object.freeze({
          verdict: contradiction.verdict,
          confidence: contradiction.confidence,
        }),
      ),
    ),
    aiDependency: edge.aiDependency,
    firstSeenAt: edge.firstSeenAt,
    lastConfirmedAt: edge.lastConfirmedAt,
  };
  if (edge.active) {
    return Object.freeze({
      ...fields,
      active: true,
    });
  }
  return Object.freeze({
    ...fields,
    active: false,
    removedAt: edge.removedAt,
  });
}

function snapshotRepositories(collection: CollectedItems): readonly SnapshotRepository[] {
  return Object.freeze(
    collection.repositoryResults.map((result) => {
      if (result.freshness === "fresh") {
        return Object.freeze({
          ...result.repository,
          observedAt: result.observedAt,
          freshness: "fresh",
        });
      }
      return Object.freeze({
        ...result.repository,
        observedAt: result.lastSuccessfulAt,
        freshness: "stale",
        failedAt: result.failedAt,
      });
    }),
  );
}

function snapshotAiState(config: Config, codexAnalysis: CodexAnalysis): SnapshotAiState {
  if (!config.ai.enabled) {
    if (codexAnalysis.run != null) {
      throw new TypeError("AIが無効ですがCodex分析結果があります");
    }
    return Object.freeze({
      enabled: false,
      available: false,
      degraded: false,
    });
  }
  const run = codexAnalysis.run;
  assertNonNullable(run, "AIが有効ですがCodex分析結果がありません");
  const degraded = run.failures.length > 0 || run.deferred.length > 0;
  if (run.results.length > 0 || !degraded) {
    return Object.freeze({
      enabled: true,
      available: true,
      degraded,
    });
  }
  return Object.freeze({
    enabled: true,
    available: false,
    degraded: true,
  });
}

function analysisPlanFingerprintForValidatedCollectionItem(
  item: SnapshotCollectionItem,
  currentItem: EnumeratedGitHubItem,
  previousItem: SnapshotCollectionItem | undefined,
  identity: AiAnalysisRunIdentity,
  detailNodeIds: ReadonlySet<GitHubNodeId>,
  trackedNodeIds: ReadonlySet<GitHubNodeId>,
  plannedNodeIds: ReadonlySet<GitHubNodeId>,
): SnapshotAnalysisPlanFingerprint {
  const currentFingerprint = analysisPlanFingerprintForItem(currentItem, identity);
  if (
    previousItem != null &&
    previousItem.itemFingerprint !== item.itemFingerprint &&
    !detailNodeIds.has(item.nodeId)
  ) {
    throw new TypeError(`項目fingerprintが変化した項目の詳細がありません。対象: ${item.nodeId}`);
  }
  if (plannedNodeIds.has(item.nodeId)) {
    if (!detailNodeIds.has(item.nodeId)) {
      throw new TypeError(`AI判定計画の詳細がありません。対象: ${item.nodeId}`);
    }
    return {
      status: "planned",
      fingerprint: currentFingerprint,
    };
  }
  if (detailNodeIds.has(item.nodeId) && !trackedNodeIds.has(item.nodeId)) {
    return {
      status: "planned",
      fingerprint: currentFingerprint,
    };
  }
  if (previousItem != null) {
    return previousItem.analysisPlanFingerprint;
  }
  return {
    status: "unplanned",
    reason: "detail_required",
  };
}

function validatedCollectionRepositories(
  state: RuntimeState,
  configuration: RuntimeConfiguration,
  collection: CollectedItems,
  codexAnalysis: CodexAnalysis,
  itemsByNodeId: ReadonlyMap<GitHubNodeId, PendingTrackedItem>,
): readonly SnapshotCollectionRepository[] {
  const identity = createAiAnalysisRunIdentity(configuration.config);
  const freshRepositoryIds = new Set(
    collection.repositoryResults
      .filter((result) => result.freshness === "fresh")
      .map((result) => result.repository.id),
  );
  const currentItemsByNodeId = new Map(
    collection.enumeratedItems.map((item) => [item.nodeId, item]),
  );
  const detailNodeIds = new Set(collection.details.map((detail) => detail.nodeId));
  const trackedNodeIds = collection.trackedNodeIds;
  const plannedNodeIds = new Set(codexAnalysis.elementPlanningByNodeId.keys());
  const previousItemsByNodeId = previousCollectionItemsByNodeId(state);
  return Object.freeze(
    collection.collectionRepositories.map((repository) => {
      if (!freshRepositoryIds.has(repository.repositoryId)) {
        return repository;
      }
      return Object.freeze({
        ...repository,
        items: Object.freeze(
          repository.items.map((item) => {
            const currentItem = currentItemsByNodeId.get(item.nodeId);
            assertNonNullable(
              currentItem,
              `fresh収集項目の列挙値がありません。対象: ${item.nodeId}`,
            );
            const previousItem = previousItemsByNodeId.get(item.nodeId);
            const currentTrackedItem = itemsByNodeId.get(item.nodeId);
            const analysisPlanFingerprint = analysisPlanFingerprintForValidatedCollectionItem(
              item,
              currentItem,
              previousItem,
              identity,
              detailNodeIds,
              trackedNodeIds,
              plannedNodeIds,
            );
            return Object.freeze({
              ...item,
              analysisPlanFingerprint,
              aiAnalysis:
                currentTrackedItem?.aiAnalysis ?? previousItem?.aiAnalysis ?? item.aiAnalysis,
            });
          }),
        ),
      });
    }),
  );
}

/** 検証済みの保存スナップショットを構築する。 */
export function createValidatedSnapshot(
  invocation: DailyRunInvocation,
  configuration: RuntimeConfiguration,
  state: RuntimeState,
  inventory: RepositoryInventory,
  collection: CollectedItems,
  codexAnalysis: CodexAnalysis,
  reduction: ReducedAnalysis,
  graph: GraphResult,
  personalReminderAnalysis: PersonalReminderAnalysis,
): StateSnapshot {
  const items = snapshotItems(
    configuration,
    state,
    inventory,
    collection,
    reduction,
    graph,
    personalReminderAnalysis,
  );
  const itemsByNodeId = new Map(items.map((item) => [item.nodeId, item]));
  const snapshot = createStateSnapshot({
    schemaVersion: "19",
    generatedAt: collection.evaluatedAt,
    trackingStartAt: pendingSnapshotTrackingStartAt(configuration, state, collection.evaluatedAt),
    ai: snapshotAiState(configuration.config, codexAnalysis),
    collection: {
      repositories: validatedCollectionRepositories(
        state,
        configuration,
        collection,
        codexAnalysis,
        itemsByNodeId,
      ),
    },
    repositories: snapshotRepositories(collection),
    items: items.map((item) => {
      const staleness = reduction.stalenessByNodeId.get(item.nodeId);
      assertNonNullable(staleness, `追跡項目 ${item.nodeId}のseverity再計算結果がありません`);
      return {
        ...item,
        attention: calculateAttention({
          importanceScore: item.importance.score,
          deadlineLevel: deadlineLevelForAssessment(
            item.deadlineAssessment,
            collection.evaluatedAt,
            configuration.config.staleness.timezone,
          ),
          deadlinePoints: configuration.config.attention.deadlinePoints,
          elapsedHours: staleness.elapsedHours,
          waitClass: staleness.waitClass,
          thresholdsHours: configuration.config.staleness.thresholdsHours,
          recencyFloor: configuration.config.attention.recencyFloor,
          levels: configuration.config.attention.levels,
        }),
        severity: staleness.severity,
        severityContext: staleness.severityContext,
      };
    }),
    graphNodeStateObservations: graph.graphNodeStateObservations,
    externalReferences: graph.externalReferences,
    relations: graph.edges.map(toStateRelation),
    run: {
      id: invocation.runId,
      status:
        reduction.runStatus === "fallback" || personalReminderAnalysis.status === "fallback"
          ? "fallback"
          : "success",
      complete: true,
    },
  });
  const expectedEvidenceBySourceId = createPersonalReminderEvidenceSourceIndex([
    ...snapshot.items.map((item) => item.evidence),
    ...snapshot.relations.map((relation) => relation.evidence),
    ...(previousSnapshot(state)?.items.map((item) => item.evidence) ?? []),
    ...(previousSnapshot(state)?.relations.map((relation) => relation.evidence) ?? []),
  ]);
  assertPersonalReminderEvidenceRecordsClosure(snapshot, expectedEvidenceBySourceId);
  assertPersonalReminderEvidenceClosure(snapshot);
  return snapshot;
}
