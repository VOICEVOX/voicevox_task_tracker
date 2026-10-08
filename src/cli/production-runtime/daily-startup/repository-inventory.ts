import { createPublicRepositoryAllowlist } from "../../../github/index.js";
import { assertStatePublicSafety } from "../../../persistence/index.js";
import type { DailyTransactionDependencies } from "../../daily-transaction.js";
import type { RepositoryInventoryRuntimeAdapters } from "../adapters.js";
import type { ProductionTypes } from "../contracts.js";
import { githubApiRemaining } from "../github-rate-limit.js";
import { assertExcludedPullRequestReturns404 } from "./excluded-pull-request-404.js";

/** リポジトリ一覧の収集段階を既存adapterへ接続する。 */
export function createCollectRepositoryInventoryStage(
  adapters: RepositoryInventoryRuntimeAdapters,
): DailyTransactionDependencies<ProductionTypes>["collectRepositoryInventory"] {
  return async ({ invocation, configuration, state, authentication }) => {
    const inventory = await adapters.discoverRepositoryInventory({
      organization: configuration.config.organization,
      observedAt: invocation.startedAt,
      request: authentication.request,
    });
    const allowlist = createPublicRepositoryAllowlist(inventory);
    if (state.rawSnapshot.status === "available") {
      assertStatePublicSafety({
        snapshot: state.rawSnapshot.snapshot,
        repositoryInventory: inventory,
        additionalValues: [],
        knownSecrets: configuration.credentials.knownSecrets,
      });
    }
    await assertExcludedPullRequestReturns404(authentication.request);
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
