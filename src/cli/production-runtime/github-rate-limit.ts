import type { GitHubClient } from "../../github/index.js";

/** GitHub APIの残量を読み取る。 */
export function githubApiRemaining(client: GitHubClient): number {
  return client.getRateLimitSnapshot()?.remaining ?? 0;
}
