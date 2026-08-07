import {
  createUtcIsoDateTime,
  isRetryableTrackedItemAiAnalysisStatus,
  type GitHubNodeId,
  type TrackedItemAiAnalysis,
  type UtcIsoDateTime,
} from "../domain/index.js";
import { type EnumeratedGitHubItem, type Sha256Fingerprint } from "./item-enumeration.js";
import { type GitHubItemDetailEventWindow } from "./item-detail-queries.js";

/** 項目種別ごとの現在の判定規則fingerprint。 */
export type CurrentAnalysisRulesFingerprints = Readonly<
  Record<EnumeratedGitHubItem["type"], Sha256Fingerprint>
>;

/** 項目を前回判定したときの判定規則fingerprint。 */
export type PreviousAnalysisRulesFingerprint =
  | Readonly<{
      status: "unavailable";
    }>
  | Readonly<{
      status: "available";
      fingerprint: Sha256Fingerprint;
    }>;

type PreviousItemCollectionValue = Readonly<{
  itemFingerprint: Sha256Fingerprint;
  analysisRulesFingerprint: PreviousAnalysisRulesFingerprint;
}>;

type ChangedItem = Readonly<{
  nodeId: GitHubNodeId;
  timelineWindow: "full_history" | "incremental";
}>;

/** 前回成功時点の項目fingerprintと判定規則fingerprint。 */
export type PreviousItemCollection =
  | Readonly<{
      status: "none";
    }>
  | Readonly<{
      status: "successful";
      completedAt: UtcIsoDateTime;
      items: ReadonlyMap<GitHubNodeId, PreviousItemCollectionValue>;
    }>;

type IncrementalItemCollectionPlanFields = Readonly<{
  changedItemNodeIds: readonly GitHubNodeId[];
  detailTargets: readonly IncrementalItemDetailTarget[];
  currentItemFingerprints: ReadonlyMap<GitHubNodeId, Sha256Fingerprint>;
}>;

/** 詳細取得対象のnode IDとtimeline取得窓。 */
export type IncrementalItemDetailTarget = Readonly<{
  nodeId: GitHubNodeId;
  eventWindow: GitHubItemDetailEventWindow;
}>;

/** 項目ごとのtimeline取得窓を含む詳細取得計画。 */
export type IncrementalItemCollectionPlan =
  | (IncrementalItemCollectionPlanFields &
      Readonly<{
        mode: "initial";
      }>)
  | (IncrementalItemCollectionPlanFields &
      Readonly<{
        mode: "incremental";
        since: UtcIsoDateTime;
      }>);

export type PlanIncrementalItemCollectionOptions = Readonly<{
  items: readonly EnumeratedGitHubItem[];
  previous: PreviousItemCollection;
  previousAiAnalysisStatusesByNodeId: ReadonlyMap<GitHubNodeId, TrackedItemAiAnalysis["status"]>;
  currentAnalysisRulesFingerprints: CurrentAnalysisRulesFingerprints;
  adjacentItemNodeIds: ReadonlySet<GitHubNodeId>;
  overlapMilliseconds: number;
}>;

function validateOverlapMilliseconds(overlapMilliseconds: number): void {
  if (!Number.isSafeInteger(overlapMilliseconds) || overlapMilliseconds < 0) {
    throw new TypeError("overlapMillisecondsには0以上の安全な整数を指定してください");
  }
}

function calculateSince(completedAt: UtcIsoDateTime, overlapMilliseconds: number): UtcIsoDateTime {
  const sinceDate = new Date(new Date(completedAt).getTime() - overlapMilliseconds);
  if (Number.isNaN(sinceDate.getTime())) {
    throw new RangeError("overlap適用後の増分取得起点を表現できません");
  }
  return createUtcIsoDateTime(sinceDate.toISOString());
}

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

