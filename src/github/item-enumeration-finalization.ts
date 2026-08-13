import { hashCanonicalJson } from "../persistence/canonical-json.js";
import { type GitHubNodeId } from "../domain/index.js";
import { GitHubResponseValidationError } from "./errors.js";
import { type EnumeratedGitHubItem, type Sha256Fingerprint } from "./item-enumeration.js";
import { type GitHubPullRequestVolatileMetadata } from "./item-volatile-metadata.js";

/** probe前のREST列挙値。Pull Requestのitem fingerprintはまだ確定していない。 */
export type ProvisionalGitHubItem = EnumeratedGitHubItem;

/** probe後にitem fingerprintを確定したPull Request。 */
export type FinalizedGitHubPullRequest = Extract<EnumeratedGitHubItem, { type: "pull_request" }>;

/** probe後に判定計画へ渡せる項目。 */
export type FinalizedGitHubItem =
  Extract<EnumeratedGitHubItem, { type: "issue" }> | FinalizedGitHubPullRequest;

/** probe後の項目とdetail照合用volatile metadataをまとめた確定済みcollection。 */
export type FinalizedGitHubItemCollection = Readonly<{
  status: "finalized";
  items: readonly FinalizedGitHubItem[];
  volatileMetadataByNodeId: ReadonlyMap<GitHubNodeId, GitHubPullRequestVolatileMetadata>;
}>;

/** REST列挙値とPull Request probeの対応を検証する入力。 */
export type FinalizeGitHubItemsWithVolatileMetadataOptions = Readonly<{
  items: readonly ProvisionalGitHubItem[];
  volatileMetadata: readonly GitHubPullRequestVolatileMetadata[];
}>;

function createValidationError(message: string): GitHubResponseValidationError {
  return new GitHubResponseValidationError("Pull Request volatile metadataと列挙値", {
    cause: new TypeError(message),
  });
}

function compareNodeIds(left: { nodeId: GitHubNodeId }, right: { nodeId: GitHubNodeId }): number {
  if (left.nodeId < right.nodeId) {
    return -1;
  }
  if (left.nodeId > right.nodeId) {
    return 1;
  }
  return 0;
}

function createFinalItemFingerprint(
  item: Extract<EnumeratedGitHubItem, { type: "pull_request" }>,
  currentMetadataFingerprint: Sha256Fingerprint,
): Sha256Fingerprint {
  return hashCanonicalJson({
    nodeId: item.nodeId,
    itemFingerprint: item.itemFingerprint,
    currentMetadataFingerprint,
  });
}

/** REST列挙値へprobe結果を結合し、Pull Requestのitem fingerprintを確定する。 */
export function finalizeGitHubItemsWithVolatileMetadata(
  options: FinalizeGitHubItemsWithVolatileMetadataOptions,
): FinalizedGitHubItemCollection {
  const itemNodeIds = new Set<GitHubNodeId>();
  const pullRequestNodeIds = new Set<GitHubNodeId>();
  for (const item of options.items) {
    if (itemNodeIds.has(item.nodeId)) {
      throw createValidationError(`列挙値のnode IDが重複しています。対象: ${item.nodeId}`);
    }
    itemNodeIds.add(item.nodeId);
    if (item.type === "pull_request") {
      pullRequestNodeIds.add(item.nodeId);
    }
  }

  const metadataByNodeId = new Map<GitHubNodeId, GitHubPullRequestVolatileMetadata>();
  const sortedMetadata = [...options.volatileMetadata].sort(compareNodeIds);
  for (const metadata of sortedMetadata) {
    if (metadataByNodeId.has(metadata.nodeId)) {
      throw createValidationError(`probe結果のnode IDが重複しています。対象: ${metadata.nodeId}`);
    }
    if (!itemNodeIds.has(metadata.nodeId) || !pullRequestNodeIds.has(metadata.nodeId)) {
      throw createValidationError(
        `probe結果が列挙済みPull Requestに対応しません。対象: ${metadata.nodeId}`,
      );
    }
    metadataByNodeId.set(metadata.nodeId, metadata);
  }

  if (metadataByNodeId.size !== pullRequestNodeIds.size) {
    throw createValidationError("列挙済みPull Requestとprobe結果の件数が一致しません");
  }

  const sortedItems = [...options.items].sort(compareNodeIds);
  const items = Object.freeze(
    sortedItems.map((item): FinalizedGitHubItem => {
      if (item.type === "issue") {
        return item;
      }
      const metadata = metadataByNodeId.get(item.nodeId);
      if (metadata == null) {
        throw createValidationError(`Pull Requestのprobe結果がありません。対象: ${item.nodeId}`);
      }
      return Object.freeze({
        ...item,
        itemFingerprint: createFinalItemFingerprint(item, metadata.currentMetadataFingerprint),
      });
    }),
  );
  return Object.freeze({
    status: "finalized",
    items,
    volatileMetadataByNodeId: metadataByNodeId,
  });
}
