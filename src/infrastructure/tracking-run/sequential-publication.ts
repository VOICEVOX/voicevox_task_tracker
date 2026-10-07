import {
  completeTrackingRun,
  type CompletedRun,
} from "../../application/tracking-run/complete-run.js";
import type { InitialStateCommitReference } from "../../application/tracking-run/engine.js";
import type { StateCommitReceiptEvidence } from "../../application/tracking-run/observed-state-commit.js";
import type { ReceiptChainEntry } from "../../application/tracking-run/receipt-chain-schema.js";
import type { Receipt } from "../../application/tracking-run/receipt-schema.js";
import { nodeContentDigestPort } from "./content-digest.js";
import type { NotificationSettlementOutcome } from "./notification-settlement-contracts.js";
import type { BoundPublicationCheckpoint } from "./publication-checkpoint-binding.js";
import type {
  InitialPagesPreparedRun,
  InitialPagesPublishedRun,
  NotificationHistoryPagesPreparedRun,
  NotificationHistoryPublishedRun,
  PersistedRun,
} from "./publication/contracts.js";
import type { FinalizeRunOutcome } from "./run-finalization-contracts.js";
import type {
  PostCheckpointPublicationContext,
  SequentialPublicationInput,
} from "./sequential-publication-input.js";
import type { SequentialRunDependencies } from "./sequential-run-contracts.js";
import type { DailyRunRuntime, NotificationStageResult } from "./sequential-result.js";

/** 公開境界へ渡す完全性検証済みの値。 */
export type PublicationStageInput = SequentialPublicationInput;

type CommittedDailyState = PersistedRun &
  Readonly<{
    stateContentDigest: string;
    receiptEvidence: Extract<StateCommitReceiptEvidence, { receiptType: "initial_state_commit" }>;
  }>;

type PreparedDailyPages = Readonly<{
  committed: CommittedDailyState;
  pagesPrepared: InitialPagesPreparedRun;
}>;

type PublishedDailyState = Readonly<{
  committed: CommittedDailyState;
  pages: InitialPagesPublishedRun;
}>;

type SettledDailyState = PublishedDailyState &
  Readonly<{
    notifications: NotificationStageResult<
      Extract<NotificationSettlementOutcome, { kind: "settled" }>
    >;
  }>;

type FinalizedDailyState = SettledDailyState &
  Readonly<{ finalization: Extract<FinalizeRunOutcome, { kind: "finalized" }> }>;

type PreparedHistoryDailyState = FinalizedDailyState &
  Readonly<{ historyPagesPrepared: NotificationHistoryPagesPreparedRun }>;

type HistoryPagesDailyState = FinalizedDailyState &
  Readonly<{ historyPages: NotificationHistoryPublishedRun }>;

/** CLI runnerへ公開段階の副作用と通知実績を渡す。 */
export type DailyPublicationProgress = Readonly<{
  stateCommitted: () => void;
  pagesBuilt: () => void;
  notificationStarted: () => void;
  notificationsSettled: (
    result: NotificationStageResult<Extract<NotificationSettlementOutcome, { kind: "settled" }>>,
  ) => void;
  receiptRecorded: (receipt: Receipt) => void;
}>;

/** 公開段階の成果物をcanonical engineの各段階へ対応させる。 */
export type DailyPublicationStageValues = Readonly<{
  publication_planned: PublicationStageInput;
  initial_state_committed: CommittedDailyState;
  initial_pages_prepared: PreparedDailyPages;
  initial_pages_published: PublishedDailyState;
  notifications_settled: SettledDailyState;
  run_finalized: FinalizedDailyState;
  notification_history_pages_prepared: PreparedHistoryDailyState;
  notification_history_pages_published: HistoryPagesDailyState;
}>;

