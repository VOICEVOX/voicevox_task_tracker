import { TaskTrackerError } from "../util/task-tracker-error.js";

/** Codex execの初回試行用に予約した枠。 */
export type CodexInitialAttemptTicket = Readonly<{
  id: symbol;
}>;

/** Codex execの実試行枠がないことを表す。 */
export class CodexAttemptBudgetExceededError extends TaskTrackerError {
  public constructor() {
    super("Codex execのrun実試行上限に達しました", {});
  }
}

/** 一つのrunで共有するCodex exec実試行予算。 */
export class CodexAttemptBudget {
  readonly #maxAttempts: number;
  readonly #tickets = new Map<CodexInitialAttemptTicket, "reserved" | "consumed">();
  #attemptCount = 0;

  public constructor(maxAttempts: number) {
    if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 0) {
      throw new RangeError("Codex execのrun実試行上限は0以上の安全な整数にしてください");
    }
    this.#maxAttempts = maxAttempts;
  }

  /** processRunnerへ渡したCodex execの実試行数を返す。 */
  public get attemptCount(): number {
    return this.#attemptCount;
  }

  /** 初回試行の枠を指定数だけ原子的に予約する。 */
  public reserveInitialAttempts(count: number): readonly CodexInitialAttemptTicket[] | undefined {
    if (!Number.isSafeInteger(count) || count <= 0) {
      throw new RangeError("Codex execの予約枠数は正の安全な整数にしてください");
    }
    if (this.#attemptCount + this.#reservedCount() + count > this.#maxAttempts) {
      return undefined;
    }
    const tickets = Array.from({ length: count }, () => Object.freeze({ id: Symbol() }));
    for (const ticket of tickets) {
      this.#tickets.set(ticket, "reserved");
    }
    return Object.freeze(tickets);
  }

  /** 未使用の初回試行枠を解放する。 */
  public releaseInitialAttempt(ticket: CodexInitialAttemptTicket): void {
    const status = this.#tickets.get(ticket);
    if (status == null) {
      throw new TypeError("Codex execの初回試行ticketがこのrunに属しません");
    }
    this.#tickets.delete(ticket);
  }

  /** processRunner呼び出し直前に一つの実試行を計上する。 */
  public beginAttempt(ticket: CodexInitialAttemptTicket | undefined): void {
    if (ticket != null) {
      const status = this.#tickets.get(ticket);
      if (status == null) {
        throw new TypeError("Codex execの初回試行ticketが有効ではありません");
      }
      if (status === "reserved") {
        this.#tickets.set(ticket, "consumed");
        this.#attemptCount += 1;
        return;
      }
    }
    if (this.#attemptCount + this.#reservedCount() >= this.#maxAttempts) {
      throw new CodexAttemptBudgetExceededError();
    }
    this.#attemptCount += 1;
  }

  #reservedCount(): number {
    let count = 0;
    for (const status of this.#tickets.values()) {
      if (status === "reserved") {
        count += 1;
      }
    }
    return count;
  }
}

/** 優先順の候補へ初回試行枠を配り、必要なら認証preflightを実行する。 */
export async function prepareCodexInitialAttempts<Candidate>(
  candidates: readonly Candidate[],
  budget: CodexAttemptBudget,
  ensureReady: () => Promise<void>,
  preflight: ((ticket: CodexInitialAttemptTicket) => Promise<void>) | undefined,
): Promise<
  Readonly<{
    selected: readonly Readonly<{
      candidate: Candidate;
      ticket: CodexInitialAttemptTicket;
    }>[];
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
  let nextIndex = 0;
  if (preflight != null) {
    const tickets = budget.reserveInitialAttempts(2);
    if (tickets == null) {
      return Object.freeze({
        selected: Object.freeze([]),
        deferred: Object.freeze([...candidates]),
        authenticationPreflightExecuted: false,
      });
    }
    const candidateTicket = tickets[0];
    const preflightTicket = tickets[1];
    const candidate = candidates[0];
    if (candidateTicket == null || preflightTicket == null || candidate == null) {
      throw new TypeError("Codex execの初回試行ticketを確保できませんでした");
    }
    try {
      await ensureReady();
      await preflight(preflightTicket);
    } catch (error: unknown) {
      budget.releaseInitialAttempt(candidateTicket);
      throw error;
    } finally {
      budget.releaseInitialAttempt(preflightTicket);
    }
    selected.push({ candidate, ticket: candidateTicket });
    nextIndex = 1;
  }

  for (const candidate of candidates.slice(nextIndex)) {
    const ticket = budget.reserveInitialAttempts(1)?.[0];
    if (ticket == null) {
      deferred.push(candidate);
      continue;
    }
    selected.push({ candidate, ticket });
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
