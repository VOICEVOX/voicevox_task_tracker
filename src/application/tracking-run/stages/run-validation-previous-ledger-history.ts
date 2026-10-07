import { serializeCanonicalJson } from "../../../canonical-json/value.js";
import type {
  PersonalReminderCause,
  PersonalReminderTimeBasis,
} from "../../../domain/personal-reminder-causes.js";
import type {
  PendingNotification,
  PendingPersonalReminderTarget,
} from "../../../domain/pending-notification.js";
import type { Relation } from "../../../domain/relation.js";
import { RunCompletenessError } from "./run-completeness-error.js";
import type { RunValidationLedger } from "./run-validation-final-checks.js";

type Path = readonly (string | number)[];

type PreviousPendingCauseSnapshotInput = Readonly<{
  items: readonly Readonly<{
    nodeId: string;
    personalReminderCauses: readonly PersonalReminderCause[];
  }>[];
  relations: readonly Pick<Relation, "id" | "fromNodeId" | "toNodeId">[];
}>;

/** 前回通知の時計を支持した原因と関係の最小投影。 */
export type PreviousPendingCauseContext = Readonly<{
  pendingIndex: number;
  itemNodeId: string;
  causeId: string;
  responsibilityId: string;
  reasonCode: string;
  actionableSince: PersonalReminderTimeBasis;
  stallSince: PersonalReminderTimeBasis;
  executionSurfaceNodeIds: readonly string[];
  relations: readonly Readonly<{ id: string; fromNodeId: string; toNodeId: string }>[];
}>;

function hasEventClock(
  pending: PendingNotification,
): pending is PendingNotification & Readonly<{ target: PendingPersonalReminderTarget }> {
  return (
    pending.target.kind === "personal_reminder" &&
    (pending.target.actionableSince.source === "event" ||
      pending.target.stallSince.source === "event")
  );
}

function sameTimeBasis(left: PersonalReminderTimeBasis, right: PersonalReminderTimeBasis): boolean {
  if (
    left.at !== right.at ||
    (left.source !== right.source &&
      !(left.source === "reconfirmation_pending" && right.source === "event"))
  )
    return false;
  if (left.source === "first_observation" || right.source === "first_observation") {
    return left.source === right.source;
  }
  if (
    left.source === "reconfirmed_observation" &&
    right.source === "reconfirmed_observation" &&
    left.previousAt !== right.previousAt
  ) {
    return false;
  }
  const leftIds = [...left.sourceIds].sort();
  const rightIds = [...right.sourceIds].sort();
  return leftIds.length === rightIds.length && leftIds.every((id, index) => id === rightIds[index]);
}

function assertContextMatchesPending(
  context: PreviousPendingCauseContext,
  pending: PendingNotification,
): void {
  const path: Path = ["previousNotificationLedger", "pendingNotifications", context.pendingIndex];
  if (
    pending.target.kind !== "personal_reminder" ||
    context.itemNodeId !== pending.itemNodeId ||
    context.causeId !== pending.target.causeId ||
    context.responsibilityId !== pending.target.responsibilityId ||
    context.reasonCode !== pending.reason.reasonCode ||
    !sameTimeBasis(context.actionableSince, pending.target.actionableSince) ||
    !sameTimeBasis(context.stallSince, pending.target.stallSince)
  ) {
    throw new RunCompletenessError("invalid_reference", pending.itemNodeId, path, undefined);
  }
  const surfaces = [...new Set(context.executionSurfaceNodeIds)].sort();
  if (
    surfaces.length !== context.executionSurfaceNodeIds.length ||
    surfaces.some((id, index) => id !== context.executionSurfaceNodeIds[index])
  ) {
    throw new RunCompletenessError("invalid_reference", pending.itemNodeId, path, undefined);
  }
  const relationIds = context.relations.map((relation) => relation.id);
  if (
    new Set(relationIds).size !== relationIds.length ||
    relationIds.some((id, index) => {
      const previousId = relationIds[index - 1];
      return previousId != null && previousId > id;
    })
  ) {
    throw new RunCompletenessError("invalid_reference", pending.itemNodeId, path, undefined);
  }
  for (const relation of context.relations) {
    if (relation.fromNodeId !== pending.itemNodeId && relation.toNodeId !== pending.itemNodeId) {
      throw new RunCompletenessError("wrong_owner", relation.id, path, undefined);
    }
  }
}

