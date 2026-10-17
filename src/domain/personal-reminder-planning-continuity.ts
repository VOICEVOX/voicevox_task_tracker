import { sha256Hex } from "../canonical-json/sha256-hex.js";
import { assertNonNullable } from "../util/index.js";
import {
  personalReminderCauseIdSchema,
  personalReminderCauseSeedSchema,
  personalReminderLastConfirmedActionabilitySchema,
  personalReminderResponsibilityIdSchema,
  personalReminderResponsibilitySchema,
  personalReminderTimeBasisSchema,
  type PersonalReminderCause,
  type PersonalReminderCauseId,
  type PersonalReminderCauseSeed,
  type PersonalReminderExecutionSurface,
  type PersonalReminderResponsibilityId,
  type PersonalReminderResponsible,
  type PersonalReminderTimeBasis,
} from "./personal-reminder-causes.js";
import {
  PERSONAL_REMINDER_ID_VERSION,
  compareSourceIds,
  compareStrings,
  createSourceIds,
  parseTimestamp,
  responsibleSignatures,
  sameResponsible,
  sortedExecutionSurfaces,
  surfaceSignature,
} from "./personal-reminder-planning-common.js";
import {
  type PersonalReminderCauseDraft,
  type PersonalReminderCauseSeedReconciliation,
  type PersonalReminderItem,
} from "./personal-reminder-planning-contracts.js";
import { type SourceId } from "./source-id.js";
import { type NormalizedEvent, type UtcIsoDateTime } from "./types.js";

export type ResponsibilityValue = Readonly<{
  authority: "fixed" | "semantic";
  scope:
    | Readonly<{ kind: "item" }>
    | Readonly<{
        kind: "execution_surfaces";
        surfaces: readonly PersonalReminderExecutionSurface[];
      }>
    | Readonly<{
        kind: "item_and_execution_surfaces";
        surfaces: readonly PersonalReminderExecutionSurface[];
      }>;
}>;

function responsibilitySignature(value: ResponsibilityValue): string {
  return JSON.stringify([value.authority, value.scope.kind]);
}

function responsibilitySurfaceSignatures(value: ResponsibilityValue): ReadonlySet<string> {
  if (value.scope.kind === "item") {
    return new Set();
  }
  return new Set(value.scope.surfaces.map(surfaceSignature));
}

function hasSharedExecutionSurface(left: ResponsibilityValue, right: ResponsibilityValue): boolean {
  const leftSurfaces = responsibilitySurfaceSignatures(left);
  const rightSurfaces = responsibilitySurfaceSignatures(right);
  for (const surface of leftSurfaces) {
    if (rightSurfaces.has(surface)) {
      return true;
    }
  }
  return false;
}

/** 二つの責務が同じ継続期間に属するか判定する。 */
export function responsibilityEpisodeContinues(
  previous: ResponsibilityValue,
  current: ResponsibilityValue,
): boolean {
  if (previous.authority !== current.authority) {
    return false;
  }
  if (previous.scope.kind === "item") {
    return current.scope.kind !== "execution_surfaces";
  }
  if (current.scope.kind === "item") {
    return previous.scope.kind !== "execution_surfaces";
  }
  if (previous.scope.kind === "item_and_execution_surfaces") {
    return current.scope.kind === "item_and_execution_surfaces";
  }
  return hasSharedExecutionSurface(previous, current);
}

function personalReminderContinuityScopeCandidates(
  left: ResponsibilityValue,
  right: ResponsibilityValue,
): readonly ResponsibilityValue[] {
  const surfaceValues = [
    ...(left.scope.kind === "item" ? [] : left.scope.surfaces),
    ...(right.scope.kind === "item" ? [] : right.scope.surfaces),
  ];
  const candidates: ResponsibilityValue[] = [
    Object.freeze({
      authority: left.authority,
      scope: Object.freeze({ kind: "item" }),
    }),
  ];
  if (surfaceValues.length !== 0) {
    const surfaces = sortedExecutionSurfaces(surfaceValues);
    candidates.push(
      Object.freeze({
        authority: left.authority,
        scope: Object.freeze({
          kind: "execution_surfaces",
          surfaces,
        }),
      }),
      Object.freeze({
        authority: left.authority,
        scope: Object.freeze({
          kind: "item_and_execution_surfaces",
          surfaces,
        }),
      }),
    );
  }
  return Object.freeze(candidates);
}

