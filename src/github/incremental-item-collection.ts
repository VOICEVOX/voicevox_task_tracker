import {
  isRetryableTrackedItemAiAnalysisStatus,
  type GitHubNodeId,
  type TrackedItemAiAnalysis,
} from "../domain/index.js";
import { type EnumeratedGitHubItem, type Sha256Fingerprint } from "./item-enumeration.js";

type PreviousItemCollectionValue = Readonly<{
  itemFingerprint: Sha256Fingerprint;
  analysisPlanFingerprint: Sha256Fingerprint;
}>;

/** 前回成功時点の項目と判定計画のfingerprint。 */
export type PreviousItemCollection =
  | Readonly<{
      status: "none";
    }>
  | Readonly<{
      status: "successful";
      items: ReadonlyMap<GitHubNodeId, PreviousItemCollectionValue>;
    }>;

/** 変更項目と全履歴の詳細取得対象を含む収集計画。 */
export type IncrementalItemCollectionPlan = Readonly<{
  changedItemNodeIds: readonly GitHubNodeId[];
  analysisPlanChangedItemNodeIds: readonly GitHubNodeId[];
  detailItemNodeIds: readonly GitHubNodeId[];
  currentItemFingerprints: ReadonlyMap<GitHubNodeId, Sha256Fingerprint>;
  currentAnalysisPlanFingerprints: ReadonlyMap<GitHubNodeId, Sha256Fingerprint>;
}>;

export type PlanIncrementalItemCollectionOptions = Readonly<{
  items: readonly EnumeratedGitHubItem[];
  previous: PreviousItemCollection;
  previousAiAnalysisStatusesByNodeId: ReadonlyMap<GitHubNodeId, TrackedItemAiAnalysis["status"]>;
  currentAnalysisPlanFingerprintsByNodeId: ReadonlyMap<GitHubNodeId, Sha256Fingerprint>;
  adjacentItemNodeIds: ReadonlySet<GitHubNodeId>;
}>;

function compareNodeIds(left: GitHubNodeId, right: GitHubNodeId): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function createCurrentFingerprints(
  items: readonly EnumeratedGitHubItem[],
): ReadonlyMap<GitHubNodeId, Sha256Fingerprint> {
  const fingerprints = new Map<GitHubNodeId, Sha256Fingerprint>();
  for (const item of items) {
    if (fingerprints.has(item.nodeId)) {
      throw new TypeError(`同じitem node IDが重複しています。対象: ${item.nodeId}`);
    }
    fingerprints.set(item.nodeId, item.itemFingerprint);
  }
  return fingerprints;
}

function validateCurrentAnalysisPlanFingerprints(
  items: readonly EnumeratedGitHubItem[],
  fingerprints: ReadonlyMap<GitHubNodeId, Sha256Fingerprint>,
): void {
  const itemNodeIds = new Set(items.map((item) => item.nodeId));
  for (const item of items) {
    if (!fingerprints.has(item.nodeId)) {
      throw new TypeError(`AI判定計画の規則fingerprintがありません。対象: ${item.nodeId}`);
    }
  }
  for (const nodeId of fingerprints.keys()) {
    if (!itemNodeIds.has(nodeId)) {
      throw new TypeError(`AI判定計画の規則fingerprintに対象外の項目があります。対象: ${nodeId}`);
    }
  }
}

function selectChangedItemNodeIds(
  items: readonly EnumeratedGitHubItem[],
  previous: PreviousItemCollection,
  previouslyTrackedItemNodeIds: ReadonlySet<GitHubNodeId>,
): readonly GitHubNodeId[] {
  if (previous.status === "none") {
    return Object.freeze(items.map((item) => item.nodeId));
  }

  const changedItemNodeIds: GitHubNodeId[] = [];
  for (const item of items) {
    const previousItem = previous.items.get(item.nodeId);
    const itemFingerprintChanged = previousItem?.itemFingerprint !== item.itemFingerprint;
    if (!previouslyTrackedItemNodeIds.has(item.nodeId)) {
      if (itemFingerprintChanged) {
        changedItemNodeIds.push(item.nodeId);
      }
      continue;
    }
    if (previousItem == null) {
      changedItemNodeIds.push(item.nodeId);
      continue;
    }
    if (itemFingerprintChanged) {
      changedItemNodeIds.push(item.nodeId);
    }
  }
  return Object.freeze(changedItemNodeIds);
}

function selectAiAnalysisRetryItemNodeIds(
  items: readonly EnumeratedGitHubItem[],
  previousAiAnalysisStatusesByNodeId: ReadonlyMap<GitHubNodeId, TrackedItemAiAnalysis["status"]>,
): readonly GitHubNodeId[] {
  const nodeIds: GitHubNodeId[] = [];
  for (const item of items) {
    const status = previousAiAnalysisStatusesByNodeId.get(item.nodeId);
    if (status != null && isRetryableTrackedItemAiAnalysisStatus(status)) {
      nodeIds.push(item.nodeId);
    }
  }
  return Object.freeze(nodeIds);
}

