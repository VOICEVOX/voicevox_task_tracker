import { createHash } from "node:crypto";

import {
  personalReminderCauseIdSchema,
  personalReminderCauseSeedSchema,
  personalReminderReasonCodeSchema,
  personalReminderLastConfirmedActionabilitySchema,
  personalReminderResponsibilitySchema,
  personalReminderResponsibilityIdSchema,
  personalReminderTimeBasisSchema,
  type PersonalReminderCause,
  type PersonalReminderCauseId,
  type PersonalReminderCauseSeed,
  type PersonalReminderReasonCode,
  type PersonalReminderResponsible,
  type PersonalReminderResponsibility,
  type PersonalReminderResponsibilityId,
  type PersonalReminderExecutionSurface,
  type PersonalReminderTimeBasis,
} from "./personal-reminder-causes.js";
import {
  type FreshObservedGitHubIssue,
  type FreshObservedGitHubPullRequest,
} from "./github-item-observation.js";
import { type IssueStateDecision, type IssueTransitionBasis } from "./issue-state-machine.js";
import {
  type PullRequestStateDecision,
  type PullRequestTransitionBasis,
} from "./pull-request-state-machine.js";
import { determineStalenessWaitClass, type StalenessWaitClass } from "./staleness.js";
import { type SourceId } from "./source-id.js";
import { isTerminalStatus } from "./status.js";
import { type GitHubNodeId, type NormalizedEvent, type UtcIsoDateTime } from "./types.js";
import { assertNonNullable, UnreachableError } from "../util/index.js";

type PersonalReminderItem = FreshObservedGitHubIssue | FreshObservedGitHubPullRequest;
type PersonalReminderLocalDecision = IssueStateDecision | PullRequestStateDecision;
type PersonalReminderResponsibilityBasis = IssueTransitionBasis | PullRequestTransitionBasis;

/** 個人催促原因を永続化する前の候補。 */
export type PersonalReminderCauseDraft = Readonly<{
  itemNodeId: GitHubNodeId;
  reasonCode: PersonalReminderReasonCode;
  responsible: readonly [PersonalReminderResponsible, ...PersonalReminderResponsible[]];
  action: Readonly<PersonalReminderCauseSeed["action"]>;
  evidenceSourceIds: readonly [SourceId, ...SourceId[]];
  responsibilityBasis: PersonalReminderResponsibilityBasis;
  responsibility: PersonalReminderResponsibility;
}>;

/** 個人催促原因の候補を作れない理由。 */
export type PersonalReminderCauseDraftUnavailableReason =
  "terminal" | "blocked_parent" | "automation" | "not_applicable" | "no_responsible_actor";

/** 個人催促原因の候補を作れない結果。 */
export type PersonalReminderCauseDraftUnavailable = Readonly<{
  status: "unavailable";
  itemNodeId: GitHubNodeId;
  reason: PersonalReminderCauseDraftUnavailableReason;
}>;

/** 前回保存された個人催促原因。 */
export type PreviousPersonalReminderCauses = Readonly<{
  observedAt: UtcIsoDateTime;
  causes: readonly PersonalReminderCause[];
}>;

/** 個人催促原因候補の照合結果。 */
export type PersonalReminderCauseSeedReconciliation =
  | Readonly<{
      status: "available";
      seeds: readonly PersonalReminderCauseSeed[];
      preservedCauseIds: readonly PersonalReminderCauseId[];
      endedCauseIds: readonly PersonalReminderCauseId[];
    }>
  | Readonly<{
      status: "unavailable";
      seeds: readonly [];
      preservedCauseIds: readonly PersonalReminderCauseId[];
      endedCauseIds: readonly PersonalReminderCauseId[];
      reason: PersonalReminderCauseDraftUnavailableReason;
    }>;

const PERSONAL_REMINDER_ID_VERSION = "personal-reminder-v1";
const PERSONAL_REMINDER_SOURCE_ID_LIMIT = 30;

const reasonByWaitClass: Readonly<
  Partial<
    Record<
      Exclude<StalenessWaitClass, "blockedParent" | "notApplicable">,
      PersonalReminderReasonCode
    >
  >
> = Object.freeze({
  assessment: "assessment_overdue",
  owner: "owner_overdue",
  decision: "decision_overdue",
  review: "review_overdue",
  revision: "revision_overdue",
  reply: "reply_overdue",
  work: "work_overdue",
  merge: "merge_overdue",
});

