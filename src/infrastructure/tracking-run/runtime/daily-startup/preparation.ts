import { prepareRun } from "../../../../application/tracking-run/prepare-run.js";
import type { SequentialRunDependencies } from "../../sequential-run-contracts.js";

/** 同じbase revisionの前回stateと検証済み設定からrunを準備する。 */
export function createPrepareRunStage(): SequentialRunDependencies["prepareRun"] {
  return ({ request, identity, configuration, state }) => {
    const prepared = prepareRun({
      request,
      identity,
      config: configuration.config,
      configDigest: configuration.configDigest,
      baseState: Object.freeze({
        revision: configuration.baseStateHead,
        snapshot: state.snapshot,
        history: state.history,
        aiCache: state.aiCache,
        personalReminderAiCache: state.personalReminderAiCache,
        notificationLedger: state.notificationLedger,
        previousState: state.previousState,
      }),
    });
    configuration.codexAttemptBudget.bind(prepared.core.aiBudget);
    return prepared;
  };
}
