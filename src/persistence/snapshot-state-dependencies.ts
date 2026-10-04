import { hashCanonicalJson } from "../canonical-json/index.js";
import {
  AI_ANALYSIS_DEPENDENCY_ELEMENTS,
  aiAnalysisDependencyForApplication,
  combineAiAnalysisDependencies,
  trackedItemAiDependenciesSchema,
} from "../domain/ai-analysis-dependencies.js";
import {
  aiAnalysisElementApplicationUsesAiValue,
  type AiAnalysisElement,
} from "../domain/ai-analysis-elements.js";
import {
  type AiAnalysisDependency,
  type AiAnalysisDependencyElement,
  type AiAnalysisDependencyProducer,
  type GraphNodeId,
  type Relation,
} from "../domain/index.js";
import { StateSnapshotSemanticError } from "./errors.js";
import { expectedAiAnalysisDependencyForProducer } from "./snapshot-ai-adoption.js";
import {
  assertAiAnalysisDependencyIntegrity,
  BLOCKER_STATE_DEPENDENCY_ELEMENTS,
  dependencyHasHiddenProducerlessReason,
  directAiAnalysisDependencyProducerElement,
  producerlessStaleRepositoryAiAnalysisDependency,
} from "./snapshot-ai-integrity.js";
import type {
  LegacyRelationWithoutAiDependency,
  SnapshotItemForRelationValidation,
  SnapshotTrackedItem,
} from "./snapshot-contracts.js";
import {
  assertAiAnalysisDependencyLowerBound,
  assertNegativeBlockerCandidateDirection,
} from "./snapshot-graph-dependencies.js";

const STALE_BLOCKER_TOPOLOGY_DEPENDENCY_ELEMENTS = Object.freeze([
  ...BLOCKER_STATE_DEPENDENCY_ELEMENTS,
  "lastProgressAt",
  "stallSince",
] satisfies readonly AiAnalysisDependencyElement[]);

const STALE_REPOSITORY_DERIVED_DEPENDENCY_ELEMENTS = Object.freeze([
  "severity",
  "attention",
] satisfies readonly AiAnalysisDependencyElement[]);

const NATIVE_BLOCKER_STATE_APPLICATION_ELEMENTS = Object.freeze([
  "status",
  "waitingOn",
  "nextAction",
] satisfies readonly AiAnalysisElement[]);

function expectedStaleBlockerTopologyDependency(
  item: SnapshotTrackedItem,
  element: AiAnalysisDependencyElement,
): AiAnalysisDependency {
  const direct = expectedDirectAiAnalysisDependency(element, item);
  return direct == null
    ? producerlessStaleRepositoryAiAnalysisDependency
    : combineAiAnalysisDependencies([direct, producerlessStaleRepositoryAiAnalysisDependency]);
}

export function hasCanonicalStaleBlockerTopologyDependencies(item: SnapshotTrackedItem): boolean {
  return STALE_BLOCKER_TOPOLOGY_DEPENDENCY_ELEMENTS.every(
    (element) =>
      hashCanonicalJson(item.aiDependencies[element]) ===
      hashCanonicalJson(expectedStaleBlockerTopologyDependency(item, element)),
  );
}

function staleRepositorySeverityDependency(item: SnapshotTrackedItem): AiAnalysisDependency {
  if (
    item.severityContext.waitClass === "notApplicable" ||
    item.severityContext.waitClass === "blockedParent"
  ) {
    return item.aiDependencies.status;
  }
  return combineAiAnalysisDependencies([
    item.aiDependencies.stallSince,
    item.aiDependencies.status,
    item.aiDependencies.waitingOn,
  ]);
}

