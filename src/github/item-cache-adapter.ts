import { type FreshObservedGitHubItem } from "./item-normalization.js";
import {
  validateCodexAnalysisOutputAgainstCacheContext,
  type CodexCacheValidationContext,
} from "../codex/semantic-validation.js";
import { createAiCacheEntry, type AiCacheEntry } from "../codex/cache.js";
import { type ValidatedCodexAnalysisOutput } from "../codex/output-types.js";
import {
  type CandidateRelation,
  type RelationCandidate,
  type RelationCandidateNode,
} from "../graph/relation-candidate-types.js";
import {
  type RelationMutation,
  type RelationMutationInterval,
  type RelationMutationResult,
} from "../graph/relation-mutation.js";
import {
  createUtcIsoDateTime,
  type ReplayItemHistoryResult,
  type UtcIsoDateTime,
} from "../domain/index.js";
import {
  CACHE_DOCUMENT_SCHEMA_VERSION,
  createCacheDocument,
  type AiCacheReference,
  type CacheHistory,
  type CacheExplicitRequestCandidate,
  type CacheItemIndex,
  type CacheLifecycle,
  type CacheRepositoryIdentity,
  type GitHubItemCacheDocument,
  type GitHubItemCacheObservation,
  type CacheMentionedWaitingOnCandidate,
  type GitHubItemCacheRelationCandidate,
  type GitHubItemCacheRelationMutationResult,
  type GitHubItemCacheReplay,
} from "../persistence/cache-documents.js";
import { parseSha256Hash } from "../persistence/canonical-json.js";

/** GitHub item cache文書を生成する入力。raw本文は受け取らない。 */
export type CreateGitHubItemCacheDocumentInput = Readonly<{
  repository: CacheRepositoryIdentity;
  observation: FreshObservedGitHubItem;
  state: CacheItemIndex["state"];
  draftState: CacheItemIndex["draftState"];
  analysisRulesFingerprint: CacheItemIndex["analysisRulesFingerprint"];
  deterministicRulesVersion: string;
  lifecycle: CacheLifecycle;
  relationCandidates: readonly RelationCandidate[];
  relationMutations: readonly RelationMutationResult[];
  replay: ReplayItemHistoryResult;
  history: CacheHistory;
  analysisFacts: Readonly<{
    bodyEmpty: boolean;
    explicitRequestCandidates: readonly CacheExplicitRequestCandidate[];
    mentionedWaitingOnCandidates: readonly CacheMentionedWaitingOnCandidate[];
    codexValidationContext: CodexCacheValidationContext;
  }>;
  aiCacheReference: AiCacheReference;
}>;

/** current fingerprint一致を確認するcache復元入力。 */
export type RestoreGitHubItemCacheInput =
  | Readonly<{
      mode: "fresh";
      bodyFingerprint: CacheItemIndex["bodyFingerprint"];
      itemFingerprint: CacheItemIndex["itemFingerprint"];
      analysisRulesFingerprint: CacheItemIndex["analysisRulesFingerprint"];
    }>
  | Readonly<{
      mode: "stale";
      failedAt: UtcIsoDateTime;
    }>;

/** cache文書から復元したGitHub itemの安全な判定入力。 */
export type GitHubItemCacheRestoration =
  | Readonly<{
      status: "hit";
      freshness: "fresh";
      document: GitHubItemCacheDocument;
    }>
  | Readonly<{
      status: "hit";
      freshness: "stale";
      document: GitHubItemCacheDocument;
      failedAt: UtcIsoDateTime;
    }>
  | Readonly<{
      status: "cache_miss";
      reason: "current_fingerprint_mismatch";
    }>;

type CacheRelationNode = GitHubItemCacheRelationCandidate["relation"] extends infer Relation
  ? Relation extends { blocker: infer Blocker }
    ? Blocker
    : Relation extends { parent: infer Parent }
      ? Parent
      : Relation extends { implementation: infer Implementation }
        ? Implementation
        : Relation extends { referencing: infer Referencing }
          ? Referencing
          : never
  : never;
type CacheRelationReference = Extract<
  GitHubItemCacheRelationMutationResult,
  { status: "available" }
>["currentReferences"][number];
type CacheRelationMutation = Extract<
  GitHubItemCacheRelationMutationResult,
  { status: "available" }
>["mutations"][number];
type CacheRelationInterval = Extract<
  Extract<GitHubItemCacheRelationMutationResult, { status: "available" }>["temporalKnowledge"],
  { status: "exact" }
