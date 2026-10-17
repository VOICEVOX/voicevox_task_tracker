import type {
  PersonalReminderCauseDraft,
  PersonalReminderCauseDraftUnavailable,
  PersonalReminderCauseProjection,
  PersonalReminderCauseSeedOrigin,
  PersonalReminderCauseSeedReconciliation,
  PersonalReminderItem,
  PersonalReminderLocalDecision,
  PersonalReminderStructuralEndInput,
  PreviousPersonalReminderCauses,
} from "./personal-reminder-planning-contracts.js";
export type {
  PersonalReminderCauseDraft,
  PersonalReminderCauseDraftUnavailable,
  PersonalReminderCauseDraftUnavailableReason,
  PersonalReminderCauseProjection,
  PersonalReminderCauseSeedOrigin,
  PersonalReminderCauseSeedReconciliation,
  PersonalReminderItem,
  PersonalReminderLocalDecision,
  PersonalReminderReviewRequestTarget,
  PersonalReminderStructuralEndInput,
  PreviousPersonalReminderCauses,
} from "./personal-reminder-planning-contracts.js";
import { UnreachableError, assertNonNullable } from "../util/index.js";
import { combineAiAnalysisDependencies } from "./ai-analysis-dependencies.js";
import {
  personalReminderReasonCodeSchema,
  type PersonalReminderCause,
  type PersonalReminderCauseAiDependencies,
  type PersonalReminderCauseId,
  type PersonalReminderCauseSeed,
  type PersonalReminderResponsibility,
} from "./personal-reminder-causes.js";
import {
  actionKindForReason,
  assessmentTraceDependency,
  compareStrings,
  createUnavailable,
  normalizeResponsibility,
  parseTimestamp,
  reasonForWaitClass,
  responsibleFromDecision,
  sourceIdsFromDecision,
} from "./personal-reminder-planning-common.js";
import {
  createSeed,
  createSeedFromDraft,
  findContinuousCause,
  personalReminderContinuityGroupKey,
  personalReminderResponsibilitiesMayShareContinuation,
  responsibilityEpisodeTransition,
  seedFromCause,
  type PersonalReminderCauseSeedMultipleContinuationConflict,
  type PersonalReminderCauseSeedNewDraftIdCollision,
} from "./personal-reminder-planning-continuity.js";
import { draftKey, projectionKey } from "./personal-reminder-planning-seeds.js";
import {
  relationTouchesCauseScope,
  structuralCauseEnded,
} from "./personal-reminder-structural-end.js";
import { type SourceId } from "./source-id.js";
import { determineStalenessWaitClass } from "./staleness.js";
import { isTerminalStatus } from "./status.js";
import { type GitHubNodeId, type GraphNodeId, type UtcIsoDateTime } from "./types.js";
import { type Relation } from "./relation.js";
import { type TrackedItemAiAnalysisApplications } from "./tracked-item-ai-analysis.js";

/** state machineの判定から個人催促表示フィールドのAI依存を作る。 */
export function personalReminderCauseAiDependenciesForDecision(
  itemNodeId: GitHubNodeId,
  decision: PersonalReminderLocalDecision,
  applications: TrackedItemAiAnalysisApplications,
): PersonalReminderCauseAiDependencies {
  const status = assessmentTraceDependency(itemNodeId, "status", decision, applications);
  const waitingOn = assessmentTraceDependency(itemNodeId, "waitingOn", decision, applications);
  const nextAction = assessmentTraceDependency(itemNodeId, "nextAction", decision, applications);
  const presence = combineAiAnalysisDependencies([status, waitingOn]);
  const responsible = decision.assessmentTrace.some((trace) => trace.kind !== "explicit_request")
    ? combineAiAnalysisDependencies([status, waitingOn])
    : waitingOn;
  const action = combineAiAnalysisDependencies([status, waitingOn, nextAction]);
  return Object.freeze({
    presence,
    responseMembership: Object.freeze({ status: "not_dependent" }),
    responsible,
    action,
    evidence: combineAiAnalysisDependencies([presence, responsible]),
  });
}