function staleRepositoryAttentionDependency(item: SnapshotTrackedItem): AiAnalysisDependency {
  if (
    item.severityContext.waitClass === "notApplicable" ||
    item.severityContext.waitClass === "blockedParent"
  ) {
    return item.aiDependencies.status;
  }
  const dependencies = [item.aiDependencies.importance, item.aiDependencies.deadlineLevel];
  if (item.importance.score !== 0) {
    dependencies.push(
      item.aiDependencies.stallSince,
      item.aiDependencies.status,
      item.aiDependencies.waitingOn,
    );
  }
  if (
    item.deadlineAssessment.status === "available" &&
    item.deadlineAssessment.value.date != null
  ) {
    dependencies.push(item.aiDependencies.status, item.aiDependencies.waitingOn);
  }
  return combineAiAnalysisDependencies(dependencies);
}

function assertStaleRepositoryDerivedDependency(
  item: SnapshotTrackedItem,
  element: "severity" | "attention",
  expected: AiAnalysisDependency,
): void {
  const dependency = item.aiDependencies[element];
  if (hashCanonicalJson(dependency) !== hashCanonicalJson(expected)) {
    throw new StateSnapshotSemanticError(
      `item ${item.nodeId}の${element}がstale repository依存の導出結果と一致しません`,
    );
  }
}

function assertDirectAiAnalysisDependencyProducer(
  producer: AiAnalysisDependencyProducer,
  element: AiAnalysisDependencyElement,
  item: SnapshotTrackedItem,
  description: string,
  relationsById: ReadonlyMap<string, Relation | LegacyRelationWithoutAiDependency>,
  activeBlocksArcKeys: ReadonlySet<string>,
): void {
  const expectedProducerElement = directAiAnalysisDependencyProducerElement(element);
  if (producer.kind === "item_element") {
    if (element === "relationSet") {
      throw new StateSnapshotSemanticError(`${description}にitem element producerは指定できません`);
    }
    if (
      expectedProducerElement != null &&
      (producer.nodeId !== item.nodeId || producer.element !== expectedProducerElement)
    ) {
      throw new StateSnapshotSemanticError(
        `${description}の直接AI依存producerが親itemと一致しません`,
      );
    }
    if (element === "primaryWaitingOn") {
      if (!("applications" in item.aiAnalysis)) {
        throw new StateSnapshotSemanticError("itemのAI適用元がありません");
      }
      if (
        aiAnalysisElementApplicationUsesAiValue(item.aiAnalysis.applications.waitingOn) &&
        (producer.nodeId !== item.nodeId || producer.element !== "waitingOn")
      ) {
        throw new StateSnapshotSemanticError(
          `${description}の直接AI依存producerが親itemのwaitingOnと一致しません`,
        );
      }
    }
    return;
  }
  const blockerDerivedElements = new Set<AiAnalysisDependencyElement>([
    "status",
    "waitingOn",
    "nextAction",
    "primaryWaitingOn",
    "confidence",
    "evidence",
    "uncertainties",
    "blockers",
  ]);
  if (producer.kind === "relation_candidate") {
    if (element === "relationSet") {
      if (!producer.endpointNodeIds.includes(item.nodeId)) {
        throw new StateSnapshotSemanticError(
          `${description}のrelation candidate endpointが親itemと一致しません`,
        );
      }
      return;
    }
    if (blockerDerivedElements.has(element)) {
      if (element === "blockers") {
        assertNegativeBlockerCandidateDirection(producer, item.nodeId, activeBlocksArcKeys);
      } else if (!producer.endpointNodeIds.includes(item.nodeId)) {
        throw new StateSnapshotSemanticError(
          `${description}のrelation candidate endpointが親itemと一致しません`,
        );
      }
      return;
    }
    return;
  }
  const relation = relationsById.get(producer.relationId);
  if (relation == null) {
    throw new StateSnapshotSemanticError(`${description}のrelation producerが存在しません`);
  }
  if (element === "relationSet") {
    if (
      !relation.active ||
      (relation.fromNodeId !== item.nodeId && relation.toNodeId !== item.nodeId)
    ) {
      throw new StateSnapshotSemanticError(
        `${description}のrelation producerが親itemへ接続するactive relationではありません`,
      );
    }
    return;
  }
  if (
    blockerDerivedElements.has(element) &&
    (!relation.active || relation.type !== "blocks" || relation.toNodeId !== item.nodeId)
  ) {
    throw new StateSnapshotSemanticError(
      `${description}のrelation producerが親itemのactive blockerではありません`,
    );
  }
}

