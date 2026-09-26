import {
  combineAiAnalysisDependencies,
  normalizeAiAnalysisDependency,
  reconcileRetainedAiAnalysisDependency,
  type AiAnalysisDependency,
  type AiAnalysisDependencyElement,
  type AiAnalysisDependencyProducer,
  type AiAnalysisDependencyReconciliationContext,
} from "../../../domain/ai-analysis-dependencies.js";
import type { GitHubNodeId, GraphNodeId } from "../../../domain/index.js";
import type { ReconciledGraphEdge } from "../../../graph/index.js";
import { UnreachableError } from "../../../util/index.js";
import {
  historicalAiDependencyFallback,
  historicalAiDependencyHistory,
} from "../ai-dependencies/history.js";
import {
  aiDependencyForElementApplication,
  unrecordedAiDependency,
} from "../ai-dependencies/selection.js";
import type { RetainedBlockerValueAiDependencies } from "./retained-blocker-dependencies.js";

export type CurrentAiDependencyContext = Omit<
  AiAnalysisDependencyReconciliationContext,
  "relationsById"
> &
  Readonly<{
    relationsById: ReadonlyMap<string, ReconciledGraphEdge>;
    openNodeIds: ReadonlySet<GraphNodeId>;
    nativeOpenBlockerNodeIdsByTargetNodeId: ReadonlyMap<GraphNodeId, ReadonlySet<GraphNodeId>>;
    blockerValueDependenciesByNodeId: ReadonlyMap<GraphNodeId, RetainedBlockerValueAiDependencies>;
  }>;

/** 保持要素がblockerに依存するか判定する。 */
export function retainedElementUsesBlockerDependency(
  element: AiAnalysisDependencyElement,
): boolean {
  return (
    element === "status" ||
    element === "waitingOn" ||
    element === "primaryWaitingOn" ||
    element === "nextAction" ||
    element === "confidence" ||
    element === "evidence" ||
    element === "uncertainties"
  );
}

function retainedBlockerItemElementProducerIsValid(
  producer: Extract<AiAnalysisDependencyProducer, { kind: "item_element" }>,
  itemNodeId: GitHubNodeId,
  element: AiAnalysisDependencyElement,
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
      return true;
  }
}

/** 現在のproducerに対応するAI依存を得る。 */
export function currentAiDependencyForProducer(
  producer: AiAnalysisDependencyProducer,
  itemNodeId: GitHubNodeId,
  element: AiAnalysisDependencyElement,
  context: CurrentAiDependencyContext,
): AiAnalysisDependency | undefined {
  const usesBlockerDependency = retainedElementUsesBlockerDependency(element);
  switch (producer.kind) {
    case "item_element": {
      if (
        usesBlockerDependency &&
        !retainedBlockerItemElementProducerIsValid(producer, itemNodeId, element)
      ) {
        return undefined;
      }
      const applications = context.applicationsByNodeId.get(producer.nodeId);
      if (applications == null) {
        return undefined;
      }
      return aiDependencyForElementApplication(producer.nodeId, applications, producer.element);
    }
    case "relation": {
      const relation = context.relationsById.get(producer.relationId);
      if (
        relation == null ||
        !relation.active ||
        (usesBlockerDependency &&
          (relation.type !== "blocks" ||
            relation.toNodeId !== itemNodeId ||
            !context.openNodeIds.has(relation.fromNodeId) ||
            !context.openNodeIds.has(relation.toNodeId)))
      ) {
        return undefined;
      }
      const dependency = relation.aiDependency;
      if (dependency.status === "not_dependent") {
        return dependency;
      }
      const matchesProducer = dependency.producers?.some(
        (currentProducer) =>
          currentProducer.kind === "relation" &&
          currentProducer.relationId === producer.relationId &&
          currentProducer.producer.nodeId === producer.producer.nodeId &&
          currentProducer.producer.element === producer.producer.element,
      );
      return matchesProducer === true ? dependency : undefined;
    }
    case "relation_candidate": {
      if (usesBlockerDependency && !producer.endpointNodeIds.includes(itemNodeId)) {
        return undefined;
      }
      return reconcileRetainedAiAnalysisDependency(
        Object.freeze({ status: "current", producers: Object.freeze([producer]) }),
        context,
      );
    }
    default:
      throw new UnreachableError(producer);
  }
}

/** 現在の文脈で履歴AI依存を再検証する。 */
export function revalidatedHistoricalAiDependencyWithCurrentContext(
  itemNodeId: GitHubNodeId,
  element: AiAnalysisDependencyElement,
  dependency: AiAnalysisDependency,
  context: CurrentAiDependencyContext,
): AiAnalysisDependency {
  const normalizedDependency = normalizeAiAnalysisDependency(dependency);
  if (normalizedDependency.status === "not_dependent") {
    return normalizedDependency;
  }
  const producers = normalizedDependency.producers;
  if (producers == null) {
    return historicalAiDependencyFallback(normalizedDependency);
  }
  const resolvedDependencies: AiAnalysisDependency[] = [];
  let allProducersResolved = true;
  for (const producer of producers) {
    const resolved = currentAiDependencyForProducer(producer, itemNodeId, element, context);
    if (resolved == null || resolved.status === "not_dependent" || resolved.producers == null) {
      allProducersResolved = false;
      continue;
    }
    resolvedDependencies.push(resolved);
  }
  if (allProducersResolved) {
    const expectedDependency = combineAiAnalysisDependencies(resolvedDependencies);
    return combineAiAnalysisDependencies([
      expectedDependency,
      ...historicalAiDependencyHistory(normalizedDependency),
    ]);
  }
  return combineAiAnalysisDependencies([
    ...resolvedDependencies,
    ...historicalAiDependencyHistory(normalizedDependency),
    unrecordedAiDependency(),
  ]);
}
