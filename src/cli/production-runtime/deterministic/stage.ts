import { createLabelEffectsResolver, resolveRepositoryMaintainers } from "../../../domain/index.js";
import { assertNonNullable } from "../../../util/index.js";
import type { DailyTransactionDependencies } from "../../daily-transaction.js";
import {
  analyzeInitialItem,
  createNativeBlockers,
  type DeterministicItemAnalysis,
} from "../../initial-item-analysis.js";
import type { EffectiveAssigneeCollectionContext } from "../../issue-responsibility-candidates.js";
import type {
  CollectedItems,
  DeterministicAnalysis,
  ProductionTypes,
  RepositoryInventory,
  RuntimeConfiguration,
  RuntimeState,
} from "../contracts.js";
import { normalizeLabelRules } from "../label-rules.js";
import {
  EMPTY_RELATION_CANDIDATES,
  indexRelationCandidatesByNodeId,
} from "../relation-candidate-index.js";
import { findRepository, repositoryFullName } from "../repository-lookup.js";

function applyDeterministicAnalysis(
  configuration: RuntimeConfiguration,
  state: RuntimeState,
  inventory: RepositoryInventory,
  collection: CollectedItems,
): DeterministicAnalysis {
  const resolveLabelEffects = createLabelEffectsResolver(normalizeLabelRules(configuration.config));
  const observedItemsByNodeId = new Map(
    collection.observedItems.map((item) => [item.nodeId, item]),
  );
  const detailsByNodeId = new Map(collection.details.map((detail) => [detail.nodeId, detail]));
  const relationCandidatesByNodeId = indexRelationCandidatesByNodeId(collection.relationCandidates);
  const effectiveAssigneeCollectionContext = Object.freeze({
    observedItemsByNodeId,
    detailsByNodeId,
    trackedNodeIds: collection.trackedNodeIds,
  }) satisfies EffectiveAssigneeCollectionContext;
  const items: DeterministicItemAnalysis[] = [];
  for (const item of collection.observedItems) {
    if (!collection.analysisNodeIds.has(item.nodeId)) {
      continue;
    }
    const repository = findRepository(inventory, item.repositoryId);
    const maintainers = resolveRepositoryMaintainers(
      configuration.config.maintainers,
      repositoryFullName(repository),
    );
    const detail = detailsByNodeId.get(item.nodeId);
    assertNonNullable(detail, `GitHub詳細取得結果がありません。対象: ${item.nodeId}`);
    const notificationClass = collection.trackingNotificationClassByNodeId.get(item.nodeId);
    assertNonNullable(notificationClass, `追跡項目の通知分類がありません。対象: ${item.nodeId}`);
    const labelEffects = resolveLabelEffects(repositoryFullName(repository), item.labels);
    const relationCandidates =
      relationCandidatesByNodeId.get(item.nodeId) ?? EMPTY_RELATION_CANDIDATES;
    const blockers = createNativeBlockers(item, relationCandidates);
    items.push(
      analyzeInitialItem({
        item,
        detail,
        blockers,
        maintainers,
        labelEffects,
        confidenceThresholds: configuration.config.ai.confidence,
        evaluatedAt: collection.evaluatedAt,
        notificationClass,
        relationCandidates,
        effectiveAssigneeCollectionContext,
      }),
    );
  }
  return Object.freeze({
    items: Object.freeze(items),
    state,
    inventory,
  });
}

/** 決定的規則の適用段階を作る。 */
export function createApplyDeterministicRulesStage(): DailyTransactionDependencies<ProductionTypes>["applyDeterministicRules"] {
  return ({ configuration, state, repositoryInventory, collection }) =>
    Promise.resolve(
      applyDeterministicAnalysis(configuration, state, repositoryInventory, collection),
    );
}
