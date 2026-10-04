import {
  consumeAiBudgetAttempt,
  releaseAiBudgetAttempt,
  reserveAiBudgetAttempt,
  summarizeAiBudgetLedger,
  type AiBudgetAttemptKind,
  type AiBudgetCharge,
  type AiBudgetLedgerSnapshot,
  type AiBudgetReservationId,
} from "../application/tracking-run/contracts/ai-budget-ledger.js";
import { TaskTrackerError } from "../util/task-tracker-error.js";
import type { AiBudgetCandidate, AiPreflightBudget } from "./budget.js";

/** Codex execの初回試行用に予約した枠。 */
export type CodexInitialAttemptTicket = Readonly<{ id: AiBudgetReservationId }>;

/** Codex execの実試行枠がないことを表す。 */
export class CodexAttemptBudgetExceededError extends TaskTrackerError {
  public constructor() {
    super("Codex execのrun予算に実試行枠がありません", {});
  }
}

/** 一つのrunの不変ledger snapshotを順に保持する。 */
export class CodexAttemptBudget {
  readonly #maxAttempts: number;
  #snapshot: AiBudgetLedgerSnapshot | undefined;

  public constructor(maxAttempts: number) {
    if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 0) {
      throw new RangeError("Codex execのrun実試行上限は0以上の安全な整数にしてください");
    }
    this.#maxAttempts = maxAttempts;
  }

  /** PreparedRunのledgerを一度だけ結合する。 */
  public bind(snapshot: AiBudgetLedgerSnapshot): void {
    if (this.#snapshot != null) {
      throw new TypeError("AI予算ledgerは既に結合されています");
    }
    if (snapshot.sequence !== 0 || snapshot.maxProcessAttempts !== this.#maxAttempts) {
      throw new TypeError("AI予算ledgerの初期状態が実行設定と一致しません");
    }
    this.#snapshot = snapshot;
  }

  /** 現在の不変ledger snapshotを返す。 */
  public get snapshot(): AiBudgetLedgerSnapshot {
    if (this.#snapshot == null) {
      throw new TypeError("AI予算ledgerが準備されていません");
    }
    return this.#snapshot;
  }

  /** ledger eventからprocess実試行数を返す。 */
  public get attemptCount(): number {
    return this.#snapshot == null ? 0 : summarizeAiBudgetLedger(this.#snapshot).processAttemptCount;
  }

  /** 確定済み個人催促計画の予約を共有ledgerへ取り込む。 */
  public adoptPlannedSnapshot(planned: AiBudgetLedgerSnapshot): void {
    const current = this.snapshot;
    if (
      current.ledgerId !== planned.ledgerId ||
      current.maxProcessAttempts !== planned.maxProcessAttempts ||
      current.maxInputCharacters !== planned.maxInputCharacters ||
      current.maxEstimatedCostUsd !== planned.maxEstimatedCostUsd ||
      current.reservations.length !== 0 ||
      planned.events.length < current.events.length ||
      current.events.some((event, index) => planned.events[index] !== event) ||
      planned.sequence < current.sequence
    ) {
      throw new TypeError("個人催促計画のAI予算ledgerが現在の履歴と一致しません");
    }
    this.#snapshot = planned;
  }

  /** 初回process実試行を予約する。 */
  public reserveInitialAttempt(
    kind: "authentication_preflight" | "generic_initial" | "personal_initial",
    ownerId: string,
    charge: AiBudgetCharge,
  ): CodexInitialAttemptTicket | undefined {
    const reserved = reserveAiBudgetAttempt(this.snapshot, kind, ownerId, charge);
    if (reserved == null) {
      return undefined;
    }
    this.#snapshot = reserved.snapshot;
    return Object.freeze({ id: reserved.reservation.id });
  }

  /** 初回processを開始しなかった予約を解放する。 */
  public releaseInitialAttempt(ticket: CodexInitialAttemptTicket): void {
    if (ticket.id.ledgerId !== this.snapshot.ledgerId) {
      throw new TypeError("Codex execの初回試行ticketがこのrunに属しません");
    }
    const active = this.snapshot.reservations.some(
      (value) => value.id.sequence === ticket.id.sequence,
    );
    if (active) {
      this.#snapshot = releaseAiBudgetAttempt(this.snapshot, ticket.id);
      return;
    }
    const consumed = this.snapshot.events.some(
      (event) =>
        event.action === "consumed" && event.reservation.id.sequence === ticket.id.sequence,
    );
    if (!consumed) {
      throw new TypeError("Codex execの初回試行ticketが有効ではありません");
    }
  }

  /** processRunnerを呼ぶ直前に入力と費用を含む実試行を計上する。 */
  public beginAttempt(
    ticket: CodexInitialAttemptTicket | undefined,
    kind: AiBudgetAttemptKind,
    ownerId: string,
    actualCharge: AiBudgetCharge,
  ): void {
    if (ticket != null && ticket.id.ledgerId !== this.snapshot.ledgerId) {
      throw new TypeError("Codex execの初回試行ticketがこのrunに属しません");
    }
    const active =
      ticket == null
        ? undefined
        : this.snapshot.reservations.find((value) => value.id.sequence === ticket.id.sequence);
    if (ticket != null && active == null) {
      throw new TypeError("Codex execの初回試行ticketが有効ではありません");
    }
    if (active != null && (active.kind !== kind || active.ownerId !== ownerId)) {
      throw new TypeError("Codex execの予約対象または用途が実試行と一致しません");
    }
    if (active != null) {
      const consumed = consumeAiBudgetAttempt(this.snapshot, active.id, actualCharge);
      if (consumed == null) {
        throw new CodexAttemptBudgetExceededError();
      }
      this.#snapshot = consumed;
      return;
    }
    const reserved = reserveAiBudgetAttempt(this.snapshot, kind, ownerId, actualCharge);
    if (reserved == null) {
      throw new CodexAttemptBudgetExceededError();
    }
    this.#snapshot = reserved.snapshot;
    const consumed = consumeAiBudgetAttempt(this.snapshot, reserved.reservation.id, actualCharge);
    if (consumed == null) {
      throw new TypeError("直前に予約したAI実試行を消費できません");
    }
    this.#snapshot = consumed;
  }
}