/** 前回の個人催促原因から継続競合の可能性がある項目を抽出する。 */
export function determinePotentialPersonalReminderContinuityConflictNodeIds(
  causes: readonly PersonalReminderCause[],
): ReadonlySet<GitHubNodeId> {
  const causesByGroup = new Map<string, PersonalReminderCause[]>();
  for (const cause of causes) {
    const key = personalReminderContinuityGroupKey(cause);
    const group = causesByGroup.get(key);
    if (group == null) {
      causesByGroup.set(key, [cause]);
    } else {
      group.push(cause);
    }
  }
  const nodeIds = new Set<GitHubNodeId>();
  for (const group of causesByGroup.values()) {
    if (group.length < 2) {
      continue;
    }
    const hasPotentialConflict = group.some((leftCause, leftIndex) =>
      group
        .slice(leftIndex + 1)
        .some((rightCause) =>
          personalReminderResponsibilitiesMayShareContinuation(
            leftCause.responsibility,
            rightCause.responsibility,
          ),
        ),
    );
    if (hasPotentialConflict) {
      const firstCause = group[0];
      assertNonNullable(firstCause, "個人催促原因の継続競合候補がありません");
      nodeIds.add(firstCause.itemNodeId);
    }
  }
  return nodeIds;
}

/** IssueまたはPull Requestのblock適用前責務から個人催促原因候補を作る。 */
export function createPersonalReminderCauseDraft(
  item: PersonalReminderItem,
  localDecision: PersonalReminderLocalDecision,
  responsibility: PersonalReminderResponsibility,
  applications: TrackedItemAiAnalysisApplications,
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
    aiDependencies: personalReminderCauseAiDependenciesForDecision(
      item.nodeId,
      localDecision,
      applications,
    ),
  });
}

/** 現在候補と前回causeの継続可能性を保存せずに列挙する。 */
export function enumeratePersonalReminderCauseProjections(
  input: Readonly<{
    item: PersonalReminderItem;
    drafts: readonly PersonalReminderCauseDraft[];
    previous: PreviousPersonalReminderCauses;
  }>,
): readonly PersonalReminderCauseProjection[] {
  const projections = new Map<string, PersonalReminderCauseProjection>();
  const matchedPreviousCauseIds = new Set<PersonalReminderCauseId>();
  const previousItemCauses = input.previous.causes.filter(
    (cause) => cause.itemNodeId === input.item.nodeId,
  );
  const draftKeys = new Set<string>();
  const addProjection = (
    draft: PersonalReminderCauseDraft | undefined,
    previousCause: PersonalReminderCause | undefined,
  ): void => {
    const key = projectionKey(draft, previousCause);
    if (!projections.has(key)) {
      projections.set(key, Object.freeze({ key, draft, previousCause }));
    }
  };
  const sortedDrafts = [...input.drafts].sort((left, right) =>
    compareStrings(draftKey(left), draftKey(right)),
  );
  for (const draft of sortedDrafts) {
    if (draft.itemNodeId !== input.item.nodeId) {
      throw new TypeError("個人催促原因projectionのdraft item node IDが一致しません");
    }
    const key = draftKey(draft);
    if (draftKeys.has(key)) {
      throw new TypeError(`同じ個人催促責務のdraftが重複しています。対象: ${key}`);
    }
    draftKeys.add(key);
    const continuityMatch = findContinuousCause(
      input.item,
      draft,
      previousItemCauses,
      input.previous.observedAt,
      new Set(),
    );
    if (continuityMatch.status === "conflict") {
      for (const cause of continuityMatch.matchingCauses) {
        matchedPreviousCauseIds.add(cause.causeId);
        addProjection(draft, cause);
      }
      continue;
    }
    if (continuityMatch.status === "matched") {
      matchedPreviousCauseIds.add(continuityMatch.cause.causeId);
      addProjection(draft, continuityMatch.cause);
      continue;
    }
    addProjection(draft, undefined);
  }
  for (const cause of previousItemCauses) {
    if (!matchedPreviousCauseIds.has(cause.causeId)) {
      addProjection(undefined, cause);
    }
  }
  return Object.freeze(
    [...projections.values()].sort((left, right) => compareStrings(left.key, right.key)),
  );
}

/** 個人催促原因の投影候補へ一時的な意味入力用seedを付与する。 */
export function createPersonalReminderCauseProjectionSeed(
  input: Readonly<{
    projection: PersonalReminderCauseProjection;
    currentObservedAt: UtcIsoDateTime;
    clockEventOccurredAtBySourceId: ReadonlyMap<SourceId, UtcIsoDateTime>;
  }>,
): PersonalReminderCauseSeed {
  if (input.projection.previousCause != null) {
    if (input.projection.draft == null) {
      return seedFromCause(input.projection.previousCause);
    }
    return createSeedFromDraft({
      draft: input.projection.draft,
      previousCause: input.projection.previousCause,
      currentObservedAt: input.currentObservedAt,
      clockEventOccurredAtBySourceId: input.clockEventOccurredAtBySourceId,
    });
  }
  const draft = input.projection.draft;
  assertNonNullable(draft, `個人催促原因の投影draftがありません。対象: ${input.projection.key}`);
  return createSeedFromDraft({
    draft,
    previousCause: undefined,
    currentObservedAt: input.currentObservedAt,
    clockEventOccurredAtBySourceId: input.clockEventOccurredAtBySourceId,
  });
}

