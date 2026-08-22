import { z } from "zod";

import { type Importance } from "./importance.js";
import { type SourceId } from "./source-id.js";

const opaqueIdSchema = z
  .string()
  .min(1, "IDは空にできません")
  .regex(/^\S+$/, "IDに空白は使えません");
const githubNodeIdSchema = opaqueIdSchema.brand<"GitHubNodeId">();
const githubRepositoryIdSchema = opaqueIdSchema.brand<"GitHubRepositoryId">();
const externalReferenceNodeIdSchema = opaqueIdSchema.brand<"ExternalReferenceNodeId">();
const utcIsoDateTimeSchema = z.iso
  .datetime({
    offset: true,
    error: "タイムゾーンを含むISO 8601日時を指定してください",
  })
  .transform((value) => new Date(value).toISOString())
  .brand<"UtcIsoDateTime">();

/** GitHubのIssue、Pull Request、ユーザーなどを識別するglobal node ID。 */
export type GitHubNodeId = z.output<typeof githubNodeIdSchema>;

/** GitHubリポジトリを識別するglobal node ID。 */
export type GitHubRepositoryId = z.output<typeof githubRepositoryIdSchema>;

/** GitHub Organization外の参照先へ決定論的に割り当てるnode ID。 */
export type ExternalReferenceNodeId = z.output<typeof externalReferenceNodeIdSchema>;

/** グラフ上のnode ID。 */
export type GraphNodeId = GitHubNodeId | ExternalReferenceNodeId;

/** UTCのISO 8601文字列。表示時にだけJSTへ変換する。 */
export type UtcIsoDateTime = z.output<typeof utcIsoDateTimeSchema>;

/** GitHub global node IDを検証して型を付与する。 */
export function createGitHubNodeId(value: string): GitHubNodeId {
  return githubNodeIdSchema.parse(value);
}

/** GitHub repository IDを検証して型を付与する。 */
export function createGitHubRepositoryId(value: string): GitHubRepositoryId {
  return githubRepositoryIdSchema.parse(value);
}

/** 外部参照用node IDを検証して型を付与する。 */
export function createExternalReferenceNodeId(value: string): ExternalReferenceNodeId {
  return externalReferenceNodeIdSchema.parse(value);
}

/** ISO 8601日時をUTCへ正規化して型を付与する。 */
export function createUtcIsoDateTime(value: string): UtcIsoDateTime {
  return utcIsoDateTimeSchema.parse(value);
}

/** 追跡項目の処理状態。 */
export type Status =
  | "waiting_for_assessment"
  | "waiting_for_owner"
  | "waiting_for_decision"
  | "waiting_for_review"
  | "waiting_for_revision"
  | "waiting_for_reply"
  | "waiting_for_work"
  | "waiting_for_unblock"
  | "waiting_for_automation"
  | "waiting_for_merge"
  | "in_progress"
  | "unknown"
  | "terminal_merged"
  | "terminal_completed"
  | "terminal_not_planned";

/** 人の対応を必要としない終了状態。 */
export type TerminalStatus = "terminal_merged" | "terminal_completed" | "terminal_not_planned";

/** 処理が継続している状態。 */
export type NonTerminalStatus = Exclude<Status, TerminalStatus>;

/** 次の行動を待つ主体の種別。 */
export type WaitingOnKind = "user" | "team" | "role" | "item" | "automation" | "unknown";

/** 次の行動を待つ主体の役割。 */
export type WaitingOnRole =
  | "author"
  | "maintainer"
  | "reviewer"
  | "assignee"
  | "respondent"
  | "dependency"
  | "merge_decider"
  | "ci"
  | "unknown";

/** 停滞の重要度。 */
export type Severity = "none" | "watch" | "urgent" | "critical";

/** staleness.thresholdsHoursのキーと1対1に対応する待機分類。 */
export type WaitClass =
  | "assessment"
  | "owner"
  | "decision"
  | "review"
  | "revision"
  | "reply"
  | "work"
  | "merge"
  | "automation";

/** グラフnodeの種別。 */
export type GraphNodeKind = "issue" | "pull_request" | "external_reference";

/** 追跡項目として保存するグラフnodeの種別。 */
export type TrackedItemType = Exclude<GraphNodeKind, "external_reference">;

/** Relation edgeの意味。 */
export type RelationType = "blocks" | "parent_of" | "implements" | "related_to" | "duplicates";

/** Relation edgeを得た経路。 */
export type RelationProvenance =
  "native" | "explicit_text" | "closing_keyword" | "checklist" | "cross_reference" | "ai_inference";

