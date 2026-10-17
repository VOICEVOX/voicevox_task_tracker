import {
  consumeAiBudgetAttempt,
  createInitialAiBudgetLedger,
  releaseAiBudgetAttempt,
  reserveAiBudgetAttempt,
  summarizeAiBudgetLedger,
  type AiBudgetLedgerSnapshot,
  type AiBudgetLedgerSummary,
} from "../contracts/ai-budget-ledger.js";
import { RunCompletenessError } from "./run-completeness-error.js";
import { assertRunValueMatches } from "./run-validation-compare.js";

/** 共有AI予算の全遷移を再生して残量と実試行数を確認する。 */
export function assertAiBudgetLedgerMatches(ledger: AiBudgetLedgerSnapshot): AiBudgetLedgerSummary {
  try {
    let current: AiBudgetLedgerSnapshot = createInitialAiBudgetLedger(ledger.ledgerId, {
      maxCodexExecAttemptsPerRun: ledger.maxProcessAttempts,
      maxTotalInputCharactersPerRun: ledger.maxInputCharacters,
      maxEstimatedCostUsdPerRun: ledger.maxEstimatedCostUsd,
    });
    for (const [index, event] of ledger.events.entries()) {
      if (event.sequence !== index + 1 || event.reservation.id.ledgerId !== ledger.ledgerId) {
        throw new RunCompletenessError(
          "ledger_mismatch",
          ledger.ledgerId,
          ["core", "aiBudget", "events", index],
          undefined,
        );
      }
      if (event.action === "reserved") {
        const reserved = reserveAiBudgetAttempt(
          current,
          event.reservation.kind,
          event.reservation.ownerId,
          event.charge,
        );
        if (reserved == null) {
          throw new RunCompletenessError(
            "ledger_mismatch",
            ledger.ledgerId,
            ["core", "aiBudget", "events", index],
            undefined,
          );
        }
        assertRunValueMatches(
          event.reservation,
          reserved.reservation,
          ["core", "aiBudget", "events", index, "reservation"],
          ledger.ledgerId,
        );
        current = reserved.snapshot;
      } else if (event.action === "consumed") {
        const consumed = consumeAiBudgetAttempt(current, event.reservation.id, event.charge);
        if (consumed == null) {
          throw new RunCompletenessError(
            "ledger_mismatch",
            ledger.ledgerId,
            ["core", "aiBudget", "events", index],
            undefined,
          );
        }
        current = consumed;
      } else {
        current = releaseAiBudgetAttempt(current, event.reservation.id);
      }
      assertRunValueMatches(
        event,
        current.events[index],
        ["core", "aiBudget", "events", index],
        ledger.ledgerId,
      );
    }
    assertRunValueMatches(ledger, current, ["core", "aiBudget"], ledger.ledgerId);
    if (current.reservations.length > 0) {
      throw new RunCompletenessError(
        "ledger_mismatch",
        ledger.ledgerId,
        ["core", "aiBudget", "reservations"],
        undefined,
      );
    }
    return summarizeAiBudgetLedger(current);
  } catch (cause: unknown) {
    if (cause instanceof RunCompletenessError) throw cause;
    throw new RunCompletenessError(
      "ledger_mismatch",
      ledger.ledgerId,
      ["core", "aiBudget"],
      undefined,
      cause,
    );
  }
}
