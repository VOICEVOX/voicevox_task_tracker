import { type Config } from "../config/index.js";
import {
  createCodexAnalysisInput,
  projectCodexLockedElements,
  type CodexAnalysisInput,
  type CodexPreservedElements,
} from "../codex/index.js";
import type { AiAnalysisElement } from "../domain/ai-analysis-elements.js";
import {
  parseSourceId,
  resolvePullRequestCommitOccurredAt,
  type GitHubNodeId,
  type IssueStateDecision,
  type PullRequestStateDecision,
  type SourceId,
  type UtcIsoDateTime,
} from "../domain/index.js";
import {
  deduplicateByStableId,
  type FreshObservedGitHubItem,
  type GitHubCheckContext,
  type GitHubIssueComment,
  type GitHubItemDetail,
  type GitHubPullRequestReviewComment,
} from "../github/index.js";
import type {
  PublicGitHubRelationItem,
  RelationCandidate,
  RelationCandidateId,
} from "../graph/index.js";
import {
  relationNodes,
  selectRelationAssessmentCandidates,
} from "../graph/relation-candidate-endpoints.js";
import { assertNonNullable } from "../util/index.js";
import {
  createMentionedWaitingOnCandidates,
  resolveEffectiveAssigneePullRequestState,
  type EffectiveAssigneeCandidateContext,
  type EffectiveAssigneeSourceContext,
} from "./issue-responsibility-candidates.js";

type CodexWaitingOnCandidate = Readonly<{ id: string }>;

type CodexSelfCommitmentCandidate = Readonly<{
  id: string;
  sourceIds: readonly SourceId[];
}>;

type CodexSourceAuthor = CodexAnalysisInput["sources"][number]["author"];

type CodexInputAnalysis = Readonly<{
  item: FreshObservedGitHubItem;
  detail: GitHubItemDetail;
  decision: IssueStateDecision | PullRequestStateDecision;
  relationCandidates: readonly RelationCandidate[];
  effectiveAssigneeCandidates: readonly EffectiveAssigneeCandidateContext[];
}>;

type RelationSourceOccurredAt = (
  items: readonly FreshObservedGitHubItem[],
) => ReadonlyMap<SourceId, UtcIsoDateTime>;

function authorType(item: FreshObservedGitHubItem): "human" | "bot" | "unknown" {
  if (item.author.status === "unavailable") {
    return "unknown";
  }
  return item.author.actor.type;
}

function addMirroredNativeBlockerSourceRecords(
  sourceRecords: Map<string, unknown>,
  item: FreshObservedGitHubItem,
  relationCandidates: readonly RelationCandidate[],
): void {
  for (const candidate of relationCandidates) {
    if (
      candidate.provenance !== "native" ||
      candidate.relation.type !== "blocks" ||
      candidate.relation.blocked.nodeId !== item.nodeId
    ) {
      continue;
    }
    const currentEvent = item.events.find(
      (event) =>
        event.kind === "relation" &&
        event.provenance === "native" &&
        event.relationType === "blocks" &&
        candidate.sourceIds.includes(event.sourceId),
    );
    if (currentEvent == null) {
      continue;
    }
    for (const sourceId of candidate.sourceIds) {
      if (sourceRecords.has(sourceId)) {
        continue;
      }
      sourceRecords.set(
        sourceId,
        Object.freeze({
          id: sourceId,
          kind: currentEvent.kind,
          actorType: currentEvent.actor.type,
          author: createUnavailableCodexSourceAuthor(),
          createdAt: currentEvent.occurredAt,
        }),
      );
    }
  }
}

function codexActorType(item: FreshObservedGitHubItem): "human" | "bot" | "system" {
  const type = authorType(item);
  return type === "unknown" ? "system" : type;
}

function codexAuthorCandidateId(item: FreshObservedGitHubItem): string | undefined {
  if (item.author.status === "unavailable") {
    return undefined;
  }
  return item.author.actor.login;
}