/** authoritativeなRelationに反するCodex判定値。 */
export type RelationContradictionVerdict =
  | "current_is_blocked_by_target"
  | "current_blocks_target"
  | "current_implements_target"
  | "target_is_subtask_of_current"
  | "current_is_subtask_of_target"
  | "duplicates"
  | "related"
  | "none";

/** authoritativeなRelationに反するCodex判定の永続化用要約。 */
export type RelationContradictionSummary = Readonly<{
  verdict: RelationContradictionVerdict;
  confidence: number;
}>;

/** Codex出力schemaと一致する通知理由コード。 */
export type NotificationReasonCode =
  | "none"
  | "assessment_overdue"
  | "owner_overdue"
  | "decision_overdue"
  | "review_overdue"
  | "revision_overdue"
  | "reply_overdue"
  | "owner_unknown"
  | "blocker_overdue"
  | "newly_unblocked"
  | "dependency_cycle"
  | "responsibility_changed"
  | "merge_overdue"
  | "automation_stuck";

/** イベントを起こした主体の種別。 */
export type ActorType = "human" | "bot" | "system";

/** GitHubアカウントとして識別できるアクター。 */
export type GitHubAccountActor = Readonly<{
  type: Exclude<ActorType, "system">;
  nodeId: GitHubNodeId;
  login: string;
}>;

/** GitHubが生成したシステムアクター。 */
export type SystemActor = Readonly<{
  type: "system";
  name: string;
}>;

/** 正規化イベントを起こしたアクター。 */
export type Actor = GitHubAccountActor | SystemActor;

export type ObservedGitHubItemAuthor =
  | Readonly<{
      status: "identified";
      actor: GitHubAccountActor;
    }>
  | Readonly<{
      status: "unavailable";
      reason: "deleted_account";
    }>;

type NormalizedEventBase = Readonly<{
  sourceId: SourceId;
  itemNodeId: GitHubNodeId;
  occurredAt: UtcIsoDateTime;
  actor: Actor;
}>;

type EventChangeAction = "added" | "removed";

type NormalizedCommentEvent = NormalizedEventBase &
  Readonly<{
    kind: "comment";
    bodyFingerprint: string;
    bodyEmpty: boolean;
    replyToCommentNodeId?: GitHubNodeId;
  }>;

type NormalizedPushEvent = NormalizedEventBase &
  Readonly<{
    kind: "push";
    headCommitSha: string;
    forcePush: boolean;
  }>;

type NormalizedReviewEvent = NormalizedEventBase &
  Readonly<{
    kind: "review";
    state: "approved" | "changes_requested" | "commented" | "dismissed";
    bodyFingerprint: string;
    bodyEmpty: boolean;
  }> &
  (
    | Readonly<{
        commitStatus: "available";
        commitSha: string;
      }>
    | Readonly<{
        commitStatus: "unavailable";
      }>
  );

type ReviewRequestTarget =
  | Readonly<{
      type: "user";
      nodeId: GitHubNodeId;
    }>
  | Readonly<{
      type: "team";
      nodeId: GitHubNodeId;
    }>;

type NormalizedReviewRequestEvent = NormalizedEventBase &
  Readonly<{
    kind: "review_request";
    target: ReviewRequestTarget;
    action: EventChangeAction;
  }>;

type NormalizedLabelEvent = NormalizedEventBase &
  Readonly<{
    kind: "label";
    labelName: string;
    action: EventChangeAction;
  }>;

type NormalizedAssigneeEvent = NormalizedEventBase &
  Readonly<{
    kind: "assignee";
    assignee: GitHubAccountActor;
    action: EventChangeAction;
  }>;

type NormalizedStateEvent = NormalizedEventBase &
  (
    | Readonly<{
        kind: "state";
        state: "open" | "merged" | "reopened";
      }>
    | Readonly<{
        kind: "state";
        state: "closed";
        stateReason: "completed" | "not_planned" | "duplicate" | "unavailable";
      }>
  );

type RelationEventTarget =
  | Readonly<{
      type: "node";
      nodeId: GraphNodeId;
    }>
  | Readonly<{
      type: "url";
      url: GitHubItemUrl;
    }>;

type NormalizedRelationEvent = NormalizedEventBase &
  Readonly<{
    kind: "relation";
    relationType: RelationType;
    target: RelationEventTarget;
    action: EventChangeAction;
    provenance: RelationProvenance;
    direction: "from_item" | "to_item";
  }>;

