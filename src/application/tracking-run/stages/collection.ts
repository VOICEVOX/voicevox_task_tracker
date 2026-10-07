import type { SourceId } from "../../../domain/source-id.js";
import type { GitHubNodeId, TrackingNotificationClass } from "../../../domain/types.js";
import { createRunEvaluatedAt, type RunEvaluatedAt } from "../contracts/evaluation-time.js";
import { createCollectedStageProof } from "../contracts/proofs.js";
import type { StageState } from "../contracts/run-core.js";
import type { ContentDigestPort } from "../contracts/content-digest-port.js";
import type { ClockPort, CollectionGitHubReadPort, DelayPort } from "../ports.js";
import type { InventoryCollectedRun } from "./inventory.js";
import type { CollectionPlanningContext } from "./collection-incremental-plan.js";
import { legacyReviewRequestInspectionSourceIds } from "./collection-legacy-review-requests.js";
import { collectInitialRepositoryItems } from "./collection-repositories.js";
import {
  previousGraphAdjacentNodeIds,
  previousPersonalReminderRelationCandidateConsumerNodeIds,
  previousStaleRepositoryBlockerTopologyNodeIds,
} from "./collection-previous-state.js";
import { collectProductionItems, type CollectedItemObservations } from "./collection-production.js";
import {
  assertCollectionSourceTimes,
  createCollectionSourceCatalog,
} from "./collection-source-catalog.js";

export type CollectionSource = Readonly<{
  evaluatedAt: RunEvaluatedAt;
  trackedNodeIds: ReadonlySet<GitHubNodeId>;
  trackingNotificationClassByNodeId: ReadonlyMap<GitHubNodeId, TrackingNotificationClass>;
  analysisNodeIds: ReadonlySet<GitHubNodeId>;
  staleBlockerTopologyNodeIds: ReadonlySet<GitHubNodeId>;
  unavailableConsumerNodeIds: ReadonlySet<GitHubNodeId>;
  changedNodeIds: ReadonlySet<GitHubNodeId>;
}>;

type CollectionIndexField = Exclude<keyof CollectionSource, "evaluatedAt">;

/** 収集中の索引を配列へ固定したcanonical collection。 */
export type CanonicalCollection<Collection extends CollectionSource> = Readonly<
  Omit<Collection, CollectionIndexField> & {
    trackedNodeIds: readonly GitHubNodeId[];
    trackingNotificationClassByNodeId: readonly (readonly [
      GitHubNodeId,
      TrackingNotificationClass,
    ])[];
    analysisNodeIds: readonly GitHubNodeId[];
    staleBlockerTopologyNodeIds: readonly GitHubNodeId[];
    unavailableConsumerNodeIds: readonly GitHubNodeId[];
    changedNodeIds: readonly GitHubNodeId[];
  }
>;

/** GitHub読取と競合再取得までの待機を行う収集境界。 */
export type CollectionPort = Readonly<{
  read: CollectionGitHubReadPort;
  delay: DelayPort;
}>;

/** 一度固定した評価時刻と正規化sourceを持つrun。 */
export type CollectedRun<Collection extends Readonly<{ evaluatedAt: RunEvaluatedAt }>> = StageState<
  "collected",
  {
    approvedRepositories: InventoryCollectedRun["data"]["allowlist"]["repositories"];
    allowlistDigest: InventoryCollectedRun["data"]["allowlistDigest"];
    collection: Collection;
    sourceCatalog: readonly SourceId[];
    metrics: Readonly<{
      itemCount: number;
      changedItemCount: number;
      githubApiRemaining: number;
      staleRepositoryCount: number;
    }>;
    diagnostics: readonly string[];
  }
>;