function createUnavailableCodexSourceAuthor(): CodexSourceAuthor {
  return Object.freeze({
    status: "unavailable",
  });
}

/** 項目のCodex入力に含めるコメントを返す。 */
export function codexCommentSources(
  detail: GitHubItemDetail,
): readonly (GitHubIssueComment | GitHubPullRequestReviewComment)[] {
  if (detail.type === "issue") {
    return detail.comments;
  }
  return Object.freeze([
    ...detail.comments,
    ...detail.reviewThreads.flatMap((thread) => thread.comments),
  ]);
}

function createCodexCommentAuthor(
  item: FreshObservedGitHubItem,
  comment: GitHubIssueComment | GitHubPullRequestReviewComment,
):
  | Readonly<{
      candidate: CodexWaitingOnCandidate;
      sourceAuthor: CodexSourceAuthor;
    }>
  | undefined {
  const event = item.events.find((candidate) => candidate.sourceId === comment.sourceId);
  if (comment.author.status !== "identified" || event?.actor.type !== "human") {
    return undefined;
  }
  assertNonNullable(event, `comment ${comment.sourceId}のeventがありません`);
  if (event.actor.nodeId !== comment.author.account.nodeId) {
    return undefined;
  }
  const candidate: CodexWaitingOnCandidate = Object.freeze({
    id: comment.author.account.login,
  });
  const sourceAuthor: CodexSourceAuthor =
    comment.createdAt === comment.updatedAt
      ? Object.freeze({
          status: "identified",
          candidateId: candidate.id,
          nodeId: comment.author.account.nodeId,
        })
      : createUnavailableCodexSourceAuthor();
  return Object.freeze({
    candidate,
    sourceAuthor,
  });
}

function selfCommitmentCandidates(
  item: FreshObservedGitHubItem,
  detail: GitHubItemDetail,
  previousObservedAt: UtcIsoDateTime | undefined,
  evaluatedAt: UtcIsoDateTime,
): readonly CodexSelfCommitmentCandidate[] {
  if (previousObservedAt == null) {
    return Object.freeze([]);
  }
  const sourceIdsByCandidateId = new Map<string, SourceId[]>();
  for (const comment of codexCommentSources(detail)) {
    const commentAuthor = createCodexCommentAuthor(item, comment);
    if (commentAuthor?.sourceAuthor.status !== "identified") {
      continue;
    }
    const event = item.events.find((candidate) => candidate.sourceId === comment.sourceId);
    assertNonNullable(event, `comment ${comment.sourceId}のeventがありません`);
    if (
      event.kind !== "comment" ||
      event.actor.type !== "human" ||
      event.actor.nodeId !== commentAuthor.sourceAuthor.nodeId ||
      event.occurredAt !== comment.createdAt ||
      event.occurredAt <= previousObservedAt ||
      event.occurredAt > evaluatedAt
    ) {
      continue;
    }
    const sourceIds = sourceIdsByCandidateId.get(commentAuthor.sourceAuthor.candidateId);
    if (sourceIds == null) {
      sourceIdsByCandidateId.set(commentAuthor.sourceAuthor.candidateId, [comment.sourceId]);
    } else {
      sourceIds.push(comment.sourceId);
    }
  }
  return Object.freeze(
    [...sourceIdsByCandidateId.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([id, sourceIds]) =>
        Object.freeze({
          id,
          sourceIds: Object.freeze([...new Set(sourceIds)].sort()),
        }),
      ),
  );
}

function relationTargetUrl(
  nodeId: GitHubNodeId,
  candidate: RelationCandidate,
): PublicGitHubRelationItem["url"] {
  const nodes = relationNodes(candidate.relation);
  const target = nodes.find((node) => node.nodeId !== nodeId);
  assertNonNullable(target, `関係候補 ${candidate.id}の相手項目がありません`);
  return target.url;
}

