import {
  parseSourceId,
  type GitHubNodeId,
  type IssueEffectiveAssigneeCandidate,
  type NormalizedEvent,
  type SourceId,
  type UtcIsoDateTime,
} from "../domain/index.js";
import {
  deduplicateByStableId,
  type FreshObservedGitHubItem,
  type GitHubItemDetail,
} from "../github/index.js";
import type { RelationCandidate } from "../graph/index.js";
import { assertNonNullable, UnreachableError } from "../util/index.js";

const GITHUB_MENTION_PATTERN =
  /(?<![A-Za-z0-9-])@([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))(?:\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,99})))?/gu;

/** 本文とコメントで言及された待機先候補。 */
type MentionedWaitingOnCandidate = Readonly<{
  id: string;
  kind: "user" | "team";
  sourceIds: readonly [SourceId, ...SourceId[]];
}>;

/** 実質担当候補の根拠となる項目と詳細。 */
export type EffectiveAssigneeSourceContext = Readonly<{
  item: FreshObservedGitHubItem;
  detail: GitHubItemDetail;
}>;

/** 根拠の収集元を伴う実質担当候補。 */
export type EffectiveAssigneeCandidateContext = Readonly<{
  candidate: IssueEffectiveAssigneeCandidate;
  sourceContexts: readonly EffectiveAssigneeSourceContext[];
}>;

/** 実質担当候補を収集する項目と追跡対象。 */
export type EffectiveAssigneeCollectionContext = Readonly<{
  observedItemsByNodeId: ReadonlyMap<GitHubNodeId, FreshObservedGitHubItem>;
  detailsByNodeId: ReadonlyMap<GitHubNodeId, GitHubItemDetail>;
  trackedNodeIds: ReadonlySet<GitHubNodeId>;
}>;

/** Issue本文と人間のコメントから明示依頼候補を作る。 */
export function createIssueRequestCandidates(
  item: Extract<FreshObservedGitHubItem, { type: "issue" }>,
  detail: Extract<GitHubItemDetail, { type: "issue" }>,
): readonly Readonly<{ sourceId: SourceId; occurredAt: UtcIsoDateTime }>[] {
  const candidates: Readonly<{ sourceId: SourceId; occurredAt: UtcIsoDateTime }>[] = [];
  if (detail.body.trim().length > 0) {
    candidates.push(
      Object.freeze({
        sourceId: detail.bodySourceId,
        occurredAt: item.createdAt,
      }),
    );
  }
  const humanCommentSourceIds = new Set(
    item.events
      .filter((event) => event.kind === "comment" && event.actor.type === "human")
      .map((event) => event.sourceId),
  );
  for (const comment of detail.comments) {
    if (comment.body.trim().length > 0 && humanCommentSourceIds.has(comment.sourceId)) {
      candidates.push(
        Object.freeze({
          sourceId: comment.sourceId,
          occurredAt: comment.createdAt,
        }),
      );
    }
  }
  return deduplicateByStableId(candidates, (candidate) => candidate.sourceId);
}

type EffectiveAssigneeCandidateAccumulator = Readonly<{
  candidateId: string;
  sourceIds: Set<SourceId>;
  occurredAtBySourceId: Map<SourceId, UtcIsoDateTime>;
  sourceContexts: Map<GitHubNodeId, EffectiveAssigneeSourceContext>;
}>;

type EffectiveAssigneeStateEvent = Extract<NormalizedEvent, { kind: "state" }>;

function latestEffectiveAssigneeUnassignmentAt(
  detail: Extract<GitHubItemDetail, { type: "issue" }>,
): UtcIsoDateTime | undefined {
  let latestUnassignedAt: UtcIsoDateTime | undefined;
  for (const event of detail.timeline) {
    if (event.kind !== "unassigned") {
      continue;
    }
    if (latestUnassignedAt == null || latestUnassignedAt < event.occurredAt) {
      latestUnassignedAt = event.occurredAt;
    }
  }
  return latestUnassignedAt;
}

