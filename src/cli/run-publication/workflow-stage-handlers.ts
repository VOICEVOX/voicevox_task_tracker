import { resolve } from "node:path";

import type {
  BuildPagesCliCommand,
  NotifyDiscordCliCommand,
  NotifyOperationsCliCommand,
  PersistStateCliCommand,
} from "../command.js";
import { deliverDiscord, deliverOperationsAlert } from "../notification-delivery-runtime.js";
import { requireEnvironmentValue } from "../production-runtime-setup.js";
import { workflowArtifactRepositoryInventory } from "../workflow-artifact.js";
import { validatedRunFromArtifact } from "./artifact.js";
import type {
  NormalizeLabelRules,
  ResolveCompletedTrackingStartAt,
  RunPublicationAdapters,
} from "./contracts.js";
import { buildPublicPages } from "./pages.js";
import { persistSuccessfulRunCompletion } from "./persistence.js";
import { discordDeliverySettings, pagesUrl } from "./settings.js";

/** 分割workflowの公開stageの実行関数。 */
export type WorkflowPublicationStageHandlers = Readonly<{
  persistState: (command: PersistStateCliCommand) => Promise<void>;
  buildPages: (command: BuildPagesCliCommand) => Promise<void>;
  notifyDiscord: (command: NotifyDiscordCliCommand) => Promise<void>;
  notifyOperations: (command: NotifyOperationsCliCommand) => Promise<void>;
}>;

/** 分割workflowの公開stageを組み立てる依存。 */
export type CreateWorkflowPublicationStageHandlersInput = Readonly<{
  adapters: RunPublicationAdapters;
  normalizeLabelRules: NormalizeLabelRules;
  resolveCompletedTrackingStartAt: ResolveCompletedTrackingStartAt;
}>;

async function persistWorkflowState(
  dependencies: CreateWorkflowPublicationStageHandlersInput,
  command: PersistStateCliCommand,
): Promise<void> {
  const artifact = await dependencies.adapters.readWorkflowArtifact(
    resolve(dependencies.adapters.repositoryPath, command.artifactPath),
  );
  const config = await dependencies.adapters.loadConfig(
    resolve(dependencies.adapters.repositoryPath, command.configPath),
  );
  const session = await dependencies.adapters.openStateSession(
    dependencies.adapters.createStateBranchAdapter(),
    config.state,
  );
  for (const entry of artifact.aiCacheEntries) {
    await session.aiCache.write(entry);
  }
  for (const entry of artifact.personalReminderAiCacheEntries) {
    await session.personalReminderAiCache.write(entry);
  }
  await session.persist({
    snapshot: artifact.snapshot,
    historyInputEvents: artifact.historyInputEvents,
    notificationLedger: artifact.notificationLedger,
    repositoryInventory: workflowArtifactRepositoryInventory(artifact),
    knownSecrets: [],
  });
}

async function buildWorkflowPages(
  dependencies: CreateWorkflowPublicationStageHandlersInput,
  command: BuildPagesCliCommand,
): Promise<void> {
  const artifact = await dependencies.adapters.readWorkflowArtifact(
    resolve(dependencies.adapters.repositoryPath, command.artifactPath),
  );
  const config = await dependencies.adapters.loadConfig(
    resolve(dependencies.adapters.repositoryPath, command.configPath),
  );
  if (pagesUrl(config) !== artifact.pagesUrl) {
    throw new TypeError("workflow artifactと現在の設定でPages URLが一致しません");
  }
  const session = await dependencies.adapters.openStateSession(
    dependencies.adapters.createStateBranchAdapter(),
    config.state,
  );
  const persistedSnapshot = await session.loadSnapshot();
  if (
    persistedSnapshot.status !== "available" ||
    persistedSnapshot.snapshot.run.id !== artifact.snapshot.run.id
  ) {
    throw new TypeError("Pages生成対象のrunがtracker-state branchにありません");
  }
  const historyRecords = await session.loadHistoryRecords();
  await buildPublicPages({
    writePublicData: dependencies.adapters.writePublicData,
    config,
    inventory: workflowArtifactRepositoryInventory(artifact),
    repositoryAllowlist: artifact.repositoryAllowlist,
    validated: validatedRunFromArtifact(artifact),
    historyRecords,
    outputDirectory: resolve(dependencies.adapters.repositoryPath, command.outputDirectory),
    knownSecrets: [],
    resolveLabelRules: () => dependencies.normalizeLabelRules(config),
  });
}

