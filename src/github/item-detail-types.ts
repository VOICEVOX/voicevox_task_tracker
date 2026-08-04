import {
  type GitHubItemUrl,
  type GitHubNodeId,
  type GitHubRepositoryId,
  type ObservedGitHubAutoMerge,
  type ObservedGitHubCommitPushedAt,
  type ObservedGitHubHeadCheckContext,
  type ObservedGitHubHeadChecks,
  type ObservedGitHubMergeQueue,
  type ObservedGitHubPullRequestCommit,
  type ObservedGitHubPullRequestMergeState,
  type ObservedGitHubReviewRequest,
  type ObservedGitHubReviewRequestTarget,
  type ObservedGitHubReviewRequestTimestamp,
  type SourceId,
  type UtcIsoDateTime,
} from "../domain/index.js";
import { type GitHubApiAccountType } from "./account-types.js";
import { type PublicRepositoryId } from "./public-repository-allowlist.js";

/** GitHub APIが識別情報を返したアカウント。 */
export type GitHubDetailAccount = Readonly<{
  sourceId: SourceId;
  nodeId: GitHubNodeId;
  login: string;
  apiType: GitHubApiAccountType;
}>;

/** GitHub API上のアクター取得結果。 */
export type GitHubDetailActor =
  | Readonly<{
      status: "identified";
      account: GitHubDetailAccount;
    }>
  | Readonly<{
      status: "unavailable";
      reason: "github_did_not_return_actor";
    }>;

/** レビュー依頼先となるGitHub userまたはteam。 */
export type GitHubReviewRequestTarget =
  | Readonly<{
      type: "user";
      sourceId: SourceId;
      nodeId: GitHubNodeId;
      login: string;
      apiType: GitHubApiAccountType;
    }>
  | Extract<ObservedGitHubReviewRequestTarget, { type: "team" }>;

/** GitHub上の公開IssueまたはPull Requestへの参照。 */
export type GitHubReferencedItem = Readonly<{
  sourceId: SourceId;
  nodeId: GitHubNodeId;
  repositoryId: GitHubRepositoryId;
  repositoryOwner: string;
  repositoryName: string;
  repositoryArchived: boolean;
  repositoryDisabled: boolean;
  type: "issue" | "pull_request";
  number: number;
  url: GitHubItemUrl;
  createdAt: UtcIsoDateTime;
  state: "open" | "closed" | "merged";
}>;

/** 信頼できないbodyはCodex入力データだけに利用し、永続化や公開用DTOへ渡してはならないissue comment取得値。 */
export type GitHubIssueComment = Readonly<{
  sourceId: SourceId;
  nodeId: GitHubNodeId;
  sequence: number;
  author: GitHubDetailActor;
  body: string;
  createdAt: UtcIsoDateTime;
  updatedAt: UtcIsoDateTime;
  url: GitHubItemUrl;
}>;

/** Pull Request reviewが対象としたcommitの取得結果。 */
export type GitHubReviewCommit =
  | Readonly<{
      status: "available";
      sourceId: SourceId;
      nodeId: GitHubNodeId;
      sha: string;
    }>
  | Readonly<{
      status: "unavailable";
      reason: "github_did_not_return_commit";
    }>;

/** 信頼できないbodyはCodex入力データだけに利用し、永続化や公開用DTOへ渡してはならないreview submission取得値。 */
export type GitHubPullRequestReview = Readonly<{
  sourceId: SourceId;
  nodeId: GitHubNodeId;
  sequence: number;
  state: "approved" | "changes_requested" | "commented" | "dismissed";
  author: GitHubDetailActor;
  commit: GitHubReviewCommit;
  submittedAt: UtcIsoDateTime;
  body: string;
  url: GitHubItemUrl;
}>;

/** 信頼できないbodyはCodex入力データだけに利用し、永続化や公開用DTOへ渡してはならないinline review comment取得値。 */
export type GitHubPullRequestReviewComment = Readonly<{
  sourceId: SourceId;
  nodeId: GitHubNodeId;
  sequence: number;
  author: GitHubDetailActor;
  body: string;
  createdAt: UtcIsoDateTime;
  updatedAt: UtcIsoDateTime;
  url: GitHubItemUrl;
}>;

