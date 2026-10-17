import type { AiRunBudget } from "../../../codex/budget.js";

const MICRO_USD_PER_USD = 1_000_000;

/** 一つのCodex process実試行が属する用途。 */
export type AiBudgetAttemptKind =
  | "authentication_preflight"
  | "authentication_preflight_transport_retry"
  | "generic_initial"
  | "generic_transport_retry"
  | "generic_semantic_correction"
  | "generic_semantic_correction_transport_retry"
  | "personal_initial"
  | "personal_transport_retry";

/** process実試行の入力と費用の見積。 */
export type AiBudgetCharge = Readonly<{
  inputCharacters: number;
  estimatedInputTokens: number;
  estimatedCostUsd: number;
}>;

/** 予約した実試行枠の識別子。 */
export type AiBudgetReservationId = Readonly<{
  ledgerId: string;
  sequence: number;
}>;

/** 実試行枠の予約。 */
export type AiBudgetReservation = Readonly<{
  id: AiBudgetReservationId;
  kind: AiBudgetAttemptKind;
  ownerId: string;
  charge: AiBudgetCharge;
}>;

/** AI予算の一遷移。 */
export type AiBudgetLedgerEvent = Readonly<{
  sequence: number;
  action: "reserved" | "consumed" | "released";
  reservation: AiBudgetReservation;
  charge: AiBudgetCharge;
}>;

/** 同じrunで共有する不変のAI予算履歴。 */
export type AiBudgetLedgerSnapshot = Readonly<{
  ledgerId: string;
  sequence: number;
  maxProcessAttempts: number;
  maxInputCharacters: number;
  maxEstimatedCostUsd: number;
  reservations: readonly AiBudgetReservation[];
  events: readonly AiBudgetLedgerEvent[];
}>;

/** 予算履歴から導出した利用量と残量。 */
export type AiBudgetLedgerSummary = Readonly<{
  logicalCandidateCount: number;
  processAttemptCount: number;
  authenticationPreflightAttemptCount: number;
  transportRetryCount: number;
  semanticCorrectionCount: number;
  inputCharacters: number;
  estimatedInputTokens: number;
  estimatedCostUsd: number;
  reservedProcessAttempts: number;
  reservedInputCharacters: number;
  reservedEstimatedCostUsd: number;
  remainingProcessAttempts: number;
  remainingInputCharacters: number;
  remainingEstimatedCostUsd: number;
}>;

function microUsd(value: number, rounding: "up" | "down"): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError("AI予算の見積費用は0以上の有限値にしてください");
  }
  const scaled = value * MICRO_USD_PER_USD;
  const rounded = rounding === "up" ? Math.ceil(scaled) : Math.floor(scaled);
  if (!Number.isSafeInteger(rounded)) {
    throw new RangeError("AI予算の見積費用が安全な範囲を超えています");
  }
  return rounded;
}

function validateCharge(charge: AiBudgetCharge): void {
  if (!Number.isSafeInteger(charge.inputCharacters) || charge.inputCharacters < 0) {
    throw new RangeError("AI入力文字数は0以上の安全な整数にしてください");
  }
  if (!Number.isSafeInteger(charge.estimatedInputTokens) || charge.estimatedInputTokens < 0) {
    throw new RangeError("AI入力token数は0以上の安全な整数にしてください");
  }
  microUsd(charge.estimatedCostUsd, "up");
}

/** run開始時の空のAI予算履歴を作る。 */
export function createInitialAiBudgetLedger(
  ledgerId: string,
  budget: Pick<
    AiRunBudget,
    "maxCodexExecAttemptsPerRun" | "maxTotalInputCharactersPerRun" | "maxEstimatedCostUsdPerRun"
  >,
): AiBudgetLedgerSnapshot & Readonly<{ sequence: 0 }> {
  if (ledgerId.length === 0) {
    throw new TypeError("AI予算のledger IDは空にできません");
  }
  if (
    !Number.isSafeInteger(budget.maxCodexExecAttemptsPerRun) ||
    budget.maxCodexExecAttemptsPerRun < 0
  ) {
    throw new RangeError("AI実試行上限は0以上の安全な整数にしてください");
  }
  if (
    !Number.isSafeInteger(budget.maxTotalInputCharactersPerRun) ||
    budget.maxTotalInputCharactersPerRun < 0
  ) {
    throw new RangeError("AI入力文字数上限は0以上の安全な整数にしてください");
  }
  microUsd(budget.maxEstimatedCostUsdPerRun, "down");
  return Object.freeze({
    ledgerId,
    sequence: 0,
    maxProcessAttempts: budget.maxCodexExecAttemptsPerRun,
    maxInputCharacters: budget.maxTotalInputCharactersPerRun,
    maxEstimatedCostUsd: budget.maxEstimatedCostUsdPerRun,
    reservations: Object.freeze([]),
    events: Object.freeze([]),
  });
}

