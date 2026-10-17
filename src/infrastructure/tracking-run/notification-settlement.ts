import type {
  NotificationCasOutcome,
  NotificationHttpOutcome,
} from "./notification-recovery-contracts.js";
import type {
  NotificationSettlementInput,
  NotificationSettlementPreflightInput,
  NotificationSettlementPort,
  NotificationSettlementOutcome,
  SettledMessageReceipt,
} from "./notification-settlement-contracts.js";
import { randomUUID } from "node:crypto";

import { ZodError } from "zod";

import {
  parseInitialPagesPublicationEvidence,
  type InitialPagesPublicationEvidence,
} from "../../application/tracking-run/initial-pages-evidence-codec.js";
import type { StateCommitReceiptEvidence } from "../../application/tracking-run/observed-state-commit.js";
import type { ReceiptChainEvidence } from "../../application/tracking-run/receipt-chain-schema.js";
import { verifyReceiptChain } from "../../application/tracking-run/receipt-chain.js";
import { parseReceipt } from "../../application/tracking-run/receipt-codec.js";
import type {
  PagesDeploymentReceipt,
  Receipt,
} from "../../application/tracking-run/receipt-schema.js";
import { serializeCanonicalJson } from "../../canonical-json/value.js";
import {
  StateBranchConflictError,
  StateFormatError,
  StateHistoryError,
} from "../../persistence/errors.js";
import { loadStateNotificationLedgers } from "../../persistence/state-ledger-files.js";
import { exactStateValidationSession } from "../../persistence/exact-state-validation-session.js";
import { parseDurablePublicationRecord } from "../../publication/durable-record-schema.js";
import { nodeContentDigestPort as digest } from "./content-digest.js";
import { verifyInitialStateCommitReceiptAtRevision } from "./initial-pages-source.js";
import { verifyManualResolutionReceipt } from "./manual-resolution.js";
import { prepareNotificationMessageContext } from "./notification-message-context.js";
import { deliverNotificationMessage } from "./notification-message-delivery.js";
import { validatePagesSource } from "./notification-message-receipt.js";
import {
  readNotificationMessageState,
  type NotificationMessageState,
} from "./notification-message-state.js";
import { restoreNotificationReceiptHistory } from "./notification-receipt-history.js";
import { classifyNotificationRecovery } from "./notification-recovery.js";
import { commitNotificationSettlement } from "./notification-settlement-commit.js";
import {
  assertNextReceipt,
  receiptForSettlement,
  settledRevision,
} from "./notification-settlement-observation.js";
import {
  assertInitialNotificationLedger,
  plannedNotificationMessages,
} from "./notification-settlement-validation.js";
import { NotificationStructureError } from "./notification-structure-error.js";

/** 通知stageの失敗結果と元の診断をCLI境界へ渡す。 */
export class NotificationSettlementFailureError extends Error {
  public readonly outcome: Exclude<NotificationSettlementOutcome, { kind: "settled" }>;

  public constructor(outcome: Exclude<NotificationSettlementOutcome, { kind: "settled" }>) {
    let cause: Error | undefined;
    if (outcome.kind === "structural_failure") {
      cause = outcome.cause;
    } else if (outcome.kind === "state_unconfirmed") {
      cause = outcome.observationError;
    }
    super(`通知settlementを確定できません。状態: ${outcome.kind}`, {
      cause,
    });
    this.name = "NotificationSettlementFailureError";
    this.outcome = outcome;
  }
}

interface NotificationSettlementProgress {
  messageReceipts: SettledMessageReceipt[];
  previousReceipt: Receipt | undefined;
  pagesReceipt: PagesDeploymentReceipt | undefined;
  pagesEvidence: InitialPagesPublicationEvidence | undefined;
}

function invalidPagesSource(cause: unknown): never {
  if (cause instanceof NotificationStructureError) {
    throw cause;
  }
  if (cause instanceof TypeError || cause instanceof ZodError) {
    throw new NotificationStructureError("通知settlementの初回Pages証拠が不正です", "no_effect", {
      cause,
    });
  }
  throw cause;
}

