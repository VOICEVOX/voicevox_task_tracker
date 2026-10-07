import type { InitialPagesPublicationEvidence } from "../../application/tracking-run/initial-pages-evidence-codec.js";
import type {
  InitialStateCommitReceipt,
  PagesDeploymentReceipt,
  Receipt,
} from "../../application/tracking-run/receipt-schema.js";
import type { DurablePublicationRecord } from "../../publication/durable-record-schema.js";

/** 失敗した通知操作のstate CAS結果。 */
export type NotificationCasOutcome = "not_attempted" | "no_effect" | "observed" | "unknown";

/** 失敗した通知操作のDiscord HTTP結果。 */
export type NotificationHttpOutcome = "not_started" | "no_effect" | "committed" | "ambiguous";

/** exact stateと別々の副作用結果から決めた通知の復旧先。 */
export type NotificationRecoveryDecision = Readonly<{
  stateRevision: string;
  markerPhase:
    | "initial_state_committed"
    | "notifications_in_progress"
    | "notifications_settled"
    | "run_finalized"
    | "unreadable";
  recoveryDisposition:
    "operator_conflict_resolution" | "manual_resolution_required" | "resume_from_receipt";
  casOutcome: NotificationCasOutcome;
  httpOutcome: NotificationHttpOutcome;
  observationError?: Error;
}>;

export type NotificationRecoveryInput = Readonly<{
  record: DurablePublicationRecord;
  initialStateReceipt: InitialStateCommitReceipt;
  pagesReceipt?: PagesDeploymentReceipt;
  pagesEvidence?: InitialPagesPublicationEvidence;
  lastVerifiedReceipt?: Receipt;
  casOutcome: NotificationCasOutcome;
  httpOutcome: NotificationHttpOutcome;
}>;
