import { deliverDiscord, deliverOperationsAlert } from "../notification-delivery-runtime.js";
import { createCollectAnalyzeArtifact } from "./artifact.js";
import type {
  DailyPublicationStageHandlers,
  NormalizeLabelRules,
  ResolveCompletedTrackingStartAt,
  RunPublicationAdapters,
} from "./contracts.js";
import { createRunMetadata } from "./metadata.js";
import { buildPublicPages } from "./pages.js";
import { persistSuccessfulRunCompletion, persistValidatedRun } from "./persistence.js";
import { discordDeliverySettings } from "./settings.js";

type DailyNotificationAdapters = Pick<
  RunPublicationAdapters,
  | "environment"
  | "repositoryPath"
  | "loadConfig"
  | "openStateSession"
  | "createStateBranchAdapter"
  | "discordHttpClient"
  | "now"
  | "sleep"
  | "random"
  | "sendDiscord"
>;

/** 完全性検証済みrunを初期保存へ渡す。 */
export function persistDailyState(
  input: Parameters<DailyPublicationStageHandlers["persistState"]>[0],
): ReturnType<DailyPublicationStageHandlers["persistState"]> {
  const { configuration, state, repositoryInventory, validated } = input;
  return persistValidatedRun({
    configuration,
    state,
    inventory: repositoryInventory,
    validated,
  });
}

/** 初期保存済みrunをPages生成へ渡す。 */
export function buildDailyPages(
  dependencies: Readonly<{
    adapters: Pick<RunPublicationAdapters, "writePublicData" | "pagesOutputDirectory">;
    normalizeLabelRules: NormalizeLabelRules;
  }>,
  input: Parameters<DailyPublicationStageHandlers["buildPages"]>[0],
): ReturnType<DailyPublicationStageHandlers["buildPages"]> {
  const { configuration, repositoryInventory, validated, persisted } = input;
  return buildPublicPages({
    writePublicData: dependencies.adapters.writePublicData,
    config: configuration.config,
    inventory: repositoryInventory.inventory,
    repositoryAllowlist: repositoryInventory.allowlist.repositories,
    validated,
    historyRecords: persisted.historyRecords,
    outputDirectory: dependencies.adapters.pagesOutputDirectory,
    knownSecrets: configuration.credentials.knownSecrets,
    resolveLabelRules: () => dependencies.normalizeLabelRules(configuration.config),
  });
}

/** 日次runのDiscord配送または通知省略を実行する。 */
export async function sendDailyDiscord(
  dependencies: Readonly<{
    adapters: DailyNotificationAdapters;
    normalizeLabelRules: NormalizeLabelRules;
  }>,
  input: Parameters<DailyPublicationStageHandlers["sendDiscord"]>[0],
): ReturnType<DailyPublicationStageHandlers["sendDiscord"]> {
  const { invocation, configuration, state, repositoryInventory, validated, pages } = input;
  if (
    invocation.command.kind !== "dry-run" &&
    (invocation.command.notificationAction === "acknowledge-current" ||
      invocation.command.notificationAction === "hold")
  ) {
    return Object.freeze({
      value: Object.freeze({
        delivery: Object.freeze({
          status: "skipped",
          reason: invocation.command.notificationAction === "hold" ? "held" : "no_candidates",
        }),
        notificationEvents: Object.freeze([]),
        notificationLedger: validated.notificationLedger,
      }),
      notificationCount: 0,
      discordSentAt: null,
    });
  }
  const result = await deliverDiscord(
    dependencies.adapters,
    configuration.config,
    () => dependencies.normalizeLabelRules(configuration.config),
    discordDeliverySettings(configuration.config),
    state,
    repositoryInventory.inventory,
    configuration.credentials.knownSecrets,
    validated,
    pages.pagesUrl,
  );
  return Object.freeze({
    value: Object.freeze({
      ...result.value,
      notificationLedger: result.notificationLedger,
    }),
    notificationCount: result.notificationCount,
    discordSentAt: result.discordSentAt,
  });
}

/** Discord結果を使って日次runの完了状態を保存する。 */
export function completeDailyRun(
  dependencies: Readonly<{
    adapters: Pick<RunPublicationAdapters, "now">;
    resolveCompletedTrackingStartAt: ResolveCompletedTrackingStartAt;
  }>,
  input: Parameters<DailyPublicationStageHandlers["completeRun"]>[0],
): ReturnType<DailyPublicationStageHandlers["completeRun"]> {
  const {
    invocation,
    configuration,
    state,
    repositoryInventory,
    validated,
    discord,
    metrics,
    diagnostics,
  } = input;
  return persistSuccessfulRunCompletion({
    now: dependencies.adapters.now,
    config: configuration.config,
    state,
    repositoryInventory: repositoryInventory.inventory,
    validated,
    runMetadata: createRunMetadata({ invocation, validated, metrics, diagnostics }),
    delivery: {
      notificationLedger: discord.notificationLedger,
      notificationCount: metrics.notificationCount,
    },
    knownSecrets: configuration.credentials.knownSecrets,
    resolveCompletedTrackingStartAt: dependencies.resolveCompletedTrackingStartAt,
  });
}

/** 日次runの障害通知またはsandboxでの省略を実行する。 */
export async function sendDailyOperationsAlert(
  dependencies: Readonly<{
    adapters: DailyNotificationAdapters;
  }>,
  input: Parameters<DailyPublicationStageHandlers["sendOperationsAlert"]>[0],
): ReturnType<DailyPublicationStageHandlers["sendOperationsAlert"]> {
  const { invocation, configuration, state, persisted, kind, retryAttempts } = input;
  if (configuration.target.kind === "sandbox") {
    return Object.freeze({
      value: Object.freeze({
        delivery: Object.freeze({
          status: "disabled",
        }),
        notificationEvents: Object.freeze([]),
        notificationLedger:
          persisted == null ? state.notificationLedger : persisted.notificationLedger,
      }),
      notificationCount: 0,
      discordSentAt: null,
    });
  }
  let persistedState = state;
  if (persisted != null) {
    persistedState = Object.freeze({
      ...state,
      notificationLedger: persisted.notificationLedger,
    });
  }
  return deliverOperationsAlert(
    dependencies.adapters,
    discordDeliverySettings(configuration.config),
    configuration.credentials.knownSecrets,
    persistedState,
    {
      incidentId: `${invocation.runId}:${kind}`,
      kind,
      occurredAt: invocation.startedAt,
      retryAttempts,
    },
  );
}

/** 日次runの解析結果からworkflow artifactを書き出す。 */
export function writeDailyCollectAnalyzeArtifact(
  dependencies: Readonly<{
    adapters: Pick<RunPublicationAdapters, "writeJsonArtifact">;
  }>,
  path: string,
  stageInput: Parameters<DailyPublicationStageHandlers["writeCollectAnalyzeArtifact"]>[1],
): ReturnType<DailyPublicationStageHandlers["writeCollectAnalyzeArtifact"]> {
  return dependencies.adapters.writeJsonArtifact(
    path,
    createCollectAnalyzeArtifact({
      invocation: stageInput.invocation,
      configuration: stageInput.configuration,
      state: stageInput.state,
      inventory: stageInput.repositoryInventory,
      validated: stageInput.validated,
      metrics: stageInput.metrics,
      diagnostics: stageInput.diagnostics,
    }),
  );
}
