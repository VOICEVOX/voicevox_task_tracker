import { serializeCanonicalJson } from "../../canonical-json/value.js";
import { parseInitialPagesPublicationEvidence } from "./initial-pages-evidence-codec.js";
import {
  assertObservedStateCommitReceipt,
  type ObservedStateCommitPosition,
} from "./observed-state-commit.js";
import type { ContentDigestPort } from "./contracts/content-digest-port.js";
import {
  manualResolutionStateEvidenceSchema,
  notificationMessageStateEvidenceSchema,
  receiptChainEntrySchema,
  type ReceiptChainEvidence,
} from "./receipt-chain-schema.js";
import { parseReceipt } from "./receipt-codec.js";
import type { Receipt } from "./receipt-schema.js";

const receiptChainProofBrand: unique symbol = Symbol("receiptChainProof");

/** receiptの順序と識別を検証した証明。 */
export type ReceiptChainProof = Readonly<{
  lastReceiptDigest: Receipt["receiptDigest"];
  completedPhaseSequence: number;
  readonly [receiptChainProofBrand]: true;
}>;

/** 検証済みのreceipt列とその連鎖証明。 */
export type VerifiedReceiptChain = Readonly<{
  receipts: readonly Receipt[];
  proof: ReceiptChainProof;
}>;

