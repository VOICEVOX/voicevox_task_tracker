import { serializeCanonicalJson } from "../../../canonical-json/value.js";
import { createPersonalReminderCauseInputFingerprint } from "../../../codex/personal-reminder-input-assessment.js";
import { preparePersonalReminderAiBatch } from "../../../codex/personal-reminder-input-transport.js";
import { serializePersonalReminderAiInput } from "../../../codex/personal-reminder-input-transport-validation.js";
import type {
  PersonalReminderAiGeneration,
  PersonalReminderCauseId,
} from "../../../domain/personal-reminder-causes.js";
import { assertNonNullable } from "../../../util/index.js";
import {
  summarizeAiBudgetLedger,
  type AiBudgetLedgerSnapshot,
  type AiBudgetReservation,
} from "../contracts/ai-budget-ledger.js";
import { createPersonalReminderExecutedStageProof } from "../contracts/proofs.js";
import type { StageState } from "../contracts/run-core.js";
import type { ContentDigestPort } from "../contracts/content-digest-port.js";
import type {
  PersonalReminderCauseDecision,
  PersonalReminderPlannedBatch,
} from "./personal-reminder-plan-contracts.js";
import type { PersonalReminderPlannedRun } from "./personal-reminder-plan.js";

/** Codex portが返す計画済み原因の実行結果。 */
export type PersonalReminderBatchCauseResult =
  | Readonly<{
      causeId: PersonalReminderCauseId;
      status: "completed";
      generation: PersonalReminderAiGeneration;
    }>
  | Readonly<{
      causeId: PersonalReminderCauseId;
      status: "failed";
      reason: "execution_failed" | "semantic_validation_failed";
    }>
  | Readonly<{ causeId: PersonalReminderCauseId; status: "deferred"; reason: "call_limit" }>;

/** 個人催促のprocessと共有ledgerに接続する境界。 */
export type PersonalReminderExecutionPort = Readonly<{
  snapshot: () => AiBudgetLedgerSnapshot;
  ensureReady: () => Promise<void>;
  executePreflight: (reservation: AiBudgetReservation) => Promise<void>;
  executeBatch: (
    batch: PersonalReminderPlannedBatch,
  ) => Promise<readonly PersonalReminderBatchCauseResult[]>;
  release: (reservation: AiBudgetReservation) => void;
}>;

/** 一つの計画原因と実行結果の対応。 */
export type PersonalReminderExecutionOutcome =
  | Readonly<{ cause: PersonalReminderCauseDecision; status: "deterministic" | "snapshot_reuse" }>
  | Readonly<{
      cause: PersonalReminderCauseDecision;
      status: "cache_hit";
      generation: PersonalReminderAiGeneration;
    }>
  | Readonly<{
      cause: PersonalReminderCauseDecision;
      status: "completed";
      generation: PersonalReminderAiGeneration;
    }>
  | Readonly<{
      cause: PersonalReminderCauseDecision;
      status: "failed";
      reason: "execution_failed" | "semantic_validation_failed";
    }>
  | Readonly<{
      cause: PersonalReminderCauseDecision;
      status: "deferred";
      reason:
        Extract<PersonalReminderCauseDecision, { choice: "deferred" }>["reason"] | "call_limit";
    }>;

/** 原因別結果と更新済み共有ledgerを保持するrun。 */
export type PersonalReminderExecutedRun = StageState<
  "personal_reminder_executed",
  PersonalReminderPlannedRun["data"] &
    Readonly<{ outcomes: readonly PersonalReminderExecutionOutcome[] }>
>;

function assertPlannedLedger(
  planned: PersonalReminderPlannedRun,
  ledger: AiBudgetLedgerSnapshot,
): void {
  if (
    ledger.ledgerId !== planned.core.aiBudget.ledgerId ||
    ledger.sequence !== planned.core.aiBudget.sequence ||
    ledger.events.length !== planned.core.aiBudget.events.length ||
    ledger.events.some((event, index) => event !== planned.core.aiBudget.events[index]) ||
    ledger.reservations.length !== planned.core.aiBudget.reservations.length ||
    ledger.reservations.some(
      (reservation, index) => reservation !== planned.core.aiBudget.reservations[index],
    )
  ) {
    throw new TypeError("個人催促実行の共有ledgerが計画と一致しません");
  }
}

