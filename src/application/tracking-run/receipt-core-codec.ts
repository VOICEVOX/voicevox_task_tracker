import { z } from "zod";

import { serializeCanonicalJson, serializeCanonicalJsonLine } from "../../canonical-json/value.js";
import type { ContentDigestPort } from "./contracts/content-digest-port.js";
import { receiptSchema, type Receipt } from "./receipt-schema.js";

const MAX_RECEIPT_BYTES = 1024 * 1024;
const identityMask = {
  operationId: true,
  attemptId: true,
  receiptDigest: true,
  receiptId: true,
} satisfies Record<"operationId" | "attemptId" | "receiptDigest" | "receiptId", true>;
const draftSchema = z.union([
  receiptSchema.options[0].omit(identityMask),
  receiptSchema.options[1].omit(identityMask),
  receiptSchema.options[2].omit(identityMask),
  receiptSchema.options[3].omit(identityMask),
  receiptSchema.options[4].omit(identityMask),
  receiptSchema.options[5].omit(identityMask),
  receiptSchema.options[6].omit(identityMask),
  receiptSchema.options[7].omit(identityMask),
  receiptSchema.options[8].omit(identityMask),
]);

/** 同じ起動の一試行で確定した識別子以外のreceipt値。 */
export type ReceiptDraft = z.output<typeof draftSchema>;

function digestId(
  prefix: "operation" | "attempt" | "receipt",
  value: unknown,
  digest: ContentDigestPort,
): string {
  return `${prefix}:v1:${digest.sha256Utf8(serializeCanonicalJson(value)).slice("sha256:".length)}`;
}

type ReceiptIdentitySource = Pick<
  ReceiptDraft,
  "binding" | "stage" | "phase" | "logicalTarget" | "invocationId" | "localAttemptIndex"
>;

function operationIdentity(receipt: ReceiptIdentitySource): object {
  const common = {
    bindingKind: receipt.binding.bindingKind,
    stage: receipt.stage,
    phase: receipt.phase,
    logicalTarget: receipt.logicalTarget,
  };
  switch (receipt.binding.bindingKind) {
    case "checkpoint":
      return { ...common, runId: receipt.binding.runId };
    case "run_pre_checkpoint_alert":
      return {
        ...common,
        runId: receipt.binding.runId,
        failedStage: receipt.binding.failedStage,
        failureArtifactDigest: receipt.binding.failureArtifactDigest,
      };
    case "state_bootstrap_alert":
      return {
        ...common,
        observedStateRevision: receipt.binding.observedStateRevision,
        observedMarkerFile: receipt.binding.observedMarkerFile,
        observedRecordFile: receipt.binding.observedRecordFile,
        failureArtifactDigest: receipt.binding.failureArtifactDigest,
      };
    case "invocation_pre_run_alert":
      return {
        ...common,
        invocationId: receipt.invocationId,
        failureArtifactDigest: receipt.binding.failureArtifactDigest,
      };
  }
}

/** receiptと同じ規則で効果と起動内試行の識別子を事前に作る。 */
export function receiptIdentifiers(
  value: ReceiptIdentitySource,
  digest: ContentDigestPort,
): Readonly<{ operationId: string; attemptId: string }> {
  const operationId = digestId("operation", operationIdentity(value), digest);
  return Object.freeze({
    operationId,
    attemptId: digestId(
      "attempt",
      { operationId, invocationId: value.invocationId, localAttemptIndex: value.localAttemptIndex },
      digest,
    ),
  });
}