function blockerDerivedItemElementIsValid(
  producer: Extract<AiAnalysisDependencyProducer, { kind: "item_element" }>,
  element: AiAnalysisDependencyElement,
  itemNodeId: GraphNodeId,
): boolean {
  if (producer.nodeId !== itemNodeId) {
    return false;
  }
  switch (element) {
    case "status":
      return producer.element === "status";
    case "waitingOn":
    case "primaryWaitingOn":
      return producer.element === "waitingOn";
    case "nextAction":
      return producer.element === "nextAction";
    case "confidence":
    case "evidence":
    case "uncertainties":
      return (
        producer.element === "status" ||
        producer.element === "waitingOn" ||
        producer.element === "nextAction"
      );
    default:
      return false;
  }
}

function blockerDerivedDependencyHasHiddenProducerlessReason(
  dependency: AiAnalysisDependency,
  reason: "not_recorded" | "migration",
  element: AiAnalysisDependencyElement,
  item: SnapshotTrackedItem,
  itemsByNodeId: ReadonlyMap<string, SnapshotItemForRelationValidation>,
  relationsById: ReadonlyMap<string, Relation | LegacyRelationWithoutAiDependency>,
  activeBlocksArcKeys: ReadonlySet<string>,
): boolean {
  if (
    dependency.status === "not_dependent" ||
    !dependencyHasHiddenProducerlessReason(dependency, reason, itemsByNodeId, relationsById)
  ) {
    return false;
  }
  for (const producer of dependency.producers ?? []) {
    if (
      producer.kind === "item_element" &&
      !blockerDerivedItemElementIsValid(producer, element, item.nodeId)
    ) {
      throw new StateSnapshotSemanticError(
        `itemのAI依存の${element}にblocker由来でないitem producerがあります`,
      );
    }
    assertDirectAiAnalysisDependencyProducer(
      producer,
      element,
      item,
      `itemのAI依存の${element}`,
      relationsById,
      activeBlocksArcKeys,
    );
  }
  return true;
}

function expectedDirectAiAnalysisDependency(
  element: AiAnalysisDependencyElement,
  item: SnapshotTrackedItem,
): AiAnalysisDependency | undefined {
  if (!("applications" in item.aiAnalysis)) {
    throw new StateSnapshotSemanticError("itemのAI適用元がありません");
  }
  if (
    element === "primaryWaitingOn" &&
    aiAnalysisElementApplicationUsesAiValue(item.aiAnalysis.applications.waitingOn)
  ) {
    return aiAnalysisDependencyForApplication(
      item.nodeId,
      "waitingOn",
      item.aiAnalysis.applications.waitingOn,
    );
  }
  const producerElement = directAiAnalysisDependencyProducerElement(element);
  if (producerElement == null) {
    return undefined;
  }
  return aiAnalysisDependencyForApplication(
    item.nodeId,
    producerElement,
    item.aiAnalysis.applications[producerElement],
  );
}

function directDependencyCanBeReplacedByNativeBlocker(
  element: AiAnalysisDependencyElement,
  item: SnapshotTrackedItem,
  notDependentOpenBlockerNodeIdsByTargetNodeId: ReadonlyMap<GraphNodeId, ReadonlySet<GraphNodeId>>,
): boolean {
  if (element !== "status" && element !== "nextAction") {
    return false;
  }
  if (!("applications" in item.aiAnalysis)) {
    throw new StateSnapshotSemanticError("itemのAI適用元がありません");
  }
  if (aiAnalysisElementApplicationUsesAiValue(item.aiAnalysis.applications[element])) {
    return false;
  }
  const blockerNodeIds = notDependentOpenBlockerNodeIdsByTargetNodeId.get(item.nodeId);
  if (blockerNodeIds == null) {
    return false;
  }
  if (element === "status") {
    return item.status === "waiting_for_unblock";
  }
  return [...blockerNodeIds].some(
    (blockerNodeId) => item.nextAction === `${blockerNodeId}の完了を待つ`,
  );
}

