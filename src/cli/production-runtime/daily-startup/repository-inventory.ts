import { createPublicRepositoryAllowlist } from "../../../github/index.js";
import type { DailyTransactionDependencies } from "../../daily-transaction.js";
import type { RepositoryInventoryRuntimeAdapters } from "../adapters.js";
import type { ProductionTypes } from "../contracts.js";
import { githubApiRemaining } from "../github-rate-limit.js";

/** リポジトリ一覧の収集段階を既存adapterへ接続する。 */
export function createCollectRepositoryInventoryStage(
  adapters: RepositoryInventoryRuntimeAdapters,
): DailyTransactionDependencies<ProductionTypes>["collectRepositoryInventory"] {
  return async ({ invocation, configuration, authentication }) => {
    const inventory = await adapters.discoverRepositoryInventory({
      organization: configuration.config.organization,
      observedAt: invocation.startedAt,
      request: authentication.request,
    });
    const allowlist = createPublicRepositoryAllowlist(inventory);
    return Object.freeze({
      value: Object.freeze({
        inventory,
        allowlist,
      }),
      repositoryCount: allowlist.repositories.length,
      githubApiRemaining: githubApiRemaining(authentication),
    });
  };
}
