import type { PersonalReminderCause } from "../../../domain/personal-reminder-causes.js";
import { parseSourceId, type SourceId } from "../../../domain/source-id.js";
import type { UtcIsoDateTime } from "../../../domain/types.js";
import type { LegacyReviewRequestInspection } from "../../../github/item-detail-types.js";
import { buildProductionSourceId } from "../../../github/production-source-id.js";
import type { LegacyCommitContext } from "./personal-reminder-legacy-commit.js";
import { RunCompletenessError } from "./run-completeness-error.js";

export type LegacyReviewRequestContext = LegacyCommitContext &
  Readonly<{
    inspectionsBySourceId: ReadonlyMap<SourceId, readonly LegacyReviewRequestInspection[]>;
  }>;

function reviewRequestError(
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

/** 旧nodeの所有と依頼先を現行PR詳細に照合し、実時刻の有無を返す。 */
export function inspectLegacyReviewRequestClock(
  sourceId: SourceId,
  previousAt: UtcIsoDateTime,
  cause: PersonalReminderCause,
  context: LegacyReviewRequestContext,
  requireCurrent: boolean,
): Readonly<{ observedAt: UtcIsoDateTime; eventAt?: UtcIsoDateTime }> {
  const parsed = parseSourceId(sourceId);
  if (parsed.kind !== "github_review_request") {
    throw reviewRequestError("kind_mismatch", sourceId);
  }
  const inspections = context.inspectionsBySourceId.get(sourceId) ?? [];
  if (inspections.length !== 1) throw reviewRequestError("missing_source", sourceId);
  const inspection = inspections[0];
  if (inspection?.sourceId !== sourceId) {
    throw reviewRequestError("source_id_conflict", sourceId);
  }
  const owner = inspection.ownerNodeId;
  if (owner !== cause.itemNodeId || !context.allowedOwnerNodeIds.has(owner)) {
    throw reviewRequestError("wrong_owner", sourceId);
  }
  const previousOwners = context.previousOwnersBySourceId.get(sourceId);
  if (previousOwners != null && (previousOwners.size !== 1 || !previousOwners.has(owner))) {
    throw reviewRequestError("wrong_owner", sourceId);
  }
  if (
    !cause.responsible.some(
      (responsible) =>
        responsible.role === "reviewer" &&
        responsible.kind === inspection.target.kind &&
        responsible.candidateId.toLowerCase() === inspection.target.candidateId.toLowerCase(),
    )
  ) {
    throw reviewRequestError("source_id_conflict", sourceId);
  }
  const detail = context.detailsByNodeId.get(owner);
  if (detail == null || !context.observedNodeIds.has(owner)) {
    throw reviewRequestError("missing_source", sourceId);
  }
  if (detail.type !== "pull_request" || detail.repositoryId !== inspection.repositoryId) {
    throw reviewRequestError("kind_mismatch", sourceId);
  }
  if (detail.observedAt !== context.evaluatedAt) {
    throw reviewRequestError("source_id_conflict", sourceId);
  }
  if (detail.observedAt < previousAt) throw reviewRequestError("future_source", sourceId);
  for (const fact of context.clockSources.factsBySourceId.get(sourceId) ?? []) {
    if (fact.sourceKind !== parsed.kind) throw reviewRequestError("kind_mismatch", sourceId);
    if (fact.itemNodeId !== owner) throw reviewRequestError("wrong_owner", sourceId);
  }
  const current = detail.reviewRequests.current.filter((request) => request.sourceId === sourceId);
  if (current.length > 1) throw reviewRequestError("source_id_conflict", sourceId);
  const request = current[0];
  if (request == null) {
    if (requireCurrent) throw reviewRequestError("missing_source", sourceId);
    return Object.freeze({ observedAt: detail.observedAt });
  }
  if (request.sourceId !== buildProductionSourceId(parsed.kind, request.nodeId)) {
    throw reviewRequestError("source_id_conflict", sourceId);
  }
  if (
    "status" in request.target ||
    request.target.type !== inspection.target.kind ||
    request.target.nodeId !== inspection.target.nodeId ||
    (request.target.type === "user" && request.target.apiType !== "User")
  ) {
    throw reviewRequestError("source_id_conflict", sourceId);
  }
  const candidateId =
    request.target.type === "team"
      ? `${request.target.organizationLogin}/${request.target.slug}`
      : request.target.login;
  if (candidateId.toLowerCase() !== inspection.target.candidateId.toLowerCase()) {
    throw reviewRequestError("source_id_conflict", sourceId);
  }
  if (request.requestedAt.status !== "available") {
    return Object.freeze({ observedAt: detail.observedAt });
  }
  if (request.requestedAt.value !== previousAt) {
    throw reviewRequestError("source_id_conflict", sourceId);
  }
  const clockEvent = context.clockSources.clockEventsBySourceId.get(sourceId);
  if (
    clockEvent?.kind !== "review_request" ||
    clockEvent.itemNodeId !== owner ||
    clockEvent.occurredAt !== request.requestedAt.value
  ) {
    throw reviewRequestError("source_id_conflict", sourceId);
  }
  return Object.freeze({ observedAt: detail.observedAt, eventAt: request.requestedAt.value });
}
