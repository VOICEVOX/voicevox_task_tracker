import type { ReducedCodexDecision } from "../../../codex/index.js";
import {
  aiAnalysisElementApplicationUsesAiValue,
  type AiAnalysisElementApplication,
} from "../../../domain/ai-analysis-elements.js";
import type {
  IssueStateDecision,
  PrimaryWaitingOn,
  PullRequestStateDecision,
  SourceId,
} from "../../../domain/index.js";
import { UnreachableError } from "../../../util/index.js";
import { latestUtcIsoDateTime } from "../../codex-input-projection.js";
import type { DeterministicItemAnalysis } from "../../initial-item-analysis.js";
import { sourceOccurredAtByIdForAnalysis } from "../relation-source-occurrence.js";
import { nonEmptySourceIds } from "../source-ids.js";

/** 判定の第一の待ち相手を返す。 */
export function primaryWaitingOnForDecision(
  deterministicDecision: IssueStateDecision | PullRequestStateDecision,
  decision: ReducedCodexDecision,
  application: AiAnalysisElementApplication,
): PrimaryWaitingOn {
  if (!aiAnalysisElementApplicationUsesAiValue(application)) {
    return deterministicDecision.primaryWaitingOn;
  }
  const selectionSource = (() => {
    switch (application.status) {
      case "current_ai":
        return "現在の入力で検証したAI判定";
      case "retained_ai":
        return "保持しているAI判定";
      case "unknown":
        return "適用元を確認できないAI判定";
      case "not_required":
      case "deterministic_fallback":
      case "unavailable":
      case "disabled":
        throw new TypeError("AIを適用していないwaitingOnからAI向けのprimaryを作成できません");
      default:
        throw new UnreachableError(application);
    }
  })();
  if (decision.waitingOn.length === 0) {
    return Object.freeze({
      index: "not_applicable",
      selectionReason: `${selectionSource}に待ち相手がないためprimaryはありません`,
    });
  }
  return Object.freeze({
    index: 0,
    selectionReason: `${selectionSource}が返した待ち相手の優先順でprimaryを選定しました`,
  });
}

/** 判定の状態遷移根拠を返す。 */
export function transitionBasisForDecision(
  analysis: DeterministicItemAnalysis,
  decision: ReducedCodexDecision,
): Readonly<{
  statusBasis: IssueStateDecision["statusBasis"];
  responsibilityBasis: IssueStateDecision["responsibilityBasis"];
}> {
  if (decision.origin === "deterministic") {
    return Object.freeze({
      statusBasis: analysis.decision.statusBasis,
      responsibilityBasis: analysis.decision.responsibilityBasis,
    });
  }
  const sourceIds = [
    ...decision.evidence.map((evidence) => evidence.sourceId),
    ...decision.waitingOn.flatMap((waitingOn) => waitingOn.sourceIds),
  ];
  const sourceOccurredAtById = sourceOccurredAtByIdForAnalysis(analysis);
  const resolvedOccurredAts = [...new Set(sourceIds)].flatMap((sourceId) => {
    const occurredAt = sourceOccurredAtById.get(sourceId);
    return occurredAt == null ? [] : [occurredAt];
  });
  const basisSourceIds =
    sourceIds.length === 0
      ? Object.freeze([analysis.item.sourceId] satisfies [SourceId])
      : nonEmptySourceIds(sourceIds, `Codex判定 ${analysis.item.nodeId}`);
  const basis = Object.freeze({
    sourceIds: basisSourceIds,
    occurredAt:
      resolvedOccurredAts.length === 0
        ? analysis.item.createdAt
        : latestUtcIsoDateTime(
            [analysis.item.createdAt, ...resolvedOccurredAts],
            `Codex判定 ${analysis.item.nodeId}`,
          ),
    precision: "inferred",
  });
  return Object.freeze({
    statusBasis: basis,
    responsibilityBasis: basis,
  });
}