function directDependencyMustMatchExactly(
  element: AiAnalysisDependencyElement,
  item: SnapshotTrackedItem,
): boolean {
  if (element === "deadline" || element === "deadlineLevel" || element === "primaryWaitingOn") {
    return true;
  }
  if (element !== "status" && element !== "waitingOn" && element !== "nextAction") {
    return false;
  }
  if (!("applications" in item.aiAnalysis)) {
    throw new StateSnapshotSemanticError("itemのAI適用元がありません");
  }
  return aiAnalysisElementApplicationUsesAiValue(item.aiAnalysis.applications[element]);
}

function assertDirectAiAnalysisDependencyLowerBound(
  expected: AiAnalysisDependency,
  actual: AiAnalysisDependency,
  element: AiAnalysisDependencyElement,
  item: SnapshotTrackedItem,
  description: string,
): void {
  const producerlessMigration =
    actual.status === "unknown" &&
    actual.reasons.length === 1 &&
    actual.reasons[0] === "migration" &&
    actual.producers == null;
  if (producerlessMigration) {
    throw new StateSnapshotSemanticError(`${description}にproducerless migrationは指定できません`);
  }
  if (directDependencyMustMatchExactly(element, item)) {
    if (hashCanonicalJson(expected) !== hashCanonicalJson(actual)) {
      throw new StateSnapshotSemanticError(`${description}がAI適用元と一致しません`);
    }
    return;
  }
  assertAiAnalysisDependencyLowerBound(expected, actual, `${description}のAI適用元`);
}