>["intervals"][number];
type CacheStateEpoch = Extract<
  GitHubItemCacheReplay["stateEpochs"],
  { status: "known" }
>["value"][number];
type CacheDraftEpoch = Extract<
  Exclude<GitHubItemCacheReplay["draftEpochs"], { status: "not_applicable" }>,
  { status: "known" }
>["value"][number];
type CacheResponsibilityEpoch = Extract<
  GitHubItemCacheReplay["responsibilityEpochs"],
  { status: "known" }
>["value"][number];
type CacheResponsibilityTarget = GitHubItemCacheReplay["currentResponsibilities"][number];
type CacheAvailableMutation = Extract<
  GitHubItemCacheRelationMutationResult,
  { status: "available" }
>;
type FreshObservedGitHubPullRequest = Extract<FreshObservedGitHubItem, { type: "pull_request" }>;
type FreshConfiguredChecks = Extract<
  FreshObservedGitHubPullRequest["mergeState"]["checks"],
  { status: "configured" }
>;
type ReplayStateEpoch = Extract<
  ReplayItemHistoryResult["stateEpochs"],
  { status: "known" }
>["value"][number];
type ReplayDraftEpoch = Extract<
  Exclude<ReplayItemHistoryResult["draftEpochs"], { status: "not_applicable" }>,
  { status: "known" }
>["value"][number];
type ReplayResponsibilityEpoch = Extract<
  ReplayItemHistoryResult["responsibilityEpochs"],
  { status: "known" }
>["value"][number];

function mapRelationNode(node: RelationCandidateNode): CacheRelationNode {
  if (node.scope === "organization") {
    return {
      scope: "organization",
      kind: node.kind,
      nodeId: node.nodeId,
      repositoryOwner: node.repositoryOwner,
      repositoryName: node.repositoryName,
      number: node.number,
      url: node.url,
      state: node.state,
    };
  }
  return {
    scope: "external_public",
    kind: "external_reference",
    nodeId: node.nodeId,
    githubNodeId: node.githubNodeId,
    githubItemType: node.githubItemType,
    repositoryOwner: node.repositoryOwner,
    repositoryName: node.repositoryName,
    number: node.number,
    url: node.url,
    state: node.state,
  };
}

function mapCandidateRelation(
  relation: CandidateRelation,
): GitHubItemCacheRelationCandidate["relation"] {
  switch (relation.type) {
    case "blocks":
      return {
        type: "blocks",
        blocker: mapRelationNode(relation.blocker),
        blocked: mapRelationNode(relation.blocked),
      };
    case "parent_of":
      return {
        type: "parent_of",
        parent: mapRelationNode(relation.parent),
        subtask: mapRelationNode(relation.subtask),
      };
    case "implements":
      return {
        type: "implements",
        implementation: mapRelationNode(relation.implementation),
        target: mapRelationNode(relation.target),
      };
    case "unclassified":
      return {
        type: "unclassified",
        referencing: mapRelationNode(relation.referencing),
        referenced: mapRelationNode(relation.referenced),
      };
  }
}

function mapRelationCandidate(candidate: RelationCandidate): GitHubItemCacheRelationCandidate {
  return {
    id: candidate.id,
    sourceIds: [...candidate.sourceIds],
    authority: candidate.authority,
    provenance: candidate.provenance,
    relation: mapCandidateRelation(candidate.relation),
  };
}

function mapRelationReference(reference: RelationMutation["relation"]): CacheRelationReference {
  return {
    repositoryOwner: reference.repositoryOwner,
    repositoryName: reference.repositoryName,
    itemType: reference.itemType,
    number: reference.number,
  };
}

function mapRelationMutation(mutation: RelationMutation): CacheRelationMutation {
  return {
    relation: mapRelationReference(mutation.relation),
    action: mutation.action,
    editedAt: mutation.editedAt,
    sourceId: mutation.sourceId,
    contentSourceId: mutation.contentSourceId,
    sequence: mutation.sequence,
  };
}

function relationReferenceKey(reference: CacheRelationReference): string {
  return `${reference.repositoryOwner.toLowerCase()}/${reference.repositoryName.toLowerCase()}#${reference.number.toString()}`;
}

