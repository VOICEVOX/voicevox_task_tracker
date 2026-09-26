import type { GitHubNodeId, GraphNodeId } from "../../domain/index.js";
import { relationNodes } from "../../graph/relation-candidate-endpoints.js";
import { normalizedBlockerRelationEndpointNodeIds } from "../relation-driven-analysis-targets.js";
import type { CollectedItems, RuntimeState } from "./contracts.js";
import { previousPersonalReminderRelationCandidateDependencies } from "./previous-state/analysis.js";
import { currentRelationCandidatesById } from "./relation-candidate-index.js";

type PersonalReminderEndpointAvailability =
  "github_observed" | "github_stale" | "external_public" | "unknown";

function addPersonalReminderEndpointAvailability(
  availabilityByNodeId: Map<GraphNodeId, PersonalReminderEndpointAvailability>,
  nodeId: GraphNodeId,
  availability: PersonalReminderEndpointAvailability,
): void {
  const existing = availabilityByNodeId.get(nodeId);
  if (existing != null && existing !== availability) {
    throw new TypeError(
      `個人催促relation endpointのavailabilityが複数区分に所属します。対象: ${nodeId}`,
    );
  }
  availabilityByNodeId.set(nodeId, availability);
}

function personalReminderEndpointAvailabilityByNodeId(
  collection: Pick<CollectedItems, "observedItems" | "staleItems" | "relationCandidates">,
): ReadonlyMap<GraphNodeId, PersonalReminderEndpointAvailability> {
  const availabilityByNodeId = new Map<GraphNodeId, PersonalReminderEndpointAvailability>();
  for (const item of collection.observedItems) {
    addPersonalReminderEndpointAvailability(availabilityByNodeId, item.nodeId, "github_observed");
  }
  for (const item of collection.staleItems) {
    addPersonalReminderEndpointAvailability(availabilityByNodeId, item.nodeId, "github_stale");
  }
  for (const candidate of collection.relationCandidates) {
    for (const node of relationNodes(candidate.relation)) {
      if (node.scope === "external_public") {
        addPersonalReminderEndpointAvailability(
          availabilityByNodeId,
          node.nodeId,
          "external_public",
        );
      }
    }
  }
  return availabilityByNodeId;
}

type PersonalReminderRelationCandidateSelection = Readonly<{
  analysisNodeIds: ReadonlySet<GitHubNodeId>;
  unavailableConsumerNodeIds: ReadonlySet<GitHubNodeId>;
}>;

/** 個人向け催促の関係候補を使う解析対象を選ぶ。 */
export function selectPersonalReminderRelationCandidateConsumers(
  state: RuntimeState,
  collection: Pick<CollectedItems, "observedItems" | "staleItems" | "relationCandidates">,
  trackedNodeIds: ReadonlySet<GitHubNodeId>,
): PersonalReminderRelationCandidateSelection {
  const endpointAvailabilityByNodeId = personalReminderEndpointAvailabilityByNodeId(collection);
  const currentCandidatesById = currentRelationCandidatesById(collection.relationCandidates);
  const freshObservedNodeIds = new Set<GitHubNodeId>(
    collection.observedItems.map((item) => item.nodeId),
  );
  const trackedGraphNodeIds = new Set<GraphNodeId>(trackedNodeIds);
  const selectionByConsumerNodeId = new Map<
    GitHubNodeId,
    {
      available: boolean;
      ownerNodeIds: Set<GitHubNodeId>;
    }
  >();
  for (const dependency of previousPersonalReminderRelationCandidateDependencies(state)) {
    if (
      !freshObservedNodeIds.has(dependency.consumerNodeId) ||
      !trackedNodeIds.has(dependency.consumerNodeId)
    ) {
      continue;
    }
    let selection = selectionByConsumerNodeId.get(dependency.consumerNodeId);
    if (selection == null) {
      selection = {
        available: true,
        ownerNodeIds: new Set<GitHubNodeId>(),
      };
      selectionByConsumerNodeId.set(dependency.consumerNodeId, selection);
    }
    const endpointComplete = dependency.producer.endpointNodeIds.every((endpointNodeId) => {
      const availability = endpointAvailabilityByNodeId.get(endpointNodeId);
      return availability === "github_observed" || availability === "external_public";
    });
    if (!endpointComplete) {
      selection.available = false;
    }
    const currentCandidate = currentCandidatesById.get(dependency.producer.candidateId);
    const previousEndpointNodeIds = normalizedBlockerRelationEndpointNodeIds(
      dependency.producer.endpointNodeIds,
    );
    if (
      currentCandidate != null &&
      (currentCandidate.endpointNodeIds[0] !== previousEndpointNodeIds[0] ||
        currentCandidate.endpointNodeIds[1] !== previousEndpointNodeIds[1] ||
        currentCandidate.ownerNodeId !== dependency.producer.producer.nodeId)
    ) {
      throw new TypeError(
        `前回と現在のpersonal reminder relation candidate定義が一致しません。対象: ${dependency.producer.candidateId}`,
      );
    }
    const ownerItem = collection.observedItems.find(
      (item) => item.nodeId === dependency.producer.producer.nodeId,
    );
    if (ownerItem == null || !trackedGraphNodeIds.has(ownerItem.nodeId)) {
      selection.available = false;
      continue;
    }
    selection.ownerNodeIds.add(ownerItem.nodeId);
  }
  const analysisNodeIds = new Set<GitHubNodeId>();
  const unavailableConsumerNodeIds = new Set<GitHubNodeId>();
  for (const [consumerNodeId, selection] of selectionByConsumerNodeId) {
    if (!selection.available) {
      unavailableConsumerNodeIds.add(consumerNodeId);
      continue;
    }
    analysisNodeIds.add(consumerNodeId);
    for (const ownerNodeId of selection.ownerNodeIds) {
      analysisNodeIds.add(ownerNodeId);
    }
  }
  return Object.freeze({
    analysisNodeIds,
    unavailableConsumerNodeIds,
  });
}