function assertObservedReceiptEvidence(
  receipt: Receipt,
  witness: ReceiptChainEvidence,
  previous: Receipt | undefined,
  digest: ContentDigestPort,
): void {
  if (receipt.receiptKind !== "observed") {
    if (witness.kind !== "none") {
      throw new TypeError("通常receiptへ観測証拠を付けられません");
    }
    return;
  }
  if (
    receipt.receiptType === "initial_state_commit" ||
    receipt.receiptType === "notification_settlement" ||
    receipt.receiptType === "run_finalization"
  ) {
    if (witness.kind !== "state_commit") {
      throw new TypeError("observed state receiptのcommit証拠がありません");
    }
    let position: ObservedStateCommitPosition;
    if (previous != null) {
      position = {
        kind: "after",
        previousReceiptDigest: previous.receiptDigest,
        previousPhaseSequence: previous.phaseSequence,
      };
    } else if (receipt.previousReceiptDigest != null) {
      position = {
        kind: "after",
        previousReceiptDigest: receipt.previousReceiptDigest,
        previousPhaseSequence: receipt.phaseSequence - 1,
      };
    } else {
      position = { kind: "first" };
    }
    assertObservedStateCommitReceipt(receipt, witness.state, position, digest);
    return;
  }
  if (receipt.receiptType === "notification_message") {
    if (witness.kind !== "notification_message_state") {
      throw new TypeError("再観測した通知messageにstate証拠がありません");
    }
    const state = notificationMessageStateEvidenceSchema.parse(witness.state);
    const attempt = state.attempt;
    const commitOperationId = (transition: "reservation" | "result"): string =>
      `operation:v1:${digest
        .sha256Utf8(
          serializeCanonicalJson({
            kind: "notification_message",
            deliveryOperationId: attempt.operationId,
            deliveryAttemptId: attempt.attemptId,
            transition,
          }),
        )
        .slice("sha256:".length)}`;
    if (
      receipt.binding.bindingKind !== "checkpoint" ||
      receipt.binding.runId !== state.runId ||
      receipt.binding.checkpointDigest !== state.checkpointDigest ||
      receipt.operationId !== attempt.operationId ||
      receipt.durableAttemptSequence !== attempt.durableAttemptSequence ||
      receipt.result.deliveryId !== state.deliveryId ||
      serializeCanonicalJson(receipt.result.notificationKeys) !==
        serializeCanonicalJson(attempt.notificationKeys) ||
      receipt.result.reservationStateRevision !== state.reservation.revision ||
      receipt.result.ledgerStateRevision !==
        (state.result?.revision ?? state.reservation.revision) ||
      receipt.result.reservationCommit.expectedTrackingStateRevision !==
        state.reservation.expectedTrackingStateRevision ||
      receipt.result.reservationCommit.actualParentStateRevision !==
        state.reservation.parentRevision ||
      serializeCanonicalJson(receipt.result.reservationCommit.interveningOperationsAlertCommits) !==
        serializeCanonicalJson(state.reservation.interveningOperationsAlertCommits) ||
      (receipt.result.resultCommit == null) !== (state.result == null) ||
      (receipt.result.resultCommit != null &&
        state.result != null &&
        (receipt.result.resultCommit.expectedTrackingStateRevision !==
          state.result.expectedTrackingStateRevision ||
          receipt.result.resultCommit.actualParentStateRevision !== state.result.parentRevision ||
          serializeCanonicalJson(receipt.result.resultCommit.interveningOperationsAlertCommits) !==
            serializeCanonicalJson(state.result.interveningOperationsAlertCommits))) ||
      receipt.result.discordMessageId !== attempt.discordMessageId ||
      receipt.effectOccurredAt !== attempt.completedAt ||
      state.reservation.commitOperationId !== commitOperationId("reservation") ||
      (state.result != null &&
        (state.result.commitOperationId !== commitOperationId("result") ||
          state.result.markerPhaseSequence !== state.reservation.markerPhaseSequence + 1)) ||
      (receipt.status === "ambiguous") !== (attempt.result === "started") ||
      (receipt.status === "sent") !== (attempt.result === "sent") ||
      (state.result == null) !== (attempt.result === "started")
    ) {
      throw new TypeError("再観測した通知message receiptとstate証拠が一致しません");
    }
    return;
  }
  if (receipt.receiptType === "manual_resolution") {
    if (witness.kind !== "manual_resolution_state") {
      throw new TypeError("再観測した手動解決にstate証拠がありません");
    }
    const state = manualResolutionStateEvidenceSchema.parse(witness.state);
    const marker = state.resultingMarker;
    if (
      receipt.binding.bindingKind !== "checkpoint" ||
      receipt.binding.runId !== state.runId ||
      receipt.binding.checkpointDigest !== state.checkpointDigest ||
      receipt.result.deliveryId !== state.deliveryId ||
      receipt.result.deliveryAttemptId !== state.attempt.attemptId ||
      receipt.result.decision !== state.decision ||
      serializeCanonicalJson(receipt.result.notificationKeys) !==
        serializeCanonicalJson(state.notificationKeys) ||
      receipt.result.expectedTrackingStateRevision !== state.expectedTrackingStateRevision ||
      receipt.result.actualParentStateRevision !== state.parentRevision ||
      receipt.result.resultingStateRevision !== state.resultingRevision ||
      receipt.result.commitOperationId !== state.commitOperationId ||
      receipt.result.changedPathManifestDigest !== state.changedPathManifestDigest ||
      receipt.result.stateContentDigest !== state.stateContentDigest ||
      receipt.effectOccurredAt !== state.resolvedAt ||
      state.stateContentDigest !==
        digest.sha256Utf8(
          serializeCanonicalJson({
            marker,
            recordDigest: state.publicationRecordDigest,
            snapshotDigest: marker.snapshotDigest,
            notificationLedgerDigest: marker.notificationLedgerDigest,
          }),
        ) ||
      serializeCanonicalJson(receipt.result.interveningOperationsAlertCommits) !==
        serializeCanonicalJson(state.interveningOperationsAlertCommits) ||
      marker.phase !== "notifications_in_progress" ||
      marker.runId !== state.runId ||
      marker.checkpointDigest !== state.checkpointDigest ||
      marker.publicationRecordDigest !== state.publicationRecordDigest ||
      marker.expectedParentStateRevision !== state.parentRevision ||
      marker.phaseSequence !== state.parentMarker.phaseSequence + 1 ||
      state.parentMarker.phase !== "notifications_in_progress" ||
      state.parentMarker.lastMessageDeliveryId !== state.deliveryId ||
      marker.lastMessageDeliveryId !== state.deliveryId ||
      state.attempt.result !== "started" ||
      serializeCanonicalJson(state.attempt.notificationKeys) !==
        serializeCanonicalJson(state.notificationKeys)
    ) {
      throw new TypeError("再観測した手動解決receiptとstate証拠が一致しません");
    }
    return;
  }
  if (
    witness.kind !== "initial_pages_state" ||
    receipt.receiptType !== "pages_deployment" ||
    receipt.result == null ||
    receipt.binding.bindingKind !== "checkpoint"
  ) {
    throw new TypeError("observed receiptのstate証拠がありません");
  }
  const evidence = parseInitialPagesPublicationEvidence(witness.state.evidence, digest);
  if (
    witness.state.marker.initialPagesPublicationEvidenceDigest !== evidence.evidenceDigest ||
    witness.state.marker.initialStateRevision !== evidence.sourceStateRevision ||
    witness.state.marker.runId !== evidence.runId ||
    witness.state.marker.checkpointDigest !== evidence.checkpointDigest ||
    receipt.expectedStateRevision !== witness.state.exactStateRevision ||
    receipt.binding.runId !== evidence.runId ||
    receipt.binding.checkpointDigest !== evidence.checkpointDigest ||
    receipt.operationId !== evidence.deploymentOperationId ||
    receipt.receiptDigest === evidence.deploymentReceiptDigest ||
    receipt.result.observedSourceReceiptDigest !== evidence.deploymentReceiptDigest ||
    receipt.result.evidenceDigest !== evidence.evidenceDigest ||
    receipt.result.deploymentIntentDigest !== evidence.deploymentIntentDigest ||
    receipt.result.pagesContentDigest !== evidence.pagesContentDigest ||
    receipt.result.sourceStateRevision !== evidence.sourceStateRevision ||
    receipt.result.pageUrl !== evidence.pageUrl ||
    serializeCanonicalJson(receipt.result.externalReference) !==
      serializeCanonicalJson(evidence.externalReference) ||
    receipt.effectOccurredAt !== evidence.effectOccurredAt
  ) {
    throw new TypeError("observed receiptと保存済みPages証拠が一致しません");
  }
}