/** PRの最新state eventから実質担当候補のPR状態を解決する。 */
export function resolveEffectiveAssigneePullRequestState(
  pullRequest: Extract<FreshObservedGitHubItem, { type: "pull_request" }>,
): "open" | "merged" | "closed_unmerged" {
  const stateEvents = pullRequest.events
    .filter((event): event is EffectiveAssigneeStateEvent => event.kind === "state")
    .sort((left, right) => {
      if (left.occurredAt !== right.occurredAt) {
        return left.occurredAt < right.occurredAt ? -1 : 1;
      }
      if (left.sourceId === right.sourceId) {
        return 0;
      }
      return left.sourceId < right.sourceId ? -1 : 1;
    });
  const latestStateEvent = stateEvents.at(-1);
  if (pullRequest.state === "open") {
    if (latestStateEvent == null) {
      return "open";
    }
    switch (latestStateEvent.state) {
      case "open":
      case "reopened":
        return "open";
      case "closed":
      case "merged":
        throw new TypeError(
          `openなPull Requestの最新state eventが現在状態と一致しません。対象: ${pullRequest.nodeId}`,
        );
      default:
        throw new UnreachableError(latestStateEvent);
    }
  }
  assertNonNullable(
    latestStateEvent,
    `closedなPull Requestの最新state eventがありません。対象: ${pullRequest.nodeId}`,
  );
  switch (latestStateEvent.state) {
    case "merged":
      return "merged";
    case "closed":
      return "closed_unmerged";
    case "open":
    case "reopened":
      throw new TypeError(
        `closedなPull Requestの最新state eventが現在状態と一致しません。対象: ${pullRequest.nodeId}`,
      );
    default:
      throw new UnreachableError(latestStateEvent);
  }
}

