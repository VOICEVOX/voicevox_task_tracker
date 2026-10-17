import type { InitialPagesPublicationEvidence } from "../../application/tracking-run/initial-pages-evidence-codec.js";
import type { PerformanceDetailObserver } from "../../application/tracking-run/contracts/performance-detail-observation.js";
import type { ReceiptChainEvidence } from "../../application/tracking-run/receipt-chain-schema.js";
import type {
  InitialStateCommitReceipt,
  ManualResolutionReceipt,
  NotificationMessageReceipt,
  PagesBuildReceipt,
  PagesDeploymentReceipt,
  Receipt,
} from "../../application/tracking-run/receipt-schema.js";
import type { Repository } from "../../domain/index.js";
import type {
  StateBranchAdapter,
  StatePersistenceConfiguration,
} from "../../persistence/branch-adapter.js";
import type { DurablePublicationRecord } from "../../publication/durable-record-schema.js";
import type { NotificationMessageSendPort } from "./notification-message-http.js";
import type {
  NotificationCasOutcome,
  NotificationHttpOutcome,
} from "./notification-recovery-contracts.js";

/** 初回Pages成功のreceipt列またはstateへ保存済みの証拠。 */
export type NotificationInitialPagesSource =
  | Readonly<{
      kind: "published";
      buildReceipt: PagesBuildReceipt;
      deploymentReceipt: PagesDeploymentReceipt;
      evidence: InitialPagesPublicationEvidence;
    }>
  | Readonly<{ kind: "state"; evidence: InitialPagesPublicationEvidence }>;

/** 固定outboxの一messageへ結合した送達要求。 */
export type NotificationMessageDeliveryInput = Readonly<{
  record: DurablePublicationRecord;
  initialStateReceipt: InitialStateCommitReceipt;
  initialPages: NotificationInitialPagesSource;
  previousReceipt: Receipt;
  expectedStateRevision: string;
  messageIndex: number;
  invocationId: string;
  localAttemptIndex: number;
  manualResolutionReceipt?: ManualResolutionReceipt;
}>;

/** state、送信、診断の副作用を持つ通知message境界。 */
export type NotificationMessageDeliveryPort = Readonly<{
  adapter: StateBranchAdapter;
  configuration: StatePersistenceConfiguration;
  repositoryInventory: readonly Repository[];
  knownSecrets: readonly string[];
  sender: NotificationMessageSendPort;
  recordDiagnostic: (cause: unknown) => Promise<void>;
  now: () => Date;
  observePerformanceDetail?: PerformanceDetailObserver;
}>;

/** 後続のsettlementが判断できる送達結果。 */
export type NotificationMessageDeliveryOutcome =
  | Readonly<{
      kind: "sent";
      receipt: NotificationMessageReceipt;
      receiptEvidence: ReceiptChainEvidence;
      stateRevision: string;
      discordMessageId: string;
    }>
  | Readonly<{
      kind: "clear_rejection";
      receipt: NotificationMessageReceipt;
      receiptEvidence: ReceiptChainEvidence;
      stateRevision: string;
    }>
  | Readonly<{
      kind: "ambiguous";
      receipt: NotificationMessageReceipt;
      receiptEvidence: ReceiptChainEvidence;
      stateRevision: string;
    }>
  | Readonly<{
      kind: "state_unconfirmed";
      stateRevision: string;
      effectCertainty: "committed" | "no_effect" | "ambiguous";
      casOutcome: NotificationCasOutcome;
      httpOutcome: NotificationHttpOutcome;
      discordMessageId?: string;
    }>
  | Readonly<{ kind: "conflict"; observedHeadRevision: string }>;
