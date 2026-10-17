import { assertNonNullable } from "../util/index.js";
import { type FreshObservedGitHubPullRequest } from "./github-item-observation.js";
import { resolveRepositoryRoleWaitingOn } from "./maintainer-resolution.js";
import type {
  DecisionContext,
  DecisionDraft,
  LabelEvent,
  LabelEventReplay,
  PullRequestPrimaryWaitingOn,
  PullRequestResponsibilityAssessmentTrace,
  PullRequestStateDecision,
  PullRequestStateMachineInput,
  PullRequestTransitionBasis,
} from "./pull-request-state-contracts.js";
import { PULL_REQUEST_DETERMINISTIC_RULES_VERSION } from "./pull-request-state-contracts.js";
import { compareSourceIds, createSourceIds } from "./pull-request-state-validation.js";
import { type SourceId } from "./source-id.js";
import {
  type Evidence,
  type EvidenceSupport,
  type NormalizedEvent,
  type Status,
  type UtcIsoDateTime,
  type WaitingOn,
} from "./types.js";

export function createBasis(
  sourceIds: readonly SourceId[],
  occurredAt: UtcIsoDateTime,
  precision: PullRequestTransitionBasis["precision"],
): PullRequestTransitionBasis {
  return Object.freeze({
    sourceIds: createSourceIds(sourceIds),
    occurredAt,
    precision,
  });
}

export function createWaitingOn(
  fields: Omit<WaitingOn, "sourceIds"> & Readonly<{ sourceIds: readonly SourceId[] }>,
): WaitingOn {
  return Object.freeze({
    ...fields,
    sourceIds: createSourceIds(fields.sourceIds),
  });
}

export function createEvidence(
  sourceIds: readonly SourceId[],
  supports: EvidenceSupport,
  summary: string,
): readonly Evidence[] {
  return createSourceIds(sourceIds).map((sourceId) =>
    Object.freeze({
      sourceId,
      supports,
      summary,
    }),
  );
}

function compareEvidence(left: Evidence, right: Evidence): -1 | 0 | 1 {
  const sourceComparison = compareSourceIds(left.sourceId, right.sourceId);
  if (sourceComparison !== 0) {
    return sourceComparison;
  }
  if (left.supports < right.supports) {
    return -1;
  }
  if (left.supports > right.supports) {
    return 1;
  }
  if (left.summary < right.summary) {
    return -1;
  }
  if (left.summary > right.summary) {
    return 1;
  }
  return 0;
}

function freezeEvidence(values: readonly Evidence[]): readonly Evidence[] {
  const unique = new Map<string, Evidence>();
  for (const evidence of values) {
    unique.set(`${evidence.sourceId}\u0000${evidence.supports}\u0000${evidence.summary}`, evidence);
  }
  return Object.freeze([...unique.values()].sort(compareEvidence));
}

export function addUncertainty(
  context: DecisionContext,
  message: string,
  sourceIds: readonly SourceId[],
  confidenceCap: number,
  stateElements: readonly ("status" | "waitingOn" | "nextAction")[],
): void {
  context.uncertainties.push(message);
  context.evidence.push(...createEvidence(sourceIds, "uncertainty", message));
  context.confidenceCap = Math.min(context.confidenceCap, confidenceCap);
  for (const element of stateElements) {
    context.uncertainStateElements.add(element);
  }
}

export function addAssessmentTrace(
  context: DecisionContext,
  trace: PullRequestResponsibilityAssessmentTrace,
): void {
  context.assessmentTrace.push(Object.freeze(trace));
}

function isTerminalStatus(status: Status): boolean {
  return (
    status === "terminal_merged" ||
    status === "terminal_completed" ||
    status === "terminal_not_planned"
  );
}

