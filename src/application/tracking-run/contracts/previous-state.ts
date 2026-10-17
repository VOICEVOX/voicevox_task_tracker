import type {
  AiAnalysisElement,
  AiAnalysisElementGeneration,
} from "../../../domain/ai-analysis-elements.js";
import type {
  PersonalReminderAiGeneration,
  PersonalReminderCauseId,
} from "../../../domain/personal-reminder-causes.js";
import type { Attention } from "../../../domain/attention.js";
import type { NaturalLanguageDeadlineAssessmentState } from "../../../domain/deadline.js";
import type { NaturalLanguageImportanceAssessmentState } from "../../../domain/importance.js";
import type {
  NotificationDeliveryAttempt,
  NotificationManualResolution,
} from "../../../domain/notification-delivery-attempt.js";
import type { StalenessSeverityContext } from "../../../domain/staleness.js";
import type { TrackingStartAtState } from "../../../domain/tracking-lifecycle.js";
import type { ExternalGhostNode } from "../../../domain/tracking-selection.js";
import type {
  AiCacheEntryId,
  GitHubNodeId,
  GraphNodeId,
  NotificationLedgerReasonCode,
  OperationsAlertLedgerKind,
  Severity,
  TrackedItemState,
  UtcIsoDateTime,
} from "../../../domain/types.js";
import type { PendingNotification } from "../../../domain/pending-notification.js";
import type { Relation } from "../../../domain/relation.js";
import type { TrackedItem } from "../../../domain/tracked-item.js";
import type { TrackedItemAiAnalysis } from "../../../domain/tracked-item-ai-analysis.js";
import type { PublicRepositoryId } from "../../../github/public-repository-allowlist.js";
import type { VerifiedExternalReference } from "../../../domain/verified-external-reference.js";

/** 前回の追跡と保持判定に使う項目。 */
export type PreviousTrackedItem = TrackedItem &
  Readonly<{
    attention: Attention;
    importanceAssessment: NaturalLanguageImportanceAssessmentState;
    deadlineAssessment: NaturalLanguageDeadlineAssessmentState;
    severity: Severity;
    severityContext: StalenessSeverityContext;
  }>;

/** 増分収集に必要な前回項目の観測値。 */
export type PreviousCollectionItem = Readonly<{
  freshness: "fresh";
  nodeId: GitHubNodeId;
  repositoryId: PublicRepositoryId;
  itemFingerprint: `sha256:${string}`;
  analysisPlanFingerprint:
    | Readonly<{ status: "planned"; fingerprint: `sha256:${string}` }>
    | Readonly<{ status: "unplanned"; reason: "migration" | "detail_required" }>;
  aiAnalysis: TrackedItemAiAnalysis;
  observedAt: UtcIsoDateTime;
}> &
  (
    | Readonly<{ state: "open"; terminalAt: null }>
    | Readonly<{ state: "closed"; terminalAt: UtcIsoDateTime }>
  );

/** リポジトリごとの前回成功収集。 */
export type PreviousCollectionRepository = Readonly<{
  repositoryId: PublicRepositoryId;
  successfulAt: UtcIsoDateTime;
  items: readonly PreviousCollectionItem[];
}>;

/** 前回snapshotから解析と保持に必要な値だけを固定した投影。 */
export type PreviousSnapshotProjection =
  | Readonly<{ status: "missing_branch" | "operations_only" }>
  | Readonly<{
      status: "available";
      trackedItems: readonly PreviousTrackedItem[];
      collectionRepositories: readonly PreviousCollectionRepository[];
      externalReferences: readonly ExternalGhostNode[];
      verifiedExternalReferences: readonly VerifiedExternalReference[];
      relations: readonly Relation[];
      graphNodeStateObservations: readonly Readonly<{
        nodeId: GitHubNodeId;
        state: TrackedItemState;
        observedAt: UtcIsoDateTime;
      }>[];
      effectiveGraphStates: readonly (readonly [GraphNodeId, TrackedItemState])[];
      trackingStartAt: TrackingStartAtState;
    }>;

/** 前回AI cacheの要素ごとの採用候補。 */
export type PreviousAiCacheEntry = Readonly<{
  cacheKey: AiCacheEntryId;
  element: AiAnalysisElement;
  generation: AiAnalysisElementGeneration;
}>;

/** 前回個人催促AI cacheの採用候補。 */
export type PreviousPersonalReminderAiCacheEntry = Readonly<{
  cacheKey: AiCacheEntryId;
  causeId: PersonalReminderCauseId;
  generation: PersonalReminderAiGeneration;
}>;

/** 前回通知の重複抑制に必要な管理記録。 */
export type PreviousNotificationLedger = Readonly<{
  entries: readonly (Readonly<{
    notificationKey: string;
    itemNodeId: string;
    reasonCode: NotificationLedgerReasonCode;
    severity: Severity;
    reservedAt: string;
    lastDeliveryAttempt?: NotificationDeliveryAttempt | undefined;
    manualResolution?: NotificationManualResolution | undefined;
  }> &
    (
      | Readonly<{ status: "reserved"; expiresAt: string }>
      | Readonly<{ status: "delivery_started"; deliveryId: string; startedAt: string }>
      | Readonly<{ status: "sent"; sentAt: string; discordMessageId: string }>
      | Readonly<{ status: "acknowledged"; acknowledgedAt: string }>
    ))[];
  operationsAlerts: readonly Readonly<{
    alertKey: string;
    incidentId: string;
    kind: OperationsAlertLedgerKind;
    occurredAt: string;
    sentAt: string;
    discordMessageId: string;
  }>[];
  pendingNotifications: readonly PendingNotification[];
}>;

/** 前回state全体を持ち越さず再利用と保持に使う値。 */
export type AnalysisPreviousState = Readonly<{
  snapshot: PreviousSnapshotProjection;
  history: readonly Readonly<{ runId: string; recordedAt: string }>[];
  aiCache: readonly PreviousAiCacheEntry[];
  personalReminderAiCache: readonly PreviousPersonalReminderAiCacheEntry[];
  notificationLedger: PreviousNotificationLedger;
}>;
