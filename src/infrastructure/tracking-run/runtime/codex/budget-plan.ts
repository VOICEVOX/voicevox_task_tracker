import type { AiBudgetCharge } from "../../../../application/tracking-run/contracts/ai-budget-ledger.js";
import type { GenericAiBudgetPlan } from "../../../../application/tracking-run/stages/generic-ai-budget-plan.js";
import type { PreparedAiAnalysisCandidate } from "../../../../codex/analysis-selection.js";
import {
  type CodexAttemptBudget,
  type CodexInitialAttemptTicket,
} from "../../../../codex/attempt-budget.js";
import {
  createEmptyAiBudgetUsage,
  estimateAiInputCost,
  planAiAnalysisBudget,
  planAiAnalysisBudgetWithPreflight,
  type AiAnalysisDeferReason,
  type AiRunBudget,
} from "../../../../codex/budget.js";

function candidateCharge(
  candidate: PreparedAiAnalysisCandidate,
  inputCostUsdPerMillionTokens: number,
): AiBudgetCharge {
  const cost = estimateAiInputCost(candidate.normalizedInput, inputCostUsdPerMillionTokens);
  if (
    Array.from(candidate.normalizedInput).length !== candidate.inputCharacters ||
    cost.estimatedCostUsd !== candidate.estimatedCostUsd
  ) {
    throw new TypeError(`汎用AI候補の予約費用が輸送入力と一致しません。対象: ${candidate.id}`);
  }
  return Object.freeze({
    inputCharacters: candidate.inputCharacters,
    estimatedInputTokens: cost.estimatedInputTokens,
    estimatedCostUsd: cost.estimatedCostUsd,
  });
}

/** miss専用の輸送入力で配分し、初回試行と認証preflightを予約する。 */
export function reserveGenericAiBudget(
  candidates: readonly PreparedAiAnalysisCandidate[],
  budget: AiRunBudget,
  inputCostUsdPerMillionTokens: number,
  attemptBudget: CodexAttemptBudget,
  preflightCharge: AiBudgetCharge | undefined,
): GenericAiBudgetPlan {
  const planned =
    preflightCharge == null
      ? planAiAnalysisBudget(candidates, budget, createEmptyAiBudgetUsage())
      : planAiAnalysisBudgetWithPreflight(
          candidates,
          budget,
          createEmptyAiBudgetUsage(),
          preflightCharge,
        );
  const selected: { candidateId: string; ticket: CodexInitialAttemptTicket }[] = [];
  const deferred: { candidateId: string; reason: AiAnalysisDeferReason }[] = planned.deferred.map(
    (value) => ({ candidateId: value.candidate.id, reason: value.reason }),
  );
  let preflightTicket: CodexInitialAttemptTicket | undefined;
  for (const [index, candidate] of planned.selected.entries()) {
    const ticket = attemptBudget.reserveInitialAttempt(
      "generic_initial",
      candidate.id,
      candidateCharge(candidate, inputCostUsdPerMillionTokens),
    );
    if (ticket == null) {
      if (index === 0 && preflightCharge != null) {
        for (const remaining of planned.selected) {
          deferred.push({ candidateId: remaining.id, reason: "call_limit" });
        }
        break;
      }
      deferred.push({ candidateId: candidate.id, reason: "call_limit" });
      continue;
    }
    if (index === 0 && preflightCharge != null) {
      preflightTicket = attemptBudget.reserveInitialAttempt(
        "authentication_preflight",
        "authentication",
        preflightCharge,
      );
      if (preflightTicket == null) {
        attemptBudget.releaseInitialAttempt(ticket);
        for (const remaining of planned.selected) {
          deferred.push({ candidateId: remaining.id, reason: "call_limit" });
        }
        break;
      }
    }
    selected.push(Object.freeze({ candidateId: candidate.id, ticket }));
  }
  const result = Object.freeze({
    selected: Object.freeze(selected),
    deferred: Object.freeze(deferred.map((value) => Object.freeze(value))),
    ledger: attemptBudget.snapshot,
  });
  if (preflightTicket == null) {
    return result;
  }
  if (preflightCharge == null) {
    throw new TypeError("汎用AIの認証preflight予約に費用がありません");
  }
  return Object.freeze({ ...result, preflightTicket, preflightCharge });
}
