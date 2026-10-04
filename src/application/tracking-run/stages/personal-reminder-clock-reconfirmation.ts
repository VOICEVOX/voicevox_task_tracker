import {
  personalReminderCauseNeedsClockReconfirmation,
  personalReminderCauseSchema,
  type PersonalReminderCause,
  type PersonalReminderTimeBasis,
} from "../../../domain/personal-reminder-causes.js";
import { createSourceIds } from "../../../domain/personal-reminder-planning-common.js";
import { parseSourceId, type SourceId } from "../../../domain/source-id.js";
import type { GitHubNodeId, UtcIsoDateTime } from "../../../domain/types.js";
import type { LegacyReviewRequestInspection } from "../../../github/item-detail-types.js";
import { assertNonNullable } from "../../../util/index.js";
import type { CurrentItemSourceFact } from "../contracts/evidence-catalog.js";
import type { GraphReconciledRun } from "./graph-reconciliation.js";
import { inspectLegacyCommit } from "./personal-reminder-legacy-commit.js";
import {
  inspectLegacyReviewRequestClock,
  type LegacyReviewRequestContext,
} from "./personal-reminder-legacy-review-request.js";
import {
  indexCurrentClockEvidenceSources,
  verifiedCurrentClockEvidence,
} from "./personal-reminder-clock-evidence.js";
import { personalReminderCauseScope } from "./personal-reminder-related-scope.js";
import { RunCompletenessError } from "./run-completeness-error.js";

type ClockReconfirmationContext = LegacyReviewRequestContext;