function assertReceiptSemantics(receipt: Receipt): void {
  if (receipt.receiptType !== "operations_alert" && receipt.binding.bindingKind !== "checkpoint") {
    throw new TypeError("通常receiptにcheckpoint以外の結合は使えません");
  }
  if (
    receipt.previousReceiptDigest == null &&
    receipt.expectedStateRevision == null &&
    receipt.binding.bindingKind !== "invocation_pre_run_alert"
  ) {
    throw new TypeError("receiptに前receiptまたは期待state revisionが必要です");
  }
  if (
    (receipt.binding.bindingKind === "invocation_pre_run_alert" &&
      receipt.expectedStateRevision != null) ||
    (receipt.binding.bindingKind === "state_bootstrap_alert" &&
      receipt.expectedStateRevision !== receipt.binding.observedStateRevision) ||
    (receipt.binding.bindingKind === "run_pre_checkpoint_alert" &&
      (receipt.binding.baseStateRevision.status === "present"
        ? receipt.expectedStateRevision !== receipt.binding.baseStateRevision.revision
        : typeof receipt.expectedStateRevision !== "object")) ||
    (typeof receipt.expectedStateRevision === "object" &&
      receipt.binding.bindingKind === "checkpoint" &&
      receipt.receiptType !== "initial_state_commit" &&
      receipt.receiptType !== "operations_alert")
  ) {
    throw new TypeError("checkpoint前の運用通知に存在しないstate revisionがあります");
  }
  if (receipt.receiptKind === "observed") {
    if (receipt.receiptType === "pages_deployment") {
      if (
        receipt.phase !== "initial" ||
        receipt.status !== "deployed" ||
        receipt.result?.observedSourceReceiptDigest == null ||
        receipt.result.evidenceDigest == null
      ) {
        throw new TypeError("observed receiptにはstateで裏付けた初回Pages証拠が必要です");
      }
    } else if (
      receipt.receiptType !== "initial_state_commit" &&
      receipt.receiptType !== "notification_message" &&
      receipt.receiptType !== "manual_resolution" &&
      receipt.receiptType !== "notification_settlement" &&
      receipt.receiptType !== "run_finalization"
    ) {
      throw new TypeError("observed receiptにはstateで裏付けた初回Pages証拠が必要です");
    }
  } else if (receipt.receiptType === "pages_deployment" && receipt.result != null) {
    if (
      receipt.result.observedSourceReceiptDigest != null ||
      receipt.result.evidenceDigest != null
    ) {
      throw new TypeError("Pagesの再観測証拠はobserved receiptだけに保持します");
    }
  }
  if (receipt.receiptKind === "not_required" && receipt.effectCertainty !== "no_effect") {
    throw new TypeError("不要なeffectを実行済みとして記録できません");
  }
  if (receipt.receiptKind === "superseded" && receipt.effectCertainty !== "no_effect") {
    throw new TypeError("新しいrunで無効になったeffectを実行済みとして記録できません");
  }
  if (receipt.receiptType === "pages_build") {
    if (
      (receipt.phase === "initial") !== (receipt.stage === "initial_pages_prepared") ||
      (receipt.status === "built") !== (receipt.result != null) ||
      (receipt.status === "built") !== (receipt.effectCertainty === "committed") ||
      (receipt.status === "not_required") !== (receipt.receiptKind === "not_required") ||
      (receipt.status === "not_required") !== (receipt.notRequiredReason != null) ||
      (receipt.phase === "initial" && receipt.notRequiredReason != null) ||
      (receipt.result != null && receipt.logicalTarget !== receipt.result.deploymentIntentDigest)
    ) {
      throw new TypeError("Pages build receiptの段階と結果が一致しません");
    }
  }
  if (receipt.receiptType === "pages_deployment") {
    if (
      (receipt.phase === "initial") !== (receipt.stage === "initial_pages_published") ||
      (receipt.status === "deployed" || receipt.status === "replayed_same_content") !==
        (receipt.result != null) ||
      (receipt.status === "deployed" || receipt.status === "replayed_same_content") !==
        (receipt.effectCertainty === "committed") ||
      (receipt.status === "not_required") !== (receipt.receiptKind === "not_required") ||
      (receipt.status === "superseded_by_newer_run") !== (receipt.receiptKind === "superseded") ||
      (receipt.status === "ambiguous") !== (receipt.effectCertainty === "ambiguous") ||
      (receipt.result != null && receipt.logicalTarget !== receipt.result.deploymentIntentDigest)
    ) {
      throw new TypeError("Pages deployment receiptの段階と結果が一致しません");
    }
  }
  if (receipt.receiptType === "notification_message") {
    const reservationCommit = receipt.result.reservationCommit;
    const resultCommit = receipt.result.resultCommit;
    if (
      typeof receipt.expectedStateRevision !== "string" ||
      receipt.result.ledgerStateRevision === receipt.expectedStateRevision ||
      reservationCommit.expectedTrackingStateRevision !== receipt.expectedStateRevision ||
      (reservationCommit.interveningOperationsAlertCommits.length === 0
        ? reservationCommit.actualParentStateRevision !== receipt.expectedStateRevision
        : reservationCommit.interveningOperationsAlertCommits.at(-1) !==
          reservationCommit.actualParentStateRevision) ||
      (resultCommit == null) !== (receipt.status === "ambiguous") ||
      (resultCommit != null &&
        (resultCommit.expectedTrackingStateRevision !== receipt.result.reservationStateRevision ||
          (resultCommit.interveningOperationsAlertCommits.length === 0
            ? resultCommit.actualParentStateRevision !== receipt.result.reservationStateRevision
            : resultCommit.interveningOperationsAlertCommits.at(-1) !==
              resultCommit.actualParentStateRevision))) ||
      new Set(receipt.result.notificationKeys).size !== receipt.result.notificationKeys.length ||
      (receipt.status === "ambiguous") !==
        (receipt.result.ledgerStateRevision === receipt.result.reservationStateRevision) ||
      (receipt.status === "sent") !== (receipt.effectCertainty === "committed") ||
      (receipt.status === "ambiguous") !== (receipt.effectCertainty === "ambiguous") ||
      (receipt.status === "sent") !== (receipt.result.discordMessageId != null)
    ) {
      throw new TypeError("通知message receiptの配送結果が一致しません");
    }
  }
  if (receipt.receiptType === "operations_alert") {
    if (
      (receipt.status === "sent") !== (receipt.effectCertainty === "committed") ||
      (receipt.status === "ambiguous") !== (receipt.effectCertainty === "ambiguous") ||
      (receipt.status === "no_effect") !== (receipt.receiptKind === "not_required") ||
      (receipt.status === "sent" && receipt.result.discordMessageId == null) ||
      (receipt.status === "no_effect" && receipt.result.discordMessageId != null) ||
      (receipt.status !== "ambiguous" && receipt.result.observedOperationsLedgerState != null) ||
      (receipt.status === "sent") !== (receipt.result.operationsLedgerRevision != null) ||
      (receipt.result.operationsLedgerRevision != null) !==
        (receipt.result.operationsLedgerCommitMetadata != null)
    ) {
      throw new TypeError("運用通知receiptの送達結果が一致しません");
    }
  }
  if (
    (receipt.receiptType === "initial_state_commit" ||
      receipt.receiptType === "notification_settlement" ||
      receipt.receiptType === "manual_resolution" ||
      receipt.receiptType === "run_finalization") &&
    (receipt.receiptType === "initial_state_commit"
      ? (typeof receipt.expectedStateRevision === "object"
          ? "unborn"
          : receipt.expectedStateRevision) !== receipt.result.expectedTrackingStateRevision
      : receipt.expectedStateRevision !== receipt.result.expectedTrackingStateRevision ||
        receipt.result.expectedTrackingStateRevision === "unborn" ||
        receipt.result.actualParentStateRevision === "unborn")
  ) {
    throw new TypeError("state commit receiptの期待revisionが一致しません");
  }
  if (
    (receipt.receiptType === "initial_state_commit" ||
      receipt.receiptType === "notification_settlement" ||
      receipt.receiptType === "manual_resolution" ||
      receipt.receiptType === "run_finalization") &&
    ((receipt.result.actualParentStateRevision === "unborn" &&
      receipt.result.expectedTrackingStateRevision !== "unborn") ||
      (receipt.result.interveningOperationsAlertCommits.length === 0 &&
        receipt.result.actualParentStateRevision !==
          receipt.result.expectedTrackingStateRevision) ||
      (receipt.result.interveningOperationsAlertCommits.length > 0 &&
        receipt.result.interveningOperationsAlertCommits.at(-1) !==
          receipt.result.actualParentStateRevision))
  ) {
    throw new TypeError("state commit receiptのCAS親と介在commitが一致しません");
  }
  if (
    (receipt.receiptType === "initial_state_commit" ||
      receipt.receiptType === "notification_settlement" ||
      receipt.receiptType === "manual_resolution" ||
      receipt.receiptType === "run_finalization") &&
    (receipt.binding.bindingKind !== "checkpoint" ||
      receipt.result.commitRunId !== receipt.binding.runId ||
      receipt.result.commitOperationId !== receipt.operationId)
  ) {
    throw new TypeError("state commit receiptとcommit metadataの識別子が一致しません");
  }
  if (
    receipt.receiptType === "initial_state_commit" ||
    receipt.receiptType === "notification_settlement" ||
    receipt.receiptType === "run_finalization"
  ) {
    if (receipt.result.commitScope !== "tracking_run") {
      throw new TypeError("tracking commit receiptのscopeが一致しません");
    }
  }
  if (
    receipt.receiptType === "manual_resolution" &&
    (receipt.result.commitScope !== "manual_resolution" ||
      receipt.logicalTarget !==
        `manual:${receipt.binding.bindingKind === "checkpoint" ? receipt.binding.checkpointDigest : ""}:${receipt.result.deliveryId}:${receipt.result.deliveryAttemptId}:${receipt.result.decision}` ||
      new Set(receipt.result.notificationKeys).size !== receipt.result.notificationKeys.length)
  ) {
    throw new TypeError("手動解決receiptのscopeが一致しません");
  }
  if (
    receipt.receiptKind === "not_required" &&
    receipt.receiptType !== "pages_build" &&
    receipt.receiptType !== "pages_deployment" &&
    receipt.receiptType !== "operations_alert"
  ) {
    throw new TypeError("このreceiptは不要判定を持てません");
  }
  if (receipt.receiptKind === "superseded" && receipt.receiptType !== "pages_deployment") {
    throw new TypeError("このreceiptは新runによる無効化を持てません");
  }
}

