import { effectiveElementConfidence } from "../../../codex/analysis-element-confidence.js";
import {
  createAiAnalysisMigrationElementResultSchema,
  type AiAnalysisElementMigrationResult,
} from "../../../domain/ai-analysis-elements.js";
import {
  buildSourceId,
  parseSourceId,
  type Evidence,
  type IssueStateDecision,
  type PullRequestStateDecision,
  type SourceId,
  type WaitingOn,
} from "../../../domain/index.js";
import { assertNonNullable } from "../../../util/index.js";
import type { GenericAiItemAdoption } from "./generic-ai-adoption-contracts.js";
import type { GraphReducedDecision } from "./graph-reconciliation-contracts.js";

function sourceIds(values: readonly string[]): readonly [SourceId, ...SourceId[]] {
  const normalized = values.map((value) => {
    const parsed = parseSourceId(value);
    return buildSourceId(parsed.kind, parsed.originalId);
  });
  const [first, ...rest] = normalized;
  assertNonNullable(first, "AI判定のsource IDがありません");
  return Object.freeze([first, ...rest]);
}

function waitingOnValues(
  result: AiAnalysisElementMigrationResult<"waitingOn">,
): readonly WaitingOn[] {
  const parsed = createAiAnalysisMigrationElementResultSchema("waitingOn").parse(result);
  return Object.freeze(
    parsed.value.map((value) =>
      Object.freeze({
        kind: value.kind,
        candidateId: value.candidateId,
        role: value.role,
        reasonSummary: value.reasonSummary,
        sourceIds: sourceIds(value.sourceIds),
        confidence: value.confidence,
      }),
    ),
  );
}

function stateEvidence(
  result: AiAnalysisElementMigrationResult,
  supports: "status" | "waiting_on",
): readonly Evidence[] {
  return Object.freeze(
    result.evidence.map((evidence) => {
      if (evidence.supports === "self_commitment" && supports !== "waiting_on") {
        throw new TypeError("self_commitmentの根拠はwaitingOn要素にだけ指定できます");
      }
      return Object.freeze({
        sourceId: sourceIds([evidence.sourceId])[0],
        supports: evidence.supports === "self_commitment" ? "self_commitment" : supports,
        summary: evidence.summary,
      });
    }),
  );
}

/** 採用済み9要素から状態の最終値を一度だけ組み立てる。 */
export function decisionFromAdoption(
  deterministic: IssueStateDecision | PullRequestStateDecision,
  adopted: GenericAiItemAdoption,
  confidence: Readonly<{ high: number; medium: number }>,
): GraphReducedDecision {
  const records = adopted.elements;
  const statusAdopted = records.status.adopted;
  const waitingOnAdopted = records.waitingOn.adopted;
  const nextActionAdopted = records.nextAction.adopted;
  const statusResult =
    statusAdopted.status === "ai"
      ? createAiAnalysisMigrationElementResultSchema("status").parse(statusAdopted.result)
      : undefined;
  const waitingOnResult =
    waitingOnAdopted.status === "ai"
      ? createAiAnalysisMigrationElementResultSchema("waitingOn").parse(waitingOnAdopted.result)
      : undefined;
  const nextActionResult =
    nextActionAdopted.status === "ai"
      ? createAiAnalysisMigrationElementResultSchema("nextAction").parse(nextActionAdopted.result)
      : undefined;
  const selected = [statusResult, waitingOnResult, nextActionResult].filter(
    (result) => result != null,
  );
  if (selected.length === 0) {
    return Object.freeze({
      origin: "deterministic",
      status: deterministic.status,
      waitingOn: deterministic.waitingOn,
      nextAction: deterministic.nextAction,
      confidence: deterministic.confidence,
      evidence: deterministic.evidence,
      uncertainties: deterministic.uncertainties,
    });
  }
  const status = statusResult?.value ?? deterministic.status;
  const waitingOn =
    waitingOnResult == null ? deterministic.waitingOn : waitingOnValues(waitingOnResult);
  const nextAction = nextActionResult?.value ?? deterministic.nextAction;
  const aiEvidence = [
    ...(statusResult == null ? [] : stateEvidence(statusResult, "status")),
    ...(waitingOnResult == null ? [] : stateEvidence(waitingOnResult, "waiting_on")),
    ...(nextActionResult == null ? [] : stateEvidence(nextActionResult, "status")),
  ];
  let evidence: readonly Evidence[] = deterministic.evidence;
  if (aiEvidence.length > 0) {
    evidence = selected.length === 3 ? aiEvidence : [...deterministic.evidence, ...aiEvidence];
  }
  const confidences = [
    ...(selected.length === 3 ? [] : [deterministic.confidence]),
    ...(statusResult == null ? [] : [effectiveElementConfidence("status", statusResult)]),
    ...(waitingOnResult == null ? [] : [effectiveElementConfidence("waitingOn", waitingOnResult)]),
    ...(nextActionResult == null
      ? []
      : [effectiveElementConfidence("nextAction", nextActionResult)]),
  ];
  const uncertainties = [
    ...deterministic.uncertainties,
    ...selected.flatMap((result) => result.uncertainties),
  ];
  const aiConfidences = [
    ...(statusResult == null ? [] : [effectiveElementConfidence("status", statusResult)]),
    ...(waitingOnResult == null ? [] : [effectiveElementConfidence("waitingOn", waitingOnResult)]),
    ...(nextActionResult == null
      ? []
      : [effectiveElementConfidence("nextAction", nextActionResult)]),
  ];
  if (aiConfidences.some((value) => value >= confidence.medium && value < confidence.high)) {
    uncertainties.push("Codexによる推定表示です");
  }
  return Object.freeze({
    origin: "codex",
    status,
    waitingOn,
    nextAction,
    confidence: Math.min(...confidences),
    evidence: Object.freeze(evidence),
    uncertainties: Object.freeze(uncertainties),
  });
}