function candidateCharge(candidate: AiBudgetCandidate): AiBudgetCharge {
  return Object.freeze({
    inputCharacters: candidate.inputCharacters,
    estimatedInputTokens: Math.ceil(candidate.inputCharacters / 4),
    estimatedCostUsd: candidate.estimatedCostUsd,
  });
}

/** 優先順の候補へ初回試行枠を配り、必要な場合だけ認証preflightを実行する。 */
export async function prepareCodexInitialAttempts<Candidate extends AiBudgetCandidate>(
  candidates: readonly Candidate[],
  budget: CodexAttemptBudget,
  ensureReady: () => Promise<void>,
  kind: "generic_initial" | "personal_initial",
  preflight:
    | Readonly<
        AiPreflightBudget & { execute: (ticket: CodexInitialAttemptTicket) => Promise<void> }
      >
    | undefined,
): Promise<
  Readonly<{
    selected: readonly Readonly<{ candidate: Candidate; ticket: CodexInitialAttemptTicket }>[];
    deferred: readonly Candidate[];
    authenticationPreflightExecuted: boolean;
  }>
> {
  if (candidates.length === 0) {
    return Object.freeze({
      selected: Object.freeze([]),
      deferred: Object.freeze([]),
      authenticationPreflightExecuted: false,
    });
  }
  const selected: { candidate: Candidate; ticket: CodexInitialAttemptTicket }[] = [];
  const deferred: Candidate[] = [];
  const first = candidates[0];
  if (first == null) {
    throw new TypeError("Codex初回候補がありません");
  }
  if (preflight != null) {
    const firstTicket = budget.reserveInitialAttempt(kind, first.id, candidateCharge(first));
    if (firstTicket == null) {
      return Object.freeze({
        selected: Object.freeze([]),
        deferred: Object.freeze([...candidates]),
        authenticationPreflightExecuted: false,
      });
    }
    const preflightTicket = budget.reserveInitialAttempt(
      "authentication_preflight",
      "authentication",
      Object.freeze({
        inputCharacters: preflight.inputCharacters,
        estimatedInputTokens: Math.ceil(preflight.inputCharacters / 4),
        estimatedCostUsd: preflight.estimatedCostUsd,
      }),
    );
    if (preflightTicket == null) {
      budget.releaseInitialAttempt(firstTicket);
      return Object.freeze({
        selected: Object.freeze([]),
        deferred: Object.freeze([...candidates]),
        authenticationPreflightExecuted: false,
      });
    }
    try {
      await ensureReady();
      await preflight.execute(preflightTicket);
    } catch (error: unknown) {
      budget.releaseInitialAttempt(firstTicket);
      throw error;
    } finally {
      budget.releaseInitialAttempt(preflightTicket);
    }
    selected.push({ candidate: first, ticket: firstTicket });
  }
  for (const candidate of candidates.slice(preflight == null ? 0 : 1)) {
    const ticket = budget.reserveInitialAttempt(kind, candidate.id, candidateCharge(candidate));
    if (ticket == null) {
      deferred.push(candidate);
    } else {
      selected.push({ candidate, ticket });
    }
  }
  if (preflight == null && selected.length > 0) {
    try {
      await ensureReady();
    } catch (error: unknown) {
      for (const value of selected) {
        budget.releaseInitialAttempt(value.ticket);
      }
      throw error;
    }
  }
  return Object.freeze({
    selected: Object.freeze(selected.map((value) => Object.freeze(value))),
    deferred: Object.freeze(deferred),
    authenticationPreflightExecuted: preflight != null,
  });
}
