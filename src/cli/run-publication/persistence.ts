import type { Config } from "../../config/index.js";
import { createUtcIsoDateTime } from "../../domain/index.js";
import type { Repository } from "../../domain/index.js";
import { createStateSnapshot } from "../../persistence/index.js";
import type { WorkflowRunMetadata } from "../workflow-artifact.js";
import { createPersistedRunReport } from "./metadata.js";
import type {
  PersistedRun,
  PublicationConfiguration,
  PublicationRepositoryInventory,
  PublicationState,
  ResolveCompletedTrackingStartAt,
  RunCompletionDelivery,
  RunPublicationAdapters,
  ValidatedRun,
} from "./contracts.js";

/** 完全性検証済みrunの初期保存に必要な値。 */
export type PersistValidatedRunInput = Readonly<{
  configuration: PublicationConfiguration;
  state: PublicationState;
  inventory: PublicationRepositoryInventory;
  validated: ValidatedRun;
}>;

/** 完全性検証済みrunを初期保存し、Pages用履歴を読む。 */
export async function persistValidatedRun(input: PersistValidatedRunInput): Promise<PersistedRun> {
  const result = await input.state.session.persist({
    snapshot: input.validated.snapshot,
    historyInputEvents: input.validated.historyInputEvents,
    notificationLedger: input.validated.notificationLedger,
    repositoryInventory: input.inventory.inventory,
    knownSecrets: input.configuration.credentials.knownSecrets,
  });
  if (input.configuration.target.kind === "sandbox") {
    await input.state.session.publish();
  }
  const historyRecords = await input.state.session.loadHistoryRecords();
  return Object.freeze({
    result,
    historyRecords,
    notificationLedger: input.validated.notificationLedger,
  });
}

/** 完了保存に必要な状態、通知結果、時刻関数。 */
export type PersistSuccessfulRunCompletionInput = Readonly<{
  now: RunPublicationAdapters["now"];
  config: Config;
  state: PublicationState;
  repositoryInventory: readonly Repository[];
  validated: ValidatedRun;
  runMetadata: WorkflowRunMetadata;
  delivery: RunCompletionDelivery;
  knownSecrets: readonly string[];
  resolveCompletedTrackingStartAt: ResolveCompletedTrackingStartAt;
}>;

/** 通知結果を含む完了状態を保存し、state branchへpublishする。 */
export async function persistSuccessfulRunCompletion(
  input: PersistSuccessfulRunCompletionInput,
): Promise<void> {
  const completedAt = createUtcIsoDateTime(input.now().toISOString());
  const persistedSnapshot = await input.state.session.loadSnapshot();
  if (persistedSnapshot.status !== "available") {
    throw new TypeError("run完了対象のstate snapshotがありません");
  }
  if (persistedSnapshot.snapshot.run.id !== input.validated.snapshot.run.id) {
    throw new TypeError("run完了対象のrunがstate snapshotと一致しません");
  }
  const snapshot = persistedSnapshot.snapshot;
  const trackingStartAt = input.resolveCompletedTrackingStartAt(
    input.config,
    snapshot,
    completedAt,
  );
  await input.state.session.persistRunCompletion({
    snapshot: createStateSnapshot({
      ...snapshot,
      trackingStartAt,
    }),
    notificationEvents: Object.freeze([]),
    notificationLedger: input.delivery.notificationLedger,
    runReport: createPersistedRunReport({
      snapshot,
      metadata: input.runMetadata,
      notificationCount: input.delivery.notificationCount,
      finishedAt: completedAt,
    }),
    repositoryInventory: input.repositoryInventory,
    knownSecrets: input.knownSecrets,
  });
  await input.state.session.publish();
}
