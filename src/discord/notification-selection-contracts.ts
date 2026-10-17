import {
  type GitHubNodeId,
  type NotificationLedgerEntry,
  type NotificationNonTimeReasonCode,
  type NotificationReason,
  type NotificationReasonCode,
  type NotificationTimeReasonCode,
  type PendingNotification,
  type PendingNotificationTarget,
  type PersonalReminderActionKind,
  type PersonalReminderCause,
  type PersonalReminderCausePlanning,
  type PersonalReminderResponsible,
  type PersonalReminderStaleness,
  type PersonalReminderTimeBasis,
  type Severity,
  type StalenessNotificationSeverityReason,
  type StalenessWaitClass,
  type Status,
  type TrackingNotificationClass,
  type UtcIsoDateTime,
  type WaitingOn,
} from "../domain/index.js";
import { type DependencyCycleId, type DownstreamImpact } from "../graph/index.js";
import { type NotificationCauses } from "./notification-cause-contracts.js";

export const MILLISECONDS_PER_HOUR = 60 * 60 * 1000;
const MILLISECONDS_PER_DAY = 24 * MILLISECONDS_PER_HOUR;
export const RESPONSIBILITY_CHANGE_STALL_HOURS = 48;
export const RESERVATION_DURATION_MILLISECONDS = MILLISECONDS_PER_DAY;
export const DELIVERY_ID_PATTERN = /^discord-digest:v1:[0-9a-f]{24}:message:[1-9][0-9]*$/u;

/** Discord通知で利用できるnone以外のreason code。 */
export type DiscordNotificationReasonCode = Exclude<NotificationReason["reasonCode"], "none">;

/** 通知判定に使う最新変更の分類。 */
export type DiscordNotificationLatestChange =
  "none" | "human" | "bot_only" | "preview_update" | "renovate_dashboard_update";

/** 状態判定が確定情報かAIだけに由来するかを表す。 */
export type DiscordNotificationDecisionBasis =
  | Readonly<{
      source: "deterministic";
    }>
  | Readonly<{
      source: "ai_only";
      confidence: number;
    }>;

/** reducerで検証済みのCodex通知提案を利用できるかを表す。 */
export type DiscordNotificationRecommendation =
  | Readonly<{
      availability: "not_available";
    }>
  | Readonly<{
      availability: "available";
      value: Readonly<{
        recommended: boolean;
        reasonCode: NotificationReasonCode;
        reasonSummary: string;
        policy: "eligible" | "normal_priority_only" | "suppressed";
        highPriorityEligible: boolean;
      }>;
    }>;

/** 通知判定時点の項目状態。 */
export type DiscordNotificationCurrentState = Readonly<{
  status: Status;
  waitingOn: readonly WaitingOn[];
  severity: Severity;
  severityReason: StalenessNotificationSeverityReason;
  waitClass: StalenessWaitClass;
  statusSince: UtcIsoDateTime;
  ownerSince: UtcIsoDateTime;
  stallSince: UtcIsoDateTime;
  lastProgressAt: UtcIsoDateTime;
}>;

/** 前回状態を利用できる場合の比較値。 */
export type DiscordNotificationPreviousState = Readonly<{
  status: Status;
  waitingOn: readonly WaitingOn[];
  severity: Severity;
  stallSince: UtcIsoDateTime;
  observedAt: UtcIsoDateTime;
}>;

/** 初回判定または前回値を持つ通知用比較状態。 */
export type DiscordNotificationPrevious =
  | Readonly<{
      availability: "not_available";
    }>
  | Readonly<{
      availability: "available";
      value: DiscordNotificationPreviousState;
    }>;

/** blocks graphの前回cycleと現在の影響範囲。 */
export type DiscordNotificationGraphContext = Readonly<{
  downstreamImpact: DownstreamImpact;
  hasOpenBlockers: boolean;
  newlyUnblocked: boolean;
  currentDependencyCycleIds: readonly DependencyCycleId[];
  previousDependencyCycles:
    | Readonly<{
        availability: "not_available";
      }>
    | Readonly<{
        availability: "available";
        cycleIds: readonly DependencyCycleId[];
      }>;
}>;

/** 1項目の通知選別に必要な正規化済み入力。 */
export type DiscordNotificationItem = Readonly<{
  nodeId: GitHubNodeId;
  createdAt: UtcIsoDateTime;
  draftState: "not_applicable" | "draft" | "ready_for_review";
  repositoryFreshness: "fresh" | "stale";
  notificationClass: TrackingNotificationClass;
  notificationsSuppressedByLabel: boolean;
  latestChange: DiscordNotificationLatestChange;
  decisionBasis: DiscordNotificationDecisionBasis;
  notificationRecommendation: DiscordNotificationRecommendation;
  priorityWeight: number;
  current: DiscordNotificationCurrentState;
  previous: DiscordNotificationPrevious;
  causes: NotificationCauses;
  personalReminderCauses: readonly DiscordPersonalReminderInput[];
  personalReminderCausePlanning: PersonalReminderCausePlanning;
  graph: DiscordNotificationGraphContext;
}>;