function compareStrings(left: string, right: string): -1 | 0 | 1 {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function compareSourceIds(left: SourceId, right: SourceId): -1 | 0 | 1 {
  return compareStrings(left, right);
}

function createSourceIds(sourceIds: readonly SourceId[]): readonly [SourceId, ...SourceId[]] {
  const uniqueSourceIds = [...new Set(sourceIds)].sort(compareSourceIds);
  if (uniqueSourceIds.length > PERSONAL_REMINDER_SOURCE_ID_LIMIT) {
    throw new RangeError("個人催促原因のsource IDは30件以内にしてください");
  }
  const [firstSourceId, ...remainingSourceIds] = uniqueSourceIds;
  assertNonNullable(firstSourceId, "個人催促原因のsource IDが1件もありません");
  return Object.freeze([firstSourceId, ...remainingSourceIds]);
}

function createBoundedSourceIds(
  requiredSourceIds: readonly SourceId[],
  optionalSourceIds: readonly SourceId[],
): readonly [SourceId, ...SourceId[]] {
  const required = [...new Set(requiredSourceIds)].sort(compareSourceIds);
  if (required.length > PERSONAL_REMINDER_SOURCE_ID_LIMIT) {
    throw new RangeError("個人催促原因の必須source IDは30件以内にしてください");
  }
  const requiredSet = new Set(required);
  const optional = [...new Set(optionalSourceIds)]
    .filter((sourceId) => !requiredSet.has(sourceId))
    .sort(compareSourceIds)
    .slice(0, PERSONAL_REMINDER_SOURCE_ID_LIMIT - required.length);
  return createSourceIds([...required, ...optional]);
}

function parseTimestamp(value: UtcIsoDateTime, context: string): number {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new TypeError(`${context}は有効な日時ではありません`);
  }
  return timestamp;
}

function responsibleSignature(value: PersonalReminderResponsible): string {
  return JSON.stringify([value.kind, value.candidateId.toLowerCase(), value.role]);
}

function sortResponsible(
  values: readonly PersonalReminderResponsible[],
): readonly [PersonalReminderResponsible, ...PersonalReminderResponsible[]] {
  const unique = new Map<string, PersonalReminderResponsible>();
  for (const value of values) {
    if (value.candidateId.length === 0) {
      throw new TypeError("個人催促原因の責任主体candidate IDは空にできません");
    }
    const key = responsibleSignature(value);
    if (!unique.has(key)) {
      unique.set(key, Object.freeze({ ...value }));
    }
  }
  const sorted = [...unique.values()].sort((left, right) =>
    compareStrings(responsibleSignature(left), responsibleSignature(right)),
  );
  const [first, ...remaining] = sorted;
  assertNonNullable(first, "個人催促原因の責任主体が1件もありません");
  return Object.freeze([first, ...remaining]);
}

function responsibleSignatures(values: readonly PersonalReminderResponsible[]): readonly string[] {
  return Object.freeze(values.map(responsibleSignature).sort(compareStrings));
}

function sourceIdsFromDecision(
  item: PersonalReminderItem,
  decision: PersonalReminderLocalDecision,
): readonly [SourceId, ...SourceId[]] {
  const requiredSourceIds = [
    item.sourceId,
    ...decision.statusBasis.sourceIds,
    ...decision.responsibilityBasis.sourceIds,
  ];
  const currentEvidenceSourceIds = decision.evidence
    .filter((evidence) => evidence.supports === "status" || evidence.supports === "waiting_on")
    .map((evidence) => evidence.sourceId);
  return createBoundedSourceIds(requiredSourceIds, currentEvidenceSourceIds);
}

function createUnavailable(
  itemNodeId: GitHubNodeId,
  reason: PersonalReminderCauseDraftUnavailableReason,
): PersonalReminderCauseDraftUnavailable {
  return Object.freeze({ status: "unavailable", itemNodeId, reason });
}

function reasonForWaitClass(waitClass: StalenessWaitClass): PersonalReminderReasonCode | undefined {
  if (
    waitClass === "blockedParent" ||
    waitClass === "notApplicable" ||
    waitClass === "automation"
  ) {
    return undefined;
  }
  return reasonByWaitClass[waitClass];
}