async function structuralFailure(
  input: Pick<NotificationSettlementInput, "record" | "initialStateReceipt">,
  port: NotificationSettlementPort,
  progress: NotificationSettlementProgress,
  cause: NotificationStructureError,
): Promise<NotificationSettlementOutcome> {
  const observed = await classifyNotificationRecovery(
    {
      record: input.record,
      initialStateReceipt: input.initialStateReceipt,
      ...(progress.pagesReceipt == null ? {} : { pagesReceipt: progress.pagesReceipt }),
      ...(progress.pagesEvidence == null ? {} : { pagesEvidence: progress.pagesEvidence }),
      ...(progress.previousReceipt == null
        ? {}
        : { lastVerifiedReceipt: progress.previousReceipt }),
      casOutcome: cause.casOutcome,
      httpOutcome: cause.httpOutcome,
    },
    port.adapter,
    port.configuration,
  );
  return {
    kind: "structural_failure",
    messageReceipts: progress.messageReceipts,
    ...observed,
    ...(progress.previousReceipt == null ? {} : { lastReceipt: progress.previousReceipt }),
    failedOperationEffectCertainty: cause.effectCertainty,
    cause,
  };
}

async function stateUnconfirmedFailure(
  input: NotificationSettlementInput,
  port: NotificationSettlementPort,
  progress: NotificationSettlementProgress,
  effectCertainty: "no_effect" | "committed" | "ambiguous",
  casOutcome: NotificationCasOutcome,
  httpOutcome: NotificationHttpOutcome,
  discordMessageId: string | undefined,
): Promise<NotificationSettlementOutcome> {
  const observed = await classifyNotificationRecovery(
    {
      record: input.record,
      initialStateReceipt: input.initialStateReceipt,
      pagesReceipt: input.pagesReceipt,
      pagesEvidence: input.initialPages.evidence,
      ...(progress.previousReceipt == null
        ? {}
        : { lastVerifiedReceipt: progress.previousReceipt }),
      casOutcome,
      httpOutcome,
    },
    port.adapter,
    port.configuration,
  );
  return {
    kind: "state_unconfirmed",
    messageReceipts: progress.messageReceipts,
    ...observed,
    effectCertainty,
    ...(progress.previousReceipt == null ? {} : { lastReceipt: progress.previousReceipt }),
    ...(discordMessageId == null ? {} : { discordMessageId }),
  };
}

function assertPagesReceipt(input: NotificationSettlementInput): void {
  const pages = parseReceipt(input.pagesReceipt, digest);
  const initial = parseReceipt(input.initialStateReceipt, digest);
  const evidence = parseInitialPagesPublicationEvidence(input.initialPages.evidence, digest);
  if (
    pages.receiptType !== "pages_deployment" ||
    initial.receiptType !== "initial_state_commit" ||
    pages.phase !== "initial" ||
    pages.effectCertainty !== "committed" ||
    pages.result == null ||
    pages.binding.bindingKind !== "checkpoint" ||
    serializeCanonicalJson(pages.binding) !== serializeCanonicalJson(initial.binding) ||
    pages.result.sourceStateRevision !== initial.result.resultingStateRevision ||
    pages.result.pageUrl !== evidence.pageUrl ||
    pages.operationId !== evidence.deploymentOperationId
  ) {
    throw new NotificationStructureError(
      "通知settlementの初回Pages receiptが永続runと一致しません",
      "no_effect",
    );
  }
  if (input.initialPages.kind === "published") {
    if (
      serializeCanonicalJson(pages) !==
        serializeCanonicalJson(input.initialPages.deploymentReceipt) ||
      pages.previousReceiptDigest !== input.initialPages.buildReceipt.receiptDigest ||
      pages.phaseSequence !== input.initialPages.buildReceipt.phaseSequence + 1
    ) {
      throw new NotificationStructureError(
        "通知settlementのPages成功receipt列が一致しません",
        "no_effect",
      );
    }
  } else if (
    pages.receiptKind !== "observed" ||
    pages.result.evidenceDigest !== evidence.evidenceDigest ||
    pages.result.observedSourceReceiptDigest !== evidence.deploymentReceiptDigest
  ) {
    throw new NotificationStructureError(
      "通知settlementのPages再観測receiptがstate証拠と一致しません",
      "no_effect",
    );
  }
}

function assertMessageChain(receipts: readonly SettledMessageReceipt[]): void {
  if (receipts.length > 0) {
    verifyReceiptChain(receipts, digest);
  }
}

