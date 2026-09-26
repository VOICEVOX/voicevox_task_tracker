import type { DailyTransactionDependencies } from "../../daily-transaction.js";
import type { GitHubAuthenticationRuntimeAdapters } from "../adapters.js";
import type { ProductionTypes } from "../contracts.js";

/** GitHub認証段階を既存adapterへ接続する。 */
export function createAuthenticateGitHubStage(
  adapters: GitHubAuthenticationRuntimeAdapters,
): DailyTransactionDependencies<ProductionTypes>["authenticateGitHub"] {
  return ({ configuration }) =>
    adapters.createGitHubClient({
      organization: configuration.config.organization,
      credentials: configuration.credentials.github,
      operations: configuration.config.operations,
    });
}
