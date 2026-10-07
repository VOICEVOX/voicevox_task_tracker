import {
  parsePublicationInputs,
  type PublicationInputs,
} from "../../../../application/tracking-run/contracts/publication-inputs.js";
import type { InitialPublicationBaseState } from "../../../../persistence/initial-publication-base-state.js";
import { projectPublicationSettings } from "../../publication/settings.js";
import type { RuntimeConfiguration } from "../contracts.js";

/** 検証済みrunへ公開可能な設定とstate書込み前提を投影する。 */
export function projectPublicationInputs(
  configuration: RuntimeConfiguration,
  base: InitialPublicationBaseState,
): PublicationInputs {
  const config = configuration.config;
  return parsePublicationInputs({
    state: {
      snapshotPath: config.state.snapshotPath,
      historyPath: base.historyPath,
      notificationLedgerPath: config.state.notificationLedgerPath,
      aiCacheDirectory: config.state.aiCacheDirectory,
      personalReminderAiCacheDirectory: config.state.personalReminderAiCacheDirectory,
      runReportsDirectory: config.state.runReportsDirectory,
      oldCacheDeletionPaths: base.oldCacheDeletionPaths,
      historyBase: base.historyBase,
      initialStateWriteManifest: base.initialStateWriteManifest,
      previousInitialPagesEvidence: base.previousInitialPagesEvidence,
    },
    ...projectPublicationSettings(config),
  });
}