function createNativeRelationSignals(
  currentNodeId: GitHubNodeId,
  candidates: readonly RelationCandidate[],
): Readonly<{
  nativeBlockedBy: readonly RelationCandidateId[];
  nativeBlocking: readonly RelationCandidateId[];
  nativeParent: readonly RelationCandidateId[];
  nativeSubIssues: readonly RelationCandidateId[];
}> {
  const nativeBlockedBy: RelationCandidateId[] = [];
  const nativeBlocking: RelationCandidateId[] = [];
  const nativeParent: RelationCandidateId[] = [];
  const nativeSubIssues: RelationCandidateId[] = [];
  for (const candidate of candidates) {
    if (candidate.provenance !== "native") {
      continue;
    }
    switch (candidate.relation.type) {
      case "blocks":
        if (candidate.relation.blocked.nodeId === currentNodeId) {
          nativeBlockedBy.push(candidate.id);
        } else if (candidate.relation.blocker.nodeId === currentNodeId) {
          nativeBlocking.push(candidate.id);
        } else {
          throw new TypeError(`native関係候補 ${candidate.id}に現在項目が含まれていません`);
        }
        break;
      case "parent_of":
        if (candidate.relation.subtask.nodeId === currentNodeId) {
          nativeParent.push(candidate.id);
        } else if (candidate.relation.parent.nodeId === currentNodeId) {
          nativeSubIssues.push(candidate.id);
        } else {
          throw new TypeError(`native関係候補 ${candidate.id}に現在項目が含まれていません`);
        }
        break;
      case "implements":
        break;
    }
  }
  return Object.freeze({
    nativeBlockedBy: Object.freeze(nativeBlockedBy.sort()),
    nativeBlocking: Object.freeze(nativeBlocking.sort()),
    nativeParent: Object.freeze(nativeParent.sort()),
    nativeSubIssues: Object.freeze(nativeSubIssues.sort()),
  });
}

/** 指定した時刻のうち最新を返す。 */
export function latestUtcIsoDateTime(
  values: readonly UtcIsoDateTime[],
  context: string,
): UtcIsoDateTime {
  const firstValue = values[0];
  assertNonNullable(firstValue, `${context}の時刻がありません`);
  return values.slice(1).reduce((latest, value) => (latest < value ? value : latest), firstValue);
}

function addCodexSourceOccurredAt(
  sourceOccurredAtById: Map<SourceId, UtcIsoDateTime>,
  sourceId: SourceId,
  occurredAt: UtcIsoDateTime,
): void {
  const existingOccurredAt = sourceOccurredAtById.get(sourceId);
  if (existingOccurredAt != null && existingOccurredAt !== occurredAt) {
    if (parseSourceId(sourceId).kind !== "github_commit") {
      throw new TypeError(`同じCodex source IDに異なる発生時刻があります。対象: ${sourceId}`);
    }
    sourceOccurredAtById.set(
      sourceId,
      existingOccurredAt < occurredAt ? existingOccurredAt : occurredAt,
    );
    return;
  }
  sourceOccurredAtById.set(sourceId, occurredAt);
}

function checkContextOccurredAt(
  headOccurredAt: UtcIsoDateTime,
  context: GitHubCheckContext,
): UtcIsoDateTime {
  if (context.type === "commit_status") {
    return context.createdAt;
  }
  return context.completedAt ?? headOccurredAt;
}

