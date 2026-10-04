import type { AiAnalysisDeferReason } from "../../../codex/budget.js";
import type {
  AiBudgetCharge,
  AiBudgetLedgerSnapshot,
  AiBudgetReservationId,
} from "../contracts/ai-budget-ledger.js";

/** 汎用AI計画で予約したprocess枠の識別子。 */
export type GenericAiAttemptTicket = Readonly<{ id: AiBudgetReservationId }>;

/** 汎用AI計画で予約したprocess枠と延期候補。 */
export type GenericAiBudgetPlan = Readonly<{
  selected: readonly Readonly<{ candidateId: string; ticket: GenericAiAttemptTicket }>[];
  deferred: readonly Readonly<{ candidateId: string; reason: AiAnalysisDeferReason }>[];
  preflightTicket?: GenericAiAttemptTicket;
  preflightCharge?: AiBudgetCharge;
  ledger: AiBudgetLedgerSnapshot;
}>;