function compareRelationReferences(
  left: CacheRelationReference,
  right: CacheRelationReference,
): number {
  const leftKey = relationReferenceKey(left);
  const rightKey = relationReferenceKey(right);
  if (leftKey < rightKey) {
    return -1;
  }
  if (leftKey > rightKey) {
    return 1;
  }
  return 0;
}

function compareRelationMutations(
  left: CacheRelationMutation,
  right: CacheRelationMutation,
): number {
  if (left.editedAt < right.editedAt) {
    return -1;
  }
  if (left.editedAt > right.editedAt) {
    return 1;
  }
  if (left.sequence !== right.sequence) {
    return left.sequence - right.sequence;
  }
  if (left.sourceId < right.sourceId) {
    return -1;
  }
  if (left.sourceId > right.sourceId) {
    return 1;
  }
  const relationOrder = compareRelationReferences(left.relation, right.relation);
  if (relationOrder !== 0) {
    return relationOrder;
  }
  if (left.action < right.action) {
    return -1;
  }
  if (left.action > right.action) {
    return 1;
  }
  return 0;
}

function mapRelationInterval(interval: RelationMutationInterval): CacheRelationInterval {
  if (interval.status === "active") {
    return {
      status: "active",
      relation: mapRelationReference(interval.relation),
      addedAt: interval.addedAt,
      addedSourceIds: [...interval.addedSourceIds],
      lastConfirmedAt: interval.lastConfirmedAt,
    };
  }
  return {
    status: "removed",
    relation: mapRelationReference(interval.relation),
    addedAt: interval.addedAt,
    addedSourceIds: [...interval.addedSourceIds],
    removedAt: interval.removedAt,
    removedSourceIds: [...interval.removedSourceIds],
  };
}

function mapRelationMutationResult(
  result: RelationMutationResult,
): GitHubItemCacheRelationMutationResult {
  if (result.status === "unknown") {
    if (result.sourceId == null) {
      return {
        status: "unknown",
        contentSourceId: result.contentSourceId,
        reason: result.reason,
      };
    }
    if (result.editedAt == null || result.sequence == null) {
      throw new TypeError("unknown relation mutationの編集根拠が不完全です");
    }
    return {
      status: "unknown",
      contentSourceId: result.contentSourceId,
      reason: result.reason,
      sourceId: result.sourceId,
      editedAt: result.editedAt,
      sequence: result.sequence,
    };
  }
  const temporalKnowledge: CacheAvailableMutation["temporalKnowledge"] =
    result.temporalKnowledge.status === "exact"
      ? {
          status: "exact",
          intervals: result.temporalKnowledge.intervals.map(mapRelationInterval),
        }
      : result.temporalKnowledge;
  return {
    status: "available",
    contentSourceId: result.contentSourceId,
    currentReferences: result.currentReferences
      .map(mapRelationReference)
      .sort(compareRelationReferences),
    replayedReferences: result.replayedReferences
      .map(mapRelationReference)
      .sort(compareRelationReferences),
    consistency: result.consistency,
    temporalKnowledge,
    mutations: result.mutations.map(mapRelationMutation).sort(compareRelationMutations),
    unmatchedRemovals: result.unmatchedRemovals
      .map(mapRelationMutation)
      .sort(compareRelationMutations),
  };
}

function mapObservationAuthor(
  author: FreshObservedGitHubItem["author"],
): GitHubItemCacheObservation["author"] {
  if (author.status === "unavailable") {
    return {
      status: "unavailable",
      reason: "deleted_account",
    };
  }
  return {
    status: "identified",
    actor: {
      type: author.actor.type,
      nodeId: author.actor.nodeId,
      login: author.actor.login,
    },
  };
}

function mapReviewThread(
  thread: FreshObservedGitHubPullRequest["reviewThreads"][number],
): Extract<GitHubItemCacheObservation, { type: "pull_request" }>["reviewThreads"][number] {
  return {
    sourceId: thread.sourceId,
    nodeId: thread.nodeId,
    isResolved: thread.isResolved,
    isOutdated: thread.isOutdated,
    path: thread.path,
    resolvedBy:
      thread.resolvedBy.status === "identified"
        ? {
            status: "identified",
            actor: thread.resolvedBy.actor,
          }
        : {
            status: "unavailable",
            reason: "github_did_not_return_actor",
          },
    commentSourceIds: [...thread.commentSourceIds],
  };
}