function reconfirmationError(
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

function clockBasesForCause(cause: PersonalReminderCause): readonly PersonalReminderTimeBasis[] {
  return cause.actionableClock.status === "observed"
    ? [
        cause.obligationSince,
        cause.actionableClock.actionableSince,
        cause.actionableClock.stallSince,
      ]
    : [cause.obligationSince];
}

function assertReappearingEventClocks(
  cause: PersonalReminderCause,
  context: ClockReconfirmationContext,
): void {
  for (const basis of clockBasesForCause(cause)) {
    if (basis.source === "reconfirmed_observation") {
      for (const sourceId of basis.sourceIds) {
        if (parseSourceId(sourceId).kind === "github_pull_request_commit") {
          inspectLegacyCommit(sourceId, basis.previousAt, context, false);
        } else if (
          parseSourceId(sourceId).kind === "github_review_request" &&
          (context.clockSources.factsBySourceId.get(sourceId)?.length ?? 0) > 0
        ) {
          inspectLegacyReviewRequestClock(sourceId, basis.previousAt, cause, context, true);
        }
      }
    }
    if (basis.source !== "event") continue;
    for (const sourceId of basis.sourceIds) {
      const detailFacts = (context.clockSources.factsBySourceId.get(sourceId) ?? []).filter(
        (fact): fact is CurrentItemSourceFact =>
          fact.origin === "item_detail" && fact.scope === "item",
      );
      if (detailFacts.length === 0) continue;
      const previousOwners = context.previousOwnersBySourceId.get(sourceId);
      if (previousOwners != null && previousOwners.size > 1) {
        throw reconfirmationError("source_id_conflict", sourceId);
      }
      let previousOwner: GitHubNodeId | undefined;
      if (previousOwners == null || previousOwners.size === 0) {
        if (context.allowedOwnerNodeIds.size === 1) previousOwner = cause.itemNodeId;
      } else {
        previousOwner = [...previousOwners][0];
      }
      if (previousOwner == null) continue;
      if (!context.allowedOwnerNodeIds.has(previousOwner)) {
        throw reconfirmationError("wrong_owner", sourceId);
      }
      verifiedCurrentClockEvidence(
        sourceId,
        basis,
        new Set([previousOwner]),
        context.evaluatedAt,
        context.clockSources,
      );
    }
  }
}

function reconfirmBasis(
  basis: PersonalReminderTimeBasis,
  cause: PersonalReminderCause,
  context: ClockReconfirmationContext,
): PersonalReminderTimeBasis {
  if (basis.source !== "reconfirmation_pending") return basis;
  let observedAt: UtcIsoDateTime | undefined;
  const eventSources: { sourceId: SourceId; at: UtcIsoDateTime }[] = [];
  let hasUnavailableCommit = false;
  let hasUnavailableReviewRequest = false;
  for (const sourceId of basis.sourceIds) {
    const kind = parseSourceId(sourceId).kind;
    if (kind === "github_pull_request_commit") {
      const inspected = inspectLegacyCommit(sourceId, basis.at, context, true);
      if (observedAt != null && observedAt !== inspected.observedAt) {
        throw reconfirmationError("source_id_conflict", sourceId);
      }
      observedAt = inspected.observedAt;
      if (inspected.eventAt == null) {
        hasUnavailableCommit = true;
      } else {
        eventSources.push({ sourceId, at: inspected.eventAt });
      }
      continue;
    }
    if (kind === "github_review_request") {
      const inspected = inspectLegacyReviewRequestClock(sourceId, basis.at, cause, context, false);
      if (observedAt != null && observedAt !== inspected.observedAt) {
        throw reconfirmationError("source_id_conflict", sourceId);
      }
      observedAt = inspected.observedAt;
      if (inspected.eventAt == null) {
        hasUnavailableReviewRequest = true;
      } else {
        eventSources.push({ sourceId, at: inspected.eventAt });
      }
      continue;
    }
    const detailFacts = (context.clockSources.factsBySourceId.get(sourceId) ?? []).filter(
      (fact): fact is CurrentItemSourceFact =>
        fact.origin === "item_detail" && fact.scope === "item",
    );
    if (detailFacts.length === 0) throw reconfirmationError("missing_source", sourceId);
    const owners = new Set(detailFacts.map((fact) => fact.itemNodeId));
    if (owners.size !== 1) throw reconfirmationError("source_id_conflict", sourceId);
    const owner = [...owners][0];
    if (owner == null || !context.allowedOwnerNodeIds.has(owner)) {
      throw reconfirmationError("wrong_owner", sourceId);
    }
    const detail = context.detailsByNodeId.get(owner);
    if (detail == null || !context.observedNodeIds.has(owner)) {
      throw reconfirmationError("missing_source", sourceId);
    }
    if (detail.observedAt !== context.evaluatedAt) {
      throw reconfirmationError("source_id_conflict", sourceId);
    }
    if (detail.observedAt < basis.at) throw reconfirmationError("future_source", sourceId);
    if (observedAt != null && observedAt !== detail.observedAt) {
      throw reconfirmationError("source_id_conflict", sourceId);
    }
    observedAt = detail.observedAt;
    if (detailFacts.some((fact) => fact.sourceKind !== kind)) {
      throw reconfirmationError("kind_mismatch", sourceId);
    }
    const clockEvent = context.clockSources.clockEventsBySourceId.get(sourceId);
    if (clockEvent == null) {
      if (
        kind === "github_issue_comment" ||
        kind === "github_pull_request_review_comment" ||
        kind === "github_pull_request_review" ||
        kind === "github_timeline_event" ||
        kind === "github_review_request"
      ) {
        throw reconfirmationError("missing_source", sourceId);
      }
      continue;
    }
    if (clockEvent.itemNodeId !== owner) throw reconfirmationError("wrong_owner", sourceId);
    if (clockEvent.occurredAt !== basis.at && kind !== "github_pull_request_commit") {
      throw reconfirmationError("source_id_conflict", sourceId);
    }
    eventSources.push({ sourceId, at: clockEvent.occurredAt });
  }
  const matchingSourceIds = eventSources
    .filter((source) => source.at === basis.at)
    .map((source) => source.sourceId);
  if (!hasUnavailableCommit && !hasUnavailableReviewRequest && matchingSourceIds.length > 0) {
    return Object.freeze({
      source: "event",
      at: basis.at,
      sourceIds: [...createSourceIds(matchingSourceIds)],
    });
  }
  const firstEventSource = eventSources[0];
  if (
    !hasUnavailableCommit &&
    !hasUnavailableReviewRequest &&
    firstEventSource != null &&
    eventSources.every((source) => source.at === firstEventSource.at)
  ) {
    return Object.freeze({
      source: "event",
      at: firstEventSource.at,
      sourceIds: [...createSourceIds(eventSources.map((source) => source.sourceId))],
    });
  }
  const firstSourceId = basis.sourceIds[0];
  assertNonNullable(firstSourceId, "再確認対象のsource IDがありません");
  if (observedAt == null) throw reconfirmationError("missing_source", firstSourceId);
  return Object.freeze({
    source: "reconfirmed_observation",
    at: observedAt,
    previousAt: basis.at,
    sourceIds: basis.sourceIds,
  });
}

function basisAtOrAfter(
  basis: PersonalReminderTimeBasis,
  earlier: PersonalReminderTimeBasis,
): PersonalReminderTimeBasis {
  if (basis.at >= earlier.at) return basis;
  if (earlier.source !== "reconfirmed_observation") {
    const sourceId =
      earlier.source === "first_observation" ? "first_observation" : earlier.sourceIds[0];
    assertNonNullable(sourceId, "先行する個人催促時計のsource IDがありません");
    throw new RunCompletenessError(
      "source_id_conflict",
      sourceId,
      ["previousSnapshot", "personalReminderCauses", "clock"],
      undefined,
    );
  }
  let previousAt = basis.at;
  if (basis.source === "first_observation") previousAt = earlier.previousAt;
  if (basis.source === "reconfirmed_observation") previousAt = basis.previousAt;
  return Object.freeze({
    source: "reconfirmed_observation",
    at: earlier.at,
    previousAt,
    sourceIds: basis.source === "first_observation" ? earlier.sourceIds : basis.sourceIds,
  });
}

function reconfirmCause(
  cause: PersonalReminderCause,
  context: ClockReconfirmationContext,
): PersonalReminderCause {
  const obligationSince = reconfirmBasis(cause.obligationSince, cause, context);
  if (cause.actionableClock.status === "not_observed") {
    return personalReminderCauseSchema.parse({ ...cause, obligationSince });
  }
  const actionableSince = basisAtOrAfter(
    reconfirmBasis(cause.actionableClock.actionableSince, cause, context),
    obligationSince,
  );
  const stallSince = basisAtOrAfter(
    reconfirmBasis(cause.actionableClock.stallSince, cause, context),
    actionableSince,
  );
  return personalReminderCauseSchema.parse({
    ...cause,
    obligationSince,
    actionableClock: {
      status: "observed",
      actionableSince,
      stallSince,
      basis:
        actionableSince.source === "reconfirmed_observation"
          ? "reconfirmed_observation"
          : cause.actionableClock.basis,
    },
  });
}

/** 保存済み時計の再出現sourceと旧時計を現行の詳細と正規化イベントで再確認する。 */
export function reconfirmPreviousPersonalReminderClocks(
  run: GraphReconciledRun,
): GraphReconciledRun {
  const previousItems = run.core.personalReminderInput.previousItems;
  const previousCauses = previousItems.flatMap((item) => item.personalReminderCauses);
  const needsReconfirmation = previousCauses.some(personalReminderCauseNeedsClockReconfirmation);
  if (
    !needsReconfirmation &&
    !previousCauses.some((cause) =>
      clockBasesForCause(cause).some(
        (basis) => basis.source === "event" || basis.source === "reconfirmed_observation",
      ),
    )
  ) {
    return run;
  }
  const clockSources = indexCurrentClockEvidenceSources(
    run.data.collection,
    run.data.collection.evaluatedAt,
  );
  const previousOwnersBySourceId = new Map<SourceId, Set<GitHubNodeId>>();
  for (const item of previousItems) {
    for (const event of item.inputEvents) {
      const owners = previousOwnersBySourceId.get(event.sourceId) ?? new Set<GitHubNodeId>();
      owners.add(item.nodeId);
      previousOwnersBySourceId.set(event.sourceId, owners);
    }
  }
  const detailsByNodeId = new Map(
    run.data.collection.details.map((detail) => [detail.nodeId, detail]),
  );
  const observedNodeIds = new Set(run.data.collection.observedItems.map((item) => item.nodeId));
  const previousRelationsById = new Map(
    run.core.personalReminderInput.previousRelations.map((relation) => [relation.id, relation]),
  );
  const inspectionsBySourceId = new Map<SourceId, LegacyReviewRequestInspection[]>();
  for (const inspection of run.data.collection.legacyReviewRequests) {
    const inspections = inspectionsBySourceId.get(inspection.sourceId) ?? [];
    inspectionsBySourceId.set(inspection.sourceId, [...inspections, inspection]);
  }
  const causesByNodeId = new Map(
    previousItems.map((item) => [
      item.nodeId,
      item.personalReminderCauses.map((cause) => {
        if (
          !personalReminderCauseNeedsClockReconfirmation(cause) &&
          !clockBasesForCause(cause).some(
            (basis) => basis.source === "event" || basis.source === "reconfirmed_observation",
          )
        ) {
          return cause;
        }
        const scope = personalReminderCauseScope(cause, previousRelationsById, [
          "previousSnapshot",
          "items",
          item.nodeId,
          "personalReminderCauses",
          cause.causeId,
        ]);
        const context: ClockReconfirmationContext = {
          clockSources,
          detailsByNodeId,
          observedNodeIds,
          evaluatedAt: run.data.collection.evaluatedAt,
          allowedOwnerNodeIds: new Set(scope.nodeIds),
          previousOwnersBySourceId,
          inspectionsBySourceId,
        };
        assertReappearingEventClocks(cause, context);
        return personalReminderCauseNeedsClockReconfirmation(cause)
          ? reconfirmCause(cause, context)
          : cause;
      }),
    ]),
  );
  if (!needsReconfirmation) return run;
  return Object.freeze({
    ...run,
    core: Object.freeze({
      ...run.core,
      personalReminderInput: Object.freeze({
        ...run.core.personalReminderInput,
        previousItems: Object.freeze(
          previousItems.map((item) =>
            Object.freeze({
              ...item,
              personalReminderCauses:
                causesByNodeId.get(item.nodeId) ?? item.personalReminderCauses,
            }),
          ),
        ),
      }),
    }),
    data: Object.freeze({
      ...run.data,
      finalItems: Object.freeze(
        run.data.finalItems.map((item) =>
          Object.freeze({
            ...item,
            personalReminderCauses: causesByNodeId.get(item.nodeId) ?? item.personalReminderCauses,
          }),
        ),
      ),
    }),
  });
}