function stateRevision(receipt: Receipt): string | undefined {
  if (receipt.receiptType === "notification_message") {
    return receipt.result.ledgerStateRevision;
  }
  if (
    receipt.receiptType === "initial_state_commit" ||
    receipt.receiptType === "notification_settlement" ||
    receipt.receiptType === "manual_resolution" ||
    receipt.receiptType === "run_finalization"
  ) {
    return receipt.result.resultingStateRevision;
  }
  return undefined;
}

function assertCompatibleNotificationAttempt(
  previous: Extract<Receipt, { receiptType: "notification_message" }>,
  current: Extract<Receipt, { receiptType: "notification_message" }>,
  receipts: readonly Receipt[],
  previousIndex: number,
): void {
  if (
    previous.durableAttemptSequence === current.durableAttemptSequence &&
    previous.status === current.status &&
    serializeCanonicalJson(previous.result) === serializeCanonicalJson(current.result) &&
    (previous.receiptKind === "observed" || current.receiptKind === "observed")
  ) {
    return;
  }
  const manuallyReleased = receipts
    .slice(previousIndex + 1)
    .some(
      (receipt) =>
        receipt.receiptType === "manual_resolution" &&
        receipt.result.deliveryId === previous.result.deliveryId &&
        receipt.result.decision === "retry",
    );
  const reusedAttemptResult = receipts.some(
    (receipt) =>
      receipt.receiptType === "notification_message" &&
      receipt.operationId === current.operationId &&
      (receipt.result.reservationStateRevision === current.result.reservationStateRevision ||
        receipt.result.ledgerStateRevision === current.result.ledgerStateRevision),
  );
  if (
    serializeCanonicalJson(previous.result.notificationKeys) !==
      serializeCanonicalJson(current.result.notificationKeys) ||
    reusedAttemptResult ||
    previous.durableAttemptSequence >= current.durableAttemptSequence ||
    previous.status === "sent" ||
    (previous.status === "ambiguous" && !manuallyReleased)
  ) {
    throw new TypeError("同じ通知operationの配送試行またはledger連鎖が矛盾しています");
  }
}