async function readPagesReceiptEvidence(
  input: NotificationSettlementInput,
  port: NotificationSettlementPort,
): Promise<ReceiptChainEvidence> {
  if (input.pagesReceipt.receiptKind !== "observed") {
    return { kind: "none" };
  }
  const revision = input.pagesReceipt.expectedStateRevision;
  if (typeof revision !== "string") {
    throw new NotificationStructureError(
      "再観測した初回Pages receiptにexact state revisionがありません",
      "no_effect",
    );
  }
  const state = await readNotificationMessageState(port.adapter, port.configuration, revision);
  const marker = state.transaction.marker;
  const evidence = state.transaction.initialPagesEvidence;
  if (
    marker.phase === "initial_state_committed" ||
    evidence == null ||
    serializeCanonicalJson(evidence) !== serializeCanonicalJson(input.initialPages.evidence)
  ) {
    throw new NotificationStructureError(
      "再観測した初回Pages receiptのexact state証拠が一致しません",
      "no_effect",
    );
  }
  const receiptEvidence = {
    kind: "initial_pages_state" as const,
    state: {
      exactStateRevision: revision,
      marker: {
        runId: marker.runId,
        checkpointDigest: marker.checkpointDigest,
        phase: marker.phase,
        initialPagesPublicationEvidenceDigest: marker.initialPagesPublicationEvidenceDigest,
        initialStateRevision: marker.initialStateRevision,
      },
      evidence,
    },
  };
  verifyReceiptChain([{ receipt: input.pagesReceipt, evidence: receiptEvidence }], digest);
  return receiptEvidence;
}

async function initialState(
  input: Pick<NotificationSettlementInput, "record" | "initialStateReceipt">,
  port: NotificationSettlementPort,
): Promise<
  Readonly<{
    state: NotificationMessageState;
    receiptEvidence: Extract<StateCommitReceiptEvidence, { receiptType: "initial_state_commit" }>;
  }>
> {
  const session = exactStateValidationSession(
    port.adapter,
    port.configuration,
    port.observePerformanceDetail,
  );
  port = Object.freeze({ ...port, adapter: session.adapter });
  const initialRevision = input.initialStateReceipt.result.resultingStateRevision;
  const receiptEvidence = await verifyInitialStateCommitReceiptAtRevision(
    port.adapter,
    port.configuration,
    input.initialStateReceipt,
    port.now().toISOString(),
  );
  port.observePerformanceDetail?.({ step: "notification_initial_receipt_reobserved" });
  const initial = await readNotificationMessageState(
    port.adapter,
    port.configuration,
    initialRevision,
  );
  const base = input.record.baseStateRevision;
  const previous = await loadStateNotificationLedgers(
    port.adapter,
    port.configuration,
    base.status === "missing"
      ? { status: "missing" }
      : { status: "present", revision: base.revision },
  );
  if (initial.transaction.record.recordDigest !== input.record.recordDigest) {
    throw new NotificationStructureError(
      "通知settlementの初回stateと永続recordが一致しません",
      "no_effect",
    );
  }
  assertInitialNotificationLedger(input.record, initial, previous);
  verifyReceiptChain(
    [
      {
        receipt: input.initialStateReceipt,
        evidence:
          input.initialStateReceipt.receiptKind === "observed"
            ? { kind: "state_commit", state: receiptEvidence }
            : { kind: "none" },
      },
    ],
    digest,
  );
  return { state: initial, receiptEvidence };
}

