import { collectRunItems } from "../../../../application/tracking-run/stages/collection.js";
import { nodeContentDigestPort } from "../../content-digest.js";
import { createGitHubReadPort, type GitHubRunSessions } from "../../github-port.js";
import type { AnalysisStages } from "../analysis-contracts.js";

import type { CollectionRuntimeAdapters } from "../adapters.js";
import { currentRuntimeTime } from "../clock.js";

/** 増分収集段階を既存adapterへ接続する。 */
export function createCollectItemsStage(
  adapters: CollectionRuntimeAdapters,
  sessions: GitHubRunSessions,
): AnalysisStages["collected"] {
  return async (inventoryCollected) => {
    const runId = inventoryCollected.core.identity.runId;
    try {
      const read = createGitHubReadPort(inventoryCollected, sessions, {
        enumerateOpen: adapters.enumerateOpenGitHubItems,
        enumerateByIdentifiers: adapters.enumerateGitHubItemsByIdentifiers,
        collectDetails: adapters.collectGitHubItemDetails,
      });
      const collected = await collectRunItems(
        inventoryCollected,
        { read, delay: { sleep: adapters.sleep } },
        { now: () => currentRuntimeTime(adapters) },
        nodeContentDigestPort,
      );
      sessions.assertPublicBoundary(runId, [collected.data]);
      sessions.releaseClient(runId);
      return collected;
    } catch (error: unknown) {
      sessions.release(runId);
      throw error;
    }
  };
}
