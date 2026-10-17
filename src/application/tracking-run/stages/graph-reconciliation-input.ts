import type { CollectedItemObservations } from "./collection-production.js";
import type { GenericAiAdoptedRun } from "./generic-ai-adoption.js";

/** 段階内だけで使う収集結果の索引を作る。 */
export function graphReconciliationCollection(
  adopted: GenericAiAdoptedRun,
): CollectedItemObservations {
  const source = adopted.data.collection;
  const facts = adopted.data.facts;
  return Object.freeze({
    ...source,
    relationCandidates: Object.freeze(facts.relations.map((fact) => fact.candidate)),
    trackedNodeIds: new Set(facts.trackedNodeIds),
    trackingNotificationClassByNodeId: new Map(source.trackingNotificationClassByNodeId),
    analysisNodeIds: new Set(facts.analysisNodeIds),
    staleBlockerTopologyNodeIds: new Set(source.staleBlockerTopologyNodeIds),
    unavailableConsumerNodeIds: new Set(facts.unavailableConsumerNodeIds),
    changedNodeIds: new Set(facts.changedNodeIds),
  });
}
