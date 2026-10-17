import type {
  FreshObservedGitHubIssue,
  FreshObservedGitHubPullRequest,
} from "./github-item-observation.js";
import type { IssueStateDecision, IssueTransitionBasis } from "./issue-state-contracts.js";
import type {
  PullRequestStateDecision,
  PullRequestTransitionBasis,
} from "./pull-request-state-contracts.js";
import type {
  PersonalReminderCause,
  PersonalReminderCauseAiDependencies,
  PersonalReminderCauseId,
  PersonalReminderCauseSeed,
  PersonalReminderReasonCode,
  PersonalReminderResponsibility,
  PersonalReminderResponsible,
} from "./personal-reminder-causes.js";
import type { SourceId } from "./source-id.js";
import type { GitHubNodeId, UtcIsoDateTime } from "./types.js";

export type PersonalReminderResponsibilityBasis = IssueTransitionBasis | PullRequestTransitionBasis;

/** 個人催促原因の判定対象項目。 */
export type PersonalReminderItem = FreshObservedGitHubIssue | FreshObservedGitHubPullRequest;

/** block適用前の個人催促責務判定。 */
export type PersonalReminderLocalDecision = IssueStateDecision | PullRequestStateDecision;

/** 個人催促原因を永続化する前の候補。 */
export type PersonalReminderCauseDraft = Readonly<{
  itemNodeId: GitHubNodeId;
  reasonCode: PersonalReminderReasonCode;
  responsible: readonly [PersonalReminderResponsible, ...PersonalReminderResponsible[]];
  action: Readonly<PersonalReminderCauseSeed["action"]>;
  evidenceSourceIds: readonly [SourceId, ...SourceId[]];
  responsibilityBasis: PersonalReminderResponsibilityBasis;
  responsibility: PersonalReminderResponsibility;
  aiDependencies: PersonalReminderCauseAiDependencies;
}>;

/** 個人催促原因の候補を作れない理由。 */
export type PersonalReminderCauseDraftUnavailableReason =
  "terminal" | "blocked_parent" | "automation" | "not_applicable" | "no_responsible_actor";

/** 個人催促原因の候補を作れない結果。 */
export type PersonalReminderCauseDraftUnavailable = Readonly<{
  status: "unavailable";
  itemNodeId: GitHubNodeId;
  reason: PersonalReminderCauseDraftUnavailableReason;
}>;

/** 前回保存された個人催促原因。 */
export type PreviousPersonalReminderCauses = Readonly<{
  observedAt: UtcIsoDateTime;
  causes: readonly PersonalReminderCause[];
}>;

/** 個人催促原因seedを作った生成元。 */
export type PersonalReminderCauseSeedOrigin =
  | Readonly<{
      kind: "new_draft";
      seed: PersonalReminderCauseSeed;
      draft: PersonalReminderCauseDraft;
    }>
  | Readonly<{
      kind: "normal_continuation";
      seed: PersonalReminderCauseSeed;
      draft: PersonalReminderCauseDraft;
      previousCause: PersonalReminderCause;
    }>
  | Readonly<{
      kind: "retained_without_draft";
      seed: PersonalReminderCauseSeed;
      previousCause: PersonalReminderCause;
    }>;

/** 個人催促原因候補の照合結果。 */
export type PersonalReminderCauseSeedReconciliation =
  | Readonly<{
      status: "available";
      seeds: readonly PersonalReminderCauseSeed[];
      seedOrigins: readonly PersonalReminderCauseSeedOrigin[];
      retainedWithoutDraftCauseIds: readonly PersonalReminderCauseId[];
      endedCauseIds: readonly PersonalReminderCauseId[];
    }>
  | Readonly<{
      status: "continuity_conflict";
      reason: "multiple_continuation_matches";
      itemNodeId: GitHubNodeId;
      previousCauseIds: readonly [
        PersonalReminderCauseId,
        PersonalReminderCauseId,
        ...PersonalReminderCauseId[],
      ];
    }>
  | Readonly<{
      status: "continuity_conflict";
      reason: "new_draft_id_collision";
      itemNodeId: GitHubNodeId;
      previousCauseIds: readonly [PersonalReminderCauseId];
    }>;

/** 個人催促原因を保存せずに意味入力へ投影する候補。 */
export type PersonalReminderCauseProjection = Readonly<{
  key: string;
  draft: PersonalReminderCauseDraft | undefined;
  previousCause: PersonalReminderCause | undefined;
}>;

/** 現在のreview request先を責務終了判定へ渡す識別情報。 */
export type PersonalReminderReviewRequestTarget =
  Readonly<{ kind: "user"; candidateId: string }> | Readonly<{ kind: "team"; candidateId: string }>;

/** 構造上終了した個人催促原因を決定する入力。 */
export type PersonalReminderStructuralEndInput = Readonly<{
  item: PersonalReminderItem;
  previous: PreviousPersonalReminderCauses;
  currentDrafts: readonly PersonalReminderCauseDraft[];
  successorDrafts?: readonly PersonalReminderCauseDraft[];
  currentDecisionStatus: PersonalReminderLocalDecision["status"];
  complete: boolean;
  currentReviewRequestTargets: readonly PersonalReminderReviewRequestTarget[];
  executionSurfaceStates: ReadonlyMap<GitHubNodeId, "open" | "merged" | "closed_without_merge">;
}>;
