import { serializeCanonicalJson } from "../../../canonical-json/index.js";
import type { PerformanceDetailObserver } from "../../../application/tracking-run/contracts/performance-detail-observation.js";
import type { StateBranchAdapter } from "../../../persistence/index.js";
import type { PublicationPlan } from "../../../publication/publication-plan-contracts.js";
import type { InitialStateCommitObserver } from "../initial-state-commit-progress.js";
import { commitInitialState } from "../initial-state-commit.js";
import {
  assertBoundPublicationCheckpoint,
  type BoundPublicationCheckpoint,
} from "../publication-checkpoint-binding.js";
import type { PersistedRun, PublicationConfiguration, PublicationState } from "./contracts.js";

/** 完全性検証済みrunの初期保存に必要な値。 */
export type PersistValidatedRunInput = Readonly<{
  configuration: PublicationConfiguration;
  bound: BoundPublicationCheckpoint;
  adapter: StateBranchAdapter;
  now: () => Date;
  observeProgress?: InitialStateCommitObserver;
  observePerformanceDetail?: PerformanceDetailObserver;
}>;

/** 完全性検証済みrunを初期保存し、後続段階へcommit結果だけを渡す。 */
export async function persistValidatedRun(input: PersistValidatedRunInput): Promise<PersistedRun> {
  assertBoundPublicationCheckpoint(input.bound);
  const result = await commitInitialState(input.bound, {
    adapter: input.adapter,
    configuration: input.configuration.target.state,
    migrationTimezone: input.configuration.config.staleness.timezone,
    knownSecrets: input.configuration.credentials.knownSecrets,
    now: input.now,
    ...(input.observeProgress == null ? {} : { observeProgress: input.observeProgress }),
    ...(input.observePerformanceDetail == null
      ? {}
      : { observePerformanceDetail: input.observePerformanceDetail }),
  });
  return Object.freeze({ result });
}

/** state sessionの保存待ちAI cacheが公開計画の値と一致することを確認する。 */
export function assertPlannedAiCacheAdditions(
  state: Pick<PublicationState, "session">,
  plan: PublicationPlan,
): void {
  const writeSet = plan.initialStateWriteSet;
  if (
    serializeCanonicalJson(writeSet.aiCacheAdditions) !==
      serializeCanonicalJson(state.session.pendingAiCacheEntries()) ||
    serializeCanonicalJson(writeSet.personalReminderAiCacheAdditions) !==
      serializeCanonicalJson(state.session.pendingPersonalReminderAiCacheEntries())
  ) {
    throw new TypeError("公開計画のAI cache追加がstate sessionと一致しません");
  }
}
