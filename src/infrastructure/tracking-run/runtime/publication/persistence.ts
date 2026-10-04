import type { SequentialRunDependencies } from "../../sequential-run-contracts.js";

import { readCommittedInitialState } from "../../publication/committed-state.js";
import {
  commitDailyCheckpoint,
  prepareDailyCheckpoint,
} from "../../publication/daily-stage-handlers.js";
import type { ProductionRuntimeAdapters } from "../adapters.js";

type SequentialStageDependencies = SequentialRunDependencies;

/** 直列runのcheckpoint codec往復とbindingを接続する。 */
export function createPrepareCheckpointStage(
  adapters: Pick<
    ProductionRuntimeAdapters,
    "repositoryPath" | "environment" | "createStateBranchAdapter" | "now"
  >,
): SequentialStageDependencies["prepareCheckpoint"] {
  return (input) => prepareDailyCheckpoint({ adapters }, input);
}

/** 検証済みcheckpointを初回stateへcommitする。 */
export function createCommitPreparedCheckpointStage(
  adapters: Pick<ProductionRuntimeAdapters, "createStateBranchAdapter" | "now">,
): SequentialStageDependencies["commitPreparedCheckpoint"] {
  return (input, checkpoint) => commitDailyCheckpoint({ adapters }, input, checkpoint);
}

/** 初回commit後のexact stateを再読込する。 */
export function createReadCommittedStateStage(
  adapters: Pick<ProductionRuntimeAdapters, "createStateBranchAdapter" | "now">,
): SequentialStageDependencies["readCommittedState"] {
  return ({ configuration, reference }) =>
    readCommittedInitialState({
      adapter: adapters.createStateBranchAdapter(),
      configuration: configuration.target.state,
      knownSecrets: configuration.credentials.knownSecrets,
      reference,
      now: adapters.now,
    });
}
