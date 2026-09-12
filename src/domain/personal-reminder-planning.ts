import { createHash } from "node:crypto";

import {
  personalReminderCauseIdSchema,
  personalReminderCauseSeedSchema,
  personalReminderLastConfirmedActionabilitySchema,
  personalReminderReasonCodeSchema,
  personalReminderResponsibilitySchema,
  personalReminderResponsibilityIdSchema,
  personalReminderTimeBasisSchema,
  type PersonalReminderCause,
  type PersonalReminderCauseId,
  type PersonalReminderCauseSeed,
  type PersonalReminderExecutionSurface,
  type PersonalReminderReasonCode,
  type PersonalReminderResponsible,
  type PersonalReminderResponsibility,
  type PersonalReminderResponsibilityId,
  type PersonalReminderTimeBasis,
} from "./personal-reminder-causes.js";
import {
  type FreshObservedGitHubIssue,
  type FreshObservedGitHubPullRequest,
} from "./github-item-observation.js";
import { type IssueStateDecision, type IssueTransitionBasis } from "./issue-state-machine.js";
import {
  isPullRequestRevisionResponsibilityResolved,
  type PullRequestStateDecision,
  type PullRequestTransitionBasis,
} from "./pull-request-state-machine.js";
import { determineStalenessWaitClass, type StalenessWaitClass } from "./staleness.js";
import { type SourceId } from "./source-id.js";
import { isTerminalStatus } from "./status.js";
import {
  type GitHubNodeId,
  type GraphNodeId,
  type NormalizedEvent,
  type Relation,
  type UtcIsoDateTime,
} from "./types.js";
import { assertNonNullable, UnreachableError } from "../util/index.js";

/** 個人催促原因の判定対象項目。 */
export type PersonalReminderItem = FreshObservedGitHubIssue | FreshObservedGitHubPullRequest;

/** block適用前の個人催促責務判定。 */
export type PersonalReminderLocalDecision = IssueStateDecision | PullRequestStateDecision;

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
export type PersonalReminderCauseSeedReconciliation = Readonly<{
  status: "available";
  seeds: readonly PersonalReminderCauseSeed[];
  retainedWithoutDraftCauseIds: readonly PersonalReminderCauseId[];
  endedCauseIds: readonly PersonalReminderCauseId[];
}>;

/** 現在のreview request先を責務終了判定へ渡す識別情報。 */
export type PersonalReminderReviewRequestTarget =
  Readonly<{ kind: "user"; candidateId: string }> | Readonly<{ kind: "team"; candidateId: string }>;