/** 論理効果、起動内試行、canonical payloadからreceiptを発行する。 */
export function createReceipt(value: ReceiptDraft, digest: ContentDigestPort): Receipt {
  if (value.receiptKind === "observed") {
    throw new TypeError("observed receiptはstate証拠専用の生成関数から発行してください");
  }
  return sealReceipt(value, digest);
}

/** state evidence照合済みのobserved receiptを発行する。 */
export function sealObservedReceipt(value: ReceiptDraft, digest: ContentDigestPort): Receipt {
  if (value.receiptKind !== "observed") {
    throw new TypeError("observed receipt以外は通常の生成関数を使用してください");
  }
  return sealReceipt(value, digest);
}

function sealReceipt(value: ReceiptDraft, digest: ContentDigestPort): Receipt {
  const draft = draftSchema.parse(value);
  const { operationId, attemptId } = receiptIdentifiers(draft, digest);
  const payload = { ...draft, operationId, attemptId };
  const receiptDigest = digest.sha256Utf8(serializeCanonicalJson(payload));
  const receipt = receiptSchema.parse({
    ...payload,
    receiptDigest,
    receiptId: digestId("receipt", { operationId, attemptId, receiptDigest }, digest),
  });
  assertReceiptSemantics(receipt);
  return receipt;
}

