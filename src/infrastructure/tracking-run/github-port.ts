import type { CollectionGitHubReadPort } from "../../application/tracking-run/ports.js";
import type {
  InventoryCollectedRun,
  RepositoryInventoryPort,
} from "../../application/tracking-run/stages/inventory.js";
import type { Repository } from "../../domain/index.js";
import type { CreateGitHubClientOptions, GitHubClient } from "../../github/client.js";
import type { GitHubAppCredentials } from "../../github/credentials.js";
import { GitHubPublicBoundaryViolationError } from "../../github/errors.js";
import type { collectGitHubItemDetails } from "../../github/item-detail-collection.js";
import { inspectLegacyReviewRequests } from "../../github/legacy-review-request.js";
import {
  type enumerateGitHubItemsByIdentifiers,
  type enumerateOpenGitHubItems,
} from "../../github/item-enumeration.js";
import { normalizeObservedGitHubItems } from "../../github/item-normalization.js";
import { containsPrivateRepositoryReference } from "../../github/private-repository-reference.js";
import { createPublicRepositoryAllowlist } from "../../github/public-repository-allowlist.js";
import {
  collectRepositoryMetadata,
  type discoverRepositoryInventory,
} from "../../github/repository-inventory.js";

type GitHubInventoryDependencies = Readonly<{
  credentials: GitHubAppCredentials;
  createClient: (options: CreateGitHubClientOptions) => Promise<GitHubClient>;
  discoverInventory: typeof discoverRepositoryInventory;
  sessions: GitHubRunSessions;
}>;

type GitHubReadDependencies = Readonly<{
  enumerateOpen: typeof enumerateOpenGitHubItems;
  enumerateByIdentifiers: typeof enumerateGitHubItemsByIdentifiers;
  collectDetails: typeof collectGitHubItemDetails;
}>;

type PrivateRepositoryReference = Pick<Repository, "id" | "owner" | "name" | "visibility">;

/** runごとのGitHub clientと非公開repository参照をstage成果物の外で保持する。 */
export class GitHubRunSessions {
  readonly #clients = new Map<string, GitHubClient>();
  readonly #privateRepositories = new Map<string, readonly PrivateRepositoryReference[]>();

  /** 認証済みclientと非公開repository参照をrunへ結び付ける。 */
  public register(runId: string, client: GitHubClient, inventory: readonly Repository[]): void {
    if (this.#privateRepositories.has(runId)) {
      throw new TypeError("同じrunのGitHub sessionが既にあります");
    }
    this.#clients.set(runId, client);
    this.#privateRepositories.set(
      runId,
      Object.freeze(
        inventory
          .filter((repository) => repository.visibility !== "public")
          .map((repository) =>
            Object.freeze({
              id: repository.id,
              owner: repository.owner,
              name: repository.name,
              visibility: repository.visibility,
            }),
          ),
      ),
    );
  }

  /** 収集段階で認証済みclientを使う。 */
  public require(runId: string): GitHubClient {
    const client = this.#clients.get(runId);
    if (client == null) {
      throw new TypeError("runのGitHub sessionがありません");
    }
    return client;
  }

  /** runの値が既知の非公開repositoryを参照しないことを確認する。 */
  public assertPublicBoundary(runId: string, values: readonly unknown[]): void {
    const privateRepositories = this.#privateRepositories.get(runId);
    if (privateRepositories == null) {
      throw new TypeError("runのGitHub sessionがありません");
    }
    if (containsPrivateRepositoryReference(values, privateRepositories)) {
      throw new GitHubPublicBoundaryViolationError(1);
    }
  }

  /** 収集後に認証済みclientへの参照を破棄する。 */
  public releaseClient(runId: string): void {
    this.#clients.delete(runId);
  }

  /** 検査完了後にrunの参照を破棄する。 */
  public release(runId: string): void {
    this.#clients.delete(runId);
    this.#privateRepositories.delete(runId);
  }
}

