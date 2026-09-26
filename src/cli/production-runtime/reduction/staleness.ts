import type { ReducedCodexDecision } from "../../../codex/index.js";
import {
  calculateStaleness,
  createLabelEffectsResolver,
  createStalenessNotificationSeverityReason,
  recalculateStalenessSeverity,
  type BlockedParentContext,
  type BlockerRanking,
  type GitHubNodeId,
  type Severity,
  type StalenessResult,
  type TrackedItem,
  type TrackingNotificationClass,
  type UtcIsoDateTime,
} from "../../../domain/index.js";
import type { FreshObservedGitHubItem } from "../../../github/index.js";
import type { AnalyzeGraphResult } from "../../../graph/index.js";
import type { SnapshotTrackedItem } from "../../../persistence/index.js";
import { assertNonNullable } from "../../../util/index.js";
import type {
  CollectedItems,
  GraphResult,
  RepositoryInventory,
  RuntimeConfiguration,
  RuntimeState,
  TrackedItemStaleness,
} from "../contracts.js";
import { previousGraphIndex } from "../previous-state/graph.js";
import { previousTrackedItem, previousTrackedItemsByNodeId } from "../previous-state/snapshot.js";
import { findRepository, repositoryFullName } from "../repository-lookup.js";
import { criticalSeverityWasRequested } from "../ai-dependencies/severity.js";

/** 前回の停滞計算状態を取得する。 */
export function previousStalenessState(
  state: RuntimeState,
  nodeId: GitHubNodeId,
): Parameters<typeof calculateStaleness>[0]["previousState"] {
  const previous = previousTrackedItem(state, nodeId);
  if (previous == null) {
    return Object.freeze({
      availability: "not_available",
    });
  }
  return Object.freeze({
    availability: "available",
    stallSincePolicy: "inherit",
    value: Object.freeze({
      status: previous.status,
      waitingOn: previous.waitingOn,
      statusSince: previous.statusSince,
      ownerSince: previous.ownerSince,
      stallSince: previous.stallSince,
      lastProgressAt: previous.lastProgressAt,
      lastHumanActivityAt: previous.lastHumanActivityAt,
    }),
  });
}

/** GitHub項目の追跡状態を取得する。 */
export function trackedItemState(
  item: FreshObservedGitHubItem,
  decision: ReducedCodexDecision,
): TrackedItem["state"] {
  if (decision.status === "terminal_merged") {
    return "merged";
  }
  return item.state;
}

type BlockedParentIndex = Readonly<{
  previousSeverityByNodeId: ReadonlyMap<string, Severity>;
  downstreamImpactByNodeId: ReadonlyMap<string, number>;
}>;

/** blocked親の参照索引を作成する。 */
export function createBlockedParentIndex(
  state: RuntimeState,
  graph: GraphResult | undefined,
): BlockedParentIndex {
  const previousSeverityByNodeId = new Map<string, Severity>(
    [...previousTrackedItemsByNodeId(state).values()].map((item) => [item.nodeId, item.severity]),
  );
  let downstreamImpacts: AnalyzeGraphResult["downstreamImpacts"];
  if (graph != null) {
    downstreamImpacts = graph.analysis.downstreamImpacts;
  } else {
    const previousGraph = previousGraphIndex(state);
    downstreamImpacts =
      previousGraph.availability === "available"
        ? previousGraph.analysis.downstreamImpacts
        : Object.freeze([]);
  }
  return Object.freeze({
    previousSeverityByNodeId,
    downstreamImpactByNodeId: new Map(
      downstreamImpacts.map((impact) => [impact.nodeId, impact.openNodeCount]),
    ),
  });
}

/** blocked親の文脈を構築する。 */
export function blockedParentContext(
  decision: ReducedCodexDecision,
  index: BlockedParentIndex,
): BlockedParentContext {
  if (decision.status !== "waiting_for_unblock") {
    return Object.freeze({
      status: "not_applicable",
    });
  }
  const firstWaitingOn = decision.waitingOn[0];
  assertNonNullable(firstWaitingOn, "blocked項目にwaitingOnがありません");
  const createRanking = (waitingOn: ReducedCodexDecision["waitingOn"][number]): BlockerRanking =>
    Object.freeze({
      candidateId: waitingOn.candidateId,
      severity: index.previousSeverityByNodeId.get(waitingOn.candidateId) ?? "none",
      downstreamImpact: index.downstreamImpactByNodeId.get(waitingOn.candidateId) ?? 0,
    });
  const blockers: [BlockerRanking, ...BlockerRanking[]] = [
    createRanking(firstWaitingOn),
    ...decision.waitingOn.slice(1).map(createRanking),
  ];
  return Object.freeze({
    status: "available",
    blockers: Object.freeze(blockers),
  });
}