type NormalizedPullRequestLifecycleEvent = NormalizedEventBase &
  Readonly<{
    kind:
      | "ready_for_review"
      | "converted_to_draft"
      | "added_to_merge_queue"
      | "removed_from_merge_queue"
      | "auto_merge_enabled"
      | "auto_merge_disabled";
  }>;

/** 安定したsource IDと変更種別ごとの内容を持つ正規化イベント。 */
export type NormalizedEvent =
  | NormalizedCommentEvent
  | NormalizedPushEvent
  | NormalizedReviewEvent
  | NormalizedReviewRequestEvent
  | NormalizedLabelEvent
  | NormalizedAssigneeEvent
  | NormalizedStateEvent
  | NormalizedRelationEvent
  | NormalizedPullRequestLifecycleEvent;

/** 根拠が支持する判定箇所。 */
export type EvidenceSupport =
  "status" | "waiting_on" | "relation" | "progress" | "notification" | "uncertainty";

/** 判定をGitHub由来のsourceへ結び付ける根拠。 */
export type Evidence = Readonly<{
  sourceId: SourceId;
  supports: EvidenceSupport;
  summary: string;
}>;

/** 次の行動を待つ主体と判断根拠。 */
export type WaitingOn = Readonly<{
  kind: WaitingOnKind;
  candidateId: string;
  role: WaitingOnRole;
  reasonSummary: string;
  sourceIds: readonly [SourceId, ...SourceId[]];
  confidence: number;
}>;

/** waitingOn配列でprimaryに選んだ要素と選定理由。 */
export type PrimaryWaitingOn =
  | Readonly<{
      index: 0;
      selectionReason: string;
    }>
  | Readonly<{
      index: "not_applicable";
      selectionReason: string;
    }>;

/** リポジトリの公開範囲。 */
export type RepositoryVisibility = "public" | "private" | "internal";

/** GitHub global repository IDを正本としてrename前後を同じリポジトリとして扱う。 */
export type Repository = Readonly<{
  id: GitHubRepositoryId;
  owner: string;
  name: string;
  visibility: RepositoryVisibility;
  archived: boolean;
  disabled: boolean;
  observedAt: UtcIsoDateTime;
}>;

/** GitHub上の項目状態。 */
export type TrackedItemState = "open" | "closed" | "merged";

/** 追跡とは独立して設定する既定digest上の通知分類。 */
export type TrackingNotificationClass = "standard" | "automation_noise";

/** Pull Requestの集約review状態。 */
export type ReviewState =
  "not_applicable" | "not_requested" | "requested" | "changes_requested" | "approved" | "unknown";

/** Pull Requestの集約check状態。 */
export type CheckState =
  "not_applicable" | "not_required" | "pending" | "passing" | "failing" | "conflict" | "unknown";

/** owner/repository#number形式の表示用別名。 */
export type GitHubItemDisplayReference = `${string}/${string}#${number}`;

/** GitHub上の項目を指す表示用URL。 */
export type GitHubItemUrl = `https://github.com/${string}`;

export type AiCacheEntryId = `sha256:${string}`;

/** 追跡項目を判定したときのAI分析利用状況。 */
export type TrackedItemAiAnalysis =
  | Readonly<{
      status: "used";
      cacheKey: AiCacheEntryId;
    }>
  | Readonly<{
      status: "failed" | "deferred" | "not_required" | "disabled" | "not_recorded";
    }>;

export type TrackedItemInputEvent = Readonly<{
  sourceId: SourceId;
  url: GitHubItemUrl;
}>;

export type TrackedItemLatestEventActor =
  | Readonly<{
      status: "absent";
    }>
  | Readonly<{
      status: "present";
      actor: Actor;
    }>;

/** 正規化イベント列から時刻とsource IDが最も新しいアクターを取得する。 */
export function createTrackedItemLatestEventActor(
  events: readonly NormalizedEvent[],
): TrackedItemLatestEventActor {
  let latestEvent: NormalizedEvent | undefined;
  for (const event of events) {
    if (latestEvent == null) {
      latestEvent = event;
      continue;
    }
    if (
      event.occurredAt > latestEvent.occurredAt ||
      (event.occurredAt === latestEvent.occurredAt && event.sourceId > latestEvent.sourceId)
    ) {
      latestEvent = event;
    }
  }
  if (latestEvent == null) {
    return Object.freeze({
      status: "absent",
    });
  }
  return Object.freeze({
    status: "present",
    actor: Object.freeze({ ...latestEvent.actor }),
  });
}