function assertCausePlan(planned: PersonalReminderPlannedRun, digest: ContentDigestPort): void {
  const causeIds = new Set<PersonalReminderCauseId>();
  for (const cause of planned.data.plan.causes) {
    if (causeIds.has(cause.causeId)) {
      throw new TypeError(`個人催促計画の原因IDが重複しています。対象: ${cause.causeId}`);
    }
    causeIds.add(cause.causeId);
    if (
      cause.exactInput.cause.causeId !== cause.causeId ||
      cause.exactInput.cause.itemNodeId !== cause.itemNodeId ||
      createPersonalReminderCauseInputFingerprint(cause.exactInput, digest) !== cause.fingerprint
    ) {
      throw new TypeError(`個人催促計画の原因入力が一致しません。対象: ${cause.causeId}`);
    }
  }
  const batchIds = new Set<string>();
  const plannedBatchCauseIds = new Set<PersonalReminderCauseId>();
  for (const batch of planned.data.plan.batches) {
    if (batchIds.has(batch.id) || batch.causeIds.length === 0) {
      throw new TypeError(`個人催促計画のbatch IDが重複または空です。対象: ${batch.id}`);
    }
    batchIds.add(batch.id);
    const inputCauseIds = batch.input.causes.map((cause) => cause.causeId);
    if (
      batch.id !== `personal-reminder-batch:${batch.batchInputFingerprint}` ||
      batch.normalizedInput !== serializePersonalReminderAiInput(batch.input) ||
      batch.inputCharacters !== Array.from(batch.normalizedInput).length ||
      batch.reservation.charge.inputCharacters !== batch.inputCharacters ||
      batch.reservation.kind !== "personal_initial" ||
      batch.reservation.ownerId !== batch.id ||
      batch.itemNodeId !== batch.input.item.nodeId ||
      digest.sha256Utf8(serializeCanonicalJson(batch.input)) !== batch.batchInputFingerprint ||
      inputCauseIds.length !== batch.causeIds.length ||
      inputCauseIds.some((id, index) => id !== batch.causeIds[index])
    ) {
      throw new TypeError(`個人催促計画のbatch入力が一致しません。対象: ${batch.id}`);
    }
    for (const causeId of batch.causeIds) {
      const cause = planned.data.plan.causes.find((value) => value.causeId === causeId);
      if (
        plannedBatchCauseIds.has(causeId) ||
        cause?.choice !== "execute" ||
        cause.batchId !== batch.id ||
        cause.itemNodeId !== batch.itemNodeId
      ) {
        throw new TypeError(`個人催促計画のbatch原因が一致しません。対象: ${causeId}`);
      }
      plannedBatchCauseIds.add(causeId);
    }
    const firstCause = planned.data.plan.causes.find(
      (value) => value.causeId === batch.causeIds[0],
    );
    assertNonNullable(firstCause, `個人催促計画の先頭原因がありません。対象: ${batch.id}`);
    const exactInputs = [
      firstCause.exactInput,
      ...batch.causeIds.slice(1).map((causeId) => {
        const cause = planned.data.plan.causes.find((value) => value.causeId === causeId);
        assertNonNullable(cause, `個人催促計画の原因がありません。対象: ${causeId}`);
        return cause.exactInput;
      }),
    ] satisfies Parameters<typeof preparePersonalReminderAiBatch>[0];
    const prepared = preparePersonalReminderAiBatch(exactInputs, digest);
    if (
      prepared.status !== "prepared" ||
      prepared.batch.normalizedInput !== batch.normalizedInput ||
      serializeCanonicalJson(
        [...prepared.batch.refs.items].sort(([left], [right]) => left.localeCompare(right)),
      ) !== serializeCanonicalJson(batch.refs.items) ||
      serializeCanonicalJson(
        [...prepared.batch.refs.relations].sort(([left], [right]) => left.localeCompare(right)),
      ) !== serializeCanonicalJson(batch.refs.relations) ||
      serializeCanonicalJson(
        [...prepared.batch.refs.sources].sort(([left], [right]) => left.localeCompare(right)),
      ) !== serializeCanonicalJson(batch.refs.sources)
    ) {
      throw new TypeError(`個人催促計画の厳密入力と輸送入力が一致しません。対象: ${batch.id}`);
    }
    const active = planned.core.aiBudget.reservations.find(
      (reservation) => reservation.id.sequence === batch.reservation.id.sequence,
    );
    if (
      active !== batch.reservation ||
      batch.reservation.id.ledgerId !== planned.core.aiBudget.ledgerId
    ) {
      throw new TypeError(`個人催促計画のbatch予約が一致しません。対象: ${batch.id}`);
    }
  }
  if (
    planned.data.plan.causes.some(
      (cause) => cause.choice === "execute" && !plannedBatchCauseIds.has(cause.causeId),
    )
  ) {
    throw new TypeError("個人催促計画の実行原因にbatchがありません");
  }
  const expectedReservationCount =
    planned.data.plan.batches.length + (planned.data.plan.preflightReservation == null ? 0 : 1);
  if (planned.core.aiBudget.reservations.length !== expectedReservationCount) {
    throw new TypeError("個人催促計画の予約件数が一致しません");
  }
  const preflight = planned.data.plan.preflightReservation;
  if (preflight != null) {
    if (
      planned.data.plan.batches.length === 0 ||
      preflight.kind !== "authentication_preflight" ||
      preflight.ownerId !== "authentication" ||
      !planned.core.aiBudget.reservations.includes(preflight)
    ) {
      throw new TypeError("個人催促計画の認証予約が一致しません");
    }
  }
}