export function finalizeDecision(
  input: PullRequestStateMachineInput,
  context: DecisionContext,
  draft: DecisionDraft,
): PullRequestStateDecision {
  if (isTerminalStatus(draft.status) && draft.waitingOn.length !== 0) {
    throw new TypeError("terminal状態にwaitingOnを設定できません");
  }
  if (!isTerminalStatus(draft.status) && draft.waitingOn.length === 0) {
    throw new TypeError("継続中の状態にはwaitingOnが1件以上必要です");
  }

  const uncertainties = Object.freeze([...new Set(context.uncertainties)].sort());
  const confidence = Math.min(draft.confidence, context.confidenceCap);
  const waitingOn = Object.freeze(
    draft.waitingOn
      .flatMap((value) => resolveRepositoryRoleWaitingOn(value, input.maintainers))
      .map((value) =>
        Object.freeze({
          ...value,
          confidence: Math.min(value.confidence, context.confidenceCap),
        }),
      ),
  );
  const primaryWaitingOn =
    waitingOn.length === 0
      ? Object.freeze({
          index: "not_applicable",
          selectionReason: draft.primarySelectionReason,
        } satisfies PullRequestPrimaryWaitingOn)
      : Object.freeze({
          index: 0,
          selectionReason: draft.primarySelectionReason,
        } satisfies PullRequestPrimaryWaitingOn);

  return Object.freeze({
    deterministicRulesVersion: PULL_REQUEST_DETERMINISTIC_RULES_VERSION,
    evaluatedAt: input.evaluatedAt,
    determination: uncertainties.length === 0 ? "determined" : "codex_candidate",
    aiAnalysisElementNecessities: Object.freeze({
      status: context.uncertainStateElements.has("status") ? "required" : "not_required",
      waitingOn: context.uncertainStateElements.has("waitingOn") ? "required" : "not_required",
      nextAction: context.uncertainStateElements.has("nextAction") ? "required" : "not_required",
    }),
    status: draft.status,
    waitingOn,
    primaryWaitingOn,
    nextAction: draft.nextAction,
    confidence,
    evidence: freezeEvidence([...draft.evidence, ...context.evidence]),
    uncertainties,
    statusBasis: draft.statusBasis,
    responsibilityBasis: draft.responsibilityBasis,
    assessmentTrace: Object.freeze([...context.assessmentTrace]),
    blockerDecisionTrace: context.blockerDecisionTrace,
  });
}

export function compareEvents(left: NormalizedEvent, right: NormalizedEvent): -1 | 0 | 1 {
  if (left.occurredAt < right.occurredAt) {
    return -1;
  }
  if (left.occurredAt > right.occurredAt) {
    return 1;
  }
  return compareSourceIds(left.sourceId, right.sourceId);
}

export function getLatestEvent<T extends NormalizedEvent>(events: readonly T[]): T | undefined {
  return [...events].sort(compareEvents).at(-1);
}

function replayLabelEvents(events: readonly NormalizedEvent[]): LabelEventReplay {
  const activeAdditionByLabelName = new Map<string, LabelEvent>();
  const labelEvents = events
    .filter((event): event is LabelEvent => event.kind === "label")
    .sort(compareEvents);

  for (const event of labelEvents) {
    if (event.action === "added") {
      activeAdditionByLabelName.set(event.labelName, event);
      continue;
    }
    activeAdditionByLabelName.delete(event.labelName);
  }

  return Object.freeze({ activeAdditionByLabelName });
}

function compareTransitionBases(
  left: PullRequestTransitionBasis,
  right: PullRequestTransitionBasis,
): -1 | 0 | 1 {
  if (left.occurredAt < right.occurredAt) {
    return -1;
  }
  if (left.occurredAt > right.occurredAt) {
    return 1;
  }
  return compareSourceIds(left.sourceIds[0], right.sourceIds[0]);
}

export function resolveMaintainerDecisionLabelBasis(
  pullRequest: FreshObservedGitHubPullRequest,
  labelNames: readonly string[],
): PullRequestTransitionBasis {
  const replay = replayLabelEvents(pullRequest.events);
  const bases = [...new Set(labelNames)].map((labelName) => {
    const additionEvent = replay.activeAdditionByLabelName.get(labelName);
    return additionEvent == null
      ? createBasis([pullRequest.sourceId], pullRequest.createdAt, "inferred")
      : createBasis([additionEvent.sourceId], additionEvent.occurredAt, "event");
  });
  return (
    bases.sort(compareTransitionBases)[0] ??
    createBasis([pullRequest.sourceId], pullRequest.createdAt, "inferred")
  );
}

type DraftLifecycleEvent = NormalizedEvent &
  Readonly<{ kind: "ready_for_review" | "converted_to_draft" }>;

export function resolveDraftIntervalBasis(
  pullRequest: FreshObservedGitHubPullRequest,
): PullRequestTransitionBasis {
  const events = pullRequest.events
    .filter(
      (event): event is DraftLifecycleEvent =>
        event.kind === "ready_for_review" || event.kind === "converted_to_draft",
    )
    .sort(compareEvents);
  const firstEvent = events[0];
  if (firstEvent == null) {
    return createBasis([pullRequest.sourceId], pullRequest.createdAt, "inferred");
  }

  let draft = firstEvent.kind === "ready_for_review";
  let intervalStartEvent: DraftLifecycleEvent | undefined;
  for (const event of events) {
    if (event.kind === "ready_for_review") {
      if (!draft) {
        throw new TypeError("non-draftのPull Requestにready for reviewイベントがあります");
      }
      draft = false;
    } else {
      if (draft) {
        throw new TypeError("draftのPull Requestにdraft変換イベントがあります");
      }
      draft = true;
    }
    intervalStartEvent = event;
  }

  if (draft !== pullRequest.draft) {
    throw new TypeError("Pull Requestのdraft状態とlifecycleイベントが一致しません");
  }
  assertNonNullable(intervalStartEvent, "draft区間の開始イベントを取得できませんでした");
  return createBasis([intervalStartEvent.sourceId], intervalStartEvent.occurredAt, "event");
}