/** 消費済みattemptと未使用予約からAI予算の残量を求める。 */
export function summarizeAiBudgetLedger(snapshot: AiBudgetLedgerSnapshot): AiBudgetLedgerSummary {
  const consumed = snapshot.events.filter((event) => event.action === "consumed");
  const ownerIds = new Set(
    consumed
      .filter(
        (event) =>
          event.reservation.kind === "generic_initial" ||
          event.reservation.kind === "personal_initial",
      )
      .map((event) => `${event.reservation.kind}:${event.reservation.ownerId}`),
  );
  const inputCharacters = consumed.reduce((sum, event) => sum + event.charge.inputCharacters, 0);
  const estimatedInputTokens = consumed.reduce(
    (sum, event) => sum + event.charge.estimatedInputTokens,
    0,
  );
  const consumedMicroUsd = consumed.reduce(
    (sum, event) => sum + microUsd(event.charge.estimatedCostUsd, "up"),
    0,
  );
  const reservedInputCharacters = snapshot.reservations.reduce(
    (sum, reservation) => sum + reservation.charge.inputCharacters,
    0,
  );
  const reservedMicroUsd = snapshot.reservations.reduce(
    (sum, reservation) => sum + microUsd(reservation.charge.estimatedCostUsd, "up"),
    0,
  );
  const maximumMicroUsd = microUsd(snapshot.maxEstimatedCostUsd, "down");
  return Object.freeze({
    logicalCandidateCount: ownerIds.size,
    processAttemptCount: consumed.length,
    authenticationPreflightAttemptCount: consumed.filter(
      (event) => event.reservation.kind === "authentication_preflight",
    ).length,
    transportRetryCount: consumed.filter((event) =>
      event.reservation.kind.endsWith("transport_retry"),
    ).length,
    semanticCorrectionCount: consumed.filter(
      (event) =>
        event.reservation.kind === "generic_semantic_correction" ||
        event.reservation.kind === "generic_semantic_correction_transport_retry",
    ).length,
    inputCharacters,
    estimatedInputTokens,
    estimatedCostUsd: consumedMicroUsd / MICRO_USD_PER_USD,
    reservedProcessAttempts: snapshot.reservations.length,
    reservedInputCharacters,
    reservedEstimatedCostUsd: reservedMicroUsd / MICRO_USD_PER_USD,
    remainingProcessAttempts:
      snapshot.maxProcessAttempts - consumed.length - snapshot.reservations.length,
    remainingInputCharacters:
      snapshot.maxInputCharacters - inputCharacters - reservedInputCharacters,
    remainingEstimatedCostUsd:
      (maximumMicroUsd - consumedMicroUsd - reservedMicroUsd) / MICRO_USD_PER_USD,
  });
}

function canReserve(snapshot: AiBudgetLedgerSnapshot, charge: AiBudgetCharge): boolean {
  const summary = summarizeAiBudgetLedger(snapshot);
  const committedMicroUsd = snapshot.events
    .filter((event) => event.action === "consumed")
    .reduce((sum, event) => sum + microUsd(event.charge.estimatedCostUsd, "up"), 0);
  const reservedMicroUsd = snapshot.reservations.reduce(
    (sum, reservation) => sum + microUsd(reservation.charge.estimatedCostUsd, "up"),
    0,
  );
  return (
    summary.remainingProcessAttempts >= 1 &&
    summary.remainingInputCharacters >= charge.inputCharacters &&
    microUsd(snapshot.maxEstimatedCostUsd, "down") - committedMicroUsd - reservedMicroUsd >=
      microUsd(charge.estimatedCostUsd, "up")
  );
}

