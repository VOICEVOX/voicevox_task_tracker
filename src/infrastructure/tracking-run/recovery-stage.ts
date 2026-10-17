import type { InitialPagesPublicationEvidence } from "../../application/tracking-run/initial-pages-evidence-codec.js";
import type { StateCommitReceiptEvidence } from "../../application/tracking-run/observed-state-commit.js";
import type { ContentDigestPort } from "../../application/tracking-run/contracts/content-digest-port.js";
import type {
  NotificationMessageReceipt,
  PagesBuildReceipt,
  PagesDeploymentReceipt,
  Receipt,
} from "../../application/tracking-run/receipt-schema.js";
import type { RunTransactionMarker } from "../../application/tracking-run/run-transaction-marker.js";
import type { StateNotificationLedger } from "../../persistence/state-documents.js";
import type { DurablePublicationRecord } from "../../publication/durable-record-schema.js";
import type { ExactPublicationStateView } from "./publication-resume-contracts.js";
import {
  resumeFinalization,
  resumeInitialPagesBuild,
  resumeInitialPagesDeploy,
  resumeNotificationHistoryBuild,
  resumeNotificationHistoryDeploy,
  resumeNotifications,
  type InitialPagesBuildInput,
  type InitialPagesDeployInput,
  type NotificationHistoryPagesBuildInput,
  type NotificationHistoryPagesDeployInput,
  type NotificationsInput,
  type RunFinalizationInput,
} from "./publication-resume-inputs.js";

type RecoveryStageBase = Readonly<{
  record: DurablePublicationRecord;
  marker: RunTransactionMarker;
  exactStateRevision: string;
  initialStateRevision: string;
  snapshotDigest: string;
  normalNotificationLedgerDigest: string;
  receiptChain: readonly Receipt[];
}>;

type StateReceiptObservation = Readonly<{
  receipt: Receipt;
  evidence: StateCommitReceiptEvidence;
}>;

/** exact stateとreceiptから次の副作用段階へ渡す入力。 */
export type RecoveryStageInput =
  | (RecoveryStageBase &
      Readonly<{ stage: "initial_pages_build"; resumeInput: InitialPagesBuildInput }>)
  | (RecoveryStageBase &
      Readonly<{
        stage: "initial_pages_deploy";
        buildReceipt: PagesBuildReceipt;
        resumeInput: InitialPagesDeployInput;
      }>)
  | (RecoveryStageBase &
      Readonly<{
        stage: "notifications";
        source:
          | Readonly<{ kind: "deployment_receipt"; receipt: PagesDeploymentReceipt }>
          | Readonly<{
              kind: "state_evidence";
              evidence: InitialPagesPublicationEvidence;
              observedReceipt: PagesDeploymentReceipt;
            }>;
        notificationLedger: StateNotificationLedger;
        resumeInput: NotificationsInput;
      }>)
  | (RecoveryStageBase &
      Readonly<{
        stage: "run_finalization";
        notificationLedger: StateNotificationLedger;
        resumeInput: RunFinalizationInput;
      }>)
  | (RecoveryStageBase &
      Readonly<{
        stage: "notification_history_build";
        resumeInput: NotificationHistoryPagesBuildInput;
      }>)
  | (RecoveryStageBase &
      Readonly<{
        stage: "notification_history_deploy";
        buildReceipt: PagesBuildReceipt;
        resumeInput: NotificationHistoryPagesDeployInput;
      }>)
  | (RecoveryStageBase & Readonly<{ stage: "completed" }>);

function exactStateView(base: RecoveryStageBase): ExactPublicationStateView {
  return {
    revision: base.exactStateRevision,
    snapshotDigest: base.snapshotDigest,
    normalNotificationLedgerDigest: base.normalNotificationLedgerDigest,
    marker: {
      runId: base.marker.runId,
      checkpointDigest: base.marker.checkpointDigest,
      publicationRecordDigest: base.marker.publicationRecordDigest,
      phase: base.marker.phase,
      phaseSequence: base.marker.phaseSequence,
      ...(base.marker.phase === "initial_state_committed"
        ? {}
        : {
            initialStateRevision: base.marker.initialStateRevision,
            initialPagesPublicationEvidenceDigest:
              base.marker.initialPagesPublicationEvidenceDigest,
          }),
    },
  };
}

