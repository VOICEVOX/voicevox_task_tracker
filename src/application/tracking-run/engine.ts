import {
  trackingRunStageNames,
  type AnalysisRunStageName,
  type TrackingRunStageName,
} from "./contracts/closed-values.js";
import type { CompletedRun } from "./complete-run.js";
import type { FailedRun } from "./failure-artifact.js";
import type { BaseStateRevision } from "./contracts/run-core.js";

/** 新規runが通るcanonical stageの唯一の順序。 */
export const trackingRunStageOrder = trackingRunStageNames;

/** 保存済みrunのeffect再開位置とcanonical stageの対応。 */
export const pendingEffectStageMap = Object.freeze({
  initial_pages_build: "initial_pages_prepared",
  initial_pages_deploy: "initial_pages_published",
  notifications: "notifications_settled",
  run_finalization: "run_finalized",
  notification_history_build: "notification_history_pages_prepared",
  notification_history_deploy: "notification_history_pages_published",
  completed: "completed",
} satisfies Readonly<Record<string, TrackingRunStageName>>);

/** 分割実行で一つのcanonical段階だけを進める。 */
export async function runTrackingStageOnce<Value>(
  completedStage: TrackingRunStageName,
  nextStage: TrackingRunStageName,
  execute: () => Promise<Value>,
): Promise<Value> {
  const completedIndex = trackingRunStageOrder.indexOf(completedStage);
  const nextIndex = trackingRunStageOrder.indexOf(nextStage);
  if (completedIndex < 0 || nextIndex !== completedIndex + 1) {
    throw new TypeError("分割runの段階順がcanonical順序と一致しません");
  }
  return execute();
}

/** 初回commit後にメモリ上のcheckpointを破棄して渡す識別子。 */
export type InitialStateCommitReference = Readonly<{
  stateRevision: string;
  stateContentDigest: string;
}>;

/** 直列engineが受け取る段階成果物の型対応。 */
export type TrackingRunStageValues = Readonly<
  Record<Exclude<TrackingRunStageName, "completed">, object>
>;

/** 新規runの各canonical stageを実行するport。 */
export type NewRunStagePorts<Stages extends TrackingRunStageValues, Checkpoint> = Readonly<{
  prepare: () => Promise<Stages["prepared"]>;
  inventoryCollected: (value: Stages["prepared"]) => Promise<Stages["inventory_collected"]>;
  collected: (value: Stages["inventory_collected"]) => Promise<Stages["collected"]>;
  deterministicallyAnalyzed: (
    value: Stages["collected"],
  ) => Promise<Stages["deterministically_analyzed"]>;
  genericAiPlanned: (
    value: Stages["deterministically_analyzed"],
  ) => Promise<Stages["generic_ai_planned"]>;
  genericAiExecuted: (
    value: Stages["generic_ai_planned"],
  ) => Promise<Stages["generic_ai_executed"]>;
  genericAiAdopted: (value: Stages["generic_ai_executed"]) => Promise<Stages["generic_ai_adopted"]>;
  graphReconciled: (value: Stages["generic_ai_adopted"]) => Promise<Stages["graph_reconciled"]>;
  personalReminderPlanned: (
    value: Stages["graph_reconciled"],
  ) => Promise<Stages["personal_reminder_planned"]>;
  personalReminderExecuted: (
    value: Stages["personal_reminder_planned"],
  ) => Promise<Stages["personal_reminder_executed"]>;
  personalReminderFinalized: (
    value: Stages["personal_reminder_executed"],
  ) => Promise<Stages["personal_reminder_finalized"]>;
  validated: (value: Stages["personal_reminder_finalized"]) => Promise<Stages["validated"]>;
  publicationPlanned: (value: Stages["validated"]) => Promise<Stages["publication_planned"]>;
  encodeCheckpoint: (value: Stages["publication_planned"]) => Promise<Checkpoint>;
  commitInitialState: (checkpoint: Checkpoint) => Promise<InitialStateCommitReference>;
  readCommittedState: (
    reference: InitialStateCommitReference,
  ) => Promise<Stages["initial_state_committed"] & Readonly<{ stateContentDigest: string }>>;
  initialPagesPrepared: (
    value: Stages["initial_state_committed"],
  ) => Promise<Stages["initial_pages_prepared"]>;
  initialPagesPublished: (
    value: Stages["initial_pages_prepared"],
  ) => Promise<Stages["initial_pages_published"]>;
  notificationsSettled: (
    value: Stages["initial_pages_published"],
  ) => Promise<Stages["notifications_settled"]>;
  runFinalized: (value: Stages["notifications_settled"]) => Promise<Stages["run_finalized"]>;
  notificationHistoryPagesPrepared: (
    value: Stages["run_finalized"],
  ) => Promise<Stages["notification_history_pages_prepared"]>;
  notificationHistoryPagesPublished: (
    value: Stages["notification_history_pages_prepared"],
  ) => Promise<Stages["notification_history_pages_published"]>;
  complete: (value: Stages["notification_history_pages_published"]) => Promise<CompletedRun>;
}>;

