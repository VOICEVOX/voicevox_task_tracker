import {
  buildSourceId,
  isTerminalStatus,
  parseSourceId,
  type Evidence,
  type SourceId,
  type Status,
  type WaitingOn,
} from "../domain/index.js";
import { assertNonNullable } from "../util/index.js";
import type { DeterministicCodexDecision, ReducedCodexDecision } from "./reducer-contracts.js";

function validateProbability(value: number, context: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError(`${context}は0以上1以下にしてください`);
  }
}

export function createSourceIdTuple(
  sourceIds: readonly string[],
): readonly [SourceId, ...SourceId[]] {
  const parsedSourceIds = sourceIds.map((sourceId) => {
    const parts = parseSourceId(sourceId);
    return buildSourceId(parts.kind, parts.originalId);
  });
  const [firstSourceId, ...remainingSourceIds] = parsedSourceIds;
  assertNonNullable(firstSourceId, "source IDが1件もありません");
  return Object.freeze([firstSourceId, ...remainingSourceIds]);
}

export function copyWaitingOn(
  waitingOn: readonly Readonly<{
    kind: WaitingOn["kind"];
    candidateId: string;
    role: WaitingOn["role"];
    reasonSummary: string;
    sourceIds: readonly string[];
    confidence: number;
  }>[],
): readonly WaitingOn[] {
  return Object.freeze(
    waitingOn.map((value) =>
      Object.freeze({
        kind: value.kind,
        candidateId: value.candidateId,
        role: value.role,
        reasonSummary: value.reasonSummary,
        sourceIds: createSourceIdTuple(value.sourceIds),
        confidence: value.confidence,
      }),
    ),
  );
}

function copyEvidence(evidence: readonly Evidence[]): readonly Evidence[] {
  return Object.freeze(
    evidence.map((value) =>
      Object.freeze({
        sourceId: value.sourceId,
        supports: value.supports,
        summary: value.summary,
      }),
    ),
  );
}

export function createDecision(
  origin: ReducedCodexDecision["origin"],
  value: Readonly<{
    status: Status;
    waitingOn: readonly WaitingOn[];
    nextAction: string;
    confidence: number;
    evidence: readonly Evidence[];
    uncertainties: readonly string[];
  }>,
  additionalUncertainty: string | undefined,
): ReducedCodexDecision {
  const uncertainties =
    additionalUncertainty == null
      ? value.uncertainties
      : [...value.uncertainties, additionalUncertainty];
  return Object.freeze({
    origin,
    status: value.status,
    waitingOn: copyWaitingOn(value.waitingOn),
    nextAction: value.nextAction,
    confidence: value.confidence,
    evidence: copyEvidence(value.evidence),
    uncertainties: Object.freeze([...new Set(uncertainties)].sort()),
  });
}

export function validateDecision(value: DeterministicCodexDecision): void {
  validateProbability(value.confidence, "決定論的判定のconfidence");
  if (value.nextAction.trim().length === 0) {
    throw new TypeError("決定論的判定のnextActionは空にできません");
  }
  if (isTerminalStatus(value.status) && value.waitingOn.length !== 0) {
    throw new TypeError("terminal状態にwaitingOnを設定できません");
  }
  if (!isTerminalStatus(value.status) && value.waitingOn.length === 0) {
    throw new TypeError("継続中の状態にはwaitingOnが1件以上必要です");
  }
  for (const waitingOn of value.waitingOn) {
    validateProbability(waitingOn.confidence, "決定論的waitingOnのconfidence");
  }
}