function responsibleFromDecision(
  decision: PersonalReminderLocalDecision,
): readonly [PersonalReminderResponsible, ...PersonalReminderResponsible[]] | undefined {
  const responsible: PersonalReminderResponsible[] = [];
  for (const waitingOn of decision.waitingOn) {
    if (waitingOn.kind !== "user" && waitingOn.kind !== "team" && waitingOn.kind !== "role") {
      continue;
    }
    if (waitingOn.role === "dependency" || waitingOn.role === "ci") {
      continue;
    }
    responsible.push(
      Object.freeze({
        kind: waitingOn.kind,
        candidateId: waitingOn.candidateId,
        role: waitingOn.role,
      }),
    );
  }
  if (responsible.length === 0) {
    return undefined;
  }
  return sortResponsible(responsible);
}

function actionKindForReason(
  reasonCode: PersonalReminderReasonCode,
): PersonalReminderCauseSeed["action"]["kind"] {
  switch (reasonCode) {
    case "assessment_overdue":
      return "assessment";
    case "owner_overdue":
      return "owner";
    case "decision_overdue":
      return "decision";
    case "review_overdue":
      return "review";
    case "revision_overdue":
      return "revision";
    case "reply_overdue":
      return "reply";
    case "work_overdue":
      return "work";
    case "merge_overdue":
      return "merge";
    default:
      throw new UnreachableError(reasonCode);
  }
}

function surfaceSignature(surface: PersonalReminderExecutionSurface): string {
  return JSON.stringify([surface.kind, surface.nodeId]);
}

function sortedExecutionSurfaces(
  surfaces: readonly PersonalReminderExecutionSurface[],
): readonly [PersonalReminderExecutionSurface, ...PersonalReminderExecutionSurface[]] {
  const unique = new Map<string, PersonalReminderExecutionSurface>();
  for (const surface of surfaces) {
    if (!unique.has(surfaceSignature(surface))) {
      unique.set(surfaceSignature(surface), Object.freeze({ ...surface }));
    }
  }
  const sorted = [...unique.values()].sort((left, right) =>
    compareStrings(surfaceSignature(left), surfaceSignature(right)),
  );
  const [first, ...remaining] = sorted;
  assertNonNullable(first, "個人催促原因の実行面が1件もありません");
  return Object.freeze([first, ...remaining]);
}

function normalizeResponsibility(
  value: PersonalReminderResponsibility,
): PersonalReminderResponsibility {
  const parsed = personalReminderResponsibilitySchema.parse(value);
  if (parsed.scope.kind === "item") {
    return Object.freeze({
      authority: parsed.authority,
      scope: Object.freeze({ kind: "item" }),
    });
  }
  if (parsed.scope.kind === "execution_surfaces") {
    return Object.freeze({
      authority: parsed.authority,
      scope: Object.freeze({
        kind: "execution_surfaces",
        surfaces: sortedExecutionSurfaces(parsed.scope.surfaces),
      }),
    });
  }
  return Object.freeze({
    authority: parsed.authority,
    scope: Object.freeze({
      kind: "item_and_execution_surfaces",
      surfaces: sortedExecutionSurfaces(parsed.scope.surfaces),
    }),
  });
}

function isUnavailableDraft(
  value: PersonalReminderCauseDraft | PersonalReminderCauseDraftUnavailable,
): value is PersonalReminderCauseDraftUnavailable {
  return "status" in value;
}

type ResponsibilityValue = Readonly<{
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
  return JSON.stringify([
    value.authority,
    value.scope.kind,
    value.scope.kind === "item" ? [] : value.scope.surfaces.map(surfaceSignature),
  ]);
}

function hasSharedExecutionSurface(left: ResponsibilityValue, right: ResponsibilityValue): boolean {
  if (left.scope.kind === "item" || right.scope.kind === "item") {
    return false;
  }
  const rightSurfaces = new Set(right.scope.surfaces.map(surfaceSignature));
  return left.scope.surfaces.some((surface) => rightSurfaces.has(surfaceSignature(surface)));
}

function responsibilityEpisodeContinues(
  previous: ResponsibilityValue,
  current: ResponsibilityValue,
): boolean {
  if (previous.authority !== current.authority) {
    return false;
  }
  if (previous.scope.kind !== "execution_surfaces") {
    return true;
  }
  if (current.scope.kind === "item") {
    return false;
  }
  return hasSharedExecutionSurface(previous, current);
}