/** launcherとengineの組合せを実行前に照合する判断。 */
export type TrackingRunLaunchDecision<Pending> = Readonly<{
  runtime: "current" | "exact";
  decision:
    | Readonly<{ kind: "start_new"; baseRevision: BaseStateRevision }>
    | Readonly<{ kind: "resume_pending"; pending: Pending }>
    | Readonly<{ kind: "completed"; completed: CompletedRun; runId: string }>
    | Readonly<{
        kind: "manual_resolution_required" | "operator_conflict_resolution";
        failure: FailedRun;
      }>;
}>;

/** 再開段階の入力をeffect後にexact stateから再検証するport。 */
export type PendingRunPorts<
  Pending extends Readonly<{ stage: keyof typeof pendingEffectStageMap }>,
> = Readonly<{
  inspect: () => Promise<Pending>;
  execute: Readonly<
    Record<
      Exclude<keyof typeof pendingEffectStageMap, "completed">,
      (pending: Pending) => Promise<void>
    >
  >;
  complete: (pending: Pending) => Promise<CompletedRun>;
}>;

/** engineの失敗を元のerrorと段階から型付き結果へ変えるport。 */
export type TrackingRunFailurePort = Readonly<{
  beforeStage: (stage: FailedRun["failedStage"]) => Promise<void>;
  fail: (stage: FailedRun["failedStage"], error: unknown) => Promise<FailedRun>;
}>;

/** 準備から公開計画までのcanonical stageを共通順序で実行する。 */
export async function runTrackingAnalysis<Stages extends TrackingRunStageValues, Checkpoint>(
  stages: NewRunStagePorts<Stages, Checkpoint>,
  boundary: TrackingRunFailurePort,
): Promise<
  | Readonly<{
      kind: "planned";
      value: Stages["publication_planned"];
      completedStages: readonly AnalysisRunStageName[];
    }>
  | Readonly<{ kind: "failed"; failure: FailedRun }>
> {
  let failedStage: FailedRun["failedStage"] = "prepare";
  const completedStages: AnalysisRunStageName[] = [];
  const step = async <Value>(
    stage: AnalysisRunStageName,
    action: () => Promise<Value>,
  ): Promise<Value> => {
    failedStage = stage;
    await boundary.beforeStage(stage);
    const value = await action();
    completedStages.push(stage);
    return value;
  };
  try {
    const prepared = await step("prepared", () => stages.prepare());
    const inventory = await step("inventory_collected", () => stages.inventoryCollected(prepared));
    const collected = await step("collected", () => stages.collected(inventory));
    const analyzed = await step("deterministically_analyzed", () =>
      stages.deterministicallyAnalyzed(collected),
    );
    const aiPlanned = await step("generic_ai_planned", () => stages.genericAiPlanned(analyzed));
    const aiExecuted = await step("generic_ai_executed", () => stages.genericAiExecuted(aiPlanned));
    const aiAdopted = await step("generic_ai_adopted", () => stages.genericAiAdopted(aiExecuted));
    const graph = await step("graph_reconciled", () => stages.graphReconciled(aiAdopted));
    const reminderPlanned = await step("personal_reminder_planned", () =>
      stages.personalReminderPlanned(graph),
    );
    const reminderExecuted = await step("personal_reminder_executed", () =>
      stages.personalReminderExecuted(reminderPlanned),
    );
    const reminderFinalized = await step("personal_reminder_finalized", () =>
      stages.personalReminderFinalized(reminderExecuted),
    );
    const validated = await step("validated", () => stages.validated(reminderFinalized));
    const planned = await step("publication_planned", () => stages.publicationPlanned(validated));
    return Object.freeze({
      kind: "planned",
      value: planned,
      completedStages: Object.freeze(completedStages),
    });
  } catch (error: unknown) {
    return Object.freeze({ kind: "failed", failure: await boundary.fail(failedStage, error) });
  }
}

/** 新規runの解析、checkpoint、公開、完了をcanonical順に実行する。 */
export async function runNewTrackingRun<Stages extends TrackingRunStageValues, Checkpoint>(
  stages: NewRunStagePorts<Stages, Checkpoint>,
  boundary: TrackingRunFailurePort,
): Promise<CompletedRun | FailedRun> {
  const analysis = await runTrackingAnalysis(stages, boundary);
  if (analysis.kind === "failed") {
    return analysis.failure;
  }
  return runPlannedTrackingRun(analysis.value, stages, boundary);
}