function requiredStateReceipt(
  observation: StateReceiptObservation | undefined,
  kind: StateCommitReceiptEvidence["receiptType"],
): StateReceiptObservation {
  if (observation?.receipt.receiptType !== kind || observation.evidence.receiptType !== kind) {
    throw new TypeError("再開段階に必要なstate commit receiptの根拠がありません");
  }
  return observation;
}

function latestPagesBuildReceipt(
  receipts: readonly Receipt[],
  phase: "initial" | "notification_history",
): PagesBuildReceipt | undefined {
  for (const receipt of [...receipts].reverse()) {
    if (receipt.receiptType === "pages_build" && receipt.phase === phase) {
      return receipt;
    }
  }
  return undefined;
}

function latestPagesDeploymentReceipt(
  receipts: readonly Receipt[],
  phase: "initial" | "notification_history",
): PagesDeploymentReceipt | undefined {
  for (const receipt of [...receipts].reverse()) {
    if (receipt.receiptType === "pages_deployment" && receipt.phase === phase) {
      return receipt;
    }
  }
  return undefined;
}

function assertHttpReceiptsUnambiguous(receipts: readonly Receipt[]): void {
  let unresolved: NotificationMessageReceipt | undefined;
  for (const receipt of receipts) {
    if (receipt.receiptType === "pages_deployment" && receipt.effectCertainty === "ambiguous") {
      throw new TypeError("外部HTTP結果が曖昧な操作を自動再開できません");
    }
    if (receipt.receiptType === "notification_message" && receipt.status === "ambiguous") {
      if (unresolved != null) {
        throw new TypeError("未解決の通知送達より後に別の曖昧送達があります");
      }
      unresolved = receipt;
    }
    if (receipt.receiptType === "manual_resolution") {
      if (unresolved == null) {
        throw new TypeError("手動解決receiptが曖昧送達試行と一致しません");
      }
      if (
        receipt.result.deliveryId !== unresolved.result.deliveryId ||
        receipt.expectedStateRevision !== unresolved.result.ledgerStateRevision
      ) {
        throw new TypeError("手動解決receiptが曖昧送達試行と一致しません");
      }
      unresolved = undefined;
    }
  }
  if (unresolved != null) {
    throw new TypeError("外部HTTP結果が曖昧な操作を自動再開できません");
  }
}