function canonicalHash(value: readonly unknown[]): string {
  const serialized = JSON.stringify(value);
  const digest = createHash("sha256").update(serialized, "utf8").digest("hex");
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
  sourceOccurredAtById: ReadonlyMap<SourceId, UtcIsoDateTime>,
): PersonalReminderTimeBasis {
  const basis = draft.responsibilityBasis;
  const currentTimestamp = parseTimestamp(currentObservedAt, "現在の観測時刻");
  const sourceIds = createSourceIds(basis.sourceIds);
  const eventSourceIds = sourceIds.filter(
    (sourceId) => sourceOccurredAtById.get(sourceId) === basis.occurredAt,
  );
  if (eventSourceIds.length > 0) {
    const occurredAt = basis.occurredAt;
    const occurredTimestamp = parseTimestamp(occurredAt, "責務basisの時刻");
    if (occurredTimestamp > currentTimestamp) {
      throw new RangeError("責務basisの時刻は現在の観測時刻以前にしてください");
    }
    return personalReminderTimeBasisSchema.parse({
      source: "event",
      at: occurredAt,
      sourceIds: [...eventSourceIds],
    });
  }
  return personalReminderTimeBasisSchema.parse({
    source: "first_observation",
    at: currentObservedAt,
  });
}

function previousCauseValues(
  previous: PreviousPersonalReminderCauses,
): readonly PersonalReminderCause[] {
  return previous.causes;
}

function sameResponsible(
  left: readonly PersonalReminderResponsible[],
  right: readonly PersonalReminderResponsible[],
): boolean {
  const leftSignatures = responsibleSignatures(left);
  const rightSignatures = responsibleSignatures(right);
  return (
    leftSignatures.length === rightSignatures.length &&
    leftSignatures.every((value, index) => value === rightSignatures[index])
  );
}

function responsibleCandidateMatchesEvent(
  item: PersonalReminderItem,
  responsible: PersonalReminderResponsible,
  event: Extract<NormalizedEvent, { kind: "assignee" | "review_request" }>,
): boolean {
  if (event.kind === "assignee") {
    return (
      responsible.kind === "user" &&
      responsible.role === "assignee" &&
      event.assignee.login.toLowerCase() === responsible.candidateId.toLowerCase()
    );
  }
  if (responsible.role !== "reviewer") {
    return false;
  }
  if (item.type !== "pull_request") {
    return false;
  }
  const request = item.reviewRequests.find((candidate) =>
    candidate.target.type === "user"
      ? candidate.target.actor.nodeId === event.target.nodeId
      : candidate.target.nodeId === event.target.nodeId,
  );
  if (request == null) {
    return false;
  }
  if (request.target.type === "user") {
    return (
      responsible.kind === "user" &&
      request.target.actor.login.toLowerCase() === responsible.candidateId.toLowerCase()
    );
  }
  return (
    responsible.kind === "team" &&
    `${request.target.organizationLogin}/${request.target.slug}`.toLowerCase() ===
      responsible.candidateId.toLowerCase()
  );
}

type ResponsibilityEpisodeTransition = Readonly<{
  ended: boolean;
  restarted: boolean;
}>;

function responsibilityEpisodeTransition(
  item: PersonalReminderItem,
  previous: PersonalReminderCause,
  previousObservedAt: UtcIsoDateTime,
): ResponsibilityEpisodeTransition {
  const observedAt = parseTimestamp(previousObservedAt, "前回の観測時刻");
  const relevantResponsibilities = previous.responsible.filter(
    (responsible) =>
      (responsible.role === "assignee" && responsible.kind === "user") ||
      responsible.role === "reviewer",
  );
  let responsibilityEnded = false;
  let responsibilityRestarted = false;
  let stateEnded = false;
  let stateRestarted = false;
  for (const event of [...item.events].sort((left, right) => {
    const leftOccurredAt = parseTimestamp(left.occurredAt, `イベント ${left.sourceId}の発生時刻`);
    const rightOccurredAt = parseTimestamp(
      right.occurredAt,
      `イベント ${right.sourceId}の発生時刻`,
    );
    if (leftOccurredAt !== rightOccurredAt) {
      return leftOccurredAt - rightOccurredAt;
    }
    return compareSourceIds(left.sourceId, right.sourceId);
  })) {
    if (parseTimestamp(event.occurredAt, `イベント ${event.sourceId}の発生時刻`) <= observedAt) {
      continue;
    }
    if (event.kind === "state") {
      if (event.state === "closed" || event.state === "merged") {
        stateEnded = true;
      } else if (stateEnded) {
        stateRestarted = true;
      }
      continue;
    }
    if (
      (event.kind !== "assignee" && event.kind !== "review_request") ||
      !relevantResponsibilities.some((responsible) =>
        responsibleCandidateMatchesEvent(item, responsible, event),
      )
    ) {
      continue;
    }
    if (event.action === "removed") {
      responsibilityEnded = true;
    } else if (responsibilityEnded) {
      responsibilityRestarted = true;
    }
  }
  return Object.freeze({
    ended: responsibilityEnded || stateRestarted || (stateEnded && item.state === "closed"),
    restarted: responsibilityRestarted || stateRestarted,
  });
}

