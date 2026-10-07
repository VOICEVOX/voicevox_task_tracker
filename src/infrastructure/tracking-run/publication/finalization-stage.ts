import { readNotificationMessageState } from "../notification-message-state.js";
import { createNotificationSettlementPort } from "../notification-stage-runtime.js";
import { finalizeRun } from "../run-finalization.js";
import type { DailyPublicationStageHandlers } from "./stage-handler-contracts.js";
import type { RunPublicationAdapters } from "./contracts.js";

type FinalizationAdapters = Pick<
  RunPublicationAdapters,
  | "environment"
  | "createStateBranchAdapter"
  | "discordHttpClient"
  | "diagnosticsRecorder"
  | "now"
  | "sleep"
  | "random"
  | "observePerformanceDetail"
>;

/** settlementのexact stateから完了reportを一つのCASへ確定する。 */
export async function finalizeDailyRun(
  adapters: FinalizationAdapters,
  input: Parameters<DailyPublicationStageHandlers["finalizeRun"]>[0],
): ReturnType<DailyPublicationStageHandlers["finalizeRun"]> {
  const configuration = input.configuration.target.state;
  const state = await readNotificationMessageState(
    adapters.createStateBranchAdapter(),
    configuration,
    input.notifications.stateRevision,
  );
  const outcome = await finalizeRun(
    {
      record: state.transaction.record,
      initialStateReceipt: input.persisted.result.receipt,
      settlementReceipt: input.notifications.receipt,
    },
    createNotificationSettlementPort(
      adapters,
      configuration,
      state.snapshot.repositories,
      input.configuration.credentials.knownSecrets,
      input.configuration.target.kind === "production" ? "production" : "recording",
    ),
  );
  if (outcome.kind !== "finalized") {
    throw new TypeError(`run finalizationを確定できません。状態: ${outcome.kind}`);
  }
  return outcome;
}