function mapReviewRequest(
  request: FreshObservedGitHubPullRequest["reviewRequests"][number],
): Extract<GitHubItemCacheObservation, { type: "pull_request" }>["reviewRequests"][number] {
  if (request.target.type === "user") {
    return {
      sourceId: request.sourceId,
      nodeId: request.nodeId,
      target: {
        type: "user",
        actor: request.target.actor,
      },
      requestedAt: request.requestedAt,
    };
  }
  return {
    sourceId: request.sourceId,
    nodeId: request.nodeId,
    target: {
      type: "team",
      sourceId: request.target.sourceId,
      nodeId: request.target.nodeId,
      organizationLogin: request.target.organizationLogin,
      slug: request.target.slug,
      name: request.target.name,
    },
    requestedAt: request.requestedAt,
  };
}

function mapPullRequestMergeState(
  mergeState: FreshObservedGitHubPullRequest["mergeState"],
): Extract<GitHubItemCacheObservation, { type: "pull_request" }>["mergeState"] {
  return {
    mergeability: mergeState.mergeability,
    mergeState: mergeState.mergeState,
    autoMerge: mergeState.autoMerge,
    mergeQueue: mergeState.mergeQueue,
    checks:
      mergeState.checks.status === "not_configured"
        ? { status: "not_configured" }
        : {
            status: "configured",
            sourceId: mergeState.checks.sourceId,
            nodeId: mergeState.checks.nodeId,
            combinedState: mergeState.checks.combinedState,
            contexts: mergeState.checks.contexts.map(mapCheckContext),
          },
  };
}

function mapCheckContext(
  context: FreshConfiguredChecks["contexts"][number],
): Extract<
  Extract<GitHubItemCacheObservation, { type: "pull_request" }>["mergeState"]["checks"],
  { status: "configured" }
>["contexts"][number] {
  if (context.type === "check_run") {
    return {
      type: "check_run",
      nodeId: context.nodeId,
      name: context.name,
      sourceId: context.sourceId,
      status: context.status,
      conclusion: context.conclusion,
      completedAt: context.completedAt,
    };
  }
  return {
    type: "commit_status",
    nodeId: context.nodeId,
    context: context.context,
    sourceId: context.sourceId,
    state: context.state,
    createdAt: context.createdAt,
  };
}

function mapNormalizedEvent(
  event: FreshObservedGitHubItem["events"][number],
): GitHubItemCacheObservation["events"][number] {
  if (event.kind === "comment" || event.kind === "review") {
    return {
      ...event,
      bodyFingerprint: parseSha256Hash(event.bodyFingerprint),
    };
  }
  return { ...event };
}

function mapObservation(
  observation: FreshObservedGitHubItem,
  analysisFacts: CreateGitHubItemCacheDocumentInput["analysisFacts"],
): GitHubItemCacheObservation {
  const freshness: GitHubItemCacheObservation["freshness"] = "fresh";
  const common = {
    freshness,
    sourceId: observation.sourceId,
    nodeId: observation.nodeId,
    repositoryId: observation.repositoryId,
    number: observation.number,
    url: observation.url,
    title: observation.title,
    bodySourceId: observation.bodySourceId,
    bodyEmpty: analysisFacts.bodyEmpty,
    bodyFingerprint: observation.bodyFingerprint,
    itemFingerprint: observation.itemFingerprint,
    createdAt: observation.createdAt,
    githubUpdatedAt: observation.githubUpdatedAt,
    observedAt: observation.observedAt,
    author: mapObservationAuthor(observation.author),
    assignees: observation.assignees.map((assignee) => ({ ...assignee })),
    labels: [...observation.labels],
    milestone:
      observation.milestone == null
        ? null
        : {
            nodeId: observation.milestone.nodeId,
            number: observation.milestone.number,
            title: observation.milestone.title,
            state: observation.milestone.state,
            dueOn: observation.milestone.dueOn,
          },
    events: observation.events.map(mapNormalizedEvent),
  };
  if (observation.type === "issue") {
    return {
      ...common,
      type: "issue",
      state: observation.state,
      stateReason: observation.stateReason,
      closedAt: observation.closedAt,
      draft: "not_applicable",
    };
  }
  return {
    ...common,
    type: "pull_request",
    state: observation.state,
    stateReason: observation.stateReason,
    closedAt: observation.closedAt,
    draft: observation.draft,
    headSha: observation.headSha,
    headCommit: {
      sourceId: observation.headCommit.sourceId,
      nodeId: observation.headCommit.nodeId,
      sha: observation.headCommit.sha,
      committedAt: observation.headCommit.committedAt,
      pushedAt: observation.headCommit.pushedAt,
    },
    reviewThreads: observation.reviewThreads.map(mapReviewThread),
    reviewRequests: observation.reviewRequests.map(mapReviewRequest),
    mergeState: mapPullRequestMergeState(observation.mergeState),
  };
}