function responsibilityScopeEnded(
  previous: ResponsibilityValue,
  current: ResponsibilityValue,
): boolean {
  if (previous.scope.kind !== "execution_surfaces") {
    return false;
  }
  if (current.scope.kind === "item") {
    return true;
  }
  return !hasSharedExecutionSurface(previous, current);
}

function causeEpisodeEnded(
  item: PersonalReminderItem,
  cause: PersonalReminderCause,
  currentResponsibility: ResponsibilityValue | undefined,
  previousObservedAt: UtcIsoDateTime,
): boolean {
  if (
    currentResponsibility != null &&
    responsibilityScopeEnded(cause.responsibility, currentResponsibility)
  ) {
    return true;
  }
  return responsibilityEpisodeTransition(item, cause, previousObservedAt).ended;
}

function findContinuousCause(
  item: PersonalReminderItem,
  draft: PersonalReminderCauseDraft,
  previous: readonly PersonalReminderCause[],
  previousObservedAt: UtcIsoDateTime,
): PersonalReminderCause | undefined {
  const matching = previous.filter(
    (cause) =>
      cause.itemNodeId === item.nodeId &&
      cause.action.kind === draft.action.kind &&
      sameResponsible(cause.responsible, draft.responsible) &&
      responsibilityEpisodeContinues(cause.responsibility, draft.responsibility),
  );
  if (matching.length > 1) {
    throw new TypeError("同じ個人催促責務に対応する前回causeが複数あります");
  }
  const cause = matching[0];
  if (cause == null) {
    return undefined;
  }
  if (causeEpisodeEnded(item, cause, draft.responsibility, previousObservedAt)) {
    return undefined;
  }
  return cause;
}

function createSeed(
  draft: PersonalReminderCauseDraft,
  responsibility: ResponsibilityValue,
  obligationSince: PersonalReminderTimeBasis,
  responsibilityId: PersonalReminderResponsibilityId,
  causeId: PersonalReminderCauseId,
  evidenceSourceIds: readonly [SourceId, ...SourceId[]],
  lastConfirmedActionability: PersonalReminderCauseSeed["lastConfirmedActionability"],
): PersonalReminderCauseSeed {
  return personalReminderCauseSeedSchema.parse({
    causeId,
    responsibilityId,
    itemNodeId: draft.itemNodeId,
    reasonCode: draft.reasonCode,
    responsible: draft.responsible,
    responsibility: personalReminderResponsibilitySchema.parse(responsibility),
    action: draft.action,
    evidenceSourceIds,
    obligationSince,
    lastConfirmedActionability,
  });
}

/** IssueまたはPull Requestのblock適用前責務から個人催促原因候補を作る。 */
export function createPersonalReminderCauseDraft(
  item: PersonalReminderItem,
  localDecision: PersonalReminderLocalDecision,
  responsibility: PersonalReminderResponsibility,
): PersonalReminderCauseDraft | PersonalReminderCauseDraftUnavailable {
  const waitClass = determineStalenessWaitClass(localDecision, item.events);
  if (waitClass === "notApplicable") {
    return createUnavailable(
      item.nodeId,
      isTerminalStatus(localDecision.status) ? "terminal" : "not_applicable",
    );
  }
  if (waitClass === "blockedParent") {
    return createUnavailable(item.nodeId, "blocked_parent");
  }
  if (waitClass === "automation") {
    return createUnavailable(item.nodeId, "automation");
  }
  const reasonCode = reasonForWaitClass(waitClass);
  assertNonNullable(
    reasonCode,
    `個人催促原因のreason codeを決定できません。wait class: ${waitClass}`,
  );
  const responsible = responsibleFromDecision(localDecision);
  if (responsible == null) {
    return createUnavailable(item.nodeId, "no_responsible_actor");
  }
  if (localDecision.nextAction.length === 0) {
    throw new TypeError("個人催促原因のaction summaryが空です");
  }
  const actionKind = actionKindForReason(reasonCode);
  const responsibilityBasis = Object.freeze({ ...localDecision.responsibilityBasis });
  return Object.freeze({
    itemNodeId: item.nodeId,
    reasonCode: personalReminderReasonCodeSchema.parse(reasonCode),
    responsible,
    action: Object.freeze({ kind: actionKind, summary: localDecision.nextAction }),
    evidenceSourceIds: sourceIdsFromDecision(item, localDecision),
    responsibilityBasis,
    responsibility: normalizeResponsibility(responsibility),
  });
}