/** 二つの責務が継続一致し得るか判定する。 */
export function personalReminderResponsibilitiesMayShareContinuation(
  left: ResponsibilityValue,
  right: ResponsibilityValue,
): boolean {
  return personalReminderContinuityScopeCandidates(left, right).some(
    (current) =>
      responsibilityEpisodeContinues(left, current) &&
      responsibilityEpisodeContinues(right, current),
  );
}

/** 原因の継続照合に使うgroup keyを作る。 */
export function personalReminderContinuityGroupKey(cause: PersonalReminderCause): string {
  return JSON.stringify([
    cause.itemNodeId,
    cause.action.kind,
    responsibleSignatures(cause.responsible),
    cause.responsibility.authority,
  ]);
}

function canonicalHash(value: readonly unknown[]): string {
  const serialized = JSON.stringify(value);
  const digest = sha256Hex(serialized);
  return `sha256:${digest}`;
}

function createResponsibilityId(
  draft: PersonalReminderCauseDraft,
): PersonalReminderResponsibilityId {
  const identity = [
    PERSONAL_REMINDER_ID_VERSION,
    draft.itemNodeId,
    draft.action.kind,
    responsibleSignatures(draft.responsible),
    responsibilitySignature(draft.responsibility),
    draft.responsibilityBasis.occurredAt,
    [...draft.responsibilityBasis.sourceIds].sort(compareSourceIds),
  ];
  return personalReminderResponsibilityIdSchema.parse(canonicalHash(identity));
}

function createCauseId(
  draft: PersonalReminderCauseDraft,
  responsibilityId: PersonalReminderResponsibilityId,
): PersonalReminderCauseId {
  const identity = [
    PERSONAL_REMINDER_ID_VERSION,
    draft.itemNodeId,
    draft.reasonCode,
    responsibleSignatures(draft.responsible),
    responsibilityId,
  ];
  return personalReminderCauseIdSchema.parse(canonicalHash(identity));
}

function createObligationSince(
  draft: PersonalReminderCauseDraft,
  currentObservedAt: UtcIsoDateTime,
  clockEventOccurredAtBySourceId: ReadonlyMap<SourceId, UtcIsoDateTime>,
): PersonalReminderTimeBasis {
  const basis = draft.responsibilityBasis;
  const currentTimestamp = parseTimestamp(currentObservedAt, "現在の観測時刻");
  const sourceIds = createSourceIds(basis.sourceIds);
  const eventSourceIds =
    basis.precision === "event"
      ? sourceIds.filter(
          (sourceId) => clockEventOccurredAtBySourceId.get(sourceId) === basis.occurredAt,
        )
      : [];
  if (eventSourceIds.length > 0) {
    const occurredTimestamp = parseTimestamp(basis.occurredAt, "責務basisの時刻");
    if (occurredTimestamp > currentTimestamp) {
      throw new RangeError("責務basisの時刻は現在の観測時刻以前にしてください");
    }
    return personalReminderTimeBasisSchema.parse({
      source: "event",
      at: basis.occurredAt,
      sourceIds: [...eventSourceIds],
    });
  }
  return personalReminderTimeBasisSchema.parse({
    source: "first_observation",
    at: currentObservedAt,
  });
}

/** eventを発生時刻とsource IDで比較する。 */
export function eventSort(left: NormalizedEvent, right: NormalizedEvent): number {
  const leftTime = parseTimestamp(left.occurredAt, `イベント ${left.sourceId}の発生時刻`);
  const rightTime = parseTimestamp(right.occurredAt, `イベント ${right.sourceId}の発生時刻`);
  if (leftTime !== rightTime) {
    return leftTime - rightTime;
  }
  return compareSourceIds(left.sourceId, right.sourceId);
}

