import { AI_ANALYSIS_ELEMENTS } from "../../../domain/ai-analysis-elements.js";
import { assertNonNullable } from "../../../util/index.js";
import type {
  FinalSnapshotAiState,
  FinalSnapshotPlanProjection,
  FinalSnapshotProjection,
  FinalSnapshotRepository,
} from "../contracts/final-snapshot.js";
import type { PreviousCollectionRepository } from "../contracts/previous-state.js";
import type { ContentDigestPort } from "../contracts/content-digest-port.js";
import {
  analysisPlanFingerprintForItem,
  createAiAnalysisRunIdentity,
} from "./collection-analysis-fingerprint.js";
import { resolveConfiguredTrackingStartAt } from "./collection-tracking-request.js";
import type { CollectedItemObservations } from "./collection-production.js";
import type { DeterministicallyAnalyzedRun } from "./deterministic.js";
import type { GenericAiAdoptedRun } from "./generic-ai-adoption.js";
import type { GenericAiPlan } from "./generic-ai-plan-contracts.js";
import type { GraphFinalItem } from "../contracts/graph-final-item.js";

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** AI計画と収集が確定した時点で保存用の軽量入力を投影する。 */
export function projectFinalSnapshotPlan(
  analyzed: DeterministicallyAnalyzedRun,
  plan: GenericAiPlan,
  digest: ContentDigestPort,
): FinalSnapshotPlanProjection {
  const previousSnapshot = analyzed.core.previousState.snapshot;
  const previousTrackingStartAt =
    previousSnapshot.status === "available"
      ? previousSnapshot.trackingStartAt
      : Object.freeze({ status: "not_fixed" as const });
  const identity = createAiAnalysisRunIdentity(analyzed.core.config);
  const fingerprints = analyzed.data.collection.enumeratedItems.map((item) =>
    Object.freeze([item.nodeId, analysisPlanFingerprintForItem(item, identity, digest)] as const),
  );
  if (new Set(fingerprints.map(([nodeId]) => nodeId)).size !== fingerprints.length) {
    throw new TypeError("保存候補の列挙項目IDが重複しています");
  }
  return Object.freeze({
    previousTrackingStartAt,
    trackingStartAt: resolveConfiguredTrackingStartAt(
      analyzed.core.config,
      previousTrackingStartAt,
      Object.freeze({
        outcome: "incomplete",
        finishedAt: analyzed.data.collection.evaluatedAt,
      }),
    ),
    previousHistory: analyzed.core.previousState.history,
    previousNotificationLedger: analyzed.core.previousState.notificationLedger,
    verifiedExternalReferences: analyzed.data.collection.verifiedExternalReferences,
    aiEnabled: plan.aiEnabled,
    plannedNodeIds: Object.freeze(plan.items.map((item) => item.nodeId).sort()),
    analysisPlanFingerprints: Object.freeze(
      fingerprints.sort(([left], [right]) => compareStrings(left, right)),
    ),
  });
}

function snapshotRepositories(
  collection: CollectedItemObservations,
): readonly FinalSnapshotRepository[] {
  return Object.freeze(
    collection.repositoryResults
      .map((result): FinalSnapshotRepository =>
        result.freshness === "fresh"
          ? Object.freeze({
              ...result.repository,
              observedAt: result.observedAt,
              freshness: "fresh",
            })
          : Object.freeze({
              ...result.repository,
              observedAt: result.lastSuccessfulAt,
              freshness: "stale",
              failedAt: result.failedAt,
            }),
      )
      .sort((left, right) => compareStrings(left.id, right.id)),
  );
}