/** 個人催促原因候補へ責務episodeの識別情報と義務時刻を付与する。 */
export function reconcilePersonalReminderCauseSeeds(
  input: Readonly<{
    item: PersonalReminderItem;
    draft: PersonalReminderCauseDraft | PersonalReminderCauseDraftUnavailable;
    previous: PreviousPersonalReminderCauses;
    currentObservedAt: UtcIsoDateTime;
    sourceOccurredAtById: ReadonlyMap<SourceId, UtcIsoDateTime>;
  }>,
): PersonalReminderCauseSeedReconciliation {
  const currentObservedTimestamp = parseTimestamp(input.currentObservedAt, "現在の観測時刻");
  const previousObservedTimestamp = parseTimestamp(input.previous.observedAt, "前回の観測時刻");
  if (currentObservedTimestamp < previousObservedTimestamp) {
    throw new RangeError("現在の観測時刻は前回の観測時刻以後にしてください");
  }
  if (currentObservedTimestamp < parseTimestamp(input.item.observedAt, "itemの観測時刻")) {
    throw new RangeError("現在の観測時刻はitemの観測時刻以後にしてください");
  }
  const previousCauses = previousCauseValues(input.previous);
  const previousItemCauses = previousCauses.filter(
    (cause) => cause.itemNodeId === input.item.nodeId,
  );
  const previousObservedAt = input.previous.observedAt;
  if (isUnavailableDraft(input.draft)) {
    const unavailableReason = input.draft.reason;
    const emptySeeds: readonly [] = [];
    const endedCauseIds = previousItemCauses
      .filter(
        (cause) =>
          unavailableReason === "terminal" ||
          causeEpisodeEnded(input.item, cause, undefined, previousObservedAt),
      )
      .map((cause) => cause.causeId)
      .sort(compareStrings);
    const preservedCauseIds = previousItemCauses
      .filter((cause) => !endedCauseIds.includes(cause.causeId))
      .map((cause) => cause.causeId)
      .sort(compareStrings);
    return Object.freeze({
      status: "unavailable",
      seeds: emptySeeds,
      preservedCauseIds: Object.freeze(preservedCauseIds),
      endedCauseIds: Object.freeze(endedCauseIds),
      reason: unavailableReason,
    });
  }

  const continuousCause = findContinuousCause(
    input.item,
    input.draft,
    previousItemCauses,
    previousObservedAt,
  );
  const obligationSince =
    continuousCause == null
      ? createObligationSince(input.draft, input.currentObservedAt, input.sourceOccurredAtById)
      : continuousCause.obligationSince;
  const responsibilityId =
    continuousCause == null
      ? createResponsibilityId(input.draft)
      : continuousCause.responsibilityId;
  const causeId =
    continuousCause == null
      ? createCauseId(input.draft, responsibilityId)
      : continuousCause.causeId;
  const evidenceSourceIds = input.draft.evidenceSourceIds;
  const lastConfirmedActionability =
    continuousCause == null
      ? personalReminderLastConfirmedActionabilitySchema.parse({ status: "not_observed" })
      : continuousCause.lastConfirmedActionability;
  const seed = createSeed(
    input.draft,
    input.draft.responsibility,
    obligationSince,
    responsibilityId,
    causeId,
    evidenceSourceIds,
    lastConfirmedActionability,
  );
  const retainedCauseId = continuousCause?.causeId;
  const endedCauseIds: PersonalReminderCauseId[] = [];
  const preservedCauseIds: PersonalReminderCauseId[] = [];
  for (const cause of previousItemCauses) {
    if (cause.causeId === retainedCauseId) {
      continue;
    }
    const sameResponsibility =
      cause.action.kind === input.draft.action.kind &&
      sameResponsible(cause.responsible, input.draft.responsible);
    if (
      causeEpisodeEnded(
        input.item,
        cause,
        sameResponsibility ? input.draft.responsibility : undefined,
        previousObservedAt,
      )
    ) {
      endedCauseIds.push(cause.causeId);
    } else {
      preservedCauseIds.push(cause.causeId);
    }
  }
  return Object.freeze({
    status: "available",
    seeds: Object.freeze([seed]),
    preservedCauseIds: Object.freeze(preservedCauseIds.sort(compareStrings)),
    endedCauseIds: Object.freeze(endedCauseIds.sort(compareStrings)),
  });
}
