import type { Sha256Hash } from "../../../canonical-json/sha256.js";
import type {
  ExternalGhostNode,
  GitHubNodeId,
  Relation,
  TrackingStartAtState,
  UtcIsoDateTime,
} from "../../../domain/index.js";
import type { PublicRepository } from "../../../github/public-repository-allowlist.js";
import type { VerifiedExternalReference } from "../../../domain/verified-external-reference.js";
import type { FinalGraphProjection } from "../../../graph/final-graph-projection.js";
import type { AnalysisPreviousState, PreviousCollectionRepository } from "./previous-state.js";
import type { GraphFinalItem } from "./graph-final-item.js";
import type { GraphReconciliationResult } from "../stages/graph-reconciliation-contracts.js";

/** 最終graphで埋める前に確定する収集計画と前回管理値。 */
export type FinalSnapshotPlanProjection = Readonly<{
  previousTrackingStartAt: TrackingStartAtState;
  trackingStartAt: TrackingStartAtState;
  previousHistory: AnalysisPreviousState["history"];
  previousNotificationLedger: AnalysisPreviousState["notificationLedger"];
  verifiedExternalReferences: readonly VerifiedExternalReference[];
  aiEnabled: boolean;
  plannedNodeIds: readonly GitHubNodeId[];
  analysisPlanFingerprints: readonly (readonly [GitHubNodeId, Sha256Hash])[];
}>;

/** 公開repoの今回取得状態。 */
export type FinalSnapshotRepository = PublicRepository &
  (Readonly<{ freshness: "fresh" }> | Readonly<{ freshness: "stale"; failedAt: UtcIsoDateTime }>);

/** 9要素の採用結果から確定したAI利用状態。 */
export type FinalSnapshotAiState =
  | Readonly<{ enabled: false; available: false; degraded: false }>
  | Readonly<{ enabled: true; available: true; degraded: boolean }>
  | Readonly<{ enabled: true; available: false; degraded: true }>;

/** 最終stageへ渡す保存候補専用の確定projection。 */
export type FinalSnapshotProjection = Readonly<{
  previousTrackingStartAt: TrackingStartAtState;
  trackingStartAt: TrackingStartAtState;
  previousHistory: AnalysisPreviousState["history"];
  previousNotificationLedger: AnalysisPreviousState["notificationLedger"];
  verifiedExternalReferences: readonly VerifiedExternalReference[];
  repositories: readonly FinalSnapshotRepository[];
  collectionRepositories: readonly PreviousCollectionRepository[];
  ai: FinalSnapshotAiState;
  graphRunStatus: "success" | "fallback";
  unavailablePersonalReminderConsumer: boolean;
}>;

/** schema version 23のcodecへ渡す唯一のsnapshot候補。 */
export type FinalSnapshotCandidate = Readonly<{
  schemaVersion: "23";
  generatedAt: UtcIsoDateTime;
  trackingStartAt: TrackingStartAtState;
  ai: FinalSnapshotAiState;
  collection: Readonly<{ repositories: readonly PreviousCollectionRepository[] }>;
  repositories: readonly FinalSnapshotRepository[];
  items: readonly Omit<GraphFinalItem, "deadlineLevel">[];
  graphNodeStateObservations: GraphReconciliationResult["graphNodeStateObservations"];
  externalReferences: readonly ExternalGhostNode[];
  verifiedExternalReferences: readonly VerifiedExternalReference[];
  relations: readonly Relation[];
  finalGraphProjection: FinalGraphProjection;
  finalGraphProjectionDigest: Sha256Hash;
  run: Readonly<{ id: string; status: "success" | "fallback" }>;
}>;
