import type { GitHubNodeId, GitHubRepositoryId, UtcIsoDateTime } from "../../../domain/types.js";
import {
  GitHubRepositoryStaleFallbackUnavailableError,
  GitHubRetryExhaustedError,
} from "../../../github/errors.js";
import type { PublicRepository } from "../../../github/public-repository-allowlist.js";

/** リポジトリから最後に取得できた値と観測時刻。 */
export type PreviousRepositoryValue<Value> = Readonly<{
  value: Value;
  observedAt: UtcIsoDateTime;
}>;

/** リポジトリ単位の最新値または明示された前回値。 */
export type RepositoryCollectionResult<Value> =
  | Readonly<{
      freshness: "fresh";
      repository: PublicRepository;
      value: Value;
      observedAt: UtcIsoDateTime;
    }>
  | Readonly<{
      freshness: "stale";
      repository: PublicRepository;
      previousValue: Value;
      lastSuccessfulAt: UtcIsoDateTime;
      failedAt: UtcIsoDateTime;
      diagnostic: Readonly<{
        code: "github_repository_temporarily_unavailable";
        message: string;
      }>;
    }>;

type CollectRepositoryValuesOptions<Value> = Readonly<{
  repositories: readonly PublicRepository[];
  observedAt: UtcIsoDateTime;
  previousValues: ReadonlyMap<GitHubRepositoryId, PreviousRepositoryValue<Value>>;
  collect: (repository: PublicRepository) => Promise<Value>;
}>;

/** 503で取得不能な公開リポジトリだけ前回値を保持する。 */
export async function collectRepositoryValues<Value>(
  options: CollectRepositoryValuesOptions<Value>,
): Promise<readonly RepositoryCollectionResult<Value>[]> {
  const results: RepositoryCollectionResult<Value>[] = [];
  for (const repository of options.repositories) {
    try {
      const value = await options.collect(repository);
      results.push(
        Object.freeze({
          freshness: "fresh",
          repository,
          value,
          observedAt: options.observedAt,
        }),
      );
    } catch (error: unknown) {
      if (!(error instanceof GitHubRetryExhaustedError && error.status === 503)) {
        throw error;
      }
      const previous = options.previousValues.get(repository.id);
      if (previous == null) {
        throw new GitHubRepositoryStaleFallbackUnavailableError(
          `${repository.owner}/${repository.name}`,
          { cause: error },
        );
      }
      results.push(
        Object.freeze({
          freshness: "stale",
          repository,
          previousValue: previous.value,
          lastSuccessfulAt: previous.observedAt,
          failedAt: options.observedAt,
          diagnostic: Object.freeze({
            code: "github_repository_temporarily_unavailable",
            message: `${repository.owner}/${repository.name}の取得に失敗したため前回値を保持しています`,
          }),
        }),
      );
    }
  }
  return Object.freeze(results);
}

/** stale化に必要な前回観測値の最小契約。 */
export type FreshObservedGitHubItemReference = Readonly<{
  freshness: "fresh";
  nodeId: GitHubNodeId;
  repositoryId: GitHubRepositoryId;
  observedAt: UtcIsoDateTime;
}>;

/** 取得失敗により前回観測値だけを保持するGitHub項目。 */
export type StaleObservedGitHubItem<PreviousObservation extends FreshObservedGitHubItemReference> =
  Readonly<{
    freshness: "stale";
    nodeId: GitHubNodeId;
    repositoryId: PreviousObservation["repositoryId"];
    previousObservation: PreviousObservation;
    lastSuccessfulAt: UtcIsoDateTime;
    failedAt: UtcIsoDateTime;
    diagnostic: Readonly<{
      code: "github_repository_temporarily_unavailable";
      message: string;
    }>;
  }>;

/** 前回の観測値を現在値へ昇格させずstale項目として保持する。 */
export function retainStaleObservedItems<
  PreviousObservation extends FreshObservedGitHubItemReference,
>(
  previousItems: readonly PreviousObservation[],
  failedAt: UtcIsoDateTime,
  diagnostic: Readonly<{ code: "github_repository_temporarily_unavailable"; message: string }>,
): readonly StaleObservedGitHubItem<PreviousObservation>[] {
  if (new Set(previousItems.map((item) => item.nodeId)).size !== previousItems.length) {
    throw new TypeError("前回観測値のitem node IDが重複しています");
  }
  return Object.freeze(
    previousItems.map((previousObservation) => {
      if (failedAt < previousObservation.observedAt) {
        throw new RangeError("取得失敗時刻は前回成功時刻以後にしてください");
      }
      return Object.freeze({
        freshness: "stale",
        nodeId: previousObservation.nodeId,
        repositoryId: previousObservation.repositoryId,
        previousObservation,
        lastSuccessfulAt: previousObservation.observedAt,
        failedAt,
        diagnostic: Object.freeze({ code: diagnostic.code, message: diagnostic.message }),
      });
    }),
  );
}