async function settleNotificationsChecked(
  input: NotificationSettlementInput,
  port: NotificationSettlementPort,
  progress: NotificationSettlementProgress,
  initial: NotificationMessageState,
  initialReceiptEvidence: Extract<
    StateCommitReceiptEvidence,
    { receiptType: "initial_state_commit" }
  >,
): Promise<NotificationSettlementOutcome> {
  const record = parseDurablePublicationRecord(input.record, digest);
  if (record.recordDigest !== input.record.recordDigest) {
    throw new NotificationStructureError("通知settlementの永続recordが一致しません", "no_effect");
  }
  let pagesReceiptEvidence: ReceiptChainEvidence;
  try {
    assertPagesReceipt(input);
    pagesReceiptEvidence = await readPagesReceiptEvidence(input, port);
    if (input.initialPages.kind === "published") {
      verifyReceiptChain(
        [
          {
            receipt: input.initialStateReceipt,
            evidence:
              input.initialStateReceipt.receiptKind === "observed"
                ? { kind: "state_commit", state: initialReceiptEvidence }
                : { kind: "none" },
          },
          { receipt: input.initialPages.buildReceipt, evidence: { kind: "none" } },
          { receipt: input.pagesReceipt, evidence: pagesReceiptEvidence },
        ],
        digest,
      );
    }
  } catch (cause: unknown) {
    invalidPagesSource(cause);
  }
  const head = await port.adapter.resolveHead(port.configuration.branch);
  if (head.status !== "present") {
    throw new TypeError("通知settlementのstate branchがありません");
  }
  let current: NotificationMessageState;
  try {
    current = await readNotificationMessageState(port.adapter, port.configuration, head.revision);
  } catch (cause: unknown) {
    if (
      cause instanceof TypeError ||
      cause instanceof SyntaxError ||
      cause instanceof ZodError ||
      cause instanceof StateFormatError ||
      cause instanceof StateHistoryError
    ) {
      throw new NotificationStructureError("通知settlementの現在stateが不正です", "no_effect", {
        cause,
      });
    }
    throw cause;
  }
  if (
    current.transaction.record.recordDigest !== record.recordDigest ||
    current.transaction.marker.runId !== record.runIdentity.runId
  ) {
    await port.recordDiagnostic(new TypeError("通知settlementのremote stateが別runへ進みました"));
    return stateUnconfirmedFailure(
      input,
      port,
      progress,
      "no_effect",
      "not_attempted",
      "not_started",
      undefined,
    );
  }
  port.observePerformanceDetail?.({
    step: "notification_current_tree_verified",
    count: current.files.size,
  });
  let evidence: InitialPagesPublicationEvidence;
  try {
    evidence = validatePagesSource(
      input.initialPages,
      input.initialStateReceipt,
      current.transaction.marker.phase === "initial_state_committed",
    );
  } catch (cause: unknown) {
    invalidPagesSource(cause);
  }
  if (
    current.transaction.marker.phase !== "initial_state_committed" &&
    serializeCanonicalJson(current.transaction.initialPagesEvidence) !==
      serializeCanonicalJson(evidence)
  ) {
    throw new NotificationStructureError(
      "通知settlementの保存済みPages証拠が入力と一致しません",
      "no_effect",
    );
  }
  progress.previousReceipt = input.pagesReceipt;
  progress.pagesReceipt = input.pagesReceipt;
  progress.pagesEvidence = evidence;
  const messages = plannedNotificationMessages(record, initial, evidence);
  for (let index = 0; index < messages.length; index += 1) {
    prepareNotificationMessageContext(
      record,
      initial.snapshot,
      initial.ledger,
      evidence,
      index,
      undefined,
    );
  }
  const invocationId = randomUUID();
  const messageReceipts = progress.messageReceipts;
  let settlementRevision: string | undefined;
  if (
    current.transaction.marker.phase === "notifications_settled" ||
    current.transaction.marker.phase === "run_finalized"
  ) {
    try {
      settlementRevision = await settledRevision(input, port, head.revision);
    } catch (cause: unknown) {
      if (cause instanceof TypeError || cause instanceof StateBranchConflictError) {
        throw new NotificationStructureError("通知settlementのGit祖先が不正です", "no_effect", {
          cause,
        });
      }
      throw cause;
    }
  }
  let throughRevision = head.revision;
  if (settlementRevision != null) {
    const commit = await port.adapter.readCommit(settlementRevision);
    if (commit.parent.status !== "present") {
      throw new TypeError("通知settlement commitのGit親がありません");
    }
    throughRevision = commit.parent.revision;
  }
  const history = await restoreNotificationReceiptHistory(
    port,
    record,
    input.initialStateReceipt,
    input.initialPages,
    { receipt: input.pagesReceipt, evidence: pagesReceiptEvidence },
    messages,
    throughRevision,
  );
  port.observePerformanceDetail?.({
    step: "notification_history_restored",
    count: history.messageReceipts.length,
  });
  messageReceipts.push(...history.messageReceipts);
  if (input.manualResolutionReceipt != null) {
    const verified = await verifyManualResolutionReceipt(
      port,
      input.manualResolutionReceipt,
      head.revision,
    );
    if (
      !history.messageReceipts.some(
        (entry) =>
          entry.receipt.receiptType === "manual_resolution" &&
          entry.receipt.operationId === verified.receipt.operationId &&
          serializeCanonicalJson(entry.receipt.result) ===
            serializeCanonicalJson(verified.receipt.result),
      )
    ) {
      throw new TypeError("手動解決artifactが同じrunの通知履歴と一致しません");
    }
  }
  let expectedRevision = history.stateRevision;
  let previousReceipt = history.previousReceipt;
  progress.previousReceipt = previousReceipt;
  const finalReceipts = [...history.finalReceipts];
  if (settlementRevision != null) {
    if (history.unresolvedReceipt != null || finalReceipts.length !== messages.length) {
      throw new TypeError("確定済みsettlementに未処理messageがあります");
    }
    return receiptForSettlement(
      input,
      port,
      settlementRevision,
      expectedRevision,
      previousReceipt,
      messageReceipts,
      finalReceipts,
      initial,
      messages,
      invocationId,
      false,
    );
  }
  if (history.unresolvedReceipt != null) {
    return {
      kind: "manual_resolution_required",
      receipt: history.unresolvedReceipt,
      messageReceipts,
      stateRevision: expectedRevision,
    };
  }
  for (let index = history.nextMessageIndex; index < messages.length; index += 1) {
    const outcome = await deliverNotificationMessage(
      {
        record,
        initialStateReceipt: input.initialStateReceipt,
        initialPages: input.initialPages,
        previousReceipt,
        expectedStateRevision: expectedRevision,
        messageIndex: index,
        invocationId,
        localAttemptIndex: index,
        ...(previousReceipt.receiptType === "manual_resolution" &&
        previousReceipt.result.decision === "retry"
          ? { manualResolutionReceipt: previousReceipt }
          : {}),
      },
      port,
    );
    if (outcome.kind === "conflict") {
      return stateUnconfirmedFailure(
        input,
        port,
        progress,
        "no_effect",
        "no_effect",
        "not_started",
        undefined,
      );
    }
    if (outcome.kind === "state_unconfirmed") {
      return stateUnconfirmedFailure(
        input,
        port,
        progress,
        outcome.effectCertainty,
        outcome.casOutcome,
        outcome.httpOutcome,
        outcome.discordMessageId,
      );
    }
    assertNextReceipt(previousReceipt, outcome.receipt, expectedRevision);
    const next = { receipt: outcome.receipt, evidence: outcome.receiptEvidence };
    assertMessageChain([...messageReceipts, next]);
    messageReceipts.push(next);
    finalReceipts[index] = outcome.receipt;
    previousReceipt = outcome.receipt;
    progress.previousReceipt = outcome.receipt;
    expectedRevision = outcome.stateRevision;
    if (outcome.kind === "ambiguous") {
      return {
        kind: "manual_resolution_required",
        receipt: outcome.receipt,
        messageReceipts,
        stateRevision: outcome.stateRevision,
      };
    }
  }
  const committed = await commitNotificationSettlement(
    input,
    port,
    initial,
    messages,
    finalReceipts,
    evidence,
    expectedRevision,
  );
  if (committed.kind === "conflict") {
    await port.recordDiagnostic(new TypeError("通知settlementのCASとremote stateが競合しました"));
    return stateUnconfirmedFailure(
      input,
      port,
      progress,
      "no_effect",
      "no_effect",
      "not_started",
      undefined,
    );
  }
  if (committed.kind === "no_effect") {
    await port.recordDiagnostic(new TypeError("通知settlementのCASをremoteで確定できません"));
    return stateUnconfirmedFailure(
      input,
      port,
      progress,
      "no_effect",
      "no_effect",
      "not_started",
      undefined,
    );
  }
  return receiptForSettlement(
    input,
    port,
    committed.revision,
    expectedRevision,
    previousReceipt,
    messageReceipts,
    finalReceipts,
    initial,
    messages,
    invocationId,
    !committed.observed,
  );
}

