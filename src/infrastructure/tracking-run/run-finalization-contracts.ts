import type { PerformanceDetailObserver } from "../../application/tracking-run/contracts/performance-detail-observation.js";
import type { ReceiptChainEvidence } from "../../application/tracking-run/receipt-chain-schema.js";
import type {
  InitialStateCommitReceipt,
  NotificationSettlementReceipt,
  RunFinalizationReceipt,
} from "../../application/tracking-run/receipt-schema.js";
import type { Repository } from "../../domain/index.js";
import type {
  StateBranchAdapter,
  StatePersistenceConfiguration,
} from "../../persistence/branch-adapter.js";
import type { StateRunReport } from "../../persistence/state-run-report.js";
import type { DurablePublicationRecord } from "../../publication/durable-record-schema.js";

/** settlementと初回state receiptから最終commitを開始する入力。 */
export type FinalizeRunInput = Readonly<{
  record: DurablePublicationRecord;
  initialStateReceipt: InitialStateCommitReceipt;
  settlementReceipt: NotificationSettlementReceipt;
}>;

/** run finalizationのstateと診断境界。 */
export type FinalizeRunPort = Readonly<{
  adapter: StateBranchAdapter;
  configuration: StatePersistenceConfiguration;
  repositoryInventory: readonly Repository[];
  knownSecrets: readonly string[];
  recordDiagnostic: (cause: unknown) => Promise<void>;
  now: () => Date;
  observePerformanceDetail?: PerformanceDetailObserver;
}>;

/** finalizationの確定状態または未確定状態。 */
export type FinalizeRunOutcome =
  | Readonly<{
      kind: "finalized";
      receipt: RunFinalizationReceipt;
      receiptEvidence: ReceiptChainEvidence;
      stateRevision: string;
      report: StateRunReport;
    }>
  | Readonly<{ kind: "state_unconfirmed"; stateRevision: string }>
  | Readonly<{ kind: "conflict"; observedHeadRevision: string }>;