function assertStoredPrivateRepositoryBoundary(
  inventory: Awaited<ReturnType<typeof discoverRepositoryInventory>>,
  prepared: Parameters<RepositoryInventoryPort["collect"]>[0],
): void {
  const storedValues: unknown[] = [
    prepared.core.baseState.snapshot,
    prepared.core.baseState.history,
    prepared.core.baseState.aiCache,
    prepared.core.baseState.personalReminderAiCache,
    prepared.core.baseState.notificationLedger,
  ];
  if (containsPrivateRepositoryReference(storedValues, inventory)) {
    throw new GitHubPublicBoundaryViolationError(1);
  }
}

/** GitHub認証とinventory取得を一つのportへ接続する。 */
export function createGitHubRepositoryInventoryPort(
  dependencies: GitHubInventoryDependencies,
): RepositoryInventoryPort {
  return Object.freeze({
    async collect(prepared) {
      const client = await dependencies.createClient({
        organization: prepared.core.config.organization,
        credentials: dependencies.credentials,
        operations: prepared.core.config.operations,
      });
      const inventory = await dependencies.discoverInventory({
        organization: prepared.core.config.organization,
        observedAt: prepared.core.identity.startedAt,
        request: client.request,
      });
      assertStoredPrivateRepositoryBoundary(inventory, prepared);
      const allowlist = createPublicRepositoryAllowlist(inventory);
      dependencies.sessions.register(prepared.core.identity.runId, client, inventory);
      return Object.freeze({
        allowlist,
        installationId: client.installationId,
        githubApiRemaining: client.getRateLimitSnapshot()?.remaining ?? 0,
        diagnostics: Object.freeze([]),
      });
    },
  });
}

/** 選定済み公開repository集合へ全GitHub読取を閉じる。 */
export function createGitHubReadPort(
  run: InventoryCollectedRun,
  sessions: GitHubRunSessions,
  dependencies: GitHubReadDependencies,
): CollectionGitHubReadPort {
  const allowlist = run.data.allowlist;
  const client = sessions.require(run.core.identity.runId);
  return Object.freeze({
    async enumerateOpen(repositories, observedAt) {
      const repositoryIds = new Set(repositories.map((repository) => repository.id));
      for (const repository of repositories) {
        allowlist.require(repository.id);
      }
      const items = await dependencies.enumerateOpen({
        allowlist,
        repositories,
        observedAt,
        request: client.request,
      });
      for (const item of items) {
        if (!repositoryIds.has(item.repositoryId)) {
          throw new TypeError("open列挙結果のrepositoryが要求した集合にありません");
        }
      }
      return items;
    },
    async enumerateByIdentifiers(identifiers, observedAt) {
      const items = await dependencies.enumerateByIdentifiers({
        allowlist,
        identifiers,
        observedAt,
        request: client.request,
        graphql: client.graphql,
      });
      for (const item of items) {
        allowlist.require(item.repositoryId);
      }
      return items;
    },
    async collectDetails(targets, observedAt, isBot) {
      for (const target of targets) {
        allowlist.require(target.item.repositoryId);
      }
      const details = (
        await dependencies.collectDetails({
          allowlist,
          targets,
          observedAt,
          graphql: client.graphql,
        })
      ).items;
      const targetsByNodeId = new Map(targets.map((target) => [target.item.nodeId, target.item]));
      for (const detail of details) {
        const target = targetsByNodeId.get(detail.nodeId);
        if (target?.repositoryId !== detail.repositoryId) {
          throw new TypeError("詳細取得結果が要求した項目と一致しません");
        }
      }
      return Object.freeze({
        details,
        observedItems: normalizeObservedGitHubItems({
          items: targets.map((target) => target.item),
          details,
          isBot,
        }),
      });
    },
    async collectRepositoryMetadata(repositoryFullNames, observedAt) {
      return collectRepositoryMetadata(repositoryFullNames, observedAt, client.request);
    },
    async inspectLegacyReviewRequests(sourceIds) {
      return inspectLegacyReviewRequests(sourceIds, allowlist, client.graphql);
    },
    rateLimitSnapshot() {
      return client.getRateLimitSnapshot();
    },
  });
}