/** 保存済みphaseと確定効果から次の一段階だけを選ぶ。 */
export function selectRecoveryStage(
  base: RecoveryStageBase,
  notificationLedger: StateNotificationLedger,
  evidence: InitialPagesPublicationEvidence | undefined,
  stateReceipt: StateReceiptObservation | undefined,
  observation: Readonly<{ invocationId: string; observedAt: string }>,
  digest: ContentDigestPort,
): RecoveryStageInput {
  const { marker, record, receiptChain } = base;
  const resumeBase = {
    record,
    state: exactStateView(base),
    expectedRevision: base.exactStateRevision,
  };
  if (notificationLedger.entries.some((entry) => entry.status === "delivery_started")) {
    throw new TypeError("配送開始済みの通知は外部結果の手動解決が必要です");
  }
  assertHttpReceiptsUnambiguous(receiptChain);
  if (marker.phase === "initial_state_committed") {
    const deployed = latestPagesDeploymentReceipt(receiptChain, "initial");
    if (deployed?.receiptKind === "superseded") {
      throw new TypeError("新しいrunによって初回Pages公開が無効化されています");
    }
    if (deployed?.effectCertainty === "committed" && deployed.result != null) {
      const resumeInput = resumeNotifications(
        {
          ...resumeBase,
          source: { kind: "deployment_receipt", initialPagesDeploymentReceipt: deployed },
        },
        digest,
      );
      return Object.freeze({
        ...base,
        stage: "notifications",
        source: Object.freeze({ kind: "deployment_receipt", receipt: deployed }),
        notificationLedger,
        resumeInput,
      });
    }
    const initial = requiredStateReceipt(stateReceipt, "initial_state_commit");
    if (
      initial.receipt.receiptType !== "initial_state_commit" ||
      initial.evidence.receiptType !== "initial_state_commit"
    ) {
      throw new TypeError("初回state commitの観測結果が不正です");
    }
    const built = latestPagesBuildReceipt(receiptChain, "initial");
    if (built?.status === "built" && built.result != null) {
      const resumeInput = resumeInitialPagesDeploy(
        {
          ...resumeBase,
          initialStateCommitReceipt: initial.receipt,
          initialStateCommitEvidence: initial.evidence,
          initialPagesBuildReceipt: built,
        },
        digest,
      );
      return Object.freeze({
        ...base,
        stage: "initial_pages_deploy",
        buildReceipt: built,
        resumeInput,
      });
    }
    const resumeInput = resumeInitialPagesBuild(
      {
        ...resumeBase,
        initialStateCommitReceipt: initial.receipt,
        initialStateCommitEvidence: initial.evidence,
      },
      digest,
    );
    return Object.freeze({ ...base, stage: "initial_pages_build", resumeInput });
  }
  if (evidence?.evidenceDigest !== marker.initialPagesPublicationEvidenceDigest) {
    throw new TypeError("通知段階のPages保存証拠が一致しません");
  }
  if (marker.phase === "notifications_in_progress") {
    const resumeInput = resumeNotifications(
      {
        ...resumeBase,
        source: {
          kind: "state_evidence",
          initialPagesEvidence: evidence,
          invocationId: observation.invocationId,
          localAttemptIndex: 0,
          phaseSequence: 1,
          previousReceiptDigest: evidence.deploymentReceiptDigest,
          observedAt: observation.observedAt,
        },
      },
      digest,
    );
    return Object.freeze({
      ...base,
      stage: "notifications",
      source: Object.freeze({
        kind: "state_evidence",
        evidence,
        observedReceipt: resumeInput.initialPagesDeploymentReceipt,
      }),
      notificationLedger,
      resumeInput,
    });
  }
  if (marker.phase === "notifications_settled") {
    const settlement = requiredStateReceipt(stateReceipt, "notification_settlement");
    if (
      settlement.receipt.receiptType !== "notification_settlement" ||
      settlement.evidence.receiptType !== "notification_settlement"
    ) {
      throw new TypeError("通知settlementの観測結果が不正です");
    }
    const resumeInput = resumeFinalization(
      {
        ...resumeBase,
        notificationSettlementReceipt: settlement.receipt,
        notificationSettlementEvidence: settlement.evidence,
      },
      digest,
    );
    return Object.freeze({ ...base, stage: "run_finalization", notificationLedger, resumeInput });
  }
  const finalization = requiredStateReceipt(stateReceipt, "run_finalization");
  if (
    finalization.receipt.receiptType !== "run_finalization" ||
    finalization.evidence.receiptType !== "run_finalization"
  ) {
    throw new TypeError("run finalizationの観測結果が不正です");
  }
  const deployed = latestPagesDeploymentReceipt(receiptChain, "notification_history");
  const built = latestPagesBuildReceipt(receiptChain, "notification_history");
  if (deployed?.receiptKind === "superseded") {
    throw new TypeError("新しいrunによって通知履歴Pages公開が無効化されています");
  }
  if (
    (deployed?.effectCertainty === "committed" &&
      deployed.result != null &&
      built?.status === "built") ||
    (deployed?.status === "not_required" && built?.status === "not_required")
  ) {
    return Object.freeze({ ...base, stage: "completed" });
  }
  if (
    built != null &&
    ((built.status === "built" && built.result != null) || built.status === "not_required")
  ) {
    const resumeInput = resumeNotificationHistoryDeploy(
      {
        ...resumeBase,
        runFinalizationReceipt: finalization.receipt,
        runFinalizationEvidence: finalization.evidence,
        notificationHistoryPagesBuildReceipt: built,
      },
      digest,
    );
    return Object.freeze({
      ...base,
      stage: "notification_history_deploy",
      buildReceipt: built,
      resumeInput,
    });
  }
  const resumeInput = resumeNotificationHistoryBuild(
    {
      ...resumeBase,
      runFinalizationReceipt: finalization.receipt,
      runFinalizationEvidence: finalization.evidence,
    },
    digest,
  );
  return Object.freeze({ ...base, stage: "notification_history_build", resumeInput });
}