/** 解析済みrunをcheckpointから完了まで同じcanonical順序で進める。 */
export async function runPlannedTrackingRun<Stages extends TrackingRunStageValues, Checkpoint>(
  planned: Stages["publication_planned"],
  stages: NewRunStagePorts<Stages, Checkpoint>,
  boundary: TrackingRunFailurePort,
): Promise<CompletedRun | FailedRun> {
  let failedStage: FailedRun["failedStage"] = "checkpoint_encoding";
  const step = async <Value>(
    stage: FailedRun["failedStage"],
    action: () => Promise<Value>,
  ): Promise<Value> => {
    failedStage = stage;
    await boundary.beforeStage(stage);
    return action();
  };
  try {
    let reference: InitialStateCommitReference;
    {
      const checkpoint = await step("checkpoint_encoding", () => stages.encodeCheckpoint(planned));
      reference = await step("initial_state_committed", () =>
        stages.commitInitialState(checkpoint),
      );
    }
    const committed = await step("initial_state_committed", () =>
      stages.readCommittedState(reference),
    );
    if (committed.stateContentDigest !== reference.stateContentDigest) {
      throw new TypeError("初回commit後に再読込したstateが一致しません");
    }
    const pagesPrepared = await step("initial_pages_prepared", () =>
      stages.initialPagesPrepared(committed),
    );
    const pagesPublished = await step("initial_pages_published", () =>
      stages.initialPagesPublished(pagesPrepared),
    );
    const notifications = await step("notifications_settled", () =>
      stages.notificationsSettled(pagesPublished),
    );
    const finalized = await step("run_finalized", () => stages.runFinalized(notifications));
    const historyPrepared = await step("notification_history_pages_prepared", () =>
      stages.notificationHistoryPagesPrepared(finalized),
    );
    const historyPublished = await step("notification_history_pages_published", () =>
      stages.notificationHistoryPagesPublished(historyPrepared),
    );
    return await step("completed", () => stages.complete(historyPublished));
  } catch (error: unknown) {
    return boundary.fail(failedStage, error);
  }
}

/** exact stateで選ばれた最初の未完effectからrunを再開する。 */
export async function resumePendingTrackingRun<
  Pending extends Readonly<{ stage: keyof typeof pendingEffectStageMap }>,
>(
  initial: Pending,
  ports: PendingRunPorts<Pending>,
  boundary: TrackingRunFailurePort,
): Promise<CompletedRun | FailedRun> {
  let pending = initial;
  let failedStage: FailedRun["failedStage"] = pendingEffectStageMap[pending.stage];
  try {
    while (pending.stage !== "completed") {
      failedStage = pendingEffectStageMap[pending.stage];
      await boundary.beforeStage(failedStage);
      await ports.execute[pending.stage](pending);
      const next = await ports.inspect();
      if (
        trackingRunStageOrder.indexOf(pendingEffectStageMap[next.stage]) <=
        trackingRunStageOrder.indexOf(pendingEffectStageMap[pending.stage])
      ) {
        throw new TypeError("再開effect後も未完段階が進んでいません");
      }
      pending = next;
    }
    failedStage = "completed";
    await boundary.beforeStage(failedStage);
    return await ports.complete(pending);
  } catch (error: unknown) {
    return boundary.fail(failedStage, error);
  }
}

/** launcher判断に従って新規runまたはexact pending runを進める。 */
export async function runTrackingRunSequentially<
  Stages extends TrackingRunStageValues,
  Checkpoint,
  Pending extends Readonly<{ stage: keyof typeof pendingEffectStageMap }>,
>(
  launch: () => Promise<TrackingRunLaunchDecision<Pending>>,
  newRun: NewRunStagePorts<Stages, Checkpoint>,
  pendingRun: PendingRunPorts<Pending>,
  boundary: TrackingRunFailurePort,
): Promise<CompletedRun | FailedRun> {
  let failedStage: FailedRun["failedStage"] = "runtime_bootstrap";
  try {
    await boundary.beforeStage(failedStage);
    const selected = await launch();
    if (
      selected.decision.kind === "manual_resolution_required" ||
      selected.decision.kind === "operator_conflict_resolution"
    ) {
      return selected.decision.failure;
    }
    failedStage = "runtime_selection";
    if (selected.runtime === "current" && selected.decision.kind === "start_new") {
      return await runNewTrackingRun(newRun, boundary);
    }
    if (selected.runtime === "exact" && selected.decision.kind === "resume_pending") {
      return await resumePendingTrackingRun(selected.decision.pending, pendingRun, boundary);
    }
    if (selected.runtime === "exact" && selected.decision.kind === "completed") {
      return selected.decision.completed;
    }
    throw new TypeError("launcherとengineの起動判断が一致しません");
  } catch (error: unknown) {
    return boundary.fail(failedStage, error);
  }
}