function mapResponsibilityTarget(
  target: ReplayItemHistoryResult["currentResponsibilities"][number],
): CacheResponsibilityTarget {
  if (target.kind === "assignee") {
    return {
      kind: "assignee",
      nodeId: target.nodeId,
    };
  }
  if ("status" in target) {
    return {
      kind: "review_request",
      status: "unavailable",
      reason: "actor_unavailable",
    };
  }
  return {
    kind: "review_request",
    target: target.target,
    nodeId: target.nodeId,
  };
}

function mapStateEpoch(epoch: ReplayStateEpoch): CacheStateEpoch {
  return {
    occurredAt: epoch.occurredAt,
    sourceIds: [...epoch.sourceIds],
    state: epoch.state,
  };
}

function mapDraftEpoch(epoch: ReplayDraftEpoch): CacheDraftEpoch {
  return {
    occurredAt: epoch.occurredAt,
    sourceIds: [...epoch.sourceIds],
    draft: epoch.draft,
  };
}

function mapResponsibilityEpoch(epoch: ReplayResponsibilityEpoch): CacheResponsibilityEpoch {
  return {
    occurredAt: epoch.occurredAt,
    sourceIds: [...epoch.sourceIds],
    targets: epoch.targets.map(mapResponsibilityTarget),
  };
}

function mapReplay(replay: ReplayItemHistoryResult): GitHubItemCacheReplay {
  const stateEpochs: GitHubItemCacheReplay["stateEpochs"] =
    replay.stateEpochs.status === "known"
      ? { status: "known", value: replay.stateEpochs.value.map(mapStateEpoch) }
      : replay.stateEpochs;
  const currentStateEpoch: GitHubItemCacheReplay["currentStateEpoch"] =
    replay.currentStateEpoch.status === "known"
      ? { status: "known", value: mapStateEpoch(replay.currentStateEpoch.value) }
      : replay.currentStateEpoch;
  const draftEpochs: GitHubItemCacheReplay["draftEpochs"] =
    replay.draftEpochs.status === "not_applicable"
      ? replay.draftEpochs
      : replay.draftEpochs.status === "known"
        ? { status: "known", value: replay.draftEpochs.value.map(mapDraftEpoch) }
        : replay.draftEpochs;
  const currentDraftEpoch: GitHubItemCacheReplay["currentDraftEpoch"] =
    replay.currentDraftEpoch.status === "not_applicable"
      ? replay.currentDraftEpoch
      : replay.currentDraftEpoch.status === "known"
        ? { status: "known", value: mapDraftEpoch(replay.currentDraftEpoch.value) }
        : replay.currentDraftEpoch;
  const responsibilityEpochs: GitHubItemCacheReplay["responsibilityEpochs"] =
    replay.responsibilityEpochs.status === "known"
      ? {
          status: "known",
          value: replay.responsibilityEpochs.value.map(mapResponsibilityEpoch),
        }
      : replay.responsibilityEpochs;
  const currentOwnerEpoch: GitHubItemCacheReplay["currentOwnerEpoch"] =
    replay.currentOwnerEpoch.status === "known"
      ? { status: "known", value: mapResponsibilityEpoch(replay.currentOwnerEpoch.value) }
      : replay.currentOwnerEpoch;
  return {
    trackingStartAt: replay.trackingStartAt,
    currentState: replay.currentState,
    currentDraft:
      replay.currentDraft.status === "not_applicable"
        ? replay.currentDraft
        : { status: "known", value: replay.currentDraft.value },
    currentResponsibilities: replay.currentResponsibilities.map(mapResponsibilityTarget),
    stateEpochs,
    currentStateEpoch,
    draftEpochs,
    currentDraftEpoch,
    responsibilityEpochs,
    currentOwnerEpoch,
  };
}

