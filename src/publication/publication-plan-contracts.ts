import type { PublicationInputs } from "../application/tracking-run/contracts/publication-inputs.js";
import type { ValidatedRun } from "../application/tracking-run/stages/validate-run.js";
import type { Sha256Hash } from "../canonical-json/sha256.js";
import type { AiCacheEntry, PersonalReminderAiCacheEntry } from "../codex/index.js";
import type { DiscordNotificationSelection } from "../discord/index.js";
import type { PendingNotification } from "../domain/index.js";
import type {
  StateHistoryInputEvent,
  StateNotificationLedger,
  StateSnapshot,
} from "../persistence/index.js";
import type { RunMetrics } from "./run-report.js";

/** 公開計画へ渡せる具体的な証明付きrun。 */
export type PublicationValidatedRun = ValidatedRun<
  StateSnapshot,
  readonly StateHistoryInputEvent[],
  readonly AiCacheEntry[],
  readonly PersonalReminderAiCacheEntry[],
  StateNotificationLedger,
  DiscordNotificationSelection,
  RunMetrics
>;

/** Pages公開結果でだけ置換できるURL参照。 */
export type InitialPagesUrlPlaceholder = Readonly<{ kind: "initial_pages_deployment_url" }>;

/** 初回state commitに必要な確定済み業務値。 */
export type InitialStateWriteSet = Readonly<{
  snapshot: StateSnapshot;
  historyInputEvents: readonly StateHistoryInputEvent[];
  aiCacheAdditions: readonly AiCacheEntry[];
  personalReminderAiCacheAdditions: readonly PersonalReminderAiCacheEntry[];
  notificationLedger: StateNotificationLedger;
  paths: PublicationInputs["state"];
  previousInitialPagesEvidence: Readonly<{
    action: "delete_if_present";
    path: string;
    expectedBase: PublicationInputs["state"]["previousInitialPagesEvidence"];
  }>;
  deletions: readonly string[];
  valueDigests: Readonly<{
    snapshot: Sha256Hash;
    historyInputEvents: Sha256Hash;
    initialStateWriteManifest: Sha256Hash;
    aiCacheAdditions: Sha256Hash;
    personalReminderAiCacheAdditions: Sha256Hash;
    notificationLedger: Sha256Hash;
  }>;
  markerTemplate: RunTransactionMarkerTemplate;
  durableRecordTemplate: DurablePublicationRecordTemplate;
}>;

/** checkpointとの結合前に固定する初回run markerの業務値。 */
export type RunTransactionMarkerTemplate = Readonly<{
  phase: "initial_state_committed";
  runIdentity: PublicationValidatedRun["core"]["identity"];
  baseStateRevision: PublicationValidatedRun["core"]["baseRevision"];
  initialStateValueDigests: InitialStateWriteSet["valueDigests"];
}>;

/** 初回Pagesの生成に固定する公開対象。 */
export type InitialPagesProjection = Readonly<{
  phase: "initial";
  snapshot: Readonly<{ kind: "initial_state_snapshot"; path: string; digest: Sha256Hash }>;
  repositoryAllowlist: PublicationValidatedRun["repositoryAllowlist"];
  repositoryAllowlistDigest: Sha256Hash;
  publicDtoSchemaVersion: string;
  generatedAt: StateSnapshot["generatedAt"];
  settings: PublicationInputs["pages"];
}>;

/** 同じ選別文脈をDiscord本文と通知履歴へ渡す。 */
export type SelectedNotificationContext = DiscordNotificationSelection;

/** action別に固定した通知対象と初回ledger遷移。 */
export type NotificationOutbox =
  | Readonly<{
      action: "send";
      delivery: "send" | "no_candidates";
      selectedContext: SelectedNotificationContext;
      pagesUrl: InitialPagesUrlPlaceholder;
      settings: PublicationInputs["discord"];
      previousLedgerDigest: Sha256Hash;
      initialLedgerDigest: Sha256Hash;
    }>
  | Readonly<{
      action: "hold";
      delivery: "held";
      pendingNotifications: readonly PendingNotification[];
      previousLedgerDigest: Sha256Hash;
      initialLedgerDigest: Sha256Hash;
    }>
  | Readonly<{
      action: "acknowledge-current";
      delivery: "acknowledged";
      acknowledgedEntries: readonly Extract<
        StateNotificationLedger["entries"][number],
        { status: "acknowledged" }
      >[];
      pendingNotifications: readonly PendingNotification[];
      previousLedgerDigest: Sha256Hash;
      initialLedgerDigest: Sha256Hash;
    }>;

/** receiptと保存済み台帳から最終値を作るための規則。 */
export type RunFinalizationPolicy = Readonly<{
  notificationCountSource: "outbox_keys_with_sent_ledger_status";
  metricsSource: "validated_run_and_notification_settlement_receipt";
  completeSuccessRequires: readonly ["initial_pages_deployed", "notifications_settled"];
  configuredTrackingStartAt: PublicationInputs["configuredTrackingStartAt"];
  trackingStartAtCondition: "complete_success";
  report: Readonly<{
    runId: string;
    scheduledFor: PublicationValidatedRun["core"]["identity"]["scheduledFor"];
    startedAt: PublicationValidatedRun["core"]["identity"]["startedAt"];
    status: StateSnapshot["run"]["status"];
    metrics: RunMetrics;
    diagnostics: readonly string[];
    completionSource: "notification_settlement_receipt";
  }>;
  ledgerAndHistorySource: "notification_settlement_receipt";
  markerPhase: "run_finalized";
}>;

/** 通知履歴Pagesを必要とする条件。 */
export type NotificationHistoryPagesPolicy =
  | Readonly<{
      action: "send";
      requirement: "when_sent_history_added";
      context: "outbox_selected_context";
    }>
  | Readonly<{ action: "hold" | "acknowledge-current"; requirement: "not_required" }>;

/** checkpoint binding以前に確定できるdurable recordの業務部分。 */
export type DurablePublicationRecordTemplate = Readonly<{
  runIdentity: PublicationValidatedRun["core"]["identity"];
  executionPolicy: PublicationValidatedRun["core"]["executionPolicy"];
  baseStateRevision: PublicationValidatedRun["core"]["baseRevision"];
  configDigest: Sha256Hash;
  initialStateValueDigests: InitialStateWriteSet["valueDigests"];
  initialPagesProjection: InitialPagesProjection;
  notificationOutbox: NotificationOutbox;
  runFinalizationPolicy: RunFinalizationPolicy;
  notificationHistoryPagesPolicy: NotificationHistoryPagesPolicy;
}>;

/** 副作用前に一度だけ確定する公開計画。 */
export type PublicationPlan = Readonly<{
  initialStateWriteSet: InitialStateWriteSet;
  initialPagesProjection: InitialPagesProjection;
  notificationOutbox: NotificationOutbox;
  runFinalizationPolicy: RunFinalizationPolicy;
  notificationHistoryPagesPolicy: NotificationHistoryPagesPolicy;
  durableRecordTemplate: DurablePublicationRecordTemplate;
  preview: Readonly<{ kind: "notification_preview"; selection: DiscordNotificationSelection }>;
}>;

/** 証明付きrunから作ったin-memory公開段階。 */
export type PublicationPlannedRun = Readonly<{
  validated: PublicationValidatedRun;
  publicationPlan: PublicationPlan;
}>;