async function notifyWorkflowDiscord(
  dependencies: CreateWorkflowPublicationStageHandlersInput,
  command: NotifyDiscordCliCommand,
): Promise<void> {
  const artifact = await dependencies.adapters.readWorkflowArtifact(
    resolve(dependencies.adapters.repositoryPath, command.artifactPath),
  );
  const config = await dependencies.adapters.loadConfig(
    resolve(dependencies.adapters.repositoryPath, command.configPath),
  );
  if (command.pagesUrl !== artifact.pagesUrl) {
    throw new TypeError("deploy済みPages URLがworkflow artifactの公開先と一致しません");
  }
  const session = await dependencies.adapters.openStateSession(
    dependencies.adapters.createStateBranchAdapter(),
    config.state,
  );
  const persistedSnapshot = await session.loadSnapshot();
  if (persistedSnapshot.status !== "available") {
    throw new TypeError("Discord通知対象のstate snapshotがありません");
  }
  if (persistedSnapshot.snapshot.run.id !== artifact.snapshot.run.id) {
    throw new TypeError(
      "Discord通知対象のworkflow artifactとtracker-state branchでrunが一致しません",
    );
  }
  const state = Object.freeze({
    session,
    snapshot: persistedSnapshot,
    notificationLedger: await session.loadNotificationLedger(),
  });
  if (
    artifact.notificationAction === "acknowledge-current" ||
    artifact.notificationAction === "hold"
  ) {
    await persistSuccessfulRunCompletion({
      now: dependencies.adapters.now,
      config,
      state,
      repositoryInventory: workflowArtifactRepositoryInventory(artifact),
      validated: validatedRunFromArtifact(artifact),
      runMetadata: artifact.runMetadata,
      delivery: {
        notificationLedger: state.notificationLedger,
        notificationCount: 0,
      },
      knownSecrets: [],
      resolveCompletedTrackingStartAt: dependencies.resolveCompletedTrackingStartAt,
    });
    return;
  }
  const knownSecrets = artifact.discordSettings.enabled
    ? Object.freeze([
        requireEnvironmentValue(
          dependencies.adapters.environment,
          artifact.discordSettings.webhookSecretName,
        ),
        requireEnvironmentValue(
          dependencies.adapters.environment,
          artifact.discordSettings.operationsWebhookSecretName,
        ),
      ])
    : Object.freeze([]);
  const result = await deliverDiscord(
    dependencies.adapters,
    config,
    () => dependencies.normalizeLabelRules(config),
    artifact.discordSettings,
    state,
    workflowArtifactRepositoryInventory(artifact),
    knownSecrets,
    Object.freeze({
      snapshot: artifact.snapshot,
      historyInputEvents: artifact.historyInputEvents,
      notificationLedger: state.notificationLedger,
      notificationSelection: artifact.notificationSelection,
    }),
    command.pagesUrl,
  );
  await persistSuccessfulRunCompletion({
    now: dependencies.adapters.now,
    config,
    state,
    repositoryInventory: workflowArtifactRepositoryInventory(artifact),
    validated: validatedRunFromArtifact(artifact),
    runMetadata: artifact.runMetadata,
    delivery: {
      notificationLedger: result.notificationLedger,
      notificationCount: result.notificationCount,
    },
    knownSecrets,
    resolveCompletedTrackingStartAt: dependencies.resolveCompletedTrackingStartAt,
  });
}

async function notifyWorkflowOperations(
  dependencies: CreateWorkflowPublicationStageHandlersInput,
  command: NotifyOperationsCliCommand,
): Promise<void> {
  const config = await dependencies.adapters.loadConfig(
    resolve(dependencies.adapters.repositoryPath, command.configPath),
  );
  const session = await dependencies.adapters.openStateSession(
    dependencies.adapters.createStateBranchAdapter(),
    config.state,
  );
  const snapshot = await session.loadSnapshot();
  const state = Object.freeze({
    session,
    snapshot,
    notificationLedger: await session.loadNotificationLedger(),
  });
  const knownSecrets = config.notifications.discord.enabled
    ? Object.freeze([
        requireEnvironmentValue(
          dependencies.adapters.environment,
          config.notifications.discord.operationsWebhookSecretName,
        ),
      ])
    : Object.freeze([]);
  await deliverOperationsAlert(
    dependencies.adapters,
    discordDeliverySettings(config),
    knownSecrets,
    state,
    {
      incidentId: command.incidentId,
      kind: command.incidentKind,
      occurredAt: command.occurredAt,
      retryAttempts: command.retryAttempts,
    },
  );
}

/** 分割workflowの公開stageだけを組み立てる。 */
export function createWorkflowPublicationStageHandlers(
  dependencies: CreateWorkflowPublicationStageHandlersInput,
): WorkflowPublicationStageHandlers {
  return Object.freeze({
    persistState: (command) => persistWorkflowState(dependencies, command),
    buildPages: (command) => buildWorkflowPages(dependencies, command),
    notifyDiscord: (command) => notifyWorkflowDiscord(dependencies, command),
    notifyOperations: (command) => notifyWorkflowOperations(dependencies, command),
  });
}
