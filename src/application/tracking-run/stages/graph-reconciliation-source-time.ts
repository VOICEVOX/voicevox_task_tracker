import {
  parseSourceId,
  resolvePullRequestCommitOccurredAt,
  type SourceId,
  type UtcIsoDateTime,
} from "../../../domain/index.js";
import type { GitHubItemDetail } from "../../../github/item-detail-types.js";
import type { FreshObservedGitHubItem } from "../../../github/item-normalization.js";
import type { GitHubCheckContext } from "../../../github/item-detail-types.js";
import { assertNonNullable } from "../../../util/index.js";
import type { DeterministicItemAnalysis } from "./deterministic-item.js";

/** 関係根拠のsource IDごとに最初の発生時刻を確定する。 */
export function earliestRelationSourceOccurredAtById(
  items: readonly FreshObservedGitHubItem[],
): ReadonlyMap<SourceId, UtcIsoDateTime> {
  const occurredAtById = new Map<SourceId, UtcIsoDateTime>();
  for (const item of items) {
    const sources = [
      Object.freeze({ sourceId: item.bodySourceId, occurredAt: item.createdAt }),
      ...item.events.map((event) =>
        Object.freeze({ sourceId: event.sourceId, occurredAt: event.occurredAt }),
      ),
    ];
    for (const source of sources) {
      const existing = occurredAtById.get(source.sourceId);
      if (existing == null || source.occurredAt < existing) {
        occurredAtById.set(source.sourceId, source.occurredAt);
      }
    }
  }
  return occurredAtById;
}

/** 指定した時刻のうち最新を返す。 */
export function latestUtcIsoDateTime(
  values: readonly UtcIsoDateTime[],
  context: string,
): UtcIsoDateTime {
  const first = values[0];
  assertNonNullable(first, `${context}の時刻がありません`);
  return values.slice(1).reduce((latest, value) => (latest < value ? value : latest), first);
}

function addSourceOccurredAt(
  values: Map<SourceId, UtcIsoDateTime>,
  sourceId: SourceId,
  occurredAt: UtcIsoDateTime,
): void {
  const existing = values.get(sourceId);
  if (existing != null && existing !== occurredAt) {
    if (parseSourceId(sourceId).kind !== "github_commit") {
      throw new TypeError(`同じsource IDに異なる発生時刻があります。対象: ${sourceId}`);
    }
    values.set(sourceId, existing < occurredAt ? existing : occurredAt);
    return;
  }
  values.set(sourceId, occurredAt);
}

function checkContextOccurredAt(
  headOccurredAt: UtcIsoDateTime,
  context: GitHubCheckContext,
): UtcIsoDateTime {
  return context.type === "commit_status"
    ? context.createdAt
    : (context.completedAt ?? headOccurredAt);
}

function addContextSources(
  values: Map<SourceId, UtcIsoDateTime>,
  item: FreshObservedGitHubItem,
  detail: GitHubItemDetail,
): void {
  for (const [sourceId, occurredAt] of earliestRelationSourceOccurredAtById([item])) {
    addSourceOccurredAt(values, sourceId, occurredAt);
  }
  addSourceOccurredAt(values, item.sourceId, item.createdAt);
  addSourceOccurredAt(values, detail.bodySourceId, item.createdAt);
  for (const comment of detail.comments) {
    addSourceOccurredAt(values, comment.sourceId, comment.createdAt);
  }
  if (detail.type !== "pull_request" || detail.mergeState.checks.status !== "configured") {
    return;
  }
  const headOccurredAt = resolvePullRequestCommitOccurredAt(detail.headCommit, item.createdAt);
  const checkOccurredAts = detail.mergeState.checks.contexts.map((context) => {
    const occurredAt = checkContextOccurredAt(headOccurredAt, context);
    addSourceOccurredAt(values, context.sourceId, occurredAt);
    return occurredAt;
  });
  addSourceOccurredAt(
    values,
    detail.mergeState.checks.sourceId,
    latestUtcIsoDateTime(
      [headOccurredAt, ...checkOccurredAts],
      `check rollup ${detail.mergeState.checks.sourceId}`,
    ),
  );
}

/** 一項目の再判定に必要なsource発生時刻を作る。 */
export function sourceOccurredAtByIdForAnalysis(
  analysis: Readonly<
    Pick<DeterministicItemAnalysis, "item" | "detail" | "effectiveAssigneeCandidates">
  >,
): ReadonlyMap<SourceId, UtcIsoDateTime> {
  const values = new Map<SourceId, UtcIsoDateTime>();
  addContextSources(values, analysis.item, analysis.detail);
  for (const candidate of analysis.effectiveAssigneeCandidates) {
    for (const context of candidate.sourceContexts) {
      addContextSources(values, context.item, context.detail);
    }
  }
  return values;
}

/** 一項目の依存解消に必要なsource発生時刻を作る。 */
export function sourceOccurredAtByIdForItem(
  item: FreshObservedGitHubItem,
  detail: GitHubItemDetail,
): ReadonlyMap<SourceId, UtcIsoDateTime> {
  const values = new Map<SourceId, UtcIsoDateTime>();
  addContextSources(values, item, detail);
  return values;
}