/** process実試行の枠を事前に予約する。 */
export function reserveAiBudgetAttempt(
  snapshot: AiBudgetLedgerSnapshot,
  kind: AiBudgetAttemptKind,
  ownerId: string,
  charge: AiBudgetCharge,
): Readonly<{ snapshot: AiBudgetLedgerSnapshot; reservation: AiBudgetReservation }> | undefined {
  validateCharge(charge);
  if (ownerId.length === 0) {
    throw new TypeError("AI実試行の所有IDは空にできません");
  }
  if (!canReserve(snapshot, charge)) {
    return undefined;
  }
  const sequence = snapshot.sequence + 1;
  const reservation = Object.freeze({
    id: Object.freeze({ ledgerId: snapshot.ledgerId, sequence }),
    kind,
    ownerId,
    charge: Object.freeze({ ...charge }),
  });
  const event = Object.freeze({
    sequence,
    action: "reserved" as const,
    reservation,
    charge: reservation.charge,
  });
  return Object.freeze({
    reservation,
    snapshot: Object.freeze({
      ...snapshot,
      sequence,
      reservations: Object.freeze([...snapshot.reservations, reservation]),
      events: Object.freeze([...snapshot.events, event]),
    }),
  });
}

function activeReservation(
  snapshot: AiBudgetLedgerSnapshot,
  id: AiBudgetReservationId,
): AiBudgetReservation {
  if (id.ledgerId !== snapshot.ledgerId) {
    throw new TypeError("AI予約のledger IDが一致しません");
  }
  const reservation = snapshot.reservations.find((value) => value.id.sequence === id.sequence);
  if (reservation == null) {
    throw new TypeError("AI予約が有効ではありません");
  }
  return reservation;
}

function settleAiBudgetAttempt(
  snapshot: AiBudgetLedgerSnapshot,
  id: AiBudgetReservationId,
  action: "consumed" | "released",
  charge: AiBudgetCharge,
): AiBudgetLedgerSnapshot {
  const reservation = activeReservation(snapshot, id);
  validateCharge(charge);
  const sequence = snapshot.sequence + 1;
  return Object.freeze({
    ...snapshot,
    sequence,
    reservations: Object.freeze(snapshot.reservations.filter((value) => value !== reservation)),
    events: Object.freeze([
      ...snapshot.events,
      Object.freeze({ sequence, action, reservation, charge: Object.freeze({ ...charge }) }),
    ]),
  });
}

/** 実際のprocess入力で予約を消費する。 */
export function consumeAiBudgetAttempt(
  snapshot: AiBudgetLedgerSnapshot,
  id: AiBudgetReservationId,
  actualCharge: AiBudgetCharge,
): AiBudgetLedgerSnapshot | undefined {
  const reservation = activeReservation(snapshot, id);
  const released = Object.freeze({
    ...snapshot,
    reservations: Object.freeze(snapshot.reservations.filter((value) => value !== reservation)),
  });
  validateCharge(actualCharge);
  const remaining = summarizeAiBudgetLedger(released);
  const committedMicroUsd = released.events
    .filter((event) => event.action === "consumed")
    .reduce((sum, event) => sum + microUsd(event.charge.estimatedCostUsd, "up"), 0);
  const reservedMicroUsd = released.reservations.reduce(
    (sum, value) => sum + microUsd(value.charge.estimatedCostUsd, "up"),
    0,
  );
  if (
    remaining.remainingInputCharacters < actualCharge.inputCharacters ||
    microUsd(snapshot.maxEstimatedCostUsd, "down") - committedMicroUsd - reservedMicroUsd <
      microUsd(actualCharge.estimatedCostUsd, "up")
  ) {
    return undefined;
  }
  return settleAiBudgetAttempt(snapshot, id, "consumed", actualCharge);
}

/** 実行されなかった予約を明示的に解放する。 */
export function releaseAiBudgetAttempt(
  snapshot: AiBudgetLedgerSnapshot,
  id: AiBudgetReservationId,
): AiBudgetLedgerSnapshot {
  return settleAiBudgetAttempt(
    snapshot,
    id,
    "released",
    Object.freeze({ inputCharacters: 0, estimatedInputTokens: 0, estimatedCostUsd: 0 }),
  );
}