/** 文脈内sourceの発生時刻をCodex入力の時刻表へ加える。 */
export function addCodexSourceOccurredAtForContext(
  sourceOccurredAtById: Map<SourceId, UtcIsoDateTime>,
  item: FreshObservedGitHubItem,
  detail: GitHubItemDetail,
  relationSourceOccurredAt: RelationSourceOccurredAt,
): void {
  for (const [sourceId, occurredAt] of relationSourceOccurredAt([item])) {
    addCodexSourceOccurredAt(sourceOccurredAtById, sourceId, occurredAt);
  }
  addCodexSourceOccurredAt(sourceOccurredAtById, item.sourceId, item.createdAt);
  addCodexSourceOccurredAt(sourceOccurredAtById, detail.bodySourceId, item.createdAt);
  for (const comment of detail.comments) {
    addCodexSourceOccurredAt(sourceOccurredAtById, comment.sourceId, comment.createdAt);
  }
  if (detail.type !== "pull_request" || detail.mergeState.checks.status !== "configured") {
    return;
  }
  const headOccurredAt = resolvePullRequestCommitOccurredAt(detail.headCommit, item.createdAt);
  const checkOccurredAts = detail.mergeState.checks.contexts.map((context) => {
    const occurredAt = checkContextOccurredAt(headOccurredAt, context);
    addCodexSourceOccurredAt(sourceOccurredAtById, context.sourceId, occurredAt);
    return occurredAt;
  });
  addCodexSourceOccurredAt(
    sourceOccurredAtById,
    detail.mergeState.checks.sourceId,
    latestUtcIsoDateTime(
      [headOccurredAt, ...checkOccurredAts],
      `check rollup ${detail.mergeState.checks.sourceId}`,
    ),
  );
}

/** 項目と詳細からCodex sourceの発生時刻表を作る。 */
export function createCodexSourceOccurredAtById(
  item: FreshObservedGitHubItem,
  detail: GitHubItemDetail,
  relationSourceOccurredAt: RelationSourceOccurredAt,
): ReadonlyMap<SourceId, UtcIsoDateTime> {
  const sourceOccurredAtById = new Map<SourceId, UtcIsoDateTime>();
  addCodexSourceOccurredAtForContext(sourceOccurredAtById, item, detail, relationSourceOccurredAt);
  return sourceOccurredAtById;
}

function addCodexSourceRecord(
  sourceRecords: Map<string, unknown>,
  sourceId: SourceId,
  record: unknown,
): void {
  if (sourceRecords.has(sourceId)) {
    return;
  }
  sourceRecords.set(sourceId, record);
}

