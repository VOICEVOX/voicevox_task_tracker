import { StatePersistenceSession } from "../../../persistence/index.js";
import type { DailyTransactionDependencies } from "../../daily-transaction.js";
import type { StateRuntimeAdapters } from "../adapters.js";
import type { ProductionTypes } from "../contracts.js";

/** 前回stateの読取段階を既存adapterへ接続する。 */
export function createLoadStateStage(
  adapters: StateRuntimeAdapters,
): DailyTransactionDependencies<ProductionTypes>["loadState"] {
  return async ({ configuration }) => {
    const stateAdapter = adapters.createStateBranchAdapter();
    const session =
      configuration.target.kind === "sandbox"
        ? await StatePersistenceSession.openAtRevision(
            stateAdapter,
            configuration.target.state,
            configuration.target.context.baseStateRevision,
          )
        : await adapters.openStateSession(stateAdapter, configuration.target.state);
    const [snapshot, notificationLedger] = await Promise.all([
      session.loadSnapshot(),
      session.loadNotificationLedger(),
    ]);
    return Object.freeze({
      session,
      snapshot,
      notificationLedger,
    });
  };
}