/** 構造上終了した個人催促原因を決定する入力。 */
export type PersonalReminderStructuralEndInput = Readonly<{
  item: PersonalReminderItem;
  previous: PreviousPersonalReminderCauses;
  currentDrafts: readonly PersonalReminderCauseDraft[];
  currentDecisionStatus: PersonalReminderLocalDecision["status"];
  complete: boolean;
  currentReviewRequestTargets: readonly PersonalReminderReviewRequestTarget[];
  executionSurfaceStates: ReadonlyMap<GitHubNodeId, "open" | "merged" | "closed_without_merge">;
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

function parseTimestamp(value: UtcIsoDateTime, context: string): number {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new TypeError(`${context}は有効な日時ではありません`);
  }
  return timestamp;
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

function responsibilityEpisodeContinues(
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
  const eventSourceIds =
    basis.precision === "event"
      ? sourceIds.filter((sourceId) => sourceOccurredAtById.get(sourceId) === basis.occurredAt)
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

function eventSort(left: NormalizedEvent, right: NormalizedEvent): number {
  const leftTime = parseTimestamp(left.occurredAt, `イベント ${left.sourceId}の発生時刻`);
  const rightTime = parseTimestamp(right.occurredAt, `イベント ${right.sourceId}の発生時刻`);
  if (leftTime !== rightTime) {
    return leftTime - rightTime;
  }
  return compareSourceIds(left.sourceId, right.sourceId);
}

function eventAfter(event: NormalizedEvent, observedAt: UtcIsoDateTime): boolean {
  return (
    parseTimestamp(event.occurredAt, `イベント ${event.sourceId}の発生時刻`) >
    parseTimestamp(observedAt, "前回の観測時刻")
  );
}

function assigneeMatches(
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

function responsibilityEpisodeTransition(
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

function findContinuousCause(
  item: PersonalReminderItem,
  draft: PersonalReminderCauseDraft,
  previous: readonly PersonalReminderCause[],
  previousObservedAt: UtcIsoDateTime,
  confirmedEndedCauseIds: ReadonlySet<PersonalReminderCauseId>,
): PersonalReminderCause | undefined {
  const matching = previous.filter(
    (cause) =>
      cause.itemNodeId === item.nodeId &&
      cause.action.kind === draft.action.kind &&
      sameResponsible(cause.responsible, draft.responsible) &&
      responsibilityEpisodeContinues(cause.responsibility, draft.responsibility) &&
      !confirmedEndedCauseIds.has(cause.causeId),
  );
  if (matching.length > 1) {
    throw new TypeError("同じ個人催促責務に対応する前回causeが複数あります");
  }
  const cause = matching[0];
  if (cause == null) {
    return undefined;
  }
  const transition = responsibilityEpisodeTransition(item, cause, previousObservedAt);
  if (transition.ended || transition.restarted) {
    return undefined;
  }
  return cause;
}

function createSeed(
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
  });
}

function seedFromCause(cause: PersonalReminderCause): PersonalReminderCauseSeed {
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
  return Object.freeze({
    itemNodeId: item.nodeId,
    reasonCode: personalReminderReasonCodeSchema.parse(reasonCode),
    responsible,
    action: Object.freeze({
      kind: actionKindForReason(reasonCode),
      summary: localDecision.nextAction,
    }),
    evidenceSourceIds: sourceIdsFromDecision(item, localDecision),
    responsibilityBasis: Object.freeze({ ...localDecision.responsibilityBasis }),
    responsibility: normalizeResponsibility(responsibility),
  });
}

function draftKey(draft: PersonalReminderCauseDraft): string {
  return JSON.stringify([
    draft.itemNodeId,
    draft.action.kind,
    responsibleSignatures(draft.responsible),
  ]);
}

/** 個人催促原因候補集合へ責務episodeの識別情報と義務時刻を付与する。 */
export function reconcilePersonalReminderCauseSeeds(
  input: Readonly<{
    item: PersonalReminderItem;
    drafts: readonly PersonalReminderCauseDraft[];
    previous: PreviousPersonalReminderCauses;
    currentObservedAt: UtcIsoDateTime;
    sourceOccurredAtById: ReadonlyMap<SourceId, UtcIsoDateTime>;
    confirmedEndedCauseIds: ReadonlySet<PersonalReminderCauseId>;
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
  const draftKeys = new Set<string>();
  for (const draft of input.drafts) {
    if (draft.itemNodeId !== input.item.nodeId) {
      throw new TypeError("個人催促原因draftのitem node IDが一致しません");
    }
    const key = draftKey(draft);
    if (draftKeys.has(key)) {
      throw new TypeError(`同じ個人催促責務のdraftが重複しています。対象: ${key}`);
    }
    draftKeys.add(key);
  }

  const previousItemCauses = input.previous.causes.filter(
    (cause) => cause.itemNodeId === input.item.nodeId,
  );
  const previousIds = new Set<PersonalReminderCauseId>();
  for (const cause of input.previous.causes) {
    if (previousIds.has(cause.causeId)) {
      throw new TypeError(`前回の個人催促cause IDが重複しています。対象: ${cause.causeId}`);
    }
    previousIds.add(cause.causeId);
  }

  const seeds: PersonalReminderCauseSeed[] = [];
  const retainedCauseIds = new Set<PersonalReminderCauseId>();
  const endedCauseIds = new Set<PersonalReminderCauseId>(input.confirmedEndedCauseIds);
  const sortedDrafts = [...input.drafts].sort((left, right) =>
    compareStrings(draftKey(left), draftKey(right)),
  );
  for (const draft of sortedDrafts) {
    const continuousCause = findContinuousCause(
      input.item,
      draft,
      previousItemCauses,
      input.previous.observedAt,
      input.confirmedEndedCauseIds,
    );
    let obligationSince =
      continuousCause == null
        ? createObligationSince(draft, input.currentObservedAt, input.sourceOccurredAtById)
        : continuousCause.obligationSince;
    let responsibilityId =
      continuousCause == null ? createResponsibilityId(draft) : continuousCause.responsibilityId;
    let causeId =
      continuousCause == null ? createCauseId(draft, responsibilityId) : continuousCause.causeId;
    let lastConfirmedActionability =
      continuousCause == null
        ? personalReminderLastConfirmedActionabilitySchema.parse({ status: "not_observed" })
        : continuousCause.lastConfirmedActionability;
    if (continuousCause != null) {
      const transition = responsibilityEpisodeTransition(
        input.item,
        continuousCause,
        input.previous.observedAt,
      );
      if (transition.ended || transition.restarted) {
        endedCauseIds.add(continuousCause.causeId);
        obligationSince = createObligationSince(
          draft,
          input.currentObservedAt,
          input.sourceOccurredAtById,
        );
        responsibilityId = createResponsibilityId(draft);
        causeId = createCauseId(draft, responsibilityId);
        lastConfirmedActionability = personalReminderLastConfirmedActionabilitySchema.parse({
          status: "not_observed",
        });
      }
    }
    seeds.push(
      createSeed(draft, obligationSince, responsibilityId, causeId, lastConfirmedActionability),
    );
    retainedCauseIds.add(causeId);
  }

  const retainedWithoutDraftCauseIds = new Set<PersonalReminderCauseId>();
  for (const cause of previousItemCauses) {
    if (retainedCauseIds.has(cause.causeId) || endedCauseIds.has(cause.causeId)) {
      continue;
    }
    seeds.push(seedFromCause(cause));
    retainedWithoutDraftCauseIds.add(cause.causeId);
  }
  for (const causeId of retainedCauseIds) {
    endedCauseIds.delete(causeId);
  }
  const seedCauseIds = new Set(seeds.map((seed) => seed.causeId));
  for (const causeId of endedCauseIds) {
    if (seedCauseIds.has(causeId)) {
      throw new TypeError(`個人催促causeが終了と継続へ同時に分類されました。対象: ${causeId}`);
    }
  }
  return Object.freeze({
    status: "available",
    seeds: Object.freeze(seeds.sort((left, right) => compareStrings(left.causeId, right.causeId))),
    retainedWithoutDraftCauseIds: Object.freeze(
      [...retainedWithoutDraftCauseIds].sort(compareStrings),
    ),
    endedCauseIds: Object.freeze([...endedCauseIds].sort(compareStrings)),
  });
}

function targetMatchesResponsible(
  target: PersonalReminderReviewRequestTarget,
  responsible: PersonalReminderResponsible,
): boolean {
  return (
    target.kind === responsible.kind &&
    responsible.role === "reviewer" &&
    target.candidateId.toLowerCase() === responsible.candidateId.toLowerCase()
  );
}

function currentReviewRequestNodeIds(
  item: PersonalReminderItem,
  cause: PersonalReminderCause,
): ReadonlySet<GitHubNodeId> {
  if (item.type !== "pull_request") {
    return new Set();
  }
  const nodeIds = new Set<GitHubNodeId>();
  for (const request of item.reviewRequests) {
    for (const responsible of cause.responsible) {
      if (responsible.role !== "reviewer") {
        continue;
      }
      if (
        request.target.type === "user" &&
        responsible.kind === "user" &&
        request.target.actor.login.toLowerCase() === responsible.candidateId.toLowerCase()
      ) {
        nodeIds.add(request.target.actor.nodeId);
      }
      if (
        request.target.type === "team" &&
        responsible.kind === "team" &&
        `${request.target.organizationLogin}/${request.target.slug}`.toLowerCase() ===
          responsible.candidateId.toLowerCase()
      ) {
        nodeIds.add(request.target.nodeId);
      }
    }
  }
  return nodeIds;
}

function reviewRequestEpisodeRestarted(
  item: PersonalReminderItem,
  cause: PersonalReminderCause,
  previousObservedAt: UtcIsoDateTime,
): boolean {
  if (cause.action.kind !== "review" || item.type !== "pull_request") {
    return false;
  }
  const currentTargetNodeIds = currentReviewRequestNodeIds(item, cause);
  let removed = false;
  for (const event of [...item.events].sort(eventSort)) {
    if (
      event.kind !== "review_request" ||
      !currentTargetNodeIds.has(event.target.nodeId) ||
      !eventAfter(event, previousObservedAt)
    ) {
      continue;
    }
    if (event.action === "removed") {
      removed = true;
      continue;
    }
    if (removed) {
      return true;
    }
  }
  return false;
}

function currentResponsibleDraftExists(
  cause: PersonalReminderCause,
  drafts: readonly PersonalReminderCauseDraft[],
): boolean {
  return drafts.some(
    (draft) =>
      draft.action.kind === cause.action.kind &&
      sameResponsible(draft.responsible, cause.responsible) &&
      responsibilityEpisodeContinues(cause.responsibility, draft.responsibility),
  );
}

function allExecutionSurfacesEnded(
  responsibility: ResponsibilityValue,
  states: ReadonlyMap<GitHubNodeId, "open" | "merged" | "closed_without_merge">,
): boolean {
  if (responsibility.scope.kind !== "execution_surfaces") {
    return false;
  }
  for (const surface of responsibility.scope.surfaces) {
    const state = states.get(surface.nodeId);
    if (state == null || state === "open") {
      return false;
    }
  }
  return true;
}

function hasAssignmentEndEvent(
  item: PersonalReminderItem,
  cause: PersonalReminderCause,
  previousObservedAt: UtcIsoDateTime,
): boolean {
  return item.events.some(
    (event) =>
      event.kind === "assignee" &&
      event.action === "removed" &&
      eventAfter(event, previousObservedAt) &&
      cause.responsible.some((responsible) => assigneeMatches(responsible, event)),
  );
}

function hasReadyResolutionEvent(
  item: PersonalReminderItem,
  previousObservedAt: UtcIsoDateTime,
): boolean {
  return item.events.some(
    (event) =>
      item.type === "pull_request" &&
      !item.draft &&
      event.kind === "ready_for_review" &&
      eventAfter(event, previousObservedAt),
  );
}

function currentDecisionCanConfirmResponsibilityEnd(
  status: PersonalReminderLocalDecision["status"],
): boolean {
  switch (status) {
    case "unknown":
    case "waiting_for_unblock":
    case "waiting_for_automation":
    case "in_progress":
      return false;
    default:
      return true;
  }
}

function hasCurrentDraftWithAction(
  input: PersonalReminderStructuralEndInput,
  actionKind: PersonalReminderCauseDraft["action"]["kind"],
): boolean {
  return input.currentDrafts.some(
    (draft) => draft.itemNodeId === input.item.nodeId && draft.action.kind === actionKind,
  );
}

function isAssessmentSuccessorAction(
  actionKind: PersonalReminderCauseDraft["action"]["kind"],
): boolean {
  switch (actionKind) {
    case "owner":
    case "work":
    case "reply":
    case "decision":
      return true;
    case "assessment":
    case "review":
    case "revision":
    case "merge":
      return false;
    default:
      throw new UnreachableError(actionKind);
  }
}

function hasCurrentAssessmentSuccessorDraft(input: PersonalReminderStructuralEndInput): boolean {
  return input.currentDrafts.some(
    (draft) =>
      draft.itemNodeId === input.item.nodeId && isAssessmentSuccessorAction(draft.action.kind),
  );
}

function hasPullRequestOwnerResolutionEvidence(
  input: PersonalReminderStructuralEndInput,
  cause: PersonalReminderCause,
): boolean {
  if (input.item.type !== "pull_request") {
    return false;
  }
  if (input.currentReviewRequestTargets.length > 0) {
    return true;
  }
  return input.item.events.some(
    (event) =>
      eventAfter(event, cause.obligationSince.at) &&
      ((event.kind === "review_request" && event.action === "added") ||
        (event.kind === "review" && event.actor.type === "human")),
  );
}

function fixedResponsibilityCauseEnded(
  input: PersonalReminderStructuralEndInput,
  cause: PersonalReminderCause,
): boolean {
  if (
    !input.complete ||
    input.item.state !== "open" ||
    cause.responsibility.authority !== "fixed" ||
    cause.responsibility.scope.kind !== "item" ||
    !currentDecisionCanConfirmResponsibilityEnd(input.currentDecisionStatus)
  ) {
    return false;
  }

  if (cause.action.kind === "assessment") {
    return (
      input.item.type === "issue" &&
      cause.reasonCode === "assessment_overdue" &&
      hasCurrentAssessmentSuccessorDraft(input)
    );
  }

  if (cause.action.kind !== "owner" || cause.reasonCode !== "owner_overdue") {
    return false;
  }
  if (input.item.type === "issue") {
    return (
      input.currentDecisionStatus === "waiting_for_work" && hasCurrentDraftWithAction(input, "work")
    );
  }
  if (input.item.draft) {
    return false;
  }
  return hasPullRequestOwnerResolutionEvidence(input, cause);
}

function structuralCauseEnded(
  input: PersonalReminderStructuralEndInput,
  cause: PersonalReminderCause,
): boolean {
  if (fixedResponsibilityCauseEnded(input, cause)) {
    return true;
  }
  if (!input.complete) {
    return false;
  }
  if (input.item.state === "closed") {
    return true;
  }
  if (allExecutionSurfacesEnded(cause.responsibility, input.executionSurfaceStates)) {
    return true;
  }
  const previousObservedAt = input.previous.observedAt;
  if (cause.action.kind === "review" && input.item.type === "pull_request") {
    if (reviewRequestEpisodeRestarted(input.item, cause, previousObservedAt)) {
      return true;
    }
    const currentReviewerExists = input.currentReviewRequestTargets.some((target) =>
      cause.responsible.some((responsible) => targetMatchesResponsible(target, responsible)),
    );
    if (!currentReviewerExists && !currentResponsibleDraftExists(cause, input.currentDrafts)) {
      return true;
    }
  }
  if (
    cause.action.kind === "work" &&
    hasAssignmentEndEvent(input.item, cause, previousObservedAt)
  ) {
    return true;
  }
  if (
    cause.action.kind === "revision" &&
    input.item.type === "pull_request" &&
    !currentResponsibleDraftExists(cause, input.currentDrafts) &&
    (currentDecisionCanConfirmResponsibilityEnd(input.currentDecisionStatus) ||
      (cause.obligationSince.source === "event" &&
        isPullRequestRevisionResponsibilityResolved({
          pullRequest: input.item,
          previousResponsibilityBasis: {
            sourceIds: createSourceIds(cause.obligationSince.sourceIds),
            occurredAt: cause.obligationSince.at,
            precision: "event",
          },
        })))
  ) {
    return true;
  }
  if (cause.action.kind === "work" && hasReadyResolutionEvent(input.item, previousObservedAt)) {
    return true;
  }
  return false;
}

/** freshかつ完全な構造入力から終了を確定したcause IDを返す。 */
export function determineStructurallyEndedPersonalReminderCauses(
  input: PersonalReminderStructuralEndInput,
): readonly PersonalReminderCauseId[] {
  const ended = input.previous.causes
    .filter((cause) => cause.itemNodeId === input.item.nodeId)
    .filter((cause) => structuralCauseEnded(input, cause))
    .map((cause) => cause.causeId)
    .sort(compareStrings);
  return Object.freeze(ended);
}

function relationTouchesCauseScope(
  relation: Relation,
  cause: PersonalReminderCauseSeed | PersonalReminderCause,
): boolean {
  const nodeIds = new Set<GraphNodeId>([cause.itemNodeId]);
  if (cause.responsibility.scope.kind !== "item") {
    for (const surface of cause.responsibility.scope.surfaces) {
      nodeIds.add(surface.nodeId);
    }
  }
  return nodeIds.has(relation.fromNodeId) || nodeIds.has(relation.toNodeId);
}

/** 個人催促原因へ効力を持つactive relationかを判定する。 */
export function relationAffectsPersonalReminderCause(
  relation: Relation,
  cause: PersonalReminderCauseSeed | PersonalReminderCause,
): boolean {
  if (!relation.active || relation.type === "related_to") {
    return false;
  }
  const nodeIds = new Set<GraphNodeId>([cause.itemNodeId]);
  if (cause.responsibility.scope.kind !== "item") {
    for (const surface of cause.responsibility.scope.surfaces) {
      nodeIds.add(surface.nodeId);
    }
  }
  switch (relation.type) {
    case "blocks":
      return nodeIds.has(relation.toNodeId);
    case "implements":
    case "parent_of":
      return relation.toNodeId === cause.itemNodeId;
    case "duplicates":
      return relationTouchesCauseScope(relation, cause);
    default:
      throw new UnreachableError(relation.type);
  }
}