function addCodexSourceRecordsForContext(
  sourceRecords: Map<string, unknown>,
  sourceOccurredAtById: ReadonlyMap<SourceId, UtcIsoDateTime>,
  context: EffectiveAssigneeSourceContext,
): void {
  const { item, detail } = context;
  addCodexSourceRecord(
    sourceRecords,
    item.sourceId,
    Object.freeze({
      id: item.sourceId,
      kind: "item",
      actorType: codexActorType(item),
      author: createUnavailableCodexSourceAuthor(),
      createdAt: item.createdAt,
    }),
  );
  for (const event of item.events) {
    addCodexSourceRecord(
      sourceRecords,
      event.sourceId,
      Object.freeze({
        id: event.sourceId,
        kind: event.kind,
        actorType: event.actor.type,
        author: createUnavailableCodexSourceAuthor(),
        createdAt: requireCodexSourceOccurredAt(sourceOccurredAtById, event.sourceId),
      }),
    );
  }
  const itemActorType = codexActorType(item);
  addCodexSourceRecord(
    sourceRecords,
    detail.bodySourceId,
    Object.freeze({
      id: detail.bodySourceId,
      kind: "body",
      actorType: itemActorType,
      author: createUnavailableCodexSourceAuthor(),
      createdAt: item.createdAt,
      ...(itemActorType === "human" ? { content: detail.body } : {}),
    }),
  );
  for (const comment of detail.comments) {
    const event = item.events.find((candidate) => candidate.sourceId === comment.sourceId);
    const actorType = event?.actor.type ?? "system";
    addCodexSourceRecord(
      sourceRecords,
      comment.sourceId,
      Object.freeze({
        id: comment.sourceId,
        kind: "comment",
        actorType,
        author: createUnavailableCodexSourceAuthor(),
        createdAt: comment.createdAt,
        ...(actorType === "human" ? { content: comment.body } : {}),
      }),
    );
  }
  if (detail.type !== "pull_request") {
    return;
  }
  if (item.type !== "pull_request") {
    throw new TypeError("Pull Request詳細にIssueの観測値が指定されています");
  }
  for (const thread of detail.reviewThreads) {
    for (const comment of thread.comments) {
      const event = item.events.find((candidate) => candidate.sourceId === comment.sourceId);
      const actorType = event?.actor.type ?? "system";
      addCodexSourceRecord(
        sourceRecords,
        comment.sourceId,
        Object.freeze({
          id: comment.sourceId,
          kind: "comment",
          actorType,
          author: createUnavailableCodexSourceAuthor(),
          createdAt: comment.createdAt,
          ...(actorType === "human" ? { content: comment.body } : {}),
        }),
      );
    }
  }
  for (const review of detail.reviews) {
    const event = item.events.find((candidate) => candidate.sourceId === review.sourceId);
    const actorType = event?.actor.type ?? "system";
    addCodexSourceRecord(
      sourceRecords,
      review.sourceId,
      Object.freeze({
        id: review.sourceId,
        kind: "review",
        actorType,
        author: createUnavailableCodexSourceAuthor(),
        createdAt: review.submittedAt,
        ...(actorType === "human" ? { content: review.body } : {}),
      }),
    );
  }
  for (const request of detail.reviewRequests.current) {
    if (request.requestedAt.status === "unavailable") {
      continue;
    }
    addCodexSourceRecord(
      sourceRecords,
      request.sourceId,
      Object.freeze({
        id: request.sourceId,
        kind: "review_request",
        actorType: "system",
        author: createUnavailableCodexSourceAuthor(),
        createdAt: request.requestedAt.value,
      }),
    );
  }
  if (item.mergeState.autoMerge.status === "enabled") {
    const autoMerge = item.mergeState.autoMerge;
    addCodexSourceRecord(
      sourceRecords,
      autoMerge.sourceId,
      Object.freeze({
        id: autoMerge.sourceId,
        kind: "auto_merge_request",
        actorType: autoMerge.enabledBy.type,
        author: createUnavailableCodexSourceAuthor(),
        createdAt: autoMerge.enabledAt,
        mergeMethod: autoMerge.mergeMethod,
      }),
    );
  }
  if (detail.mergeState.checks.status !== "configured") {
    return;
  }
  const checks = detail.mergeState.checks;
  addCodexSourceRecord(
    sourceRecords,
    checks.sourceId,
    Object.freeze({
      id: checks.sourceId,
      kind: "required_check_rollup",
      actorType: "system",
      author: createUnavailableCodexSourceAuthor(),
      createdAt: requireCodexSourceOccurredAt(sourceOccurredAtById, checks.sourceId),
      combinedState: checks.combinedState,
    }),
  );
  for (const check of checks.contexts) {
    addCodexSourceRecord(
      sourceRecords,
      check.sourceId,
      Object.freeze({
        id: check.sourceId,
        kind: check.type,
        actorType: "system",
        author: createUnavailableCodexSourceAuthor(),
        createdAt: requireCodexSourceOccurredAt(sourceOccurredAtById, check.sourceId),
        ...(check.type === "check_run"
          ? {
              name: check.name,
              status: check.status,
              conclusion: check.conclusion,
            }
          : {
              context: check.context,
              state: check.state,
            }),
      }),
    );
  }
}

function requireCodexSourceOccurredAt(
  sourceOccurredAtById: ReadonlyMap<SourceId, UtcIsoDateTime>,
  sourceId: SourceId,
): UtcIsoDateTime {
  const occurredAt = sourceOccurredAtById.get(sourceId);
  assertNonNullable(occurredAt, `Codex sourceの発生時刻がありません。対象: ${sourceId}`);
  return occurredAt;
}