/** 個人催促原因候補集合へ責務episodeの識別情報と義務時刻を付与する。 */
export function reconcilePersonalReminderCauseSeeds(
  input: Readonly<{
    item: PersonalReminderItem;
    drafts: readonly PersonalReminderCauseDraft[];
    previous: PreviousPersonalReminderCauses;
    currentObservedAt: UtcIsoDateTime;
    clockEventOccurredAtBySourceId: ReadonlyMap<SourceId, UtcIsoDateTime>;
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
  const seedOrigins: PersonalReminderCauseSeedOrigin[] = [];
  const multipleContinuationConflicts: PersonalReminderCauseSeedMultipleContinuationConflict[] = [];
  const newDraftIdCollisions: PersonalReminderCauseSeedNewDraftIdCollision[] = [];
  const retainedCauseIds = new Set<PersonalReminderCauseId>();
  const endedCauseIds = new Set<PersonalReminderCauseId>(input.confirmedEndedCauseIds);
  const sortedDrafts = [...input.drafts].sort((left, right) =>
    compareStrings(draftKey(left), draftKey(right)),
  );
  for (const draft of sortedDrafts) {
    const continuityMatch = findContinuousCause(
      input.item,
      draft,
      previousItemCauses,
      input.previous.observedAt,
      input.confirmedEndedCauseIds,
    );
    if (continuityMatch.status === "conflict") {
      for (const cause of continuityMatch.matchingCauses) {
        createSeed(
          draft,
          cause.obligationSince,
          cause.responsibilityId,
          cause.causeId,
          cause.lastConfirmedActionability,
        );
      }
      multipleContinuationConflicts.push(
        Object.freeze({
          status: "continuity_conflict",
          reason: "multiple_continuation_matches",
          itemNodeId: input.item.nodeId,
          previousCauseIds: continuityMatch.previousCauseIds,
        }),
      );
      continue;
    }
    const continuousCause =
      continuityMatch.status === "matched" ? continuityMatch.cause : undefined;
    let previousCauseForSeed = continuousCause;
    if (continuousCause != null) {
      const transition = responsibilityEpisodeTransition(
        input.item,
        continuousCause,
        input.previous.observedAt,
      );
      if (transition.ended || transition.restarted) {
        endedCauseIds.add(continuousCause.causeId);
        previousCauseForSeed = undefined;
      }
    }
    const seed = createSeedFromDraft({
      draft,
      previousCause: previousCauseForSeed,
      currentObservedAt: input.currentObservedAt,
      clockEventOccurredAtBySourceId: input.clockEventOccurredAtBySourceId,
    });
    if (previousCauseForSeed == null && previousIds.has(seed.causeId)) {
      const previousCauseIds: [PersonalReminderCauseId] = [seed.causeId];
      newDraftIdCollisions.push(
        Object.freeze({
          status: "continuity_conflict",
          reason: "new_draft_id_collision",
          itemNodeId: input.item.nodeId,
          previousCauseIds: Object.freeze(previousCauseIds),
        }),
      );
      continue;
    }
    seeds.push(seed);
    seedOrigins.push(
      previousCauseForSeed == null
        ? Object.freeze({ kind: "new_draft", seed, draft })
        : Object.freeze({
            kind: "normal_continuation",
            seed,
            draft,
            previousCause: previousCauseForSeed,
          }),
    );
    retainedCauseIds.add(seed.causeId);
  }

  const [firstNewDraftIdCollision] = newDraftIdCollisions;
  if (firstNewDraftIdCollision != null) {
    return firstNewDraftIdCollision;
  }
  const [firstMultipleContinuationConflict] = multipleContinuationConflicts;
  if (firstMultipleContinuationConflict != null) {
    return firstMultipleContinuationConflict;
  }

  const retainedWithoutDraftCauseIds = new Set<PersonalReminderCauseId>();
  for (const cause of previousItemCauses) {
    if (retainedCauseIds.has(cause.causeId) || endedCauseIds.has(cause.causeId)) {
      continue;
    }
    const seed = seedFromCause(cause);
    seeds.push(seed);
    seedOrigins.push(Object.freeze({ kind: "retained_without_draft", seed, previousCause: cause }));
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
    seedOrigins: Object.freeze(
      seedOrigins.sort((left, right) => compareStrings(left.seed.causeId, right.seed.causeId)),
    ),
    retainedWithoutDraftCauseIds: Object.freeze(
      [...retainedWithoutDraftCauseIds].sort(compareStrings),
    ),
    endedCauseIds: Object.freeze([...endedCauseIds].sort(compareStrings)),
  });
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