/** 未アサインIssueの実質担当候補と根拠の収集元を作る。 */
export function createEffectiveAssigneeCandidateContexts(
  collection: EffectiveAssigneeCollectionContext,
  item: Extract<FreshObservedGitHubItem, { type: "issue" }>,
  detail: Extract<GitHubItemDetail, { type: "issue" }>,
  relationCandidates: readonly RelationCandidate[],
): readonly EffectiveAssigneeCandidateContext[] {
  if (item.state !== "open" || item.assignees.length !== 0) {
    return Object.freeze([]);
  }

  const currentSourceContext = Object.freeze({
    item,
    detail,
  }) satisfies EffectiveAssigneeSourceContext;
  const candidatesById = new Map<string, EffectiveAssigneeCandidateAccumulator>();
  const lastUnassignedAt = latestEffectiveAssigneeUnassignmentAt(detail);

  const addCandidateEvidence = (
    candidateId: string,
    sourceId: SourceId,
    occurredAt: UtcIsoDateTime,
    sourceContext: EffectiveAssigneeSourceContext,
  ): void => {
    if (candidateId.length === 0) {
      throw new TypeError("実質担当候補のGitHub loginは空にできません");
    }
    if (lastUnassignedAt != null && occurredAt <= lastUnassignedAt) {
      return;
    }
    const key = candidateId.toLowerCase();
    const existing = candidatesById.get(key);
    if (existing == null) {
      candidatesById.set(
        key,
        Object.freeze({
          candidateId,
          sourceIds: new Set([sourceId]),
          occurredAtBySourceId: new Map([[sourceId, occurredAt]]),
          sourceContexts: new Map([[sourceContext.item.nodeId, sourceContext]]),
        }),
      );
      return;
    }
    existing.sourceIds.add(sourceId);
    const existingOccurredAt = existing.occurredAtBySourceId.get(sourceId);
    if (existingOccurredAt != null && existingOccurredAt !== occurredAt) {
      if (parseSourceId(sourceId).kind !== "github_commit") {
        throw new TypeError(`実質担当候補sourceの発生時刻が一致しません。対象: ${sourceId}`);
      }
      existing.occurredAtBySourceId.set(
        sourceId,
        existingOccurredAt < occurredAt ? existingOccurredAt : occurredAt,
      );
    } else {
      existing.occurredAtBySourceId.set(sourceId, occurredAt);
    }
    existing.sourceContexts.set(sourceContext.item.nodeId, sourceContext);
  };

  if (
    item.author.status === "identified" &&
    item.author.actor.type === "human" &&
    detail.body.trim().length > 0
  ) {
    addCandidateEvidence(
      item.author.actor.login,
      detail.bodySourceId,
      item.createdAt,
      currentSourceContext,
    );
  }

  for (const comment of detail.comments) {
    if (comment.body.trim().length === 0) {
      continue;
    }
    const event = item.events.find((candidate) => candidate.sourceId === comment.sourceId);
    if (event?.actor.type !== "human") {
      continue;
    }
    addCandidateEvidence(
      event.actor.login,
      comment.sourceId,
      comment.createdAt,
      currentSourceContext,
    );
  }

  for (const relationCandidate of relationCandidates) {
    if (
      relationCandidate.authority !== "authoritative" ||
      relationCandidate.relation.type !== "implements"
    ) {
      continue;
    }
    const implementation = relationCandidate.relation.implementation;
    const target = relationCandidate.relation.target;
    if (
      implementation.scope !== "organization" ||
      implementation.kind !== "pull_request" ||
      target.scope !== "organization" ||
      target.nodeId !== item.nodeId
    ) {
      continue;
    }
    if (!collection.trackedNodeIds.has(implementation.nodeId)) {
      continue;
    }
    const relatedItem = collection.observedItemsByNodeId.get(implementation.nodeId);
    if (relatedItem == null) {
      continue;
    }
    if (relatedItem.type !== "pull_request") {
      throw new TypeError(
        `実装関係の対象がPull Requestではありません。対象: ${implementation.nodeId}`,
      );
    }
    const expectedObservedState = implementation.state === "open" ? "open" : "closed";
    if (relatedItem.state !== expectedObservedState) {
      throw new TypeError(
        `実装関係のPull Request状態が一致しません。対象: ${implementation.nodeId}`,
      );
    }
    const relatedDetail = collection.detailsByNodeId.get(implementation.nodeId);
    if (relatedDetail == null) {
      continue;
    }
    if (relatedDetail.type !== "pull_request") {
      throw new TypeError(
        `実装関係の詳細がPull Requestではありません。対象: ${implementation.nodeId}`,
      );
    }
    if (relatedItem.author.status !== "identified" || relatedItem.author.actor.type !== "human") {
      continue;
    }
    const relatedSourceContext = Object.freeze({
      item: relatedItem,
      detail: relatedDetail,
    }) satisfies EffectiveAssigneeSourceContext;
    const authorLogin = relatedItem.author.actor.login;
    addCandidateEvidence(
      authorLogin,
      relatedItem.sourceId,
      relatedItem.createdAt,
      relatedSourceContext,
    );
    if (relatedDetail.body.trim().length > 0) {
      addCandidateEvidence(
        authorLogin,
        relatedDetail.bodySourceId,
        relatedItem.createdAt,
        relatedSourceContext,
      );
    }
    for (const event of relatedItem.events) {
      if (event.kind !== "push") {
        continue;
      }
      addCandidateEvidence(authorLogin, event.sourceId, event.occurredAt, relatedSourceContext);
    }
  }

  return Object.freeze(
    [...candidatesById.values()]
      .map((candidate) => {
        const orderedSourceIds = [...candidate.sourceIds].sort((left, right) => {
          const leftOccurredAt = candidate.occurredAtBySourceId.get(left);
          const rightOccurredAt = candidate.occurredAtBySourceId.get(right);
          assertNonNullable(
            leftOccurredAt,
            `実質担当候補sourceの発生時刻がありません。対象: ${left}`,
          );
          assertNonNullable(
            rightOccurredAt,
            `実質担当候補sourceの発生時刻がありません。対象: ${right}`,
          );
          if (leftOccurredAt !== rightOccurredAt) {
            return leftOccurredAt > rightOccurredAt ? -1 : 1;
          }
          return left.localeCompare(right);
        });
        const sourceIds = orderedSourceIds.slice(0, 10);
        const firstSourceId = sourceIds[0];
        assertNonNullable(
          firstSourceId,
          `実質担当候補 ${candidate.candidateId}のsource IDがありません`,
        );
        const occurredAt = candidate.occurredAtBySourceId.get(firstSourceId);
        assertNonNullable(
          occurredAt,
          `実質担当候補sourceの発生時刻がありません。対象: ${firstSourceId}`,
        );
        return Object.freeze({
          candidate: Object.freeze({
            candidateId: candidate.candidateId,
            sourceIds: Object.freeze([firstSourceId, ...sourceIds.slice(1)] satisfies [
              SourceId,
              ...SourceId[],
            ]),
            occurredAt,
          }),
          sourceContexts: Object.freeze(
            [...candidate.sourceContexts.values()].sort((left, right) =>
              left.item.nodeId.localeCompare(right.item.nodeId),
            ),
          ),
        });
      })
      .sort((left, right) => {
        const leftId = left.candidate.candidateId.toLowerCase();
        const rightId = right.candidate.candidateId.toLowerCase();
        if (leftId < rightId) {
          return -1;
        }
        if (leftId > rightId) {
          return 1;
        }
        return left.candidate.candidateId.localeCompare(right.candidate.candidateId);
      }),
  );
}