/** eventが観測時刻より後か判定する。 */
export function eventAfter(event: NormalizedEvent, observedAt: UtcIsoDateTime): boolean {
  return (
    parseTimestamp(event.occurredAt, `イベント ${event.sourceId}の発生時刻`) >
    parseTimestamp(observedAt, "前回の観測時刻")
  );
}

/** eventの担当者が責任主体と一致するか判定する。 */
export function assigneeMatches(
  responsible: PersonalReminderResponsible,
  event: Extract<NormalizedEvent, { kind: "assignee" }>,
): boolean {
  return (
    responsible.kind === "user" &&
    responsible.role === "assignee" &&
    event.assignee.login.toLowerCase() === responsible.candidateId.toLowerCase()
  );
}

type ResponsibilityEpisodeTransition = Readonly<{
  ended: boolean;
  restarted: boolean;
}>;

/** 責務の継続と切替を判定する。 */
export function responsibilityEpisodeTransition(
  item: PersonalReminderItem,
  previous: PersonalReminderCause,
  previousObservedAt: UtcIsoDateTime,
): ResponsibilityEpisodeTransition {
  const responsibilities = previous.responsible.filter(
    (value) => value.kind === "user" && value.role === "assignee",
  );
  let responsibilityEnded = false;
  let responsibilityRestarted = false;
  let stateEnded = false;
  let stateRestarted = false;
  for (const event of [...item.events].sort(eventSort)) {
    if (!eventAfter(event, previousObservedAt)) {
      continue;
    }
    if (event.kind === "state") {
      if (event.state === "closed" || event.state === "merged") {
        stateEnded = true;
      } else if (stateEnded && event.state === "reopened") {
        stateRestarted = true;
      }
      continue;
    }
    if (event.kind !== "assignee") {
      continue;
    }
    if (!responsibilities.some((value) => assigneeMatches(value, event))) {
      continue;
    }
    if (event.action === "removed") {
      responsibilityEnded = true;
    } else if (responsibilityEnded) {
      responsibilityRestarted = true;
    }
  }
  const terminal = item.state === "closed";
  return Object.freeze({
    ended: responsibilityEnded || stateRestarted || (stateEnded && terminal),
    restarted: responsibilityRestarted || stateRestarted,
  });
}

type PersonalReminderCauseContinuityMatch =
  | Readonly<{ status: "none" }>
  | Readonly<{ status: "matched"; cause: PersonalReminderCause }>
  | Readonly<{
      status: "conflict";
      matchingCauses: readonly [
        PersonalReminderCause,
        PersonalReminderCause,
        ...PersonalReminderCause[],
      ];
      previousCauseIds: readonly [
        PersonalReminderCauseId,
        PersonalReminderCauseId,
        ...PersonalReminderCauseId[],
      ];
    }>;

type PersonalReminderCauseSeedContinuityConflict = Extract<
  PersonalReminderCauseSeedReconciliation,
  Readonly<{ status: "continuity_conflict" }>
>;

export type PersonalReminderCauseSeedMultipleContinuationConflict = Extract<
  PersonalReminderCauseSeedContinuityConflict,
  Readonly<{ reason: "multiple_continuation_matches" }>
>;

export type PersonalReminderCauseSeedNewDraftIdCollision = Extract<
  PersonalReminderCauseSeedContinuityConflict,
  Readonly<{ reason: "new_draft_id_collision" }>
>;

