import type { Evidence } from "../../../domain/types.js";
import type { PendingNotification } from "../../../domain/pending-notification.js";
import type { PersonalReminderTimeBasis } from "../../../domain/personal-reminder-causes.js";
import type {
  EvidenceClosureContext,
  EvidenceClosureOutward,
} from "../contracts/evidence-closure.js";
import type { CurrentSourceFact } from "../contracts/evidence-catalog.js";
import { RunCompletenessError } from "./run-completeness-error.js";

const evidenceFields = ["sourceId", "summary", "supports"];
const evidenceSupports = new Set([
  "status",
  "waiting_on",
  "relation",
  "progress",
  "notification",
  "uncertainty",
  "self_commitment",
]);

function assertEvidenceShape(evidence: Evidence, path: readonly (string | number)[]): void {
  const fields = Object.keys(evidence).sort();
  if (
    fields.length !== evidenceFields.length ||
    fields.some((field, index) => field !== evidenceFields[index]) ||
    !evidenceSupports.has(evidence.supports) ||
    typeof evidence.summary !== "string"
  ) {
    throw new RunCompletenessError("invalid_reference", evidence.sourceId, path, undefined);
  }
}

function assertTime(
  sourceId: string,
  at: string,
  path: readonly (string | number)[],
  context: EvidenceClosureContext,
): void {
  const time = Date.parse(at);
  if (!Number.isFinite(time)) {
    throw new RunCompletenessError("invalid_reference", sourceId, path, undefined);
  }
  if (time > Date.parse(context.evaluatedAt)) {
    throw new RunCompletenessError("future_source", sourceId, path, undefined);
  }
}

function assertBasis(
  basis: PersonalReminderTimeBasis,
  path: readonly (string | number)[],
  context: EvidenceClosureContext,
): void {
  if (basis.source === "reconfirmation_pending") {
    throw new RunCompletenessError(
      "invalid_reference",
      basis.sourceIds[0] ?? "clock",
      path,
      undefined,
    );
  }
  if (basis.source === "first_observation") return;
  if (basis.source === "reconfirmed_observation" && basis.previousAt > basis.at) {
    throw new RunCompletenessError(
      "source_id_conflict",
      basis.sourceIds[0] ?? "clock",
      path,
      undefined,
    );
  }
  for (const [index, sourceId] of basis.sourceIds.entries()) {
    assertTime(sourceId, basis.at, [...path, "sourceIds", index], context);
    if (basis.source === "reconfirmed_observation") {
      assertTime(sourceId, basis.previousAt, [...path, "previousAt"], context);
    }
  }
}

function assertPendingNotificationTimes(
  pending: PendingNotification,
  index: number,
  context: EvidenceClosureContext,
): void {
  if (pending.target.kind !== "personal_reminder") return;
  assertBasis(
    pending.target.actionableSince,
    ["pendingNotifications", index, "target", "actionableSince"],
    context,
  );
  assertBasis(
    pending.target.stallSince,
    ["pendingNotifications", index, "target", "stallSince"],
    context,
  );
}

/** 旧根拠の未知fieldとoutward参照の未来時刻を拒否する。 */
export function assertEvidenceClosureInput(
  context: EvidenceClosureContext,
  outward: EvidenceClosureOutward,
  currentById: ReadonlyMap<string, readonly CurrentSourceFact[]>,
): void {
  for (const [index, value] of context.historicalEvidence.entries()) {
    assertEvidenceShape(value.record.evidence, ["historicalEvidence", index, "record", "evidence"]);
  }
  for (const [itemIndex, entry] of outward.items.entries()) {
    for (const [evidenceIndex, evidence] of entry.item.evidence.entries()) {
      assertEvidenceShape(evidence, ["items", itemIndex, "item", "evidence", evidenceIndex]);
    }
    for (const [evidenceIndex, evidence] of entry.evidence.entries()) {
      assertEvidenceShape(evidence, ["items", itemIndex, "evidence", evidenceIndex]);
    }
    for (const [causeIndex, result] of entry.causeResults.entries()) {
      const cause = result.cause;
      const path = ["items", itemIndex, "causeResults", causeIndex, "cause"];
      assertBasis(cause.obligationSince, [...path, "obligationSince"], context);
      if (cause.actionableClock.status === "observed") {
        assertBasis(
          cause.actionableClock.actionableSince,
          [...path, "actionableClock", "actionableSince"],
          context,
        );
        assertBasis(
          cause.actionableClock.stallSince,
          [...path, "actionableClock", "stallSince"],
          context,
        );
      }
    }
  }
  for (const [relationIndex, relation] of outward.relations.entries()) {
    for (const [evidenceIndex, evidence] of relation.evidence.entries()) {
      assertEvidenceShape(evidence, ["relations", relationIndex, "evidence", evidenceIndex]);
    }
  }
  for (const [index, event] of outward.historyInputEvents.entries()) {
    assertTime(
      event.sourceId,
      event.occurredAt,
      ["historyInputEvents", index, "sourceId"],
      context,
    );
    for (const fact of currentById.get(event.sourceId) ?? []) {
      if (
        (fact.immutable.occurredAt != null && fact.immutable.occurredAt !== event.occurredAt) ||
        (event.actor.type !== "system" &&
          fact.immutable.actorNodeId != null &&
          fact.immutable.actorNodeId !== event.actor.nodeId)
      ) {
        throw new RunCompletenessError(
          "source_id_conflict",
          event.sourceId,
          ["historyInputEvents", index, "sourceId"],
          undefined,
        );
      }
    }
  }
  for (const [index, value] of outward.notificationCauses.entries()) {
    for (const reason of [
      value.causes.responsibility_changed,
      value.causes.newly_unblocked,
      value.dependencyCause,
    ]) {
      if (reason.status !== "complete") continue;
      for (const [evidenceIndex, evidence] of reason.evidence.entries()) {
        assertTime(
          evidence.sourceId,
          evidence.occurredAt,
          ["notificationCauses", index, "evidence", evidenceIndex],
          context,
        );
        for (const fact of currentById.get(evidence.sourceId) ?? []) {
          if (
            (fact.immutable.occurredAt != null &&
              fact.immutable.occurredAt !== evidence.occurredAt) ||
            (fact.immutable.actorNodeId != null &&
              fact.immutable.actorNodeId !== evidence.actor.nodeId)
          ) {
            throw new RunCompletenessError(
              "source_id_conflict",
              evidence.sourceId,
              ["notificationCauses", index, "evidence", evidenceIndex],
              undefined,
            );
          }
        }
      }
    }
  }
  for (const [index, pending] of outward.pendingNotifications.entries()) {
    assertPendingNotificationTimes(pending, index, context);
  }
}
