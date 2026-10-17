import { projectPreviousSnapshot, readBaseStateIngress } from "../../base-state-ingress.js";
import type { SequentialRunDependencies } from "../../sequential-run-contracts.js";

import type { StateRuntimeAdapters } from "../adapters.js";

/** 前回stateの読取段階を既存adapterへ接続する。 */
export function createLoadStateStage(
  adapters: StateRuntimeAdapters,
): SequentialRunDependencies["loadState"] {
  return async ({ configuration }) => {
    const stateAdapter = adapters.createStateBranchAdapter();
    const ingress = await readBaseStateIngress(
      stateAdapter,
      configuration.target.state,
      configuration.config.staleness.timezone,
      configuration.baseStateHead,
    );
    return Object.freeze({
      ...ingress,
      rawSnapshot: ingress.snapshot,
      previousState: Object.freeze({
        ...ingress.previousState,
        snapshot: projectPreviousSnapshot(ingress.snapshot),
      }),
    });
  };
}