/** resolved状態と全文を含むinline review thread取得値。 */
export type GitHubPullRequestReviewThread = Readonly<{
  sourceId: SourceId;
  nodeId: GitHubNodeId;
  sequence: number;
  isResolved: boolean;
  isOutdated: boolean;
  path: string;
  resolvedBy: GitHubDetailActor;
  comments: readonly GitHubPullRequestReviewComment[];
}>;

/** レビュー依頼時刻の取得結果。 */
export type GitHubReviewRequestTimestamp = ObservedGitHubReviewRequestTimestamp;

/** GitHubが返した現行review request。 */
export type GitHubCurrentReviewRequest = Omit<ObservedGitHubReviewRequest, "target"> &
  Readonly<{
    target: GitHubReviewRequestTarget;
  }>;

/** Pull RequestのcommitがGitHubへpushされた時刻の取得結果。 */
export type GitHubCommitPushedAt = ObservedGitHubCommitPushedAt;

/** Pull Request timelineまたはheadから取得したcommit。 */
export type GitHubPullRequestCommit = ObservedGitHubPullRequestCommit;

type GitHubTimelineEventBase = Readonly<{
  sourceId: SourceId;
  nodeId: GitHubNodeId;
  sequence: number;
  occurredAt: UtcIsoDateTime;
  actor: GitHubDetailActor;
}>;

export type GitHubTimelineAssignee = Readonly<{
  type: "account";
  account: GitHubDetailAccount;
}>;

/** 判定に必要なIssueとPull Requestのtimelineイベント。 */
export type GitHubTimelineEvent =
  | (GitHubTimelineEventBase &
      Readonly<{
        kind: "assigned" | "unassigned";
        assignee: GitHubTimelineAssignee;
      }>)
  | (GitHubTimelineEventBase &
      Readonly<{
        kind: "labeled" | "unlabeled";
        label: Readonly<{
          sourceId: SourceId;
          nodeId: GitHubNodeId;
          name: string;
        }>;
      }>)
  | (GitHubTimelineEventBase &
      Readonly<{
        kind: "review_requested" | "review_request_removed";
        target: GitHubReviewRequestTarget;
      }>)
  | (GitHubTimelineEventBase &
      Readonly<{
        kind:
          | "closed"
          | "reopened"
          | "merged"
          | "ready_for_review"
          | "converted_to_draft"
          | "added_to_merge_queue"
          | "removed_from_merge_queue"
          | "auto_merge_enabled"
          | "auto_merge_disabled";
      }>)
  | (GitHubTimelineEventBase &
      Readonly<{
        kind: "cross_referenced";
        source: GitHubReferencedItem;
        willCloseTarget: boolean;
      }>)
  | (GitHubTimelineEventBase &
      Readonly<{
        kind: "connected" | "disconnected";
        subject: GitHubReferencedItem;
      }>)
  | (GitHubTimelineEventBase &
      Readonly<{
        kind: "sub_issue_added" | "sub_issue_removed";
        subIssue: GitHubReferencedItem;
      }>)
  | (GitHubTimelineEventBase &
      Readonly<{
        kind: "parent_issue_added" | "parent_issue_removed";
        parent: GitHubReferencedItem;
      }>)
  | (GitHubTimelineEventBase &
      Readonly<{
        kind: "head_ref_force_pushed";
        beforeSha: string;
        afterSha: string;
      }>)
  | Readonly<{
      sourceId: SourceId;
      nodeId: GitHubNodeId;
      sequence: number;
      kind: "commit_added";
      commit: GitHubPullRequestCommit;
    }>;

/** tracked targetを参照したsource itemを追跡へ追加するための候補。 */
export type GitHubInboundCrossReferenceCandidate = Readonly<{
  sourceId: SourceId;
  candidateOnly: true;
  provenance: "cross_reference";
  eventSourceId: SourceId;
  sourceItem: GitHubReferencedItem;
}>;

/** GitHub native issue dependencyを推定関係と混ぜずに保持するauthoritative relation。 */
export type GitHubNativeDependency = Readonly<{
  sourceId: SourceId;
  authoritative: true;
  provenance: "native";
  direction: "blocked_by" | "blocking";
  relatedItem: GitHubReferencedItem;
}>;

/** native issue dependency APIの利用可否を含む取得結果。 */
export type GitHubNativeDependencyCollection =
  | Readonly<{
      availability: "available";
      relations: readonly GitHubNativeDependency[];
    }>
  | Readonly<{
      availability: "unavailable";
      reason: "api_not_supported";
    }>;

