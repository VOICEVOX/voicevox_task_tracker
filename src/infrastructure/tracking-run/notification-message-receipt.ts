import {
  parseInitialPagesPublicationEvidence,
  type InitialPagesPublicationEvidence,
} from "../../application/tracking-run/initial-pages-evidence-codec.js";
import { createInitialPagesPublicationEvidence } from "../../application/tracking-run/initial-pages-evidence.js";
import { createReceipt, parseReceipt } from "../../application/tracking-run/receipt-codec.js";
import type {
  InitialStateCommitReceipt,
  NotificationMessageReceipt,
  Receipt,
} from "../../application/tracking-run/receipt-schema.js";
import { serializeCanonicalJson } from "../../canonical-json/value.js";
import type { OrthogonalCommitAdvance } from "../../persistence/state-orthogonal-advance.js";
import type { DurablePublicationRecord } from "../../publication/durable-record-schema.js";
import { nodeContentDigestPort as digest } from "./content-digest.js";
import type { NotificationMessageContext } from "./notification-message-context.js";
import type {
  NotificationInitialPagesSource,
  NotificationMessageDeliveryInput,
} from "./notification-message-contracts.js";
import { NotificationStructureError } from "./notification-structure-error.js";

function requireCheckpointReceipt(
  receipt: Receipt,
): Extract<Receipt["binding"], { bindingKind: "checkpoint" }> {
  if (receipt.binding.bindingKind !== "checkpoint") {
    throw new NotificationStructureError(
      "通知messageのreceiptにcheckpoint結合がありません",
      "no_effect",
    );
  }
  return receipt.binding;
}

/** 直前receiptと固定outboxの順序を照合する。 */
export function validatePreviousReceipt(
  input: NotificationMessageDeliveryInput,
  record: DurablePublicationRecord,
): void {
  const previous = parseReceipt(input.previousReceipt, digest);
  const initial = parseReceipt(input.initialStateReceipt, digest);
  const binding = requireCheckpointReceipt(previous);
  if (initial.receiptType !== "initial_state_commit") {
    throw new NotificationStructureError("通知messageの初回commit receiptが不正です", "no_effect");
  }
  if (
    binding.runId !== record.runIdentity.runId ||
    binding.checkpointDigest !== record.checkpointDigest ||
    binding.checkpointFileDigest !== record.checkpointFileDigest ||
    binding.runtimeIdentityDigest !==
      digest.sha256Utf8(serializeCanonicalJson(record.runtimeIdentity)) ||
    serializeCanonicalJson(binding) !== serializeCanonicalJson(initial.binding)
  ) {
    throw new NotificationStructureError(
      "通知messageのreceiptと永続recordの結合が一致しません",
      "no_effect",
    );
  }
  if (previous.receiptType === "pages_deployment") {
    if (
      input.messageIndex !== 0 ||
      previous.phase !== "initial" ||
      previous.effectCertainty !== "committed" ||
      input.expectedStateRevision !== initial.result.resultingStateRevision
    ) {
      throw new NotificationStructureError(
        "最初の通知messageに初回Pages成功receiptがありません",
        "no_effect",
      );
    }
    if (
      (input.initialPages.kind === "published" &&
        previous.receiptDigest !== input.initialPages.deploymentReceipt.receiptDigest) ||
      (input.initialPages.kind === "state" &&
        (previous.receiptKind !== "observed" ||
          previous.operationId !== input.initialPages.evidence.deploymentOperationId ||
          previous.result?.evidenceDigest !== input.initialPages.evidence.evidenceDigest))
    ) {
      throw new NotificationStructureError(
        "最初の通知messageとPages公開証拠のreceiptが一致しません",
        "no_effect",
      );
    }
  } else if (previous.receiptType === "manual_resolution") {
    const match = /:message:([1-9][0-9]*)$/u.exec(previous.result.deliveryId);
    const resolvedIndex = match?.[1] == null ? -1 : Number(match[1]) - 1;
    if (
      previous.result.resultingStateRevision !== input.expectedStateRevision ||
      input.messageIndex !== resolvedIndex + (previous.result.decision === "retry" ? 0 : 1) ||
      (previous.result.decision === "retry" &&
        input.manualResolutionReceipt?.receiptDigest !== previous.receiptDigest)
    ) {
      throw new NotificationStructureError(
        "通知messageの手動解決receiptと固定outboxの位置が一致しません",
        "no_effect",
      );
    }
  } else if (
    previous.receiptType !== "notification_message" ||
    previous.status === "ambiguous" ||
    (previous.logicalTarget !== `message:${input.messageIndex.toString()}` &&
      (previous.status !== "no_effect" ||
        previous.logicalTarget !== `message:${(input.messageIndex + 1).toString()}`)) ||
    previous.result.ledgerStateRevision !== input.expectedStateRevision
  ) {
    throw new NotificationStructureError(
      "通知messageの直前receiptとstate revisionが一致しません",
      "no_effect",
    );
  }
}