function assertCompatibleOperation(
  previous: Receipt,
  current: Receipt,
  receipts: readonly Receipt[],
  previousIndex: number,
): void {
  if (
    previous.receiptType !== current.receiptType ||
    previous.logicalTarget !== current.logicalTarget ||
    serializeCanonicalJson(previous.binding) !== serializeCanonicalJson(current.binding)
  ) {
    throw new TypeError("同じoperation IDが異なる論理効果を表しています");
  }
  if (
    previous.receiptType === "notification_message" &&
    current.receiptType === "notification_message"
  ) {
    assertCompatibleNotificationAttempt(previous, current, receipts, previousIndex);
    return;
  }
  if (
    (previous.effectCertainty === "committed" && current.effectCertainty === "no_effect") ||
    (previous.effectCertainty === "no_effect" && current.effectCertainty === "committed")
  ) {
    throw new TypeError("同じoperation IDに矛盾する副作用確度があります");
  }
  const previousRevision = stateRevision(previous);
  const currentRevision = stateRevision(current);
  if (previousRevision != null && currentRevision != null && previousRevision !== currentRevision) {
    throw new TypeError("同じoperation IDに異なる結果revisionがあります");
  }
  if (
    previous.effectCertainty === "committed" &&
    current.effectCertainty === "committed" &&
    previous.receiptType !== "pages_deployment" &&
    serializeCanonicalJson(previous.result) !== serializeCanonicalJson(current.result)
  ) {
    throw new TypeError("同じoperation IDに異なる確定結果があります");
  }
  if (
    previous.effectCertainty === "no_effect" &&
    current.effectCertainty === "no_effect" &&
    previous.status !== current.status
  ) {
    throw new TypeError("同じoperation IDに異なる未実行結果があります");
  }
  if (
    previous.receiptType === "pages_deployment" &&
    current.receiptType === "pages_deployment" &&
    previous.result != null &&
    current.result != null
  ) {
    if (
      previous.result.pagesContentDigest !== current.result.pagesContentDigest ||
      previous.result.pageUrl !== current.result.pageUrl ||
      previous.result.deploymentIntentDigest !== current.result.deploymentIntentDigest ||
      (previous.status !== "replayed_same_content" &&
        current.status !== "replayed_same_content" &&
        serializeCanonicalJson(previous.result.externalReference) !==
          serializeCanonicalJson(current.result.externalReference))
    ) {
      throw new TypeError("同じPages operation IDに矛盾する公開結果があります");
    }
  }
  if (
    previous.receiptType === "notification_message" &&
    current.receiptType === "notification_message" &&
    previous.result.discordMessageId != null &&
    current.result.discordMessageId != null &&
    previous.result.discordMessageId !== current.result.discordMessageId
  ) {
    throw new TypeError("同じ通知operation IDに異なるmessage IDがあります");
  }
}