/** 停滞判定を追跡項目の形式へ変換する。 */
export function trackedItemStaleness(staleness: StalenessResult): TrackedItemStaleness {
  return Object.freeze({
    elapsedHours: staleness.elapsedHours.stall,
    severity: staleness.severity,
    severityReason: createStalenessNotificationSeverityReason(staleness.severityReason),
    criticalSuppressed:
      staleness.severityReason.kind === "elapsed_threshold" &&
      staleness.severityReason.criticalSuppressed,
    criticalRequested: criticalSeverityWasRequested(staleness.severityReason),
    waitClass: staleness.waitClass,
    severityContext: staleness.severityContext,
  });
}

/** 保持項目の停滞度を再計算する。 */
export function recalculateTrackedItemStaleness(
  evaluatedAt: UtcIsoDateTime,
  configuration: RuntimeConfiguration,
  inventory: RepositoryInventory,
  item: SnapshotTrackedItem,
  resolveLabelEffects: ReturnType<typeof createLabelEffectsResolver>,
): TrackedItemStaleness {
  const repository = findRepository(inventory, item.repositoryId);
  const recalculated = recalculateStalenessSeverity({
    evaluatedAt,
    stallSince: item.stallSince,
    confidence: item.confidence,
    minimumAiConfidence: configuration.config.ai.confidence.medium,
    repositoryFullName: repositoryFullName(repository),
    currentLabels: item.labels,
    resolveLabelEffects,
    thresholdsHours: configuration.config.staleness.thresholdsHours,
    severityContext: item.severityContext,
  });
  const highConfidenceSeverity =
    recalculated.severityReason.kind === "elapsed_threshold"
      ? recalculateStalenessSeverity({
          evaluatedAt,
          stallSince: item.stallSince,
          confidence: 1,
          minimumAiConfidence: configuration.config.ai.confidence.medium,
          repositoryFullName: repositoryFullName(repository),
          currentLabels: item.labels,
          resolveLabelEffects,
          thresholdsHours: configuration.config.staleness.thresholdsHours,
          severityContext: item.severityContext,
        }).severity
      : recalculated.severity;
  return Object.freeze({
    elapsedHours: recalculated.elapsedHours,
    severity: recalculated.severity,
    severityReason: recalculated.severityReason,
    criticalSuppressed:
      recalculated.severityReason.kind === "elapsed_threshold" &&
      recalculated.severity === "urgent" &&
      highConfidenceSeverity === "critical",
    criticalRequested:
      recalculated.severity === "critical" ||
      (recalculated.severity === "urgent" && highConfidenceSeverity === "critical"),
    waitClass: recalculated.waitClass,
    severityContext: recalculated.severityContext,
  });
}

/** 保持項目の通知分類を取得する。 */
export function retainedItemNotificationClass(
  collection: CollectedItems,
  item: SnapshotTrackedItem,
): TrackingNotificationClass {
  const currentClass = collection.trackingNotificationClassByNodeId.get(item.nodeId);
  if (currentClass != null) {
    return currentClass;
  }
  const repositoryResult = collection.repositoryResults.find(
    (result) => result.repository.id === item.repositoryId,
  );
  assertNonNullable(
    repositoryResult,
    `保持項目のrepository収集結果がありません。対象: ${item.nodeId}`,
  );
  if (repositoryResult.freshness === "fresh") {
    throw new TypeError(`保持項目の通知分類がありません。対象: ${item.nodeId}`);
  }
  return item.notificationClass;
}

/** 保持項目の観測時刻を取得する。 */
export function retainedItemObservedAt(
  collection: CollectedItems,
  item: SnapshotTrackedItem,
): UtcIsoDateTime {
  const repositoryResult = collection.repositoryResults.find(
    (result) => result.repository.id === item.repositoryId,
  );
  assertNonNullable(
    repositoryResult,
    `保持項目のrepository収集結果がありません。対象: ${item.nodeId}`,
  );
  return repositoryResult.freshness === "fresh" ? collection.evaluatedAt : item.observedAt;
}