function assertInputIdentity(input: CreateGitHubItemCacheDocumentInput): void {
  if (input.repository.repositoryId !== input.observation.repositoryId) {
    throw new TypeError("cache文書のrepository IDと観測値が一致しません");
  }
  if (input.observation.type === "issue") {
    if (input.state !== input.observation.state || input.draftState !== "not_applicable") {
      throw new TypeError("Issueのcache stateが観測値と一致しません");
    }
    return;
  }
  if (
    (input.state === "open" && input.observation.state !== "open") ||
    (input.state === "closed" && input.observation.state !== "closed") ||
    (input.state === "merged" && input.observation.state !== "closed") ||
    input.draftState !== (input.observation.draft ? "draft" : "ready_for_review")
  ) {
    throw new TypeError("Pull Requestのcache stateが観測値と一致しません");
  }
}

/** 最新の安全な観測値とreplayをstrictなitem cache文書へ変換する。 */
export function createGitHubItemCacheDocument(
  input: CreateGitHubItemCacheDocumentInput,
): GitHubItemCacheDocument {
  assertInputIdentity(input);
  const parsed = createCacheDocument({
    schemaVersion: CACHE_DOCUMENT_SCHEMA_VERSION,
    kind: "github_item",
    repository: input.repository,
    nodeId: input.observation.nodeId,
    repositoryId: input.observation.repositoryId,
    type: input.observation.type,
    number: input.observation.number,
    url: input.observation.url,
    state: input.state,
    draftState: input.draftState,
    bodyFingerprint: input.observation.bodyFingerprint,
    itemFingerprint: input.observation.itemFingerprint,
    analysisRulesFingerprint: input.analysisRulesFingerprint,
    deterministicRulesVersion: input.deterministicRulesVersion,
    createdAt: input.observation.createdAt,
    updatedAt: input.observation.githubUpdatedAt,
    observedAt: input.observation.observedAt,
    lifecycle: input.lifecycle,
    currentObservation: mapObservation(input.observation, input.analysisFacts),
    analysisFacts: {
      explicitRequestCandidates: input.analysisFacts.explicitRequestCandidates,
      mentionedWaitingOnCandidates: input.analysisFacts.mentionedWaitingOnCandidates,
      codexValidationContext: input.analysisFacts.codexValidationContext,
    },
    relationCandidates: input.relationCandidates
      .map(mapRelationCandidate)
      .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)),
    relationMutations: input.relationMutations
      .map(mapRelationMutationResult)
      .sort((left, right) =>
        left.contentSourceId < right.contentSourceId
          ? -1
          : left.contentSourceId > right.contentSourceId
            ? 1
            : 0,
      ),
    replay: mapReplay(input.replay),
    history: input.history,
    aiCacheReference: input.aiCacheReference,
  });
  if (parsed.kind !== "github_item") {
    throw new TypeError("item cache文書を生成できません");
  }
  return parsed;
}

function isCurrentFingerprintMatch(
  document: GitHubItemCacheDocument,
  input: Extract<RestoreGitHubItemCacheInput, { mode: "fresh" }>,
): boolean {
  return (
    document.bodyFingerprint === input.bodyFingerprint &&
    document.itemFingerprint === input.itemFingerprint &&
    document.analysisRulesFingerprint === input.analysisRulesFingerprint
  );
}

function validateRestoreInput(input: RestoreGitHubItemCacheInput): void {
  if (input.mode === "fresh") {
    parseSha256Hash(input.bodyFingerprint);
    parseSha256Hash(input.itemFingerprint);
    parseSha256Hash(input.analysisRulesFingerprint);
    return;
  }
  if (createUtcIsoDateTime(input.failedAt) !== input.failedAt) {
    throw new TypeError("stale復元の失敗時刻をUTCへ正規化してください");
  }
}

/** current fingerprintを検証し、freshまたはstaleなcache文書を復元する。 */
export function restoreGitHubItemCache(
  value: unknown,
  input: RestoreGitHubItemCacheInput,
): GitHubItemCacheRestoration {
  validateRestoreInput(input);
  const parsed = createCacheDocument(value);
  if (parsed.kind !== "github_item") {
    throw new TypeError("item cache文書だけを復元できます");
  }
  if (input.mode === "fresh") {
    if (!isCurrentFingerprintMatch(parsed, input)) {
      return {
        status: "cache_miss",
        reason: "current_fingerprint_mismatch",
      };
    }
    return {
      status: "hit",
      freshness: "fresh",
      document: parsed,
    };
  }
  if (input.failedAt < parsed.observedAt) {
    throw new RangeError("stale復元の失敗時刻は観測時刻以後にしてください");
  }
  return {
    status: "hit",
    freshness: "stale",
    document: parsed,
    failedAt: input.failedAt,
  };
}