type TrackedItemFields = Readonly<{
  nodeId: GitHubNodeId;
  type: TrackedItemType;
  repositoryId: GitHubRepositoryId;
  displayReference: GitHubItemDisplayReference;
  number: number;
  url: GitHubItemUrl;
  title: string;
  importance: Importance;
  author: ObservedGitHubItemAuthor;
  latestEventActor: TrackedItemLatestEventActor;
  state: TrackedItemState;
  notificationClass: TrackingNotificationClass;
  primaryWaitingOn: PrimaryWaitingOn;
  nextAction: string;
  createdAt: UtcIsoDateTime;
  githubUpdatedAt: UtcIsoDateTime;
  lastHumanActivityAt: UtcIsoDateTime;
  lastProgressAt: UtcIsoDateTime;
  statusSince: UtcIsoDateTime;
  ownerSince: UtcIsoDateTime;
  stallSince: UtcIsoDateTime;
  observedAt: UtcIsoDateTime;
  labels: readonly string[];
  assignees: readonly GitHubAccountActor[];
  reviewState: ReviewState;
  checkState: CheckState;
  aiAnalysis: TrackedItemAiAnalysis;
  inputEvents: readonly TrackedItemInputEvent[];
  confidence: number;
  evidence: readonly Evidence[];
  uncertainties: readonly string[];
}>;

/** nodeIdを正本とし、renameで変わり得る表示用別名を分離した追跡項目。 */
export type TrackedItem =
  | (TrackedItemFields &
      Readonly<{
        status: NonTerminalStatus;
        waitingOn: readonly WaitingOn[];
      }>)
  | (TrackedItemFields &
      Readonly<{
        status: TerminalStatus;
        waitingOn: readonly [];
      }>);

type RelationFields = Readonly<{
  id: string;
  fromNodeId: GraphNodeId;
  toNodeId: GraphNodeId;
  type: RelationType;
  provenance: RelationProvenance;
  confidence: number;
  evidence: readonly Evidence[];
  contradictions: readonly RelationContradictionSummary[];
  firstSeenAt: UtcIsoDateTime;
  lastConfirmedAt: UtcIsoDateTime;
}>;

/** blocksではfromNodeIdをblocker、toNodeIdをblocked itemとするRelation。 */
export type Relation =
  | (RelationFields &
      Readonly<{
        active: true;
      }>)
  | (RelationFields &
      Readonly<{
        active: false;
        removedAt: UtcIsoDateTime;
      }>);

/** Codex実行で指定できるreasoning effortの許容値一覧。 */
export const REASONING_EFFORTS = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

/** Codex実行で指定するreasoning effort。 */
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

/** Codex分析を再現するための実行設定、version、hash、実行時刻。 */
export type AnalysisMetadata = Readonly<{
  deterministicRulesVersion: string;
  model: string;
  reasoningEffort: ReasoningEffort;
  backendVersion: string;
  promptVersion: string;
  schemaVersion: string;
  inputHash: string;
  outputHash: string;
  executedAt: UtcIsoDateTime;
}>;

type NotificationLedgerEntryBase = Readonly<{
  notificationKey: string;
  itemNodeId: GitHubNodeId;
  reasonCode: NotificationReasonCode;
  severity: Severity;
  reservedAt: UtcIsoDateTime;
  cooldownUntil: UtcIsoDateTime;
}>;

/** Discord通知の予約、送信結果、手動抑制済みledger entryを記録する型。 */
export type NotificationLedgerEntry =
  | (NotificationLedgerEntryBase &
      Readonly<{
        status: "reserved";
        expiresAt: UtcIsoDateTime;
      }>)
  | (NotificationLedgerEntryBase &
      Readonly<{
        status: "sent";
        sentAt: UtcIsoDateTime;
        discordMessageId: string;
      }>)
  | (NotificationLedgerEntryBase &
      Readonly<{
        status: "dismissed";
        dismissedAt: UtcIsoDateTime;
      }>);

/** 運用障害として通知する処理の分類。 */
export type OperationsAlertKind = "collection" | "pages" | "discord";

/** 送信済みの運用障害通知を重複抑制するledger entry。 */
export type OperationsAlertLedgerEntry = Readonly<{
  alertKey: string;
  incidentId: string;
  kind: OperationsAlertKind;
  occurredAt: UtcIsoDateTime;
  sentAt: UtcIsoDateTime;
  discordMessageId: string;
}>;