/** 前回snapshotの原因と関係からevent時計を持つ通知の文脈を作る。 */
export function createPreviousPendingCauseContexts(
  ledger: RunValidationLedger,
  previousItems: PreviousPendingCauseSnapshotInput["items"],
  previousRelations: PreviousPendingCauseSnapshotInput["relations"],
): readonly PreviousPendingCauseContext[] {
  const contexts: PreviousPendingCauseContext[] = [];
  for (const [pendingIndex, pending] of ledger.pendingNotifications.entries()) {
    if (!hasEventClock(pending)) continue;
    const target = pending.target;
    const path: Path = ["previousNotificationLedger", "pendingNotifications", pendingIndex];
    const item = previousItems.find((entry) => entry.nodeId === pending.itemNodeId);
    const cause = item?.personalReminderCauses.find((entry) => entry.causeId === target.causeId);
    if (cause?.actionableClock.status !== "observed") {
      throw new RunCompletenessError("missing_value", pending.itemNodeId, path, undefined);
    }
    const relatedIds =
      cause.adoptedAssessment.status === "available"
        ? cause.adoptedAssessment.result.references.relationIds
        : [];
    const relations = [...new Set(relatedIds)].sort().map((id) => {
      const relation = previousRelations.find((entry) => entry.id === id);
      if (relation == null)
        throw new RunCompletenessError("invalid_reference", id, path, undefined);
      return Object.freeze({
        id: relation.id,
        fromNodeId: relation.fromNodeId,
        toNodeId: relation.toNodeId,
      });
    });
    const scope = cause.responsibility.scope;
    const context = Object.freeze({
      pendingIndex,
      itemNodeId: cause.itemNodeId,
      causeId: cause.causeId,
      responsibilityId: cause.responsibilityId,
      reasonCode: cause.reasonCode,
      actionableSince: cause.actionableClock.actionableSince,
      stallSince: cause.actionableClock.stallSince,
      executionSurfaceNodeIds: Object.freeze(
        scope.kind === "item"
          ? []
          : [...new Set(scope.surfaces.map((entry) => entry.nodeId))].sort(),
      ),
      relations: Object.freeze(relations),
    });
    assertContextMatchesPending(context, pending);
    contexts.push(context);
  }
  return Object.freeze(contexts);
}

/** 前回通知の文脈が通知台帳と一対一に対応することを確認する。 */
export function assertPreviousPendingCauseContexts(
  contexts: readonly PreviousPendingCauseContext[],
  ledger: RunValidationLedger,
): void {
  const expectedIndices = ledger.pendingNotifications.flatMap((pending, index) =>
    hasEventClock(pending) ? [index] : [],
  );
  if (
    contexts.length !== expectedIndices.length ||
    contexts.some((context, index) => context.pendingIndex !== expectedIndices[index])
  ) {
    throw new RunCompletenessError(
      "invalid_reference",
      "previous_notification",
      ["evidenceClosureWitness", "previousPendingCauses"],
      undefined,
    );
  }
  for (const context of contexts) {
    const pending = ledger.pendingNotifications[context.pendingIndex];
    if (pending == null) {
      throw new RunCompletenessError(
        "missing_value",
        context.itemNodeId,
        ["previousNotificationLedger", "pendingNotifications", context.pendingIndex],
        undefined,
      );
    }
    assertContextMatchesPending(context, pending);
  }
}

/** 前回通知の原因に記録された実行面と関係から所有範囲を得る。 */
export function previousPendingCauseScope(
  pendingIndex: number,
  contexts: readonly PreviousPendingCauseContext[],
): Readonly<{ nodeIds: readonly string[]; relationIds: readonly string[] }> {
  const context = contexts.find((entry) => entry.pendingIndex === pendingIndex);
  if (context == null) {
    throw new RunCompletenessError(
      "missing_value",
      "previous_notification",
      ["previousNotificationLedger", "pendingNotifications", pendingIndex],
      undefined,
    );
  }
  return Object.freeze({
    nodeIds: Object.freeze(
      [
        ...new Set([
          context.itemNodeId,
          ...context.executionSurfaceNodeIds,
          ...context.relations.flatMap((relation) => [relation.fromNodeId, relation.toNodeId]),
        ]),
      ].sort(),
    ),
    relationIds: Object.freeze(context.relations.map((relation) => relation.id)),
  });
}

/** 前回通知の文脈と通知管理記録を固定した基準状態へ照合する。 */
export function assertPreviousPendingCausesMatchBase(
  contexts: readonly PreviousPendingCauseContext[],
  ledger: RunValidationLedger,
  baseLedger: RunValidationLedger,
  snapshot: PreviousPendingCauseSnapshotInput | undefined,
): void {
  if (serializeCanonicalJson(ledger) !== serializeCanonicalJson(baseLedger)) {
    throw new RunCompletenessError(
      "ledger_mismatch",
      "previous_notification",
      ["previousNotificationLedger"],
      undefined,
    );
  }
  const actual = createPreviousPendingCauseContexts(
    ledger,
    snapshot?.items ?? [],
    snapshot?.relations ?? [],
  );
  if (serializeCanonicalJson(contexts) !== serializeCanonicalJson(actual)) {
    throw new RunCompletenessError(
      "field_mismatch",
      "previous_notification",
      ["evidenceClosureWitness", "previousPendingCauses"],
      undefined,
    );
  }
}
