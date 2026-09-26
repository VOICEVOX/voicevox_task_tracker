import type { GitHubNodeId, GitHubRepositoryId, UtcIsoDateTime } from "../../../domain/index.js";
import type { PreviousItemCollection, PublicRepository } from "../../../github/index.js";
import type {
  SnapshotCollectionItem,
  SnapshotCollectionRepository,
} from "../../../persistence/index.js";
import type { RuntimeState } from "../contracts.js";
import { previousSnapshot } from "./snapshot.js";

/** 前回のリポジトリ収集状態を参照する。 */
export function previousCollectionRepository(
  state: RuntimeState,
  repositoryId: GitHubRepositoryId,
): SnapshotCollectionRepository | undefined {
  return previousSnapshot(state)?.collection.repositories.find(
    (repository) => repository.repositoryId === repositoryId,
  );
}

/** 前回の収集項目をノードIDで参照する。 */
export function previousCollectionItemsByNodeId(
  state: RuntimeState,
): ReadonlyMap<GitHubNodeId, SnapshotCollectionItem> {
  return new Map(
    (previousSnapshot(state)?.collection.repositories ?? []).flatMap((repository) =>
      repository.items.map((item) => [item.nodeId, item] as const),
    ),
  );
}

/** 前回の項目収集結果を増分収集用に参照する。 */
export function previousItemCollection(
  state: RuntimeState,
  repository: PublicRepository,
): PreviousItemCollection {
  const previous = previousCollectionRepository(state, repository.id);
  if (previous == null) {
    return Object.freeze({
      status: "none",
    });
  }
  return Object.freeze({
    status: "successful",
    items: new Map(
      previous.items.map((item) => [
        item.nodeId,
        Object.freeze({
          itemFingerprint: item.itemFingerprint,
          analysisPlanFingerprint: item.analysisPlanFingerprint,
        }),
      ]),
    ),
  });
}

/** 前回のリポジトリ収集値を参照する。 */
export function previousRepositoryValues(state: RuntimeState): ReadonlyMap<
  GitHubRepositoryId,
  Readonly<{
    value: SnapshotCollectionRepository;
    observedAt: UtcIsoDateTime;
  }>
> {
  return new Map(
    (previousSnapshot(state)?.collection.repositories ?? []).map((repository) => [
      repository.repositoryId,
      Object.freeze({
        value: repository,
        observedAt: repository.successfulAt,
      }),
    ]),
  );
}