function selectAnalysisPlanChangedItemNodeIds(
  items: readonly EnumeratedGitHubItem[],
  previous: PreviousItemCollection,
  previouslyTrackedItemNodeIds: ReadonlySet<GitHubNodeId>,
  currentAnalysisPlanFingerprints: ReadonlyMap<GitHubNodeId, Sha256Fingerprint>,
): readonly GitHubNodeId[] {
  if (previous.status === "none") {
    return Object.freeze([]);
  }
  const changedItemNodeIds: GitHubNodeId[] = [];
  for (const item of items) {
    if (!previouslyTrackedItemNodeIds.has(item.nodeId)) {
      continue;
    }
    const currentFingerprint = currentAnalysisPlanFingerprints.get(item.nodeId);
    if (currentFingerprint == null) {
      throw new TypeError(`AI判定計画の規則fingerprintがありません。対象: ${item.nodeId}`);
    }
    const previousItem = previous.items.get(item.nodeId);
    if (previousItem?.analysisPlanFingerprint !== currentFingerprint) {
      changedItemNodeIds.push(item.nodeId);
    }
  }
  return Object.freeze(changedItemNodeIds);
}

function selectDetailItemNodeIds(
  changedItemNodeIds: readonly GitHubNodeId[],
  analysisPlanChangedItemNodeIds: readonly GitHubNodeId[],
  aiAnalysisRetryItemNodeIds: readonly GitHubNodeId[],
  adjacentItemNodeIds: ReadonlySet<GitHubNodeId>,
): readonly GitHubNodeId[] {
  const detailItemNodeIds = new Set<GitHubNodeId>();
  for (const nodeId of changedItemNodeIds) {
    detailItemNodeIds.add(nodeId);
  }
  for (const nodeId of analysisPlanChangedItemNodeIds) {
    detailItemNodeIds.add(nodeId);
  }
  for (const nodeId of aiAnalysisRetryItemNodeIds) {
    detailItemNodeIds.add(nodeId);
  }
  const sortedAdjacentItemNodeIds = [...adjacentItemNodeIds].sort(compareNodeIds);
  for (const nodeId of sortedAdjacentItemNodeIds) {
    detailItemNodeIds.add(nodeId);
  }
  return Object.freeze([...detailItemNodeIds]);
}

function createPlanFields(
  changedItemNodeIds: readonly GitHubNodeId[],
  analysisPlanChangedItemNodeIds: readonly GitHubNodeId[],
  aiAnalysisRetryItemNodeIds: readonly GitHubNodeId[],
  adjacentItemNodeIds: ReadonlySet<GitHubNodeId>,
  currentItemFingerprints: ReadonlyMap<GitHubNodeId, Sha256Fingerprint>,
  currentAnalysisPlanFingerprints: ReadonlyMap<GitHubNodeId, Sha256Fingerprint>,
): IncrementalItemCollectionPlan {
  return Object.freeze({
    changedItemNodeIds,
    analysisPlanChangedItemNodeIds,
    detailItemNodeIds: selectDetailItemNodeIds(
      changedItemNodeIds,
      analysisPlanChangedItemNodeIds,
      aiAnalysisRetryItemNodeIds,
      adjacentItemNodeIds,
    ),
    currentItemFingerprints,
    currentAnalysisPlanFingerprints,
  });
}

/** 変更項目、AI再試行項目、外部指定されたグラフ隣接nodeを詳細取得対象にする。 */
export function planIncrementalItemCollection(
  options: PlanIncrementalItemCollectionOptions,
): IncrementalItemCollectionPlan {
  const currentItemFingerprints = createCurrentFingerprints(options.items);
  validateCurrentAnalysisPlanFingerprints(
    options.items,
    options.currentAnalysisPlanFingerprintsByNodeId,
  );
  const previouslyTrackedItemNodeIds = new Set(options.previousAiAnalysisStatusesByNodeId.keys());
  const changedItemNodeIds = selectChangedItemNodeIds(
    options.items,
    options.previous,
    previouslyTrackedItemNodeIds,
  );
  const analysisPlanChangedItemNodeIds = selectAnalysisPlanChangedItemNodeIds(
    options.items,
    options.previous,
    previouslyTrackedItemNodeIds,
    options.currentAnalysisPlanFingerprintsByNodeId,
  );
  const aiAnalysisRetryItemNodeIds = selectAiAnalysisRetryItemNodeIds(
    options.items,
    options.previousAiAnalysisStatusesByNodeId,
  );

  return createPlanFields(
    changedItemNodeIds,
    analysisPlanChangedItemNodeIds,
    aiAnalysisRetryItemNodeIds,
    options.adjacentItemNodeIds,
    currentItemFingerprints,
    options.currentAnalysisPlanFingerprintsByNodeId,
  );
}
