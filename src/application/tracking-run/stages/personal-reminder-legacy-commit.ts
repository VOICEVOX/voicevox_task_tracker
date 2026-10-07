import {
  createGitHubNodeId,
  type GitHubNodeId,
  type UtcIsoDateTime,
} from "../../../domain/types.js";
import { parseSourceId, type SourceId } from "../../../domain/source-id.js";
import type { GitHubItemDetail } from "../../../github/item-detail-types.js";
import { buildPullRequestCommitSourceId } from "../../../github/production-source-id.js";
import type { CurrentClockEvidenceSources } from "./personal-reminder-clock-evidence.js";
import { RunCompletenessError } from "./run-completeness-error.js";

export type LegacyCommitContext = Readonly<{
  clockSources: CurrentClockEvidenceSources;
  detailsByNodeId: ReadonlyMap<GitHubNodeId, GitHubItemDetail>;
  observedNodeIds: ReadonlySet<GitHubNodeId>;
  evaluatedAt: UtcIsoDateTime;
  allowedOwnerNodeIds: ReadonlySet<string>;
  previousOwnersBySourceId: ReadonlyMap<SourceId, ReadonlySet<GitHubNodeId>>;
}>;

function commitError(
  code: "missing_source" | "future_source" | "wrong_owner" | "kind_mismatch" | "source_id_conflict",
  sourceId: SourceId,
): RunCompletenessError {
  return new RunCompletenessError(
    code,
    sourceId,
    ["previousSnapshot", "personalReminderCauses", "clock", sourceId],
    undefined,
  );
}

/** 旧commit時計の所有PRと現在の完全なcommit所属を照合する。 */
export function inspectLegacyCommit(
  sourceId: SourceId,
  previousAt: UtcIsoDateTime,
  context: LegacyCommitContext,
  requirePreviousOwner: boolean,
): Readonly<{ observedAt: UtcIsoDateTime; eventAt?: UtcIsoDateTime }> {
  const parsed = parseSourceId(sourceId);
  if (parsed.kind !== "github_pull_request_commit") {
    throw commitError("kind_mismatch", sourceId);
  }
  const candidates = [...context.allowedOwnerNodeIds].filter((nodeId) =>
    parsed.originalId.startsWith(`${nodeId}:`),
  );
  if (candidates.length !== 1) throw commitError("wrong_owner", sourceId);
  const ownerText = candidates[0];
  if (ownerText == null) throw commitError("wrong_owner", sourceId);
  const owner = createGitHubNodeId(ownerText);
  const previousOwners = context.previousOwnersBySourceId.get(sourceId);
  if (
    (requirePreviousOwner && previousOwners?.size !== 1) ||
    (previousOwners != null && (previousOwners.size !== 1 || !previousOwners.has(owner)))
  ) {
    throw commitError("wrong_owner", sourceId);
  }
  const detail = context.detailsByNodeId.get(owner);
  if (detail == null || !context.observedNodeIds.has(owner)) {
    throw commitError("missing_source", sourceId);
  }
  if (detail.type !== "pull_request") throw commitError("kind_mismatch", sourceId);
  if (detail.observedAt !== context.evaluatedAt) {
    throw commitError("source_id_conflict", sourceId);
  }
  if (detail.observedAt < previousAt) throw commitError("future_source", sourceId);
  const membership = detail.commitMembership;
  if (
    membership.headSha !== detail.headSha ||
    membership.totalCount !== membership.commits.length ||
    (membership.commits.length > 0 &&
      membership.commits[membership.commits.length - 1]?.sha !== detail.headSha) ||
    new Set(membership.commits.map((commit) => commit.sourceId)).size !== membership.totalCount
  ) {
    throw commitError("missing_source", sourceId);
  }
  for (const fact of context.clockSources.factsBySourceId.get(sourceId) ?? []) {
    if (fact.sourceKind !== parsed.kind) throw commitError("kind_mismatch", sourceId);
    if (fact.itemNodeId !== owner) {
      throw commitError("wrong_owner", sourceId);
    }
  }
  const commit = membership.commits.find((value) => value.sourceId === sourceId);
  const clockEvent = context.clockSources.clockEventsBySourceId.get(sourceId);
  if (clockEvent != null) {
    if (clockEvent.itemNodeId !== owner) throw commitError("wrong_owner", sourceId);
    if (clockEvent.kind !== "push") throw commitError("kind_mismatch", sourceId);
    if (clockEvent.occurredAt !== previousAt) {
      throw commitError("source_id_conflict", sourceId);
    }
  }
  if (commit == null) return Object.freeze({ observedAt: detail.observedAt });
  if (commit.sourceId !== buildPullRequestCommitSourceId(owner, commit.nodeId)) {
    throw commitError("source_id_conflict", sourceId);
  }
  if (commit.pushedAt.status !== "available") {
    return Object.freeze({ observedAt: detail.observedAt });
  }
  if (commit.pushedAt.value !== previousAt) {
    throw commitError("source_id_conflict", sourceId);
  }
  if (clockEvent == null) return Object.freeze({ observedAt: detail.observedAt });
  return Object.freeze({ observedAt: detail.observedAt, eventAt: clockEvent.occurredAt });
}