function collectionRepositories(
  adopted: GenericAiAdoptedRun,
  collection: CollectedItemObservations,
  finalItems: readonly GraphFinalItem[],
): readonly PreviousCollectionRepository[] {
  const freshRepositoryIds = new Set(
    collection.repositoryResults
      .filter((result) => result.freshness === "fresh")
      .map((result) => result.repository.id),
  );
  const currentItemsByNodeId = new Map(
    collection.enumeratedItems.map((item) => [item.nodeId, item]),
  );
  const detailNodeIds = new Set(collection.details.map((detail) => detail.nodeId));
  const plannedNodeIds = new Set(adopted.data.snapshotPlan.plannedNodeIds);
  const currentFingerprints = new Map(adopted.data.snapshotPlan.analysisPlanFingerprints);
  const previousSnapshot = adopted.core.graphInput.previousSnapshot;
  const previousItemsByNodeId = new Map(
    (previousSnapshot.status === "available"
      ? previousSnapshot.collectionRepositories
      : []
    ).flatMap((repository) => repository.items.map((item) => [item.nodeId, item] as const)),
  );
  const finalItemsByNodeId = new Map(finalItems.map((item) => [item.nodeId, item]));
  if (
    finalItemsByNodeId.size !== finalItems.length ||
    currentItemsByNodeId.size !== collection.enumeratedItems.length ||
    plannedNodeIds.size !== adopted.data.snapshotPlan.plannedNodeIds.length
  ) {
    throw new TypeError("保存候補の項目IDが重複しています");
  }
  return Object.freeze(
    collection.collectionRepositories
      .map((repository) => {
        if (!freshRepositoryIds.has(repository.repositoryId)) return repository;
        return Object.freeze({
          ...repository,
          items: Object.freeze(
            repository.items
              .map((item) => {
                const currentItem = currentItemsByNodeId.get(item.nodeId);
                assertNonNullable(
                  currentItem,
                  `fresh収集項目の列挙値がありません。対象: ${item.nodeId}`,
                );
                const fingerprint = currentFingerprints.get(item.nodeId);
                assertNonNullable(
                  fingerprint,
                  `fresh収集項目のAI計画fingerprintがありません。対象: ${item.nodeId}`,
                );
                const previous = previousItemsByNodeId.get(item.nodeId);
                if (
                  previous != null &&
                  previous.itemFingerprint !== item.itemFingerprint &&
                  !detailNodeIds.has(item.nodeId)
                ) {
                  throw new TypeError(
                    `項目fingerprintが変化した項目の詳細がありません。対象: ${item.nodeId}`,
                  );
                }
                if (plannedNodeIds.has(item.nodeId) && !detailNodeIds.has(item.nodeId)) {
                  throw new TypeError(`AI判定計画の詳細がありません。対象: ${item.nodeId}`);
                }
                const analysisPlanFingerprint =
                  plannedNodeIds.has(item.nodeId) ||
                  (detailNodeIds.has(item.nodeId) && !collection.trackedNodeIds.has(item.nodeId))
                    ? Object.freeze({ status: "planned" as const, fingerprint })
                    : (previous?.analysisPlanFingerprint ??
                      Object.freeze({
                        status: "unplanned" as const,
                        reason: "detail_required" as const,
                      }));
                return Object.freeze({
                  ...item,
                  analysisPlanFingerprint,
                  aiAnalysis:
                    finalItemsByNodeId.get(item.nodeId)?.aiAnalysis ??
                    previous?.aiAnalysis ??
                    item.aiAnalysis,
                });
              })
              .sort((left, right) => compareStrings(left.nodeId, right.nodeId)),
          ),
        });
      })
      .sort((left, right) => compareStrings(left.repositoryId, right.repositoryId)),
  );
}

function snapshotAiState(adopted: GenericAiAdoptedRun): FinalSnapshotAiState {
  if (!adopted.data.snapshotPlan.aiEnabled) {
    return Object.freeze({ enabled: false, available: false, degraded: false });
  }
  const degraded = adopted.data.items.some(
    (item) => item.status === "failed" || item.status === "deferred",
  );
  const available = adopted.data.items.some((item) =>
    AI_ANALYSIS_ELEMENTS.some(
      (element) => item.elements[element].application.status === "current_ai",
    ),
  );
  return available || !degraded
    ? Object.freeze({ enabled: true, available: true, degraded })
    : Object.freeze({ enabled: true, available: false, degraded: true });
}

/** 確定済みgraphとAI採用からsnapshot専用projectionを確定する。 */
export function projectFinalSnapshotGraph(
  adopted: GenericAiAdoptedRun,
  collection: CollectedItemObservations,
  finalItems: readonly GraphFinalItem[],
  graphRunStatus: "success" | "fallback",
): FinalSnapshotProjection {
  const plan = adopted.data.snapshotPlan;
  return Object.freeze({
    previousTrackingStartAt: plan.previousTrackingStartAt,
    trackingStartAt: plan.trackingStartAt,
    previousHistory: plan.previousHistory,
    previousNotificationLedger: plan.previousNotificationLedger,
    verifiedExternalReferences: plan.verifiedExternalReferences,
    repositories: snapshotRepositories(collection),
    collectionRepositories: collectionRepositories(adopted, collection, finalItems),
    ai: snapshotAiState(adopted),
    graphRunStatus,
    unavailablePersonalReminderConsumer: adopted.data.facts.unavailableConsumerNodeIds.length > 0,
  });
}