/** item cache文書をraw detailなしで判定へ渡せる構造化sourceへ復元する。 */
export type GitHubItemCacheAnalysisSource = Readonly<{
  observation: GitHubItemCacheObservation;
  relationCandidates: readonly GitHubItemCacheDocument["relationCandidates"][number][];
  relationMutations: readonly GitHubItemCacheDocument["relationMutations"][number][];
  replay: GitHubItemCacheDocument["replay"];
  history: GitHubItemCacheDocument["history"];
  analysisFacts: GitHubItemCacheDocument["analysisFacts"];
}>;

/** warm item sourceの復元結果。cache missは推測せず明示する。 */
export type GitHubItemCacheAnalysisRestoration =
  | Readonly<{
      status: "hit";
      freshness: "fresh";
      document: GitHubItemCacheDocument;
      source: GitHubItemCacheAnalysisSource;
    }>
  | Readonly<{
      status: "hit";
      freshness: "stale";
      document: GitHubItemCacheDocument;
      source: GitHubItemCacheAnalysisSource;
      failedAt: UtcIsoDateTime;
    }>
  | Readonly<{
      status: "cache_miss";
      reason: "current_fingerprint_mismatch";
    }>;

function createAnalysisSource(document: GitHubItemCacheDocument): GitHubItemCacheAnalysisSource {
  return {
    observation: document.currentObservation,
    relationCandidates: document.relationCandidates,
    relationMutations: document.relationMutations,
    replay: document.replay,
    history: document.history,
    analysisFacts: document.analysisFacts,
  };
}

/** current observationとcache済みの決定論的事実をwarm解析sourceへ復元する。 */
export function restoreGitHubItemCacheForAnalysis(
  value: unknown,
  input: RestoreGitHubItemCacheInput,
): GitHubItemCacheAnalysisRestoration {
  const restored = restoreGitHubItemCache(value, input);
  if (restored.status === "cache_miss") {
    return restored;
  }
  if (restored.freshness === "fresh") {
    return {
      ...restored,
      source: createAnalysisSource(restored.document),
    };
  }
  return {
    ...restored,
    source: createAnalysisSource(restored.document),
  };
}

/** exact AI entryのcache参照、schema、semanticをwarm contextで再検証する入力。 */
export type GitHubItemCacheAiEntryInput =
  | Readonly<{
      status: "missing";
    }>
  | Readonly<{
      status: "available";
      value: unknown;
    }>;

/** exact AI entryの利用可否をraw detailなしで表す結果。 */
export type GitHubItemCacheAiValidation =
  | Readonly<{
      status: "validated";
      entry: AiCacheEntry;
      output: ValidatedCodexAnalysisOutput;
    }>
  | Readonly<{
      status: "unavailable";
      reason: "ai_cache_reference_unavailable";
    }>
  | Readonly<{
      status: "cache_miss";
      reason: "ai_cache_entry_unavailable";
    }>;

/** item cacheの参照entryと出力をschema・semantic検証する。 */
export function validateGitHubItemCacheAiEntry(
  document: GitHubItemCacheDocument,
  input: GitHubItemCacheAiEntryInput,
): GitHubItemCacheAiValidation {
  if (document.aiCacheReference.status !== "available") {
    return {
      status: "unavailable",
      reason: "ai_cache_reference_unavailable",
    };
  }
  if (input.status === "missing") {
    return {
      status: "cache_miss",
      reason: "ai_cache_entry_unavailable",
    };
  }
  const entry = createAiCacheEntry(input.value);
  if (
    entry.cacheKey !== document.aiCacheReference.cacheKey ||
    entry.sourceHash !== document.aiCacheReference.sourceHash ||
    entry.metadata.inputHash !== document.aiCacheReference.inputHash
  ) {
    throw new TypeError("item cacheのAI参照とentryが一致しません");
  }
  if (
    Date.parse(entry.metadata.executedAt) >
    Date.parse(document.analysisFacts.codexValidationContext.now)
  ) {
    throw new TypeError("AI entryの実行時刻がsemantic validation contextより後です");
  }
  const output = validateCodexAnalysisOutputAgainstCacheContext(
    entry.output,
    document.analysisFacts.codexValidationContext,
  );
  return {
    status: "validated",
    entry,
    output,
  };
}
