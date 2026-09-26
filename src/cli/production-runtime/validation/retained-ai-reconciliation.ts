import { hashCanonicalJson } from "../../../canonical-json/index.js";
import {
  aiAnalysisElementApplicationUsesAiValue,
  type AiAnalysisElement,
} from "../../../domain/ai-analysis-elements.js";
import {
  aiAnalysisDependencyForApplication,
  combineAiAnalysisDependencies,
  type AiAnalysisDependency,
  type AiAnalysisDependencyElement,
} from "../../../domain/ai-analysis-dependencies.js";
import { assertNonNullable } from "../../../util/index.js";
import { historicalAiDependencyFallback } from "../ai-dependencies/history.js";
import {
  aiDependencyIndependencePriority,
  notDependentAiDependency,
  unrecordedAiDependency,
} from "../ai-dependencies/selection.js";
import type { TrackedItemWithImportanceAssessment } from "../contracts.js";
import {
  currentAiDependencyForProducer,
  retainedElementUsesBlockerDependency,
  revalidatedHistoricalAiDependencyWithCurrentContext,
  type CurrentAiDependencyContext,
} from "./retained-ai-producers.js";
import {
  staleRepositoryAiDependency,
  type RetainedBlockerValueAiDependencies,
} from "./retained-blocker-dependencies.js";

function retainedElementUsesStaleBlockerTopologyFallback(
  element: AiAnalysisDependencyElement,
): boolean {
  return (
    retainedElementUsesBlockerDependency(element) ||
    element === "lastProgressAt" ||
    element === "stallSince"
  );
}

function currentDirectAiDependencyForRetainedElement(
  item: TrackedItemWithImportanceAssessment,
  element: AiAnalysisDependencyElement,
): AiAnalysisDependency | undefined {
  let applicationElement: AiAnalysisElement | undefined;
  switch (element) {
    case "status":
    case "waitingOn":
    case "nextAction":
      applicationElement = element;
      break;
    case "primaryWaitingOn":
      applicationElement = "waitingOn";
      break;
    default:
      return undefined;
  }
  const application = item.aiAnalysis.applications[applicationElement];
  if (aiAnalysisElementApplicationUsesAiValue(application)) {
    return aiAnalysisDependencyForApplication(item.nodeId, applicationElement, application);
  }
  return undefined;
}

function staleBlockerTopologyDirectAiDependency(
  item: TrackedItemWithImportanceAssessment,
  element: AiAnalysisDependencyElement,
): AiAnalysisDependency | undefined {
  if (element === "primaryWaitingOn") {
    const application = item.aiAnalysis.applications.waitingOn;
    return aiAnalysisElementApplicationUsesAiValue(application)
      ? aiAnalysisDependencyForApplication(item.nodeId, "waitingOn", application)
      : undefined;
  }
  if (element === "status" || element === "waitingOn" || element === "nextAction") {
    return aiAnalysisDependencyForApplication(
      item.nodeId,
      element,
      item.aiAnalysis.applications[element],
    );
  }
  return undefined;
}

function staleBlockerTopologyFallbackDependency(
  item: TrackedItemWithImportanceAssessment,
  element: AiAnalysisDependencyElement,
): AiAnalysisDependency {
  const staleRepository = staleRepositoryAiDependency();
  const direct = staleBlockerTopologyDirectAiDependency(item, element);
  return direct == null
    ? staleRepository
    : combineAiAnalysisDependencies([direct, staleRepository]);
}

function retainedElementMatchesNativeOpenBlocker(
  item: TrackedItemWithImportanceAssessment,
  element: AiAnalysisDependencyElement,
  context: CurrentAiDependencyContext,
): boolean {
  const blockerNodeIds = context.nativeOpenBlockerNodeIdsByTargetNodeId.get(item.nodeId);
  if (blockerNodeIds == null) {
    return false;
  }
  if (element === "status") {
    return item.status === "waiting_for_unblock";
  }
  if (element === "nextAction") {
    return [...blockerNodeIds].some(
      (blockerNodeId) => item.nextAction === `${blockerNodeId}の完了を待つ`,
    );
  }
  return false;
}

function retainedBlockerExpectedDependencies(
  dependencies: RetainedBlockerValueAiDependencies,
  element: AiAnalysisDependencyElement,
): readonly AiAnalysisDependency[] {
  switch (element) {
    case "status":
      return dependencies.statusCandidates ?? Object.freeze([]);
    case "waitingOn":
      return dependencies.waitingOn == null
        ? Object.freeze([])
        : Object.freeze([dependencies.waitingOn]);
    case "primaryWaitingOn":
      return dependencies.primaryWaitingOn == null
        ? Object.freeze([])
        : Object.freeze([dependencies.primaryWaitingOn]);
    case "nextAction":
      return dependencies.nextAction == null
        ? Object.freeze([])
        : Object.freeze([dependencies.nextAction]);
    case "confidence":
      return dependencies.confidence == null
        ? Object.freeze([])
        : Object.freeze([dependencies.confidence]);
    case "evidence":
      return dependencies.evidence == null
        ? Object.freeze([])
        : Object.freeze([dependencies.evidence]);
    case "uncertainties":
      return dependencies.uncertainties == null
        ? Object.freeze([])
        : Object.freeze([dependencies.uncertainties]);
    default:
      return Object.freeze([]);
  }
}