/** 収集結果を検証し、一つの評価時刻とsource catalogを確定する。 */
export async function collectRunItems(
  inventory: InventoryCollectedRun,
  port: CollectionPort,
  clock: ClockPort,
  digest: ContentDigestPort,
): Promise<CollectedRun<CanonicalCollection<CollectedItemObservations>>> {
  const context: CollectionPlanningContext = Object.freeze({
    startedAt: inventory.core.identity.startedAt,
    config: inventory.core.config,
    executionPolicy: inventory.core.executionPolicy,
    previousState: inventory.core.previousState,
    references: Object.freeze({
      adjacentNodeIds: previousGraphAdjacentNodeIds(inventory.core.previousState),
      personalReminderRelationCandidateConsumerNodeIds:
        previousPersonalReminderRelationCandidateConsumerNodeIds(inventory.core.previousState),
      staleBlockerTopologyNodeIds: previousStaleRepositoryBlockerTopologyNodeIds(
        inventory.core.previousState,
      ),
    }),
    digest,
  });
  const initial = await collectInitialRepositoryItems(inventory, port.read, context);
  const evaluation: {
    current:
      Readonly<{ status: "pending" }> | Readonly<{ status: "captured"; value: RunEvaluatedAt }>;
  } = { current: Object.freeze({ status: "pending" }) };
  const observation = await collectProductionItems(
    port.read,
    port.delay,
    context,
    inventory.data.allowlist.repositories,
    initial,
    () => {
      if (evaluation.current.status === "captured") {
        throw new TypeError("評価時刻は一度だけ取得できます");
      }
      const value = createRunEvaluatedAt(clock.now());
      evaluation.current = Object.freeze({ status: "captured", value });
      return value;
    },
  );
  if (
    evaluation.current.status !== "captured" ||
    observation.value.evaluatedAt !== evaluation.current.value
  ) {
    throw new TypeError("収集結果の評価時刻が段階内の取得時刻と一致しません");
  }
  if (observation.value.evaluatedAt < inventory.core.identity.startedAt) {
    throw new RangeError("評価時刻がrun開始時刻より前です");
  }
  const legacyReviewRequests = await port.read.inspectLegacyReviewRequests(
    legacyReviewRequestInspectionSourceIds(inventory.core.previousState, observation.value.details),
  );
  const {
    trackedNodeIds,
    trackingNotificationClassByNodeId,
    analysisNodeIds,
    staleBlockerTopologyNodeIds,
    unavailableConsumerNodeIds,
    changedNodeIds,
    ...collectionFields
  } = observation.value;
  const collection = Object.freeze({
    ...collectionFields,
    legacyReviewRequests,
    trackedNodeIds: Object.freeze([...trackedNodeIds].sort()),
    trackingNotificationClassByNodeId: Object.freeze(
      [...trackingNotificationClassByNodeId]
        .map(([nodeId, notificationClass]) =>
          Object.freeze([nodeId, notificationClass] satisfies [
            GitHubNodeId,
            TrackingNotificationClass,
          ]),
        )
        .sort(([left], [right]) => left.localeCompare(right)),
    ),
    analysisNodeIds: Object.freeze([...analysisNodeIds].sort()),
    staleBlockerTopologyNodeIds: Object.freeze([...staleBlockerTopologyNodeIds].sort()),
    unavailableConsumerNodeIds: Object.freeze([...unavailableConsumerNodeIds].sort()),
    changedNodeIds: Object.freeze([...changedNodeIds].sort()),
  }) satisfies CanonicalCollection<CollectedItemObservations>;
  assertCollectionSourceTimes(collection, collection.evaluatedAt);
  const sourceCatalog = createCollectionSourceCatalog(collection);
  return Object.freeze({
    stage: "collected",
    core: inventory.core,
    data: Object.freeze({
      approvedRepositories: inventory.data.allowlist.repositories,
      allowlistDigest: inventory.data.allowlistDigest,
      collection,
      sourceCatalog,
      metrics: Object.freeze({
        itemCount: collection.trackedNodeIds.length,
        changedItemCount: observation.changedItemCount,
        githubApiRemaining: port.read.rateLimitSnapshot()?.remaining ?? 0,
        staleRepositoryCount: observation.staleRepositoryCount,
      }),
      diagnostics: Object.freeze([...observation.diagnostics]),
    }),
    proof: createCollectedStageProof(),
  });
}