/** 今回の原因に継続する前回原因を探す。 */
export function findContinuousCause(
  item: PersonalReminderItem,
  draft: PersonalReminderCauseDraft,
  previous: readonly PersonalReminderCause[],
  previousObservedAt: UtcIsoDateTime,
  confirmedEndedCauseIds: ReadonlySet<PersonalReminderCauseId>,
): PersonalReminderCauseContinuityMatch {
  const matching = previous.filter(
    (cause) =>
      cause.itemNodeId === item.nodeId &&
      cause.action.kind === draft.action.kind &&
      sameResponsible(cause.responsible, draft.responsible) &&
      responsibilityEpisodeContinues(cause.responsibility, draft.responsibility) &&
      !confirmedEndedCauseIds.has(cause.causeId),
  );
  if (matching.length > 1) {
    const matchingCauses = [...matching].sort((left, right) =>
      compareStrings(left.causeId, right.causeId),
    );
    const [firstCause, secondCause, ...remainingCauses] = matchingCauses;
    assertNonNullable(firstCause, "個人催促責務の競合causeがありません");
    assertNonNullable(secondCause, "個人催促責務の競合causeが2件未満です");
    const remainingCauseIds = remainingCauses.map((cause) => cause.causeId);
    const matchingCausesWithAtLeastTwo: [
      PersonalReminderCause,
      PersonalReminderCause,
      ...PersonalReminderCause[],
    ] = [firstCause, secondCause, ...remainingCauses];
    const previousCauseIdsWithAtLeastTwo: [
      PersonalReminderCauseId,
      PersonalReminderCauseId,
      ...PersonalReminderCauseId[],
    ] = [firstCause.causeId, secondCause.causeId, ...remainingCauseIds];
    return Object.freeze({
      status: "conflict",
      matchingCauses: Object.freeze(matchingCausesWithAtLeastTwo),
      previousCauseIds: Object.freeze(previousCauseIdsWithAtLeastTwo),
    });
  }
  const cause = matching[0];
  if (cause == null) {
    return Object.freeze({ status: "none" });
  }
  const transition = responsibilityEpisodeTransition(item, cause, previousObservedAt);
  if (transition.ended || transition.restarted) {
    return Object.freeze({ status: "none" });
  }
  return Object.freeze({ status: "matched", cause });
}

/** 継続判定から原因seedを作る。 */
export function createSeed(
  draft: PersonalReminderCauseDraft,
  obligationSince: PersonalReminderTimeBasis,
  responsibilityId: PersonalReminderResponsibilityId,
  causeId: PersonalReminderCauseId,
  lastConfirmedActionability: PersonalReminderCauseSeed["lastConfirmedActionability"],
): PersonalReminderCauseSeed {
  return personalReminderCauseSeedSchema.parse({
    causeId,
    responsibilityId,
    itemNodeId: draft.itemNodeId,
    reasonCode: draft.reasonCode,
    responsible: draft.responsible,
    responsibility: personalReminderResponsibilitySchema.parse(draft.responsibility),
    action: draft.action,
    evidenceSourceIds: draft.evidenceSourceIds,
    obligationSince,
    lastConfirmedActionability,
    aiDependencies: draft.aiDependencies,
  });
}

/** 今回の原因候補からseedを作る。 */
export function createSeedFromDraft(
  input: Readonly<{
    draft: PersonalReminderCauseDraft;
    previousCause: PersonalReminderCause | undefined;
    currentObservedAt: UtcIsoDateTime;
    clockEventOccurredAtBySourceId: ReadonlyMap<SourceId, UtcIsoDateTime>;
  }>,
): PersonalReminderCauseSeed {
  if (input.previousCause != null) {
    return createSeed(
      input.draft,
      input.previousCause.obligationSince,
      input.previousCause.responsibilityId,
      input.previousCause.causeId,
      input.previousCause.lastConfirmedActionability,
    );
  }
  const responsibilityId = createResponsibilityId(input.draft);
  return createSeed(
    input.draft,
    createObligationSince(
      input.draft,
      input.currentObservedAt,
      input.clockEventOccurredAtBySourceId,
    ),
    responsibilityId,
    createCauseId(input.draft, responsibilityId),
    personalReminderLastConfirmedActionabilitySchema.parse({ status: "not_observed" }),
  );
}

/** 保存済み原因をseedへ投影する。 */
export function seedFromCause(cause: PersonalReminderCause): PersonalReminderCauseSeed {
  return personalReminderCauseSeedSchema.parse({
    causeId: cause.causeId,
    responsibilityId: cause.responsibilityId,
    itemNodeId: cause.itemNodeId,
    reasonCode: cause.reasonCode,
    responsible: cause.responsible,
    responsibility: cause.responsibility,
    action: cause.action,
    evidenceSourceIds: cause.evidenceSourceIds,
    obligationSince: cause.obligationSince,
    lastConfirmedActionability: cause.lastConfirmedActionability,
    aiDependencies: cause.aiDependencies,
  });
}