/** 決定論的判定と収集結果から汎用Codex入力を組み立てる。 */
export function createCodexInput(
  configuration: Readonly<{ config: Config }>,
  evaluatedAt: UtcIsoDateTime,
  analysis: CodexInputAnalysis,
  selectedElements: readonly AiAnalysisElement[],
  preservedElements: CodexPreservedElements,
  previousObservedAt: UtcIsoDateTime | undefined,
  relationSourceOccurredAt: RelationSourceOccurredAt,
): CodexAnalysisInput {
  const relationCandidates = deduplicateByStableId(
    selectRelationAssessmentCandidates(analysis.item.nodeId, analysis.relationCandidates),
    (candidate) => candidate.id,
  );
  const mentionedCandidates = createMentionedWaitingOnCandidates(analysis.detail);
  const selfCandidates = selfCommitmentCandidates(
    analysis.item,
    analysis.detail,
    previousObservedAt,
    evaluatedAt,
  );
  const nativeRelationSignals = createNativeRelationSignals(
    analysis.item.nodeId,
    relationCandidates,
  );
  const waitingOnCandidates = new Map<string, CodexWaitingOnCandidate>(
    analysis.decision.waitingOn.map(
      (waitingOn) =>
        [
          waitingOn.candidateId,
          Object.freeze({
            id: waitingOn.candidateId,
          }),
        ] satisfies readonly [string, CodexWaitingOnCandidate],
    ),
  );
  const authorCandidateId = codexAuthorCandidateId(analysis.item);
  if (authorCandidateId != null) {
    waitingOnCandidates.set(
      authorCandidateId,
      Object.freeze({
        id: authorCandidateId,
      }),
    );
  }
  for (const candidate of mentionedCandidates) {
    waitingOnCandidates.set(candidate.id, Object.freeze({ id: candidate.id }));
  }
  const commentAuthorBySourceId = new Map<SourceId, CodexSourceAuthor>();
  for (const comment of codexCommentSources(analysis.detail)) {
    const commentAuthor = createCodexCommentAuthor(analysis.item, comment);
    if (commentAuthor == null) {
      continue;
    }
    waitingOnCandidates.set(commentAuthor.candidate.id, commentAuthor.candidate);
    commentAuthorBySourceId.set(comment.sourceId, commentAuthor.sourceAuthor);
  }
  for (const effectiveCandidateContext of analysis.effectiveAssigneeCandidates) {
    const candidate = effectiveCandidateContext.candidate;
    const existingKey = [...waitingOnCandidates.keys()].find(
      (candidateId) => candidateId.toLowerCase() === candidate.candidateId.toLowerCase(),
    );
    if (existingKey != null && existingKey !== candidate.candidateId) {
      waitingOnCandidates.delete(existingKey);
    }
    waitingOnCandidates.set(
      candidate.candidateId,
      Object.freeze({
        id: candidate.candidateId,
      }),
    );
  }
  const sourceOccurredAtById = new Map(
    createCodexSourceOccurredAtById(analysis.item, analysis.detail, relationSourceOccurredAt),
  );
  for (const effectiveCandidateContext of analysis.effectiveAssigneeCandidates) {
    for (const sourceContext of effectiveCandidateContext.sourceContexts) {
      addCodexSourceOccurredAtForContext(
        sourceOccurredAtById,
        sourceContext.item,
        sourceContext.detail,
        relationSourceOccurredAt,
      );
    }
  }
  const sourceRecords = new Map<string, unknown>();
  sourceRecords.set(
    analysis.item.sourceId,
    Object.freeze({
      id: analysis.item.sourceId,
      kind: "item",
      actorType: codexActorType(analysis.item),
      author: createUnavailableCodexSourceAuthor(),
      createdAt: analysis.item.createdAt,
    }),
  );
  for (const event of analysis.item.events) {
    sourceRecords.set(
      event.sourceId,
      Object.freeze({
        id: event.sourceId,
        kind: event.kind,
        actorType: event.actor.type,
        author: createUnavailableCodexSourceAuthor(),
        createdAt: requireCodexSourceOccurredAt(sourceOccurredAtById, event.sourceId),
      }),
    );
  }
  addMirroredNativeBlockerSourceRecords(sourceRecords, analysis.item, relationCandidates);
  sourceRecords.set(
    analysis.detail.bodySourceId,
    Object.freeze({
      id: analysis.detail.bodySourceId,
      kind: "body",
      actorType: codexActorType(analysis.item),
      author: createUnavailableCodexSourceAuthor(),
      createdAt: analysis.item.createdAt,
      content: analysis.detail.body,
    }),
  );
  for (const comment of analysis.detail.comments) {
    const event = analysis.item.events.find((candidate) => candidate.sourceId === comment.sourceId);
    sourceRecords.set(
      comment.sourceId,
      Object.freeze({
        id: comment.sourceId,
        kind: "comment",
        actorType: event?.actor.type ?? "system",
        author:
          commentAuthorBySourceId.get(comment.sourceId) ?? createUnavailableCodexSourceAuthor(),
        createdAt: comment.createdAt,
        content: comment.body,
      }),
    );
  }
  if (analysis.detail.type === "pull_request") {
    if (analysis.item.type !== "pull_request") {
      throw new TypeError("Pull RequestのCodex入力にIssueの観測値が指定されています");
    }
    for (const thread of analysis.detail.reviewThreads) {
      for (const comment of thread.comments) {
        const event = analysis.item.events.find(
          (candidate) => candidate.sourceId === comment.sourceId,
        );
        sourceRecords.set(
          comment.sourceId,
          Object.freeze({
            id: comment.sourceId,
            kind: "comment",
            actorType: event?.actor.type ?? "system",
            author:
              commentAuthorBySourceId.get(comment.sourceId) ?? createUnavailableCodexSourceAuthor(),
            createdAt: comment.createdAt,
            content: comment.body,
          }),
        );
      }
    }
    for (const review of analysis.detail.reviews) {
      const event = analysis.item.events.find(
        (candidate) => candidate.sourceId === review.sourceId,
      );
      sourceRecords.set(
        review.sourceId,
        Object.freeze({
          id: review.sourceId,
          kind: "review",
          actorType: event?.actor.type ?? "system",
          author: createUnavailableCodexSourceAuthor(),
          createdAt: review.submittedAt,
          content: review.body,
        }),
      );
    }
    for (const request of analysis.detail.reviewRequests.current) {
      if (request.requestedAt.status === "unavailable") {
        continue;
      }
      sourceRecords.set(
        request.sourceId,
        Object.freeze({
          id: request.sourceId,
          kind: "review_request",
          actorType: "system",
          author: createUnavailableCodexSourceAuthor(),
          createdAt: request.requestedAt.value,
        }),
      );
    }
    if (analysis.item.mergeState.autoMerge.status === "enabled") {
      const autoMerge = analysis.item.mergeState.autoMerge;
      sourceRecords.set(
        autoMerge.sourceId,
        Object.freeze({
          id: autoMerge.sourceId,
          kind: "auto_merge_request",
          actorType: autoMerge.enabledBy.type,
          author: createUnavailableCodexSourceAuthor(),
          createdAt: autoMerge.enabledAt,
          mergeMethod: autoMerge.mergeMethod,
        }),
      );
    }
  }
  if (
    analysis.detail.type === "pull_request" &&
    analysis.detail.mergeState.checks.status === "configured"
  ) {
    const checks = analysis.detail.mergeState.checks;
    sourceRecords.set(
      checks.sourceId,
      Object.freeze({
        id: checks.sourceId,
        kind: "required_check_rollup",
        actorType: "system",
        author: createUnavailableCodexSourceAuthor(),
        createdAt: requireCodexSourceOccurredAt(sourceOccurredAtById, checks.sourceId),
        combinedState: checks.combinedState,
      }),
    );
    for (const context of checks.contexts) {
      sourceRecords.set(
        context.sourceId,
        Object.freeze({
          id: context.sourceId,
          kind: context.type,
          actorType: "system",
          author: createUnavailableCodexSourceAuthor(),
          createdAt: requireCodexSourceOccurredAt(sourceOccurredAtById, context.sourceId),
          ...(context.type === "check_run"
            ? {
                name: context.name,
                status: context.status,
                conclusion: context.conclusion,
              }
            : {
                context: context.context,
                state: context.state,
              }),
        }),
      );
    }
  }
  for (const effectiveCandidateContext of analysis.effectiveAssigneeCandidates) {
    for (const sourceContext of effectiveCandidateContext.sourceContexts) {
      addCodexSourceRecordsForContext(sourceRecords, sourceOccurredAtById, sourceContext);
    }
  }
  return createCodexAnalysisInput({
    schemaVersion: "5",
    now: evaluatedAt,
    item: {
      nodeId: analysis.item.nodeId,
      url: analysis.item.url,
      type: analysis.item.type,
      title: analysis.item.title,
      ...(authorCandidateId == null ? {} : { authorCandidateId }),
      ...(analysis.item.type === "pull_request"
        ? {
            headSha: analysis.item.headSha,
          }
        : {}),
    },
    candidates: {
      waitingOn: [...waitingOnCandidates.values()],
      relations: relationCandidates.map((candidate) => ({
        id: candidate.id,
        targetUrl: relationTargetUrl(analysis.item.nodeId, candidate),
      })),
    },
    selfCommitmentCandidates: selfCandidates,
    sources: [...sourceRecords.values()],
    deterministicSignals: {
      status: analysis.decision.status,
      waitingOn: analysis.decision.waitingOn,
      relationCandidateIds: relationCandidates.map((candidate) => candidate.id),
      ...nativeRelationSignals,
      mentionedWaitingOnCandidates: mentionedCandidates,
      requiredCheckFailure:
        analysis.detail.type === "pull_request" &&
        analysis.detail.mergeState.checks.status === "configured" &&
        (analysis.detail.mergeState.checks.combinedState === "failure" ||
          analysis.detail.mergeState.checks.combinedState === "error")
          ? analysis.detail.mergeState.checks
          : null,
      uncertainties: analysis.decision.uncertainties,
      effectiveAssigneeEligible:
        analysis.item.type === "issue" &&
        analysis.item.state === "open" &&
        analysis.item.assignees.length === 0,
      effectiveAssigneeCandidates: analysis.effectiveAssigneeCandidates.map(({ candidate }) => ({
        candidateId: candidate.candidateId,
        sourceIds: candidate.sourceIds,
        occurredAt: candidate.occurredAt,
      })),
      effectiveAssigneeImplementations: analysis.effectiveAssigneeCandidates.flatMap(
        ({ candidate, sourceContexts }) =>
          sourceContexts.flatMap(({ item: sourceItem }) => {
            if (sourceItem.type !== "pull_request") {
              return [];
            }
            return analysis.relationCandidates.flatMap((relationCandidate) => {
              if (
                relationCandidate.relation.type !== "implements" ||
                relationCandidate.relation.implementation.nodeId !== sourceItem.nodeId ||
                relationCandidate.relation.target.nodeId !== analysis.item.nodeId
              ) {
                return [];
              }
              return [
                {
                  candidateId: candidate.candidateId,
                  pullRequestNodeId: sourceItem.nodeId,
                  pullRequestUrl: sourceItem.url,
                  pullRequestState: resolveEffectiveAssigneePullRequestState(sourceItem),
                  relationCandidateIds: [relationCandidate.id],
                },
              ];
            });
          }),
      ),
      effectiveAssigneeConfidenceThreshold: configuration.config.ai.confidence.high,
    },
    selectedElements,
    lockedElements: projectCodexLockedElements(preservedElements),
  });
}