function batchOutcomes(
  planned: PersonalReminderPlannedRun,
  batch: PersonalReminderPlannedBatch,
  results: readonly PersonalReminderBatchCauseResult[],
): readonly PersonalReminderExecutionOutcome[] {
  const expected = new Set(batch.causeIds);
  const seen = new Set<PersonalReminderCauseId>();
  const byCauseId = new Map<PersonalReminderCauseId, PersonalReminderBatchCauseResult>();
  for (const result of results) {
    if (!expected.has(result.causeId) || seen.has(result.causeId)) {
      throw new TypeError(
        `個人催促AIの結果原因が余分または重複しています。対象: ${result.causeId}`,
      );
    }
    seen.add(result.causeId);
    byCauseId.set(result.causeId, result);
  }
  if (results.length !== batch.causeIds.length) {
    throw new TypeError(`個人催促AIの結果原因が不足しています。対象: ${batch.id}`);
  }
  return Object.freeze(
    batch.causeIds.map((causeId) => {
      const cause = planned.data.plan.causes.find((value) => value.causeId === causeId);
      const result = byCauseId.get(causeId);
      assertNonNullable(cause, `個人催促計画の原因がありません。対象: ${causeId}`);
      assertNonNullable(result, `個人催促AIの結果原因がありません。対象: ${causeId}`);
      if (result.status === "completed") {
        if (
          result.generation.metadata.inputFingerprint !== cause.fingerprint ||
          result.generation.metadata.batchInputFingerprint !== batch.batchInputFingerprint
        ) {
          throw new TypeError(`個人催促AIの生成結果が計画入力と一致しません。対象: ${causeId}`);
        }
        return Object.freeze({ cause, status: "completed", generation: result.generation });
      }
      if (result.status === "failed") {
        return Object.freeze({ cause, status: "failed", reason: result.reason });
      }
      return Object.freeze({ cause, status: "deferred", reason: result.reason });
    }),
  );
}