/** receipt列の識別、前段digest、revision、phase順序を照合する。 */
export function verifyReceiptChain(
  values: readonly unknown[],
  digest: ContentDigestPort,
): VerifiedReceiptChain {
  const receipts: Receipt[] = [];
  const byAttempt = new Map<string, Receipt>();
  const byOperation = new Map<string, Readonly<{ receipt: Receipt; index: number }>>();
  let checkpointBinding: string | undefined;
  let preCheckpointRunId: string | undefined;
  let preCheckpointBaseRevision: string | undefined;
  let preCheckpointConfigDigest: string | undefined;
  let lastTrackingStateRevision: string | undefined;
  for (const value of values) {
    const entry = receiptChainEntrySchema.parse(value);
    const receipt = parseReceipt(entry.receipt, digest);
    const evidence = entry.evidence;
    const priorAttempt = byAttempt.get(receipt.attemptId);
    const previous = priorAttempt == null ? receipts.at(-1) : undefined;
    assertObservedReceiptEvidence(receipt, evidence, previous, digest);
    if (receipt.binding.bindingKind === "checkpoint") {
      const binding = serializeCanonicalJson(receipt.binding);
      if (
        (checkpointBinding != null && checkpointBinding !== binding) ||
        (preCheckpointRunId != null && preCheckpointRunId !== receipt.binding.runId)
      ) {
        throw new TypeError("receipt chainのrunまたはcheckpoint結合が途中で変わりました");
      }
      checkpointBinding = binding;
    }
    if (receipt.binding.bindingKind === "run_pre_checkpoint_alert") {
      const baseRevision = serializeCanonicalJson(receipt.binding.baseStateRevision);
      if (
        (preCheckpointRunId != null && preCheckpointRunId !== receipt.binding.runId) ||
        (preCheckpointBaseRevision != null && preCheckpointBaseRevision !== baseRevision) ||
        (preCheckpointConfigDigest != null &&
          preCheckpointConfigDigest !== receipt.binding.configDigest) ||
        checkpointBinding != null
      ) {
        throw new TypeError("checkpoint前の運用通知のrunまたはbaseが一致しません");
      }
      preCheckpointRunId = receipt.binding.runId;
      preCheckpointBaseRevision = baseRevision;
      preCheckpointConfigDigest = receipt.binding.configDigest;
    }
    if (priorAttempt != null) {
      if (priorAttempt.receiptDigest !== receipt.receiptDigest) {
        throw new TypeError("同じattempt IDに異なるreceiptがあります");
      }
      continue;
    }
    const priorOperation = byOperation.get(receipt.operationId);
    if (priorOperation != null) {
      assertCompatibleOperation(priorOperation.receipt, receipt, receipts, priorOperation.index);
    }
    if (previous != null) {
      if (
        receipt.previousReceiptDigest !== previous.receiptDigest ||
        receipt.phaseSequence !== previous.phaseSequence + 1 ||
        (previous.binding.bindingKind === "checkpoint" &&
          receipt.binding.bindingKind === "checkpoint" &&
          serializeCanonicalJson(previous.binding) !== serializeCanonicalJson(receipt.binding))
      ) {
        throw new TypeError("receiptの結合または順序が直前receiptと一致しません");
      }
    }
    if (
      lastTrackingStateRevision != null &&
      receipt.expectedStateRevision != null &&
      receipt.binding.bindingKind === "checkpoint" &&
      lastTrackingStateRevision !== receipt.expectedStateRevision &&
      !(receipt.receiptType === "pages_deployment" && receipt.receiptKind === "observed")
    ) {
      throw new TypeError("receiptの期待state revisionが直前のtracking結果と一致しません");
    }
    byAttempt.set(receipt.attemptId, receipt);
    byOperation.set(receipt.operationId, { receipt, index: receipts.length });
    receipts.push(receipt);
    const resultingRevision = stateRevision(receipt);
    if (resultingRevision != null) {
      lastTrackingStateRevision = resultingRevision;
    }
  }
  const last = receipts.at(-1);
  if (last == null) {
    throw new TypeError("receipt chainが空です");
  }
  const proof: ReceiptChainProof = {
    lastReceiptDigest: last.receiptDigest,
    completedPhaseSequence: last.phaseSequence,
    [receiptChainProofBrand]: true,
  };
  Object.freeze(proof);
  return Object.freeze({
    receipts: Object.freeze(receipts),
    proof,
  });
}