/** GitHub native sub-issueを推定関係と混ぜずに保持するauthoritative relation。 */
export type GitHubNativeHierarchy = Readonly<{
  sourceId: SourceId;
  authoritative: true;
  provenance: "native";
  relationship: "parent" | "sub_issue";
  relatedItem: GitHubReferencedItem;
}>;

/** native sub-issue APIの利用可否を含む取得結果。 */
export type GitHubNativeHierarchyCollection =
  | Readonly<{
      availability: "available";
      relations: readonly GitHubNativeHierarchy[];
    }>
  | Readonly<{
      availability: "unavailable";
      reason: "api_not_supported";
    }>;

/** head commitへ紐づくcheck runまたはcommit status。 */
export type GitHubCheckContext =
  | (Extract<ObservedGitHubHeadCheckContext, { type: "check_run" }> &
      Readonly<{
        nodeId: GitHubNodeId;
        name: string;
      }>)
  | (Extract<ObservedGitHubHeadCheckContext, { type: "commit_status" }> &
      Readonly<{
        nodeId: GitHubNodeId;
        context: string;
      }>);

/** head commitのstatus check rollup取得結果。 */
export type GitHubHeadChecks =
  | Extract<ObservedGitHubHeadChecks, { status: "not_configured" }>
  | (Omit<Extract<ObservedGitHubHeadChecks, { status: "configured" }>, "contexts"> &
      Readonly<{
        contexts: readonly GitHubCheckContext[];
      }>);

/** Pull Requestのauto-merge取得結果。 */
export type GitHubAutoMerge =
  | (Omit<Extract<ObservedGitHubAutoMerge, { status: "enabled" }>, "enabledBy"> &
      Readonly<{
        enabledBy: GitHubDetailActor;
      }>)
  | Extract<ObservedGitHubAutoMerge, { status: "not_enabled" }>;

/** Pull Requestのmerge queue相当の取得結果。 */
export type GitHubMergeQueue = ObservedGitHubMergeQueue;

/** Pull Requestのmergeability、merge state、automation、checks取得結果。 */
export type GitHubPullRequestMergeState = Omit<
  ObservedGitHubPullRequestMergeState,
  "autoMerge" | "checks"
> &
  Readonly<{
    autoMerge: GitHubAutoMerge;
    checks: GitHubHeadChecks;
  }>;

/** 現行review requestと追加・解除履歴。 */
export type GitHubPullRequestReviewRequests = Readonly<{
  current: readonly GitHubCurrentReviewRequest[];
  history: readonly Extract<
    GitHubTimelineEvent,
    { kind: "review_requested" | "review_request_removed" }
  >[];
}>;

type GitHubItemDetailFields = Readonly<{
  sourceId: SourceId;
  nodeId: GitHubNodeId;
  repositoryId: PublicRepositoryId;
  number: number;
  bodySourceId: SourceId;
  body: string;
  comments: readonly GitHubIssueComment[];
  timeline: readonly GitHubTimelineEvent[];
  inboundCrossReferences: readonly GitHubInboundCrossReferenceCandidate[];
  observedAt: UtcIsoDateTime;
}>;

/** 信頼できないbodyと各コメント本文はCodex入力データだけに利用し、永続化、Pages、Discordへ渡してはならない詳細取得値。 */
export type GitHubItemDetail =
  | (GitHubItemDetailFields &
      Readonly<{
        type: "issue";
        nativeDependencies: GitHubNativeDependencyCollection;
        nativeHierarchy: GitHubNativeHierarchyCollection;
      }>)
  | (GitHubItemDetailFields &
      Readonly<{
        type: "pull_request";
        reviews: readonly GitHubPullRequestReview[];
        reviewThreads: readonly GitHubPullRequestReviewThread[];
        reviewRequests: GitHubPullRequestReviewRequests;
        headSha: string;
        headCommit: GitHubPullRequestCommit;
        mergeState: GitHubPullRequestMergeState;
      }>);

/** GraphQL schemaが提供するnative relation機能。 */
export type GitHubItemDetailCapabilities = Readonly<{
  nativeDependencies: "available" | "unavailable";
  nativeHierarchy: "available" | "unavailable";
}>;

/** 詳細取得結果と取得時に確認したGraphQL機能。 */
export type GitHubItemDetailCollection = Readonly<{
  capabilities: GitHubItemDetailCapabilities;
  items: readonly GitHubItemDetail[];
}>;
