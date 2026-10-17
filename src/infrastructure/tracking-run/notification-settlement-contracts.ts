import type { ReceiptChainEvidence } from "../../application/tracking-run/receipt-chain-schema.js";
import type {
  InitialStateCommitReceipt,
  ManualResolutionReceipt,
  NotificationMessageReceipt,
  NotificationSettlementReceipt,
  PagesDeploymentReceipt,
  Receipt,
} from "../../application/tracking-run/receipt-schema.js";
import type { DurablePublicationRecord } from "../../publication/durable-record-schema.js";
import type {
  NotificationInitialPagesSource,
  NotificationMessageDeliveryPort,
} from "./notification-message-contracts.js";
import type {
  NotificationCasOutcome,
  NotificationHttpOutcome,
  NotificationRecoveryDecision,
} from "./notification-recovery-contracts.js";
import type { NotificationStructureError } from "./notification-structure-error.js";

/** 初回Pages公開後の固定outboxとstateを結合する通知settlement入力。 */
export type NotificationSettlementInput = Readonly<{
  record: DurablePublicationRecord;
  initialStateReceipt: InitialStateCommitReceipt;
  initialPages: NotificationInitialPagesSource;
  pagesReceipt: PagesDeploymentReceipt;
  manualResolutionReceipt?: ManualResolutionReceipt;
}>;

/** 通知の初回stateとPages artifact読込を同じ失敗境界へ渡す。 */
export type NotificationSettlementPreflightInput = Readonly<{
  record: DurablePublicationRecord;
  initialStateReceipt: InitialStateCommitReceipt;
  loadPages: () => Promise<Pick<NotificationSettlementInput, "initialPages" | "pagesReceipt">>;
  manualResolutionReceipt?: ManualResolutionReceipt;
}>;

/** 通知message、state、診断の副作用境界。 */
export type NotificationSettlementPort = NotificationMessageDeliveryPort;

/** settlementに先行する各messageのreceiptと観測証拠。 */
export type SettledMessageReceipt = Readonly<{
  receipt: NotificationMessageReceipt | ManualResolutionReceipt;
  evidence: ReceiptChainEvidence;
}>;

/** 後続finalizationまたは失敗処理へ渡す通知stage結果。 */
export type NotificationSettlementOutcome =
  | Readonly<{
      kind: "settled";
      receipt: NotificationSettlementReceipt;
      receiptEvidence: ReceiptChainEvidence;
      messageReceipts: readonly SettledMessageReceipt[];
      stateRevision: string;
      notificationCount: number;
    }>
  | Readonly<{
      kind: "manual_resolution_required";
      receipt: NotificationMessageReceipt;
      messageReceipts: readonly SettledMessageReceipt[];
      stateRevision: string;
    }>
  | Readonly<{
      kind: "state_unconfirmed";
      messageReceipts: readonly SettledMessageReceipt[];
      stateRevision: string;
      markerPhase: NotificationRecoveryDecision["markerPhase"];
      effectCertainty: "committed" | "no_effect" | "ambiguous";
      casOutcome: NotificationCasOutcome;
      httpOutcome: NotificationHttpOutcome;
      observationError?: Error;
      recoveryDisposition:
        "operator_conflict_resolution" | "manual_resolution_required" | "resume_from_receipt";
      lastReceipt?: Receipt;
      discordMessageId?: string;
    }>
  | Readonly<{
      kind: "structural_failure";
      messageReceipts: readonly SettledMessageReceipt[];
      stateRevision: string;
      markerPhase: NotificationRecoveryDecision["markerPhase"];
      lastReceipt?: Receipt;
      failedOperationEffectCertainty: "no_effect" | "committed";
      casOutcome: NotificationCasOutcome;
      httpOutcome: NotificationHttpOutcome;
      observationError?: Error;
      recoveryDisposition:
        "operator_conflict_resolution" | "manual_resolution_required" | "resume_from_receipt";
      cause: NotificationStructureError;
    }>;