/** 初回Pages証拠とstate移行の前提を照合する。 */
export function validatePagesSource(
  source: NotificationInitialPagesSource,
  initial: InitialStateCommitReceipt,
  firstCommit: boolean,
): InitialPagesPublicationEvidence {
  const evidence = parseInitialPagesPublicationEvidence(source.evidence, digest);
  if (evidence.sourceStateRevision !== initial.result.resultingStateRevision) {
    throw new NotificationStructureError(
      "初回Pages証拠のsource revisionが初回commitと一致しません",
      "no_effect",
    );
  }
  if (source.kind === "published") {
    if (
      source.buildReceipt.previousReceiptDigest !== initial.receiptDigest ||
      source.buildReceipt.phaseSequence !== initial.phaseSequence + 1
    ) {
      throw new NotificationStructureError(
        "初回Pages build receiptが初回state commitへ連結していません",
        "no_effect",
      );
    }
    const rebuilt = createInitialPagesPublicationEvidence(
      {
        buildReceipt: source.buildReceipt,
        deploymentReceipt: source.deploymentReceipt,
        sourceStateRevision: initial.result.resultingStateRevision,
      },
      digest,
    );
    if (serializeCanonicalJson(rebuilt) !== serializeCanonicalJson(evidence)) {
      throw new NotificationStructureError(
        "初回Pages成功receiptと保存候補の証拠が一致しません",
        "no_effect",
      );
    }
  } else if (firstCommit) {
    throw new NotificationStructureError(
      "最初の通知commitには検証済みPages成功receiptが必要です",
      "no_effect",
    );
  }
  return evidence;
}

/** 一messageのstate結果から配送receiptを作る。 */
export function receiptForMessage(
  input: NotificationMessageDeliveryInput,
  context: NotificationMessageContext,
  reservationStateRevision: string,
  ledgerStateRevision: string,
  reservationCommit: OrthogonalCommitAdvance,
  resultCommit: OrthogonalCommitAdvance | undefined,
  status: "sent" | "no_effect" | "ambiguous",
  observedAt: string,
  discordMessageId: string | undefined,
): NotificationMessageReceipt {
  const receipt = createReceipt(
    {
      schemaVersion: 1,
      receiptType: "notification_message",
      stage: "notifications_settled",
      phase: "notification",
      binding: input.initialStateReceipt.binding,
      logicalTarget: `message:${(input.messageIndex + 1).toString()}`,
      invocationId: input.invocationId,
      localAttemptIndex: input.localAttemptIndex,
      phaseSequence: input.previousReceipt.phaseSequence + 1,
      previousReceiptDigest: input.previousReceipt.receiptDigest,
      expectedStateRevision: input.expectedStateRevision,
      receiptKind: "executed",
      observedAt,
      ...(status === "ambiguous" ? { publicDiagnosticCode: "effect_unconfirmed" } : {}),
      ...(status === "no_effect" ? { publicDiagnosticCode: "action_failed" } : {}),
      ...(status === "ambiguous" ? {} : { effectOccurredAt: observedAt }),
      status,
      effectCertainty: status === "sent" ? "committed" : status,
      durableAttemptSequence: context.durableAttemptSequence,
      result: {
        deliveryId: context.deliveryId,
        notificationKeys: [...context.notificationKeys],
        reservationStateRevision,
        ledgerStateRevision,
        reservationCommit: {
          ...reservationCommit,
          interveningOperationsAlertCommits: [
            ...reservationCommit.interveningOperationsAlertCommits,
          ],
        },
        ...(resultCommit == null
          ? {}
          : {
              resultCommit: {
                ...resultCommit,
                interveningOperationsAlertCommits: [
                  ...resultCommit.interveningOperationsAlertCommits,
                ],
              },
            }),
        ...(discordMessageId == null ? {} : { discordMessageId }),
      },
    },
    digest,
  );
  if (receipt.receiptType !== "notification_message") {
    throw new TypeError("通知message receiptの型が一致しません");
  }
  return receipt;
}
