import { createHash } from "node:crypto";

import { type GitHubApiAccountType } from "./account-types.js";
import {
  type GitHubCheckContext,
  type GitHubCurrentReviewRequest,
  type GitHubDetailActor,
  type GitHubHeadChecks,
  type GitHubItemDetail,
  type GitHubPullRequestReviewDecision,
  type GitHubPullRequestMergeState,
  type GitHubReviewRequestTarget,
} from "./item-detail-types.js";
import { type Sha256Fingerprint } from "./item-enumeration.js";
import { GitHubPullRequestVolatileRaceError } from "./errors.js";
import { type GitHubNodeId, type SourceId, type UtcIsoDateTime } from "../domain/index.js";

export type { GitHubPullRequestReviewDecision } from "./item-detail-types.js";

/** volatile metadataで識別したactor。本文や表示用loginは保持しない。 */
export type GitHubVolatileActor =
  | Readonly<{
      status: "identified";
      nodeId: GitHubNodeId;
      apiType: GitHubApiAccountType;
    }>
  | Readonly<{
      status: "unavailable";
    }>;

/** volatile metadataで識別したreview requestの対象。 */
export type GitHubVolatileReviewRequestTarget =
  | Readonly<{
      status: "identified";
      kind: "actor";
      nodeId: GitHubNodeId;
      apiType: GitHubApiAccountType;
    }>
  | Readonly<{
      status: "identified";
      kind: "team";
      nodeId: GitHubNodeId;
    }>
  | Readonly<{
      status: "unavailable";
    }>;

/** 現行review requestの判定用識別情報。 */
export type GitHubVolatileReviewRequest = Readonly<{
  requestNodeId: GitHubNodeId;
  target: GitHubVolatileReviewRequestTarget;
}>;

/** volatile metadataで識別したauto-merge状態。 */
export type GitHubVolatileAutoMerge =
  | Readonly<{
      status: "enabled";
      sourceId: SourceId;
      enabledAt: UtcIsoDateTime;
      enabledBy: GitHubVolatileActor;
      mergeMethod: "merge" | "rebase" | "squash";
    }>
  | Readonly<{
      status: "not_enabled";
    }>;

/** volatile metadataで識別したmerge queue状態。 */
export type GitHubVolatileMergeQueue =
  | Readonly<{
      status: "queued";
      sourceId: SourceId;
      nodeId: GitHubNodeId;
    }>
  | Readonly<{
      status: "not_queued";
    }>;

/** Pull Requestの現在値を既存detailの判定構造へ揃えたmerge状態。 */
export type GitHubPullRequestVolatileMergeState = Readonly<{
  mergeability: GitHubPullRequestMergeState["mergeability"];
  mergeState: GitHubPullRequestMergeState["mergeState"];
  autoMerge: GitHubVolatileAutoMerge;
  mergeQueue: GitHubVolatileMergeQueue;
  checks: GitHubHeadChecks;
}>;

/** Pull Requestのfingerprintへ含める現在値。raw本文やコメント本文を含まない。 */
export type GitHubPullRequestVolatileMetadataInput = Readonly<{
  nodeId: GitHubNodeId;
  headSha: string;
  reviewDecision: GitHubPullRequestReviewDecision;
  reviewRequests: readonly GitHubVolatileReviewRequest[];
  mergeState: GitHubPullRequestVolatileMergeState;
}>;

/** Pull Requestの現在値と生成済みfingerprint。 */
export type GitHubPullRequestVolatileMetadata = GitHubPullRequestVolatileMetadataInput &
  Readonly<{
    currentMetadataFingerprint: Sha256Fingerprint;
  }>;

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizeActor(actor: GitHubDetailActor): GitHubVolatileActor {
  if (actor.status === "unavailable") {
    return Object.freeze({ status: "unavailable" });
  }
  return Object.freeze({
    status: "identified",
    nodeId: actor.account.nodeId,
    apiType: actor.account.apiType,
  });
}

function normalizeReviewRequestTarget(
  target: GitHubReviewRequestTarget,
): GitHubVolatileReviewRequestTarget {
  if ("status" in target) {
    return Object.freeze({ status: "unavailable" });
  }
  if (target.type === "team") {
    return Object.freeze({
      status: "identified",
      kind: "team",
      nodeId: target.nodeId,
    });
  }
  return Object.freeze({
    status: "identified",
    kind: "actor",
    nodeId: target.nodeId,
    apiType: target.apiType,
  });
}

function normalizeReviewRequest(request: GitHubCurrentReviewRequest): GitHubVolatileReviewRequest {
  return Object.freeze({
    requestNodeId: request.nodeId,
    target: normalizeReviewRequestTarget(request.target),
  });
}

function compareReviewRequests(
  left: GitHubVolatileReviewRequest,
  right: GitHubVolatileReviewRequest,
): number {
  const requestComparison = compareStrings(left.requestNodeId, right.requestNodeId);
  if (requestComparison !== 0) {
    return requestComparison;
  }
  return compareStrings(JSON.stringify(left.target), JSON.stringify(right.target));
}

function normalizeReviewRequests(
  requests: readonly GitHubVolatileReviewRequest[],
): readonly GitHubVolatileReviewRequest[] {
  const requestNodeIds = new Set<string>();
  const targetNodeIds = new Set<string>();
  for (const request of requests) {
    if (requestNodeIds.has(request.requestNodeId)) {
      throw new TypeError("volatile review requestのnode IDが重複しています");
    }
    requestNodeIds.add(request.requestNodeId);
    if (request.target.status === "identified") {
      if (targetNodeIds.has(request.target.nodeId)) {
        throw new TypeError("volatile review request targetのnode IDが重複しています");
      }
      targetNodeIds.add(request.target.nodeId);
    }
  }
  return Object.freeze([...requests].sort(compareReviewRequests));
}