/** receiptのshape、識別子、payload digestを再検証する。 */
export function parseReceipt(value: unknown, digest: ContentDigestPort): Receipt {
  const receipt = receiptSchema.parse(value);
  assertReceiptSemantics(receipt);
  const { receiptId, receiptDigest, ...payload } = receipt;
  if (
    receipt.operationId !== digestId("operation", operationIdentity(receipt), digest) ||
    receipt.attemptId !==
      digestId(
        "attempt",
        {
          operationId: receipt.operationId,
          invocationId: receipt.invocationId,
          localAttemptIndex: receipt.localAttemptIndex,
        },
        digest,
      ) ||
    receiptDigest !== digest.sha256Utf8(serializeCanonicalJson(payload)) ||
    receiptId !==
      digestId(
        "receipt",
        { operationId: receipt.operationId, attemptId: receipt.attemptId, receiptDigest },
        digest,
      )
  ) {
    throw new TypeError("receiptの識別子またはdigestが内容と一致しません");
  }
  return receipt;
}

/** 末尾改行付きcanonical JSONからreceiptを読む。 */
export function decodeReceipt(bytes: Uint8Array, digest: ContentDigestPort): Receipt {
  if (bytes.length > MAX_RECEIPT_BYTES) {
    throw new TypeError("receiptが許容するbyte数を超えています");
  }
  const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const raw: unknown = JSON.parse(source);
  if (source !== serializeCanonicalJsonLine(raw)) {
    throw new TypeError("receiptがcanonical JSONではありません");
  }
  return parseReceipt(raw, digest);
}

/** receiptを末尾改行付きcanonical JSONへ保存する。 */
export function encodeReceipt(value: Receipt, digest: ContentDigestPort): Uint8Array {
  return new TextEncoder().encode(serializeCanonicalJsonLine(parseReceipt(value, digest)));
}