/** 固定outboxを順に確定し、成功actionを単一のstate settlementへ進める。 */
export async function settleNotifications(
  input: NotificationSettlementInput,
  port: NotificationSettlementPort,
): Promise<NotificationSettlementOutcome> {
  return settleNotificationsWithPreflight(
    {
      record: input.record,
      initialStateReceipt: input.initialStateReceipt,
      loadPages: () =>
        Promise.resolve({ initialPages: input.initialPages, pagesReceipt: input.pagesReceipt }),
      ...(input.manualResolutionReceipt == null
        ? {}
        : { manualResolutionReceipt: input.manualResolutionReceipt }),
    },
    port,
  );
}

/** Pages artifact読込を含めて通知の失敗を分類する。 */
export async function settleNotificationsWithPreflight(
  input: NotificationSettlementPreflightInput,
  port: NotificationSettlementPort,
): Promise<NotificationSettlementOutcome> {
  const progress: NotificationSettlementProgress = {
    messageReceipts: [],
    previousReceipt: undefined,
    pagesReceipt: undefined,
    pagesEvidence: undefined,
  };
  try {
    const initial = await initialState(input, port);
    progress.previousReceipt = input.initialStateReceipt;
    const pages = await input.loadPages();
    return await settleNotificationsChecked(
      {
        record: input.record,
        initialStateReceipt: input.initialStateReceipt,
        ...pages,
        ...(input.manualResolutionReceipt == null
          ? {}
          : { manualResolutionReceipt: input.manualResolutionReceipt }),
      },
      port,
      progress,
      initial.state,
      initial.receiptEvidence,
    );
  } catch (cause: unknown) {
    port.observePerformanceDetail?.({
      step: "notification_settlement_failure_classification_started",
    });
    if (!(cause instanceof NotificationStructureError)) {
      throw cause;
    }
    return structuralFailure(input, port, progress, cause);
  }
}