/** 初回commit後はexact state再読込結果だけを公開段階へ渡す。 */
export function createDailyPublicationStages(
  dependencies: SequentialRunDependencies,
  runtime: DailyRunRuntime,
  progress: DailyPublicationProgress,
  getContext: () => PostCheckpointPublicationContext,
): Readonly<{
  encodeCheckpoint: (input: PublicationStageInput) => Promise<BoundPublicationCheckpoint>;
  commitInitialState: (
    checkpoint: BoundPublicationCheckpoint,
  ) => Promise<InitialStateCommitReference>;
  readCommittedState: (reference: InitialStateCommitReference) => Promise<CommittedDailyState>;
  initialPagesPrepared: (committed: CommittedDailyState) => Promise<PreparedDailyPages>;
  initialPagesPublished: (prepared: PreparedDailyPages) => Promise<PublishedDailyState>;
  notificationsSettled: (published: PublishedDailyState) => Promise<SettledDailyState>;
  runFinalized: (settled: SettledDailyState) => Promise<FinalizedDailyState>;
  notificationHistoryPagesPrepared: (
    finalized: FinalizedDailyState,
  ) => Promise<PreparedHistoryDailyState>;
  notificationHistoryPagesPublished: (
    prepared: PreparedHistoryDailyState,
  ) => Promise<HistoryPagesDailyState>;
  complete: (published: HistoryPagesDailyState) => Promise<CompletedRun>;
}> {
  const receiptChain: ReceiptChainEntry[] = [];
  const appendReceipts = async (...entries: readonly ReceiptChainEntry[]): Promise<void> => {
    receiptChain.push(...entries);
    await dependencies.writeReceiptChain(getContext().invocation.runId, receiptChain);
  };
  return Object.freeze({
    encodeCheckpoint: (input) => dependencies.prepareCheckpoint(input),
    commitInitialState: async (bound) => {
      const persisted = await dependencies.commitPreparedCheckpoint(
        getContext().configuration,
        bound,
      );
      progress.stateCommitted();
      return Object.freeze({
        stateRevision: persisted.result.revision,
        stateContentDigest: persisted.result.receipt.result.stateContentDigest,
      });
    },
    readCommittedState: async (reference) => {
      const committed = await dependencies.readCommittedState({
        configuration: getContext().configuration,
        reference,
      });
      progress.receiptRecorded(committed.result.receipt);
      await appendReceipts({
        receipt: committed.result.receipt,
        evidence: { kind: "state_commit", state: committed.receiptEvidence },
      });
      return committed;
    },
    initialPagesPrepared: async (committed) => {
      const input = getContext();
      const pagesPrepared = await dependencies.buildPages({
        invocation: input.invocation,
        configuration: input.configuration,
        persisted: committed,
      });
      progress.pagesBuilt();
      progress.receiptRecorded(pagesPrepared.receipt);
      await appendReceipts({ receipt: pagesPrepared.receipt, evidence: { kind: "none" } });
      return Object.freeze({ committed, pagesPrepared });
    },
    initialPagesPublished: async (prepared) => {
      const input = getContext();
      const pages = await dependencies.deployPages({
        invocation: input.invocation,
        configuration: input.configuration,
        persisted: prepared.committed,
        pagesPrepared: prepared.pagesPrepared,
      });
      progress.receiptRecorded(pages.deployment.receipt);
      await appendReceipts({
        receipt: pages.deployment.receipt,
        evidence: pages.receiptEvidence,
      });
      return Object.freeze({ committed: prepared.committed, pages });
    },
    notificationsSettled: async (published) => {
      const input = getContext();
      progress.notificationStarted();
      const notifications = await dependencies.settleNotifications({
        invocation: input.invocation,
        configuration: input.configuration,
        persisted: published.committed,
        pages: published.pages,
      });
      progress.notificationsSettled(notifications);
      progress.receiptRecorded(notifications.value.receipt);
      await appendReceipts(...notifications.value.messageReceipts, {
        receipt: notifications.value.receipt,
        evidence: notifications.value.receiptEvidence,
      });
      return Object.freeze({ ...published, notifications });
    },
    runFinalized: async (settled) => {
      const input = getContext();
      const finalization = await dependencies.finalizeRun({
        invocation: input.invocation,
        configuration: input.configuration,
        persisted: settled.committed,
        notifications: settled.notifications.value,
      });
      progress.receiptRecorded(finalization.receipt);
      await appendReceipts({
        receipt: finalization.receipt,
        evidence: finalization.receiptEvidence,
      });
      return Object.freeze({ ...settled, finalization });
    },
    notificationHistoryPagesPrepared: async (finalized) => {
      const historyPagesPrepared = await dependencies.buildNotificationHistoryPages({
        configuration: getContext().configuration,
        settlementReceipt: finalized.notifications.value.receipt,
        finalizationReceipt: finalized.finalization.receipt,
      });
      progress.receiptRecorded(historyPagesPrepared.receipt);
      await appendReceipts({ receipt: historyPagesPrepared.receipt, evidence: { kind: "none" } });
      return Object.freeze({ ...finalized, historyPagesPrepared });
    },
    notificationHistoryPagesPublished: async (prepared) => {
      const input = getContext();
      const historyPages = await dependencies.deployNotificationHistoryPages({
        configuration: input.configuration,
        prepared: prepared.historyPagesPrepared,
        settlementReceipt: prepared.notifications.value.receipt,
        finalizationReceipt: prepared.finalization.receipt,
        runId: input.invocation.runId,
      });
      progress.receiptRecorded(historyPages.deployment.receipt);
      await appendReceipts({
        receipt: historyPages.deployment.receipt,
        evidence: { kind: "none" },
      });
      return Object.freeze({ ...prepared, historyPages });
    },
    complete: (published) =>
      Promise.resolve(
        completeTrackingRun(
          {
            entries: receiptChain,
            finalStateRevision: published.finalization.stateRevision,
            invocationId: getContext().invocation.invocationId,
            observedAt: runtime.now().toISOString(),
          },
          nodeContentDigestPort,
        ),
      ),
  });
}