function mentionedCandidatesInSource(
  sourceId: SourceId,
  content: string,
): readonly MentionedWaitingOnCandidate[] {
  const candidates = new Map<string, MentionedWaitingOnCandidate>();
  for (const match of content.matchAll(GITHUB_MENTION_PATTERN)) {
    const accountOrOrganization = match[1];
    assertNonNullable(accountOrOrganization, "GitHub mentionのaccountを取得できませんでした");
    const teamSlug = match[2];
    const kind = teamSlug == null ? "user" : "team";
    const id = teamSlug == null ? accountOrOrganization : `${accountOrOrganization}/${teamSlug}`;
    candidates.set(
      `${kind}:${id.toLowerCase()}`,
      Object.freeze({
        id,
        kind,
        sourceIds: Object.freeze([sourceId] satisfies [SourceId]),
      }),
    );
  }
  return Object.freeze([...candidates.values()]);
}

/** 本文とコメントのmentionから待機先候補を作る。 */
export function createMentionedWaitingOnCandidates(
  detail: GitHubItemDetail,
): readonly MentionedWaitingOnCandidate[] {
  const sourceCandidates = [
    ...mentionedCandidatesInSource(detail.bodySourceId, detail.body),
    ...detail.comments.flatMap((comment) =>
      mentionedCandidatesInSource(comment.sourceId, comment.body),
    ),
  ];
  const grouped = new Map<
    string,
    Readonly<{
      id: string;
      kind: MentionedWaitingOnCandidate["kind"];
      sourceIds: Set<SourceId>;
    }>
  >();
  for (const candidate of sourceCandidates) {
    const key = `${candidate.kind}:${candidate.id.toLowerCase()}`;
    const existing = grouped.get(key);
    if (existing == null) {
      grouped.set(
        key,
        Object.freeze({
          id: candidate.id,
          kind: candidate.kind,
          sourceIds: new Set(candidate.sourceIds),
        }),
      );
      continue;
    }
    for (const sourceId of candidate.sourceIds) {
      existing.sourceIds.add(sourceId);
    }
  }
  return Object.freeze(
    [...grouped.values()]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((candidate) => {
        const sourceIds = [...candidate.sourceIds].sort();
        const firstSourceId = sourceIds[0];
        assertNonNullable(firstSourceId, `mention候補 ${candidate.id}のsource IDがありません`);
        return Object.freeze({
          id: candidate.id,
          kind: candidate.kind,
          sourceIds: Object.freeze([firstSourceId, ...sourceIds.slice(1)] satisfies [
            SourceId,
            ...SourceId[],
          ]),
        } satisfies MentionedWaitingOnCandidate);
      }),
  );
}
