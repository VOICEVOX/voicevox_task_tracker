import { collectRepositoryInventory } from "../../../../application/tracking-run/stages/inventory.js";
import { nodeContentDigestPort } from "../../content-digest.js";
import { createGitHubRepositoryInventoryPort, type GitHubRunSessions } from "../../github-port.js";
import type { AnalysisRuntimeContext, AnalysisStages } from "../analysis-contracts.js";

import type { ProductionRuntimeAdapters } from "../adapters.js";

/** GitHub portを用いてcanonical inventory stageを実行する。 */
export function createCollectInventoryStage(
  adapters: ProductionRuntimeAdapters,
  sessions: GitHubRunSessions,
  context: AnalysisRuntimeContext,
): AnalysisStages["inventoryCollected"] {
  const { configuration, state } = context;
  return (prepared) =>
    collectRepositoryInventory(
      prepared,
      createGitHubRepositoryInventoryPort({
        credentials: configuration.credentials.github,
        createClient: adapters.createGitHubClient,
        discoverInventory: adapters.discoverRepositoryInventory,
        sessions,
        rawSnapshot: state.rawSnapshot,
        knownSecrets: configuration.credentials.knownSecrets,
      }),
      nodeContentDigestPort,
    );
}
