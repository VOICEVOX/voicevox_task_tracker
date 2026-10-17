import type {
  DecisionContext,
  DecisionDraft,
  IssuePrimaryWaitingOn,
  IssueResponsibilityAssessmentTrace,
  IssueStateDecision,
  IssueStateMachineInput,
  IssueTransitionBasis,
} from "./issue-state-contracts.js";
import { ISSUE_DETERMINISTIC_RULES_VERSION } from "./issue-state-contracts.js";
import { compareEvents, compareSourceIds, createSourceIds } from "./issue-state-sources.js";
import { resolveRepositoryRoleWaitingOn } from "./maintainer-resolution.js";
import { type SourceId } from "./source-id.js";
import { isTerminalStatus } from "./status.js";
import {
  type Evidence,
  type EvidenceSupport,
  type NormalizedEvent,
  type UtcIsoDateTime,
  type WaitingOn,
} from "./types.js";

export function createBasis(
  sourceIds: readonly SourceId[],
  occurredAt: UtcIsoDateTime,
  precision: IssueTransitionBasis["precision"],
): IssueTransitionBasis {
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
  trace: IssueResponsibilityAssessmentTrace,
): void {
  context.assessmentTrace.push(Object.freeze(trace));
}

export function finalizeDecision(
  input: IssueStateMachineInput,
  context: DecisionContext,
  draft: DecisionDraft,
): IssueStateDecision {
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
        } satisfies IssuePrimaryWaitingOn)
      : Object.freeze({
          index: 0,
          selectionReason: draft.primarySelectionReason,
        } satisfies IssuePrimaryWaitingOn);

  return Object.freeze({
    deterministicRulesVersion: ISSUE_DETERMINISTIC_RULES_VERSION,
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

export function getLatestEvent<T extends NormalizedEvent>(events: readonly T[]): T | undefined {
  return [...events].sort(compareEvents).at(-1);
}