function aiDependencyContainsLowerBound(
  expected: AiAnalysisDependency,
  actual: AiAnalysisDependency,
): boolean {
  if (expected.status === "not_dependent") {
    return true;
  }
  if (aiDependencyIndependencePriority(actual) < aiDependencyIndependencePriority(expected)) {
    return false;
  }
  const actualProducerSignatures = new Set(
    actual.status === "not_dependent"
      ? []
      : (actual.producers ?? []).map((producer) => hashCanonicalJson(producer)),
  );
  return (
    expected.producers?.every((producer) =>
      actualProducerSignatures.has(hashCanonicalJson(producer)),
    ) ?? true
  );
}

function aiDependencyHasOnlyExpectedGraphProducers(
  dependency: AiAnalysisDependency,
  expected: AiAnalysisDependency,
): boolean {
  const expectedProducerSignatures = new Set(
    expected.status === "not_dependent"
      ? []
      : (expected.producers ?? []).map((producer) => hashCanonicalJson(producer)),
  );
  if (dependency.status === "not_dependent") {
    return true;
  }
  return (dependency.producers ?? []).every(
    (producer) =>
      producer.kind === "item_element" ||
      expectedProducerSignatures.has(hashCanonicalJson(producer)),
  );
}

function currentRetainedItemElementDependencies(
  item: TrackedItemWithImportanceAssessment,
  element: AiAnalysisDependencyElement,
  dependency: AiAnalysisDependency,
  context: CurrentAiDependencyContext,
): readonly AiAnalysisDependency[] {
  if (dependency.status === "not_dependent" || dependency.producers == null) {
    return Object.freeze([]);
  }
  const dependencies: AiAnalysisDependency[] = [];
  for (const producer of dependency.producers) {
    if (producer.kind !== "item_element") {
      continue;
    }
    const current = currentAiDependencyForProducer(producer, item.nodeId, element, context);
    if (current != null && current.status !== "not_dependent" && current.producers != null) {
      dependencies.push(current);
    }
  }
  return Object.freeze(dependencies);
}

/** 保持項目のAI依存を再検証する。 */
export function revalidatedRetainedTrackedItemAiDependency(
  item: TrackedItemWithImportanceAssessment,
  element: AiAnalysisDependencyElement,
  dependency: AiAnalysisDependency,
  context: CurrentAiDependencyContext,
): AiAnalysisDependency {
  const blockerDependencies = context.blockerValueDependenciesByNodeId.get(item.nodeId);
  assertNonNullable(
    blockerDependencies,
    `retained itemのblocker値AI依存がありません。対象: ${item.nodeId}`,
  );
  const directDependency = currentDirectAiDependencyForRetainedElement(item, element);
  const matchesNativeOpenBlocker = retainedElementMatchesNativeOpenBlocker(item, element, context);
  if (
    blockerDependencies.blockerStateRetainedWithoutCurrentTopology &&
    retainedElementUsesStaleBlockerTopologyFallback(element)
  ) {
    return staleBlockerTopologyFallbackDependency(item, element);
  }
  if (directDependency != null) {
    return directDependency;
  }
  if (matchesNativeOpenBlocker) {
    return notDependentAiDependency();
  }
  const historical = revalidatedHistoricalAiDependencyWithCurrentContext(
    item.nodeId,
    element,
    dependency,
    context,
  );
  const expectedCandidates = retainedBlockerExpectedDependencies(blockerDependencies, element);
  if (
    (element === "status" || element === "nextAction") &&
    expectedCandidates.length === 1 &&
    expectedCandidates[0]?.status === "not_dependent"
  ) {
    return notDependentAiDependency();
  }
  let revalidated = historical;
  const matchedExpected = expectedCandidates.find(
    (expected) =>
      aiDependencyContainsLowerBound(expected, historical) &&
      aiDependencyHasOnlyExpectedGraphProducers(historical, expected),
  );
  if (expectedCandidates.length !== 0 && matchedExpected == null) {
    const expected =
      expectedCandidates.find((candidate) =>
        aiDependencyContainsLowerBound(candidate, historical),
      ) ?? expectedCandidates[0];
    assertNonNullable(
      expected,
      `retained itemのblocker AI依存候補がありません。対象: ${item.nodeId} element: ${element}`,
    );
    const currentItemDependencies = currentRetainedItemElementDependencies(
      item,
      element,
      dependency,
      context,
    );
    revalidated = combineAiAnalysisDependencies([
      expected,
      ...currentItemDependencies,
      historicalAiDependencyFallback(dependency),
    ]);
  }
  if (
    (element === "status" || element === "waitingOn" || element === "nextAction") &&
    revalidated.status === "unknown" &&
    revalidated.reasons.length === 1 &&
    revalidated.reasons[0] === "migration" &&
    revalidated.producers == null
  ) {
    return unrecordedAiDependency();
  }
  return revalidated;
}
