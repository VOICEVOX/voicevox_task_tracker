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

/** daily公開stageの組立てに必要な依存。 */
export type CreateDailyPublicationStageHandlersInput = Readonly<{
  adapters: RunPublicationAdapters;
  normalizeLabelRules: NormalizeLabelRules;
  resolveCompletedTrackingStartAt: ResolveCompletedTrackingStartAt;
}>;

/** 完全性検証後のdaily公開stageだけを組み立てる。 */
export function createDailyPublicationStageHandlers(
  dependencies: CreateDailyPublicationStageHandlersInput,
): DailyPublicationStageHandlers {
  return Object.freeze({
    persistState: ({ configuration, state, repositoryInventory, validated }) =>
      persistValidatedRun({
        configuration,
        state,
        inventory: repositoryInventory,
        validated,
      }),
    buildPages: ({ configuration, repositoryInventory, validated, persisted }) =>
      buildPublicPages({
        writePublicData: dependencies.adapters.writePublicData,
        config: configuration.config,
        inventory: repositoryInventory.inventory,
        repositoryAllowlist: repositoryInventory.allowlist.repositories,
        validated,
        historyRecords: persisted.historyRecords,
        outputDirectory: dependencies.adapters.pagesOutputDirectory,
        knownSecrets: configuration.credentials.knownSecrets,
        resolveLabelRules: () => dependencies.normalizeLabelRules(configuration.config),
      }),
    sendDiscord: async ({
      invocation,
      configuration,
      state,
      repositoryInventory,
      validated,
      pages,
    }) => {
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
    },
    completeRun: ({
      invocation,
      configuration,
      state,
      repositoryInventory,
      validated,
      discord,
      metrics,
      diagnostics,
    }) =>
      persistSuccessfulRunCompletion({
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
      }),
    sendOperationsAlert: async ({
      invocation,
      configuration,
      state,
      persisted,
      kind,
      retryAttempts,
    }) => {
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
    },
    writeCollectAnalyzeArtifact: (path, stageInput) =>
      dependencies.adapters.writeJsonArtifact(
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
      ),
  });
}
