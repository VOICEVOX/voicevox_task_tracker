import { z } from "zod";

import { createGitHubNodeId, createGitHubRepositoryId } from "../domain/index.js";
import { GitHubPublicBoundaryViolationError, GitHubResponseValidationError } from "./errors.js";
import type {
  actorSchema,
  assigneeSchema,
  headRefForcePushedEventSchema,
  RawActor,
  RawReferencedItem,
  reviewRequestTargetSchema,
  teamSchema,
} from "./item-detail-response-schema.js";
import {
  type GitHubDetailAccount,
  type GitHubDetailActor,
  type GitHubReferencedItem,
  type GitHubReviewCommit,
  type GitHubReviewRequestTarget,
  type GitHubTimelineAssignee,
  type GitHubTimelineEvent,
} from "./item-detail-types.js";
import { buildProductionSourceId } from "./production-source-id.js";

function normalizeAccount(account: RawActor): GitHubDetailAccount {
  const nodeId = createGitHubNodeId(account.id);
  return Object.freeze({
    sourceId: buildProductionSourceId("github_actor", nodeId),
    nodeId,
    login: account.login,
    apiType: account.__typename,
  });
}

function normalizeUnavailableActor(): Extract<GitHubDetailActor, { status: "unavailable" }> {
  return Object.freeze({
    status: "unavailable",
    reason: "github_did_not_return_actor",
  });
}

export function normalizeActor(actor: z.output<typeof actorSchema>): GitHubDetailActor {
  if (actor == null) {
    return normalizeUnavailableActor();
  }
  return Object.freeze({
    status: "identified",
    account: normalizeAccount(actor),
  });
}

export function normalizeReviewRequestTarget(
  target: z.output<typeof reviewRequestTargetSchema> | null,
): GitHubReviewRequestTarget {
  if (target == null) {
    return normalizeUnavailableActor();
  }
  const nodeId = createGitHubNodeId(target.id);
  if (target.__typename !== "Team") {
    return Object.freeze({
      type: "user",
      sourceId: buildProductionSourceId("github_user", nodeId),
      nodeId,
      login: target.login,
      apiType: target.__typename,
    });
  }
  return normalizeTeam(target);
}

function normalizeTeam(
  target: z.output<typeof teamSchema>,
): Extract<GitHubReviewRequestTarget, { type: "team" }> {
  const nodeId = createGitHubNodeId(target.id);
  return Object.freeze({
    type: "team",
    sourceId: buildProductionSourceId("github_team", nodeId),
    nodeId,
    organizationLogin: target.organization.login,
    slug: target.slug,
    name: target.name,
  });
}

export function normalizeAssignee(
  assignee: z.output<typeof assigneeSchema> | null,
): GitHubTimelineAssignee {
  if (assignee == null) {
    return normalizeUnavailableActor();
  }
  return Object.freeze({
    type: "account",
    account: normalizeAccount(assignee),
  });
}

export function normalizeReferencedItem(item: RawReferencedItem): GitHubReferencedItem {
  if (item.repository.visibility !== "PUBLIC") {
    throw new GitHubPublicBoundaryViolationError(1);
  }
  const nodeId = createGitHubNodeId(item.id);
  const repositoryId = createGitHubRepositoryId(item.repository.id);
  const type = item.__typename === "Issue" ? "issue" : "pull_request";
  const expectedKind = type === "issue" ? "issues" : "pull";
  const expectedPath =
    `/${item.repository.owner.login}/${item.repository.name}/${expectedKind}/${item.number.toString()}`.toLowerCase();
  const parsedUrl = new URL(item.url);
  if (
    parsedUrl.pathname.toLowerCase() !== expectedPath ||
    parsedUrl.search.length !== 0 ||
    parsedUrl.hash.length !== 0
  ) {
    throw new GitHubResponseValidationError("参照先IssueまたはPull Request", {
      cause: new TypeError("URLとrepository metadataが一致しません"),
    });
  }
  const state =
    item.__typename === "Issue"
      ? item.issueState === "OPEN"
        ? "open"
        : "closed"
      : item.pullRequestState === "OPEN"
        ? "open"
        : item.pullRequestState === "MERGED"
          ? "merged"
          : "closed";
  return Object.freeze({
    sourceId: buildProductionSourceId("github_item", nodeId),
    nodeId,
    repositoryId,
    repositoryOwner: item.repository.owner.login,
    repositoryName: item.repository.name,
    repositoryArchived: item.repository.isArchived,
    repositoryDisabled: item.repository.isDisabled,
    type,
    number: item.number,
    url: item.url,
    createdAt: item.createdAt,
    state,
  });
}

export function normalizeTimelineReferencedItem(
  item: RawReferencedItem | null,
): Extract<GitHubTimelineEvent, { kind: "sub_issue_added" | "sub_issue_removed" }>["subIssue"] {
  if (item == null) {
    return Object.freeze({
      status: "unavailable",
      reason: "github_did_not_return_item",
    });
  }
  return normalizeReferencedItem(item);
}

export function normalizeUnavailableCommit(): Extract<
  GitHubReviewCommit,
  { status: "unavailable" }
> {
  return Object.freeze({
    status: "unavailable",
    reason: "github_did_not_return_commit",
  });
}

export function normalizeForcePushCommitSha(
  commit: z.output<typeof headRefForcePushedEventSchema>["beforeCommit"],
): Extract<GitHubTimelineEvent, { kind: "head_ref_force_pushed" }>["beforeSha"] {
  return commit == null ? normalizeUnavailableCommit() : commit.oid;
}