/** 確定済み原因計画を一度だけ実行して原因別結果と共有ledgerを確定する。 */
export async function executePersonalReminders(
  planned: PersonalReminderPlannedRun,
  port: PersonalReminderExecutionPort,
  digest: ContentDigestPort,
): Promise<PersonalReminderExecutedRun> {
  assertCausePlan(planned, digest);
  assertPlannedLedger(planned, port.snapshot());
  const results = new Map<PersonalReminderCauseId, PersonalReminderExecutionOutcome>();
  const reservations = [
    ...(planned.data.plan.preflightReservation == null
      ? []
      : [planned.data.plan.preflightReservation]),
    ...planned.data.plan.batches.map((batch) => batch.reservation),
  ];
  try {
    if (planned.data.plan.batches.length !== 0) {
      await port.ensureReady();
      if (planned.data.plan.preflightReservation != null) {
        await port.executePreflight(planned.data.plan.preflightReservation);
        if (
          !port
            .snapshot()
            .events.some(
              (event) =>
                event.action === "consumed" &&
                event.reservation.id.sequence ===
                  planned.data.plan.preflightReservation?.id.sequence,
            )
        ) {
          throw new TypeError("個人催促AIの認証実試行が共有ledgerにありません");
        }
      }
      for (const batch of planned.data.plan.batches) {
        const outcomes = batchOutcomes(planned, batch, await port.executeBatch(batch));
        if (
          outcomes.some(
            (outcome) =>
              outcome.status === "completed" ||
              (outcome.status === "failed" && outcome.reason === "semantic_validation_failed"),
          ) &&
          !port
            .snapshot()
            .events.some(
              (event) =>
                event.action === "consumed" &&
                event.reservation.id.sequence === batch.reservation.id.sequence,
            )
        ) {
          throw new TypeError(
            `個人催促AIの実行結果に対応するprocess実試行がありません。対象: ${batch.id}`,
          );
        }
        for (const outcome of outcomes) {
          results.set(outcome.cause.causeId, outcome);
        }
      }
    }
  } finally {
    for (const reservation of reservations) port.release(reservation);
  }
  const outcomes = Object.freeze(
    planned.data.plan.causes.map((cause): PersonalReminderExecutionOutcome => {
      if (cause.choice === "execute") {
        const result = results.get(cause.causeId);
        assertNonNullable(result, `個人催促AIの実行結果がありません。対象: ${cause.causeId}`);
        return result;
      }
      if (cause.choice === "cache_hit") {
        return Object.freeze({ cause, status: "cache_hit", generation: cause.entry.generation });
      }
      if (cause.choice === "deferred") {
        return Object.freeze({ cause, status: "deferred", reason: cause.reason });
      }
      return Object.freeze({ cause, status: cause.choice });
    }),
  );
  const ledger = port.snapshot();
  if (ledger.ledgerId !== planned.core.aiBudget.ledgerId || ledger.reservations.length !== 0) {
    throw new TypeError("個人催促AI実行後の共有ledgerが不正です");
  }
  const batchIds = new Set(planned.data.plan.batches.map((batch) => batch.id));
  if (
    ledger.events.some(
      (event) =>
        event.sequence > planned.core.aiBudget.sequence &&
        event.action === "consumed" &&
        (event.reservation.kind.startsWith("personal_")
          ? !batchIds.has(event.reservation.ownerId)
          : event.reservation.kind.startsWith("authentication_preflight")
            ? planned.data.plan.preflightReservation == null
            : true),
    )
  ) {
    throw new TypeError("個人催促AIの実試行が計画外の所有者に計上されています");
  }
  const summary = summarizeAiBudgetLedger(ledger);
  if (summary.processAttemptCount > ledger.maxProcessAttempts) {
    throw new TypeError("個人催促AIのprocess実試行が予算を超えています");
  }
  return Object.freeze({
    stage: "personal_reminder_executed",
    core: Object.freeze({ ...planned.core, aiBudget: ledger }),
    data: Object.freeze({ ...planned.data, outcomes }),
    proof: createPersonalReminderExecutedStageProof(),
  });
}