export function assertTrackedItemAiDependenciesSemantics(
  dependencies: unknown,
  description: string,
  item: SnapshotTrackedItem,
  itemsByNodeId: ReadonlyMap<string, SnapshotItemForRelationValidation>,
  relationsById: ReadonlyMap<string, Relation | LegacyRelationWithoutAiDependency>,
  activeBlocksArcKeys: ReadonlySet<string>,
  notDependentOpenBlockerNodeIdsByTargetNodeId: ReadonlyMap<GraphNodeId, ReadonlySet<GraphNodeId>>,
  itemIsStale: boolean,
): void {
  const parsedDependencies = trackedItemAiDependenciesSchema.safeParse(dependencies);
  if (!parsedDependencies.success) {
    throw new StateSnapshotSemanticError(`${description}が不正です`, {
      cause: parsedDependencies.error,
    });
  }
  const blockerDerivedElements = new Set<AiAnalysisDependencyElement>(
    BLOCKER_STATE_DEPENDENCY_ELEMENTS,
  );
  const staleBlockerTopologyElements = new Set<AiAnalysisDependencyElement>(
    STALE_BLOCKER_TOPOLOGY_DEPENDENCY_ELEMENTS,
  );
  const staleRepositoryDerivedElements = new Set<AiAnalysisDependencyElement>(
    STALE_REPOSITORY_DERIVED_DEPENDENCY_ELEMENTS,
  );
  const staleBlockerTopologyFallback =
    itemIsStale && hasCanonicalStaleBlockerTopologyDependencies(item);
  if (
    !staleBlockerTopologyFallback &&
    notDependentOpenBlockerNodeIdsByTargetNodeId.has(item.nodeId)
  ) {
    if (!("applications" in item.aiAnalysis)) {
      throw new StateSnapshotSemanticError("itemのAI適用元がありません");
    }
    for (const element of NATIVE_BLOCKER_STATE_APPLICATION_ELEMENTS) {
      if (aiAnalysisElementApplicationUsesAiValue(item.aiAnalysis.applications[element])) {
        throw new StateSnapshotSemanticError(
          `item ${item.nodeId}の${element}は確定blockerがある場合にAI値を使用できません`,
        );
      }
    }
  }
  const aggregateElements = new Set<AiAnalysisDependencyElement>([
    "lastProgressAt",
    "stallSince",
    "severity",
    "downstreamImpact",
    "importance",
    "attention",
    "blockers",
    "relationSet",
  ]);
  for (const element of AI_ANALYSIS_DEPENDENCY_ELEMENTS) {
    const dependencyEntry = parsedDependencies.data[element];
    if (dependencyEntry == null) {
      throw new StateSnapshotSemanticError(
        `${description}の依存要素がありません。対象: ${element}`,
      );
    }
    const elementDescription = `${description}の${element}`;
    const blockerDerivedHiddenNotRecorded =
      blockerDerivedElements.has(element) &&
      blockerDerivedDependencyHasHiddenProducerlessReason(
        dependencyEntry,
        "not_recorded",
        element,
        item,
        itemsByNodeId,
        relationsById,
        activeBlocksArcKeys,
      );
    const blockerDerivedHiddenMigration =
      blockerDerivedElements.has(element) &&
      blockerDerivedDependencyHasHiddenProducerlessReason(
        dependencyEntry,
        "migration",
        element,
        item,
        itemsByNodeId,
        relationsById,
        activeBlocksArcKeys,
      );
    const dependency = assertAiAnalysisDependencyIntegrity(dependencyEntry, elementDescription, {
      allowStaleRepository:
        staleBlockerTopologyFallback &&
        (staleBlockerTopologyElements.has(element) || staleRepositoryDerivedElements.has(element)),
      allowProducerlessNotRecorded: true,
      allowProducerlessMigration: true,
      allowProducerlessStaleRepository:
        staleBlockerTopologyFallback &&
        (staleBlockerTopologyElements.has(element) || staleRepositoryDerivedElements.has(element)),
      allowHiddenProducerlessNotRecorded:
        aggregateElements.has(element) || blockerDerivedHiddenNotRecorded,
      allowHiddenProducerlessMigration:
        aggregateElements.has(element) || blockerDerivedHiddenMigration,
      allowHiddenProducerlessStaleRepository:
        staleBlockerTopologyFallback &&
        (staleBlockerTopologyElements.has(element) || staleRepositoryDerivedElements.has(element)),
      dependencyForProducer: (producer, producerDescription, containingDependency) =>
        expectedAiAnalysisDependencyForProducer(
          producer,
          producerDescription,
          itemsByNodeId,
          relationsById,
          containingDependency,
        ),
    });
    const expectedDirectDependency = expectedDirectAiAnalysisDependency(element, item);
    if (
      expectedDirectDependency != null &&
      (!staleBlockerTopologyFallback || !staleBlockerTopologyElements.has(element))
    ) {
      const nativeBlockerOverride = directDependencyCanBeReplacedByNativeBlocker(
        element,
        item,
        notDependentOpenBlockerNodeIdsByTargetNodeId,
      );
      if (nativeBlockerOverride) {
        if (dependency.status !== "not_dependent") {
          throw new StateSnapshotSemanticError(
            `${elementDescription}は確定blockerによる上書き時はnot_dependentにしてください`,
          );
        }
      } else {
        assertDirectAiAnalysisDependencyLowerBound(
          expectedDirectDependency,
          dependency,
          element,
          item,
          elementDescription,
        );
      }
    }
    if (dependency.status === "not_dependent") {
      continue;
    }
    for (const producer of dependency.producers ?? []) {
      assertDirectAiAnalysisDependencyProducer(
        producer,
        element,
        item,
        elementDescription,
        relationsById,
        activeBlocksArcKeys,
      );
    }
  }
  if (staleBlockerTopologyFallback) {
    assertStaleRepositoryDerivedDependency(
      item,
      "severity",
      staleRepositorySeverityDependency(item),
    );
    assertStaleRepositoryDerivedDependency(
      item,
      "attention",
      staleRepositoryAttentionDependency(item),
    );
  }
}
