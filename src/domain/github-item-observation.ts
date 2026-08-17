import { type SourceId } from "./source-id.js";
import {
  type Actor,
  type GitHubAccountActor,
  type GitHubNodeId,
  type NormalizedEvent,
  type ObservedGitHubItemAuthor as DomainObservedGitHubItemAuthor,
  type UtcIsoDateTime,
} from "./types.js";

/** GitHub項目の作成者を保持する観測値。 */
export type ObservedGitHubItemAuthor = DomainObservedGitHubItemAuthor;

/** 最新取得に成功したGitHub項目で判定に使う共通観測値。 */
export type FreshObservedGitHubItemBase = Readonly<{
  freshness: "fresh";
  sourceId: SourceId;
  nodeId: GitHubNodeId;
  createdAt: UtcIsoDateTime;
  author: ObservedGitHubItemAuthor;
  assignees: readonly GitHubAccountActor[];
  events: readonly NormalizedEvent[];
  observedAt: UtcIsoDateTime;
}>;

/** GitHub項目のopenまたはclosed状態を保持する観測値。 */
export type ObservedGitHubItemState =
  | Readonly<{
      state: "open";
      stateReason: "reopened" | null;
      closedAt: null;
    }>
  | Readonly<{
      state: "closed";
      stateReason: "completed" | "not_planned" | "duplicate" | null;
      closedAt: UtcIsoDateTime;
    }>;

/** 最新取得に成功したIssueで状態判定に使う観測値。 */
export type FreshObservedGitHubIssue = FreshObservedGitHubItemBase &
  ObservedGitHubItemState &
  Readonly<{
    type: "issue";
    labels: readonly string[];
  }>;

/** Pull RequestのcommitがGitHubへpushされた時刻の観測値。 */
export type ObservedGitHubCommitPushedAt =
  | Readonly<{
      status: "available";
      value: UtcIsoDateTime;
    }>
  | Readonly<{
      status: "unavailable";
      reason: "github_did_not_return_pushed_at";
    }>;

/** Pull Requestのhead commit観測値。 */
export type ObservedGitHubPullRequestCommit = Readonly<{
  sourceId: SourceId;
  nodeId: GitHubNodeId;
  sha: string;
  committedAt: UtcIsoDateTime;
  pushedAt: ObservedGitHubCommitPushedAt;
}>;

/** Pull Requestのcommit発生時刻がPull Request作成時刻より前にならないように解決する。 */
export function resolvePullRequestCommitOccurredAt(
  commit: ObservedGitHubPullRequestCommit,
  itemCreatedAt: UtcIsoDateTime,
): UtcIsoDateTime {
  const occurredAt =
    commit.pushedAt.status === "available" ? commit.pushedAt.value : commit.committedAt;
  return occurredAt < itemCreatedAt ? itemCreatedAt : occurredAt;
}

/** Pull Request判定に使うreview thread観測値。 */
export type ObservedGitHubReviewThread = Readonly<{
  sourceId: SourceId;
  nodeId: GitHubNodeId;
  isResolved: boolean;
  isOutdated: boolean;
  commentSourceIds: readonly SourceId[];
}>;

/** bot種別を解決済みのreview request先。 */
export type ObservedGitHubReviewRequestTarget =
  | Readonly<{
      type: "user";
      actor: GitHubAccountActor;
    }>
  | Readonly<{
      type: "team";
      sourceId: SourceId;
      nodeId: GitHubNodeId;
      organizationLogin: string;
      slug: string;
      name: string;
    }>;

/** review request時刻の観測値。 */
export type ObservedGitHubReviewRequestTimestamp =
  | Readonly<{
      status: "available";
      value: UtcIsoDateTime;
    }>
  | Readonly<{
      status: "unavailable";
      reason: "timeline_event_not_found";
    }>;

/** 現行review requestの観測値。 */
export type ObservedGitHubReviewRequest = Readonly<{
  sourceId: SourceId;
  nodeId: GitHubNodeId;
  target: ObservedGitHubReviewRequestTarget;
  requestedAt: ObservedGitHubReviewRequestTimestamp;
}>;

/** auto-mergeの観測値。 */
export type ObservedGitHubAutoMerge =
  | Readonly<{
      status: "enabled";
      sourceId: SourceId;
      enabledAt: UtcIsoDateTime;
      enabledBy: Actor;
      mergeMethod: "merge" | "rebase" | "squash";
    }>
  | Readonly<{
      status: "not_enabled";
    }>;

/** merge queueの観測値。 */
export type ObservedGitHubMergeQueue =
  | Readonly<{
      status: "queued";
      sourceId: SourceId;
      nodeId: GitHubNodeId;
    }>
  | Readonly<{
      status: "not_queued";
    }>;

/** check runの完了結果。 */
export type ObservedGitHubCheckRunConclusion =
  | "action_required"
  | "cancelled"
  | "failure"
  | "neutral"
  | "skipped"
  | "stale"
  | "startup_failure"
  | "success"
  | "timed_out";

type ObservedGitHubHeadCheckRunContext = Readonly<{
  type: "check_run";
  sourceId: SourceId;
}> &
  (
    | Readonly<{
        status: "completed";
        conclusion: ObservedGitHubCheckRunConclusion;
        completedAt: UtcIsoDateTime;
      }>
    | Readonly<{
        status: "queued" | "in_progress" | "waiting" | "requested" | "pending";
        conclusion: "not_completed";
        completedAt: null;
      }>
  );

/** Pull Request判定に使うhead commitのcheck context観測値。 */
export type ObservedGitHubHeadCheckContext =
  | ObservedGitHubHeadCheckRunContext
  | Readonly<{
      type: "commit_status";
      sourceId: SourceId;
      state: "error" | "expected" | "failure" | "pending" | "success";
      createdAt: UtcIsoDateTime;
    }>;

/** Pull Request判定に使うcheck観測値。 */
export type ObservedGitHubHeadChecks =
  | Readonly<{
      status: "not_configured";
    }>
  | Readonly<{
      status: "configured";
      sourceId: SourceId;
      nodeId: GitHubNodeId;
      combinedState: "error" | "expected" | "failure" | "pending" | "success";
      contexts: readonly ObservedGitHubHeadCheckContext[];
    }>;

/** Pull Request判定に使うmerge情報の観測値。 */
export type ObservedGitHubPullRequestMergeState = Readonly<{
  mergeability: "mergeable" | "conflicting" | "unknown";
  mergeState:
    "behind" | "blocked" | "clean" | "dirty" | "draft" | "has_hooks" | "unknown" | "unstable";
  autoMerge: ObservedGitHubAutoMerge;
  mergeQueue: ObservedGitHubMergeQueue;
  checks: ObservedGitHubHeadChecks;
}>;

/** 最新取得に成功したPull Requestで状態判定に使う観測値。 */
export type FreshObservedGitHubPullRequest = FreshObservedGitHubItemBase &
  ObservedGitHubItemState &
  Readonly<{
    type: "pull_request";
    draft: boolean;
    headSha: string;
    headCommit: ObservedGitHubPullRequestCommit;
    reviewThreads: readonly ObservedGitHubReviewThread[];
    reviewRequests: readonly ObservedGitHubReviewRequest[];
    mergeState: ObservedGitHubPullRequestMergeState;
  }>;