function selectChangedItems(
  items: readonly EnumeratedGitHubItem[],
  previous: PreviousItemCollection,
  previouslyTrackedItemNodeIds: ReadonlySet<GitHubNodeId>,
  currentAnalysisRulesFingerprints: CurrentAnalysisRulesFingerprints,
): readonly ChangedItem[] {
  if (previous.status === "none") {
    return Object.freeze(
      items.map((item) =>
        Object.freeze({
          nodeId: item.nodeId,
          timelineWindow: "full_history",
        }),
      ),
    );
  }

  const changedItems: ChangedItem[] = [];
  for (const item of items) {
    const previousItem = previous.items.get(item.nodeId);
    const itemFingerprintChanged = previousItem?.itemFingerprint !== item.itemFingerprint;
    if (!previouslyTrackedItemNodeIds.has(item.nodeId)) {
      if (itemFingerprintChanged) {
        changedItems.push(
          Object.freeze({
            nodeId: item.nodeId,
            timelineWindow: "full_history",
          }),
        );
      }
      continue;
    }
    if (previousItem == null) {
      changedItems.push(
        Object.freeze({
          nodeId: item.nodeId,
          timelineWindow: "full_history",
        }),
      );
      continue;
    }
    const previousRulesFingerprint = previousItem.analysisRulesFingerprint;
    if (
      previousRulesFingerprint.status === "unavailable" ||
      previousRulesFingerprint.fingerprint !== currentAnalysisRulesFingerprints[item.type]
    ) {
      changedItems.push(
        Object.freeze({
          nodeId: item.nodeId,
          timelineWindow: "full_history",
        }),
      );
      continue;
    }
    if (itemFingerprintChanged) {
      changedItems.push(
        Object.freeze({
          nodeId: item.nodeId,
          timelineWindow: "incremental",
        }),
      );
    }
  }
  return Object.freeze(changedItems);
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

function selectDetailTargets(
  changedItems: readonly ChangedItem[],
  aiAnalysisRetryItemNodeIds: readonly GitHubNodeId[],
  adjacentItemNodeIds: ReadonlySet<GitHubNodeId>,
  previouslyTrackedItemNodeIds: ReadonlySet<GitHubNodeId>,
  defaultEventWindow: GitHubItemDetailEventWindow,
): readonly IncrementalItemDetailTarget[] {
  const fullHistoryEventWindow = Object.freeze({
    mode: "initial",
  }) satisfies GitHubItemDetailEventWindow;
  const detailTargetsByNodeId = new Map<GitHubNodeId, IncrementalItemDetailTarget>();
  for (const item of changedItems) {
    detailTargetsByNodeId.set(
      item.nodeId,
      Object.freeze({
        nodeId: item.nodeId,
        eventWindow:
          item.timelineWindow === "full_history" ? fullHistoryEventWindow : defaultEventWindow,
      }),
    );
  }
  for (const nodeId of aiAnalysisRetryItemNodeIds) {
    if (detailTargetsByNodeId.has(nodeId)) {
      continue;
    }
    detailTargetsByNodeId.set(
      nodeId,
      Object.freeze({
        nodeId,
        eventWindow: defaultEventWindow,
      }),
    );
  }
  const sortedAdjacentItemNodeIds = [...adjacentItemNodeIds].sort(compareNodeIds);
  for (const nodeId of sortedAdjacentItemNodeIds) {
    if (detailTargetsByNodeId.has(nodeId)) {
      continue;
    }
    detailTargetsByNodeId.set(
      nodeId,
      Object.freeze({
        nodeId,
        eventWindow: previouslyTrackedItemNodeIds.has(nodeId)
          ? defaultEventWindow
          : fullHistoryEventWindow,
      }),
    );
  }
  return Object.freeze([...detailTargetsByNodeId.values()]);
}

function createPlanFields(
  changedItems: readonly ChangedItem[],
  aiAnalysisRetryItemNodeIds: readonly GitHubNodeId[],
  adjacentItemNodeIds: ReadonlySet<GitHubNodeId>,
  previouslyTrackedItemNodeIds: ReadonlySet<GitHubNodeId>,
  defaultEventWindow: GitHubItemDetailEventWindow,
  currentItemFingerprints: ReadonlyMap<GitHubNodeId, Sha256Fingerprint>,
): IncrementalItemCollectionPlanFields {
  return Object.freeze({
    changedItemNodeIds: Object.freeze(changedItems.map((item) => item.nodeId)),
    detailTargets: selectDetailTargets(
      changedItems,
      aiAnalysisRetryItemNodeIds,
      adjacentItemNodeIds,
      previouslyTrackedItemNodeIds,
      defaultEventWindow,
    ),
    currentItemFingerprints,
  });
}

/** 変更項目、AI再試行項目、外部指定されたグラフ隣接nodeを詳細取得対象にする。 */
export function planIncrementalItemCollection(
  options: PlanIncrementalItemCollectionOptions,
): IncrementalItemCollectionPlan {
  validateOverlapMilliseconds(options.overlapMilliseconds);
  const currentItemFingerprints = createCurrentFingerprints(options.items);
  const previouslyTrackedItemNodeIds = new Set(options.previousAiAnalysisStatusesByNodeId.keys());
  const changedItems = selectChangedItems(
    options.items,
    options.previous,
    previouslyTrackedItemNodeIds,
    options.currentAnalysisRulesFingerprints,
  );
  const aiAnalysisRetryItemNodeIds = selectAiAnalysisRetryItemNodeIds(
    options.items,
    options.previousAiAnalysisStatusesByNodeId,
  );

  if (options.previous.status === "none") {
    const fields = createPlanFields(
      changedItems,
      aiAnalysisRetryItemNodeIds,
      options.adjacentItemNodeIds,
      previouslyTrackedItemNodeIds,
      Object.freeze({ mode: "initial" }),
      currentItemFingerprints,
    );
    return Object.freeze({
      mode: "initial",
      ...fields,
    });
  }
  const since = calculateSince(options.previous.completedAt, options.overlapMilliseconds);
  const fields = createPlanFields(
    changedItems,
    aiAnalysisRetryItemNodeIds,
    options.adjacentItemNodeIds,
    previouslyTrackedItemNodeIds,
    Object.freeze({
      mode: "incremental",
      since,
    }),
    currentItemFingerprints,
  );
  return Object.freeze({
    mode: "incremental",
    since,
    ...fields,
  });
}