function compareCheckContexts(left: GitHubCheckContext, right: GitHubCheckContext): number {
  const nodeIdComparison = compareStrings(left.nodeId, right.nodeId);
  if (nodeIdComparison !== 0) {
    return nodeIdComparison;
  }
  return compareStrings(left.type, right.type);
}

function normalizeChecks(checks: GitHubHeadChecks): GitHubHeadChecks {
  if (checks.status === "not_configured") {
    return Object.freeze({ status: "not_configured" });
  }
  const contextNodeIds = new Set<string>();
  for (const context of checks.contexts) {
    if (contextNodeIds.has(context.nodeId)) {
      throw new TypeError("volatile check contextのnode IDが重複しています");
    }
    contextNodeIds.add(context.nodeId);
  }
  const contexts = Object.freeze([...checks.contexts].sort(compareCheckContexts));
  return Object.freeze({
    status: "configured",
    sourceId: checks.sourceId,
    nodeId: checks.nodeId,
    combinedState: checks.combinedState,
    contexts,
  });
}

function normalizeAutoMerge(
  autoMerge: GitHubPullRequestMergeState["autoMerge"],
): GitHubVolatileAutoMerge {
  if (autoMerge.status === "not_enabled") {
    return Object.freeze({ status: "not_enabled" });
  }
  return Object.freeze({
    status: "enabled",
    sourceId: autoMerge.sourceId,
    enabledAt: autoMerge.enabledAt,
    enabledBy: normalizeActor(autoMerge.enabledBy),
    mergeMethod: autoMerge.mergeMethod,
  });
}

function normalizeMergeQueue(
  mergeQueue: GitHubPullRequestMergeState["mergeQueue"],
): GitHubVolatileMergeQueue {
  if (mergeQueue.status === "not_queued") {
    return Object.freeze({ status: "not_queued" });
  }
  return Object.freeze({
    status: "queued",
    sourceId: mergeQueue.sourceId,
    nodeId: mergeQueue.nodeId,
  });
}

function normalizeMergeState(
  mergeState: GitHubPullRequestVolatileMergeState,
): GitHubPullRequestVolatileMergeState {
  return Object.freeze({
    mergeability: mergeState.mergeability,
    mergeState: mergeState.mergeState,
    autoMerge: Object.freeze({ ...mergeState.autoMerge }),
    mergeQueue: Object.freeze({ ...mergeState.mergeQueue }),
    checks: normalizeChecks(mergeState.checks),
  });
}

function serializeMetadata(input: GitHubPullRequestVolatileMetadataInput): string {
  const normalizedMergeState = normalizeMergeState(input.mergeState);
  return JSON.stringify({
    nodeId: input.nodeId,
    headSha: input.headSha,
    reviewDecision: input.reviewDecision,
    reviewRequests: normalizeReviewRequests(input.reviewRequests),
    mergeState: normalizedMergeState,
  });
}

function createSha256Fingerprint(value: string): Sha256Fingerprint {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

/** Pull Requestのvolatile metadataから決定論的fingerprintを生成する。 */
export function createGitHubPullRequestVolatileMetadataFingerprint(
  input: GitHubPullRequestVolatileMetadataInput,
): Sha256Fingerprint {
  return createSha256Fingerprint(serializeMetadata(input));
}

/** Pull Requestのvolatile metadataを正規化してfingerprintを付与する。 */
export function createGitHubPullRequestVolatileMetadata(
  input: GitHubPullRequestVolatileMetadataInput,
): GitHubPullRequestVolatileMetadata {
  const reviewRequests = normalizeReviewRequests(input.reviewRequests);
  const mergeState = normalizeMergeState(input.mergeState);
  const normalizedInput = Object.freeze({
    nodeId: input.nodeId,
    headSha: input.headSha,
    reviewDecision: input.reviewDecision,
    reviewRequests,
    mergeState,
  });
  return Object.freeze({
    ...normalizedInput,
    currentMetadataFingerprint: createSha256Fingerprint(JSON.stringify(normalizedInput)),
  });
}

/** 既存のPull Request detailからvolatile metadataを生成する。 */
export function createGitHubPullRequestVolatileMetadataFromDetail(
  detail: Extract<GitHubItemDetail, { type: "pull_request" }>,
): GitHubPullRequestVolatileMetadata {
  const reviewRequests = detail.reviewRequests.current.map(normalizeReviewRequest);
  return createGitHubPullRequestVolatileMetadata({
    nodeId: detail.nodeId,
    headSha: detail.headSha,
    reviewDecision: detail.reviewDecision,
    reviewRequests,
    mergeState: {
      mergeability: detail.mergeState.mergeability,
      mergeState: detail.mergeState.mergeState,
      autoMerge: normalizeAutoMerge(detail.mergeState.autoMerge),
      mergeQueue: normalizeMergeQueue(detail.mergeState.mergeQueue),
      checks: detail.mergeState.checks,
    },
  });
}

/** probeとPull Request detailのvolatile metadataが一致することを検証する。 */
export function validateGitHubPullRequestVolatileMetadata(
  expected: GitHubPullRequestVolatileMetadata,
  detail: Extract<GitHubItemDetail, { type: "pull_request" }>,
): GitHubPullRequestVolatileMetadata {
  const actual = createGitHubPullRequestVolatileMetadataFromDetail(detail);
  if (actual.currentMetadataFingerprint !== expected.currentMetadataFingerprint) {
    throw new GitHubPullRequestVolatileRaceError("detail", detail.nodeId, {
      cause: new TypeError(
        `probeとPull Request detailのvolatile metadataが一致しません。対象: ${detail.nodeId}`,
      ),
    });
  }
  return actual;
}