/** 個人催促原因と現在のstaleness判定。 */
export type DiscordPersonalReminderInput = Readonly<{
  cause: PersonalReminderCause;
  staleness: PersonalReminderStaleness;
}>;

/** 送信直前にsnapshotから再計算した個人催促選別入力。 */
export type DiscordPersonalReminderSelectionValidationItem = Readonly<{
  nodeId: GitHubNodeId;
  current: Pick<
    DiscordNotificationCurrentState,
    | "status"
    | "waitingOn"
    | "severity"
    | "severityReason"
    | "waitClass"
    | "statusSince"
    | "ownerSince"
    | "stallSince"
    | "lastProgressAt"
  >;
  personalReminderCauses: readonly DiscordPersonalReminderInput[];
  personalReminderCausePlanning: PersonalReminderCausePlanning;
}>;

/** 個人催促通知の選別結果へ渡す原因の文脈。 */
export type DiscordPersonalReminderNotificationContext = Readonly<{
  causeId: PersonalReminderCause["causeId"];
  responsibilityId: PersonalReminderCause["responsibilityId"];
  responsible: readonly PersonalReminderResponsible[];
  action: Readonly<{
    kind: PersonalReminderActionKind;
    summary: string;
  }>;
  obligationSince: PersonalReminderTimeBasis;
  actionableSince: PersonalReminderTimeBasis;
  stallSince: PersonalReminderTimeBasis;
}>;

/** 選別した通知理由のsystemまたは個人催促由来。 */
export type DiscordNotificationReasonSource =
  | Readonly<{
      kind: "system";
    }>
  | Readonly<{
      kind: "personal_reminder";
      context: DiscordPersonalReminderNotificationContext;
    }>;

/** 設定から渡す通知上限、noise閾値。 */
export type DiscordNotificationSelectionSettings = Readonly<{
  maxItemsPerDigest: number;
  recentProgressGraceHours: number;
  minimumAiConfidence: number;
}>;

/** 通知候補選別へ渡す現在時刻、項目、ledger、設定。 */
export type SelectDiscordNotificationsInput = Readonly<{
  evaluatedAt: UtcIsoDateTime;
  items: readonly DiscordNotificationItem[];
  ledger: readonly NotificationLedgerEntry[];
  pendingNotifications: readonly PendingNotification[];
  settings: DiscordNotificationSelectionSettings;
}>;

/** 選別された1理由とledger予約情報。 */
export type SelectedDiscordNotificationReason = NotificationReason &
  Readonly<{
    notificationKey: string;
    severity: Severity;
    source: DiscordNotificationReasonSource;
  }>;

/** digestへ1件として渡す通知候補。 */
export type DiscordNotificationCandidate = Readonly<{
  itemNodeId: GitHubNodeId;
  reasons: readonly [SelectedDiscordNotificationReason, ...SelectedDiscordNotificationReason[]];
  severity: Severity;
  downstreamImpact: DownstreamImpact;
  priorityWeight: number;
}>;

export type NotificationLedgerReservation = Extract<
  NotificationLedgerEntry,
  { status: "reserved" }
>;
export type NotificationLedgerAcknowledgement = Extract<
  NotificationLedgerEntry,
  { status: "acknowledged" }
>;

/** 空digestを明示する通知選別結果。 */
export type DiscordNotificationSelection =
  | Readonly<{
      action: "skip_digest";
      reason: "no_candidates" | "held";
      candidates: readonly [];
      ledgerReservations: readonly [];
      pendingNotifications: readonly PendingNotification[];
    }>
  | Readonly<{
      action: "create_digest";
      candidates: readonly [DiscordNotificationCandidate, ...DiscordNotificationCandidate[]];
      ledgerReservations: readonly [
        NotificationLedgerReservation,
        ...NotificationLedgerReservation[],
      ];
      pendingNotifications: readonly PendingNotification[];
    }>;

export type PendingNotificationWaitingOn = Extract<
  PendingNotificationTarget,
  { kind: "responsibility" }
>["waitingOn"][number];

export type ReasonSignal = Readonly<{
  reason: NotificationReason;
  stateDiscriminator: string;
  highPriorityEligible: boolean;
  target: PendingNotificationTarget;
  severity: Severity;
  source: DiscordNotificationReasonSource;
}>;

export type EligibleReason = Readonly<{
  signal: ReasonSignal;
  notificationKey: string;
  pendingNotification: PendingNotification;
}>;

export type CandidateDraft = Readonly<{
  item: DiscordNotificationItem;
  reasons: readonly [EligibleReason, ...EligibleReason[]];
}>;

export function systemReasonSource(): DiscordNotificationReasonSource {
  return Object.freeze({ kind: "system" });
}

export type NotificationReasonSelectionInput =
  | Readonly<{
      item: Pick<DiscordNotificationItem, "nodeId" | "current">;
      reasonCode: NotificationTimeReasonCode;
      source: "deterministic" | "codex";
    }>
  | Readonly<{
      reasonCode: NotificationNonTimeReasonCode;
    }>;
