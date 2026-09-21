import { serializeCanonicalJson } from "../canonical-json/index.js";
import type { AiAnalysisDependency } from "../domain/ai-analysis-dependencies.js";
import type {
  ExternalGhostNode,
  GraphNodeId,
  NormalizedEvent,
  SourceId,
  TrackedItem,
  TrackedItemState,
} from "../domain/index.js";
import type { FreshObservedGitHubItem } from "../github/index.js";
import type {
  ReconciledGraphEdge,
  RelationCandidate,
  RelationCandidateDecisionProof,
  RelationCandidateId,
  RelationCandidateResolution,
} from "../graph/index.js";
import {
  relationAssessmentOwnerNodeId,
  relationNodes,
} from "../graph/relation-candidate-endpoints.js";
import type { StateSnapshot } from "../persistence/index.js";
import { assertNonNullable } from "../util/index.js";
import type {
  PersonalReminderRuntimeCandidateEndpointItem,
  PersonalReminderRuntimeGraph,
} from "./personal-reminder-runtime.js";

type PersonalReminderGraphCollection = Readonly<{
  observedItems: readonly FreshObservedGitHubItem[];
  relationCandidates: readonly RelationCandidate[];
}>;

type PersonalReminderGraphReduction = Readonly<{
  items: readonly Pick<TrackedItem, "nodeId" | "type" | "state" | "author">[];
}>;

type PersonalReminderGraphInput = Readonly<{
  edges: readonly ReconciledGraphEdge[];
  effectiveStateByNodeId: ReadonlyMap<GraphNodeId, TrackedItemState>;
  relationCandidateAiDependencies: ReadonlyMap<RelationCandidateId, AiAnalysisDependency>;
  candidateResolutions: readonly RelationCandidateResolution[];
  candidateDecisionProofs: readonly RelationCandidateDecisionProof[];
  externalReferences: readonly ExternalGhostNode[];
}>;

function personalReminderRuntimeEndpointState(
  item: Readonly<{
    type: FreshObservedGitHubItem["type"];
    state: "open" | "closed" | "merged";
    events: readonly NormalizedEvent[];
  }>,
): "open" | "closed" | "merged" {
  if (item.state === "open") {
    return "open";
  }
  if (
    item.type === "pull_request" &&
    item.events.some((event) => event.kind === "state" && event.state === "merged")
  ) {
    return "merged";
  }
  return "closed";
}

function personalReminderRuntimeCandidateRelation(
  candidate: RelationCandidate,
  aiDependenciesByCandidateId: ReadonlyMap<RelationCandidateId, AiAnalysisDependency>,
  proof: RelationCandidateDecisionProof,
  resolution: RelationCandidateResolution,
): PersonalReminderRuntimeGraph["candidateRelations"][number] {
  const [firstNode, secondNode] = relationNodes(candidate.relation);
  if (firstNode.nodeId === secondNode.nodeId) {
    throw new TypeError(`個人催促relation候補のendpointが同一です。対象: ${candidate.id}`);
  }
  const endpointNodeIds = [firstNode.nodeId, secondNode.nodeId].sort((left, right) =>
    left.localeCompare(right),
  );
  const firstEndpoint = endpointNodeIds[0];
  const secondEndpoint = endpointNodeIds[1];
  assertNonNullable(
    firstEndpoint,
    `個人催促relation候補のendpointがありません。対象: ${candidate.id}`,
  );
  assertNonNullable(
    secondEndpoint,
    `個人催促relation候補のendpointがありません。対象: ${candidate.id}`,
  );
  const normalizedSourceIds = [...new Set(candidate.sourceIds)].sort((left, right) =>
    left.localeCompare(right),
  );
  const firstSourceId = normalizedSourceIds[0];
  assertNonNullable(
    firstSourceId,
    `個人催促relation候補のsourceがありません。対象: ${candidate.id}`,
  );
  const endpointTuple: readonly [GraphNodeId, GraphNodeId] = [firstEndpoint, secondEndpoint];
  const sourceTuple: readonly [SourceId, ...SourceId[]] = [
    firstSourceId,
    ...normalizedSourceIds.slice(1),
  ];
  const aiDependency = aiDependenciesByCandidateId.get(candidate.id);
  assertNonNullable(
    aiDependency,
    `個人催促relation候補のAI依存がありません。対象: ${candidate.id}`,
  );
  if (proof.candidateId !== candidate.id || resolution.candidateId !== candidate.id) {
    throw new TypeError(`個人催促relation候補のproof IDが一致しません。対象: ${candidate.id}`);
  }
  if (proof.authority !== candidate.authority) {
    throw new TypeError(
      `個人催促relation候補のproof authorityが一致しません。対象: ${candidate.id}`,
    );
  }
  if (
    proof.endpointNodeIds[0] !== firstNode.nodeId ||
    proof.endpointNodeIds[1] !== secondNode.nodeId
  ) {
    throw new TypeError(
      `個人催促relation候補のproof endpointが一致しません。対象: ${candidate.id}`,
    );
  }
  if (proof.resolution.status !== resolution.status) {
    throw new TypeError(`個人催促relation候補のresolutionが一致しません。対象: ${candidate.id}`);
  }
  if (serializeCanonicalJson(proof.resolution) !== serializeCanonicalJson(resolution)) {
    throw new TypeError(
      `個人催促relation候補のresolution内容が一致しません。対象: ${candidate.id}`,
    );
  }
  if (serializeCanonicalJson(proof.dependency) !== serializeCanonicalJson(aiDependency)) {
    throw new TypeError(`個人催促relation候補のproof AI依存が一致しません。対象: ${candidate.id}`);
  }
  return Object.freeze({
    candidateId: candidate.id,
    endpointNodeIds: Object.freeze(endpointTuple),
    ownerNodeId: relationAssessmentOwnerNodeId(candidate),
    relationType: candidate.relation.type,
    authority: candidate.authority,
    provenance: candidate.provenance,
    resolution,
    ...(proof.canonicalRelation == null ? {} : { canonicalRelation: proof.canonicalRelation }),
    evidenceSourceIds: Object.freeze(sourceTuple),
    aiDependency,
  });
}

/** 最終graphと項目状態を個人催促のgraph文脈へ投影する。 */
export function personalReminderRuntimeGraph(
  getPreviousSnapshot: () => StateSnapshot | undefined,
  collection: PersonalReminderGraphCollection,
  reduction: PersonalReminderGraphReduction,
  graph: PersonalReminderGraphInput,
): PersonalReminderRuntimeGraph {
  const endpointStates = new Map<GraphNodeId, "open" | "closed" | "merged" | "missing">();
  for (const item of getPreviousSnapshot()?.items ?? []) {
    endpointStates.set(
      item.nodeId,
      item.state === "merged" ? "merged" : item.state === "open" ? "open" : "closed",
    );
  }
  for (const reference of graph.externalReferences) {
    endpointStates.set(reference.nodeId, reference.state);
  }
  for (const item of collection.observedItems) {
    endpointStates.set(item.nodeId, personalReminderRuntimeEndpointState(item));
  }
  for (const item of reduction.items) {
    endpointStates.set(
      item.nodeId,
      item.state === "merged" ? "merged" : item.state === "open" ? "open" : "closed",
    );
  }
  for (const [nodeId, effectiveState] of graph.effectiveStateByNodeId) {
    endpointStates.set(nodeId, effectiveState);
  }
  const candidateEndpointItemsByNodeId = personalReminderCandidateEndpointItems(
    getPreviousSnapshot,
    collection,
    reduction,
    graph.effectiveStateByNodeId,
  );
  const candidateRelations = graphCandidateRelations(
    collection.relationCandidates.filter((candidate) =>
      graph.relationCandidateAiDependencies.has(candidate.id),
    ),
    graph.relationCandidateAiDependencies,
    graph.candidateDecisionProofs,
    graph.candidateResolutions,
  );
  for (const candidate of candidateRelations) {
    for (const endpointNodeId of candidate.endpointNodeIds) {
      if (!endpointStates.has(endpointNodeId)) {
        endpointStates.set(endpointNodeId, "missing");
      }
    }
  }
  for (const edge of graph.edges) {
    for (const endpointNodeId of [edge.fromNodeId, edge.toNodeId]) {
      if (!endpointStates.has(endpointNodeId)) {
        endpointStates.set(endpointNodeId, "missing");
      }
    }
  }
  return Object.freeze({
    activeRelations: Object.freeze(
      graph.edges.filter(
        (edge): edge is ReconciledGraphEdge & Readonly<{ active: true }> => edge.active,
      ),
    ),
    candidateRelations,
    candidateResolutions: Object.freeze(graph.candidateResolutions),
    endpointStates,
    candidateEndpointItemsByNodeId,
    externalReferences: Object.freeze(
      graph.externalReferences.map((reference) =>
        Object.freeze({
          nodeId: reference.nodeId,
          url: reference.url,
          title: reference.title,
          state: reference.state,
        }),
      ),
    ),
  });
}

function personalReminderCandidateEndpointItem(
  item: Pick<TrackedItem, "nodeId" | "type" | "state" | "author">,
): PersonalReminderRuntimeCandidateEndpointItem {
  return Object.freeze({
    nodeId: item.nodeId,
    type: item.type,
    state: item.state,
    author:
      item.author.status === "identified"
        ? Object.freeze({
            status: "identified",
            type: item.author.actor.type,
            login: item.author.actor.login,
          })
        : Object.freeze({ status: "unavailable" }),
  });
}

function personalReminderCandidateEndpointItems(
  getPreviousSnapshot: () => StateSnapshot | undefined,
  collection: PersonalReminderGraphCollection,
  reduction: PersonalReminderGraphReduction,
  effectiveStateByNodeId: ReadonlyMap<GraphNodeId, TrackedItemState>,
): ReadonlyMap<GraphNodeId, PersonalReminderRuntimeCandidateEndpointItem> {
  const itemsByNodeId = new Map<GraphNodeId, PersonalReminderRuntimeCandidateEndpointItem>();
  for (const item of getPreviousSnapshot()?.items ?? []) {
    itemsByNodeId.set(item.nodeId, personalReminderCandidateEndpointItem(item));
  }
  for (const item of collection.observedItems) {
    itemsByNodeId.set(item.nodeId, personalReminderCandidateEndpointItem(item));
  }
  for (const item of reduction.items) {
    itemsByNodeId.set(item.nodeId, personalReminderCandidateEndpointItem(item));
  }
  for (const [nodeId, effectiveState] of effectiveStateByNodeId) {
    const item = itemsByNodeId.get(nodeId);
    if (item == null) {
      continue;
    }
    itemsByNodeId.set(
      nodeId,
      Object.freeze({
        ...item,
        state: effectiveState,
      }),
    );
  }
  return itemsByNodeId;
}

function graphCandidateRelations(
  candidates: readonly RelationCandidate[],
  aiDependenciesByCandidateId: ReadonlyMap<RelationCandidateId, AiAnalysisDependency>,
  proofs: readonly RelationCandidateDecisionProof[],
  resolutions: readonly RelationCandidateResolution[],
): readonly PersonalReminderRuntimeGraph["candidateRelations"][number][] {
  const proofsByCandidateId = new Map<RelationCandidateId, RelationCandidateDecisionProof>();
  for (const proof of proofs) {
    if (proofsByCandidateId.has(proof.candidateId)) {
      throw new TypeError(
        `個人催促relation候補のproof IDが重複しています。対象: ${proof.candidateId}`,
      );
    }
    proofsByCandidateId.set(proof.candidateId, proof);
  }
  const resolutionsByCandidateId = new Map<RelationCandidateId, RelationCandidateResolution>();
  for (const resolution of resolutions) {
    if (resolutionsByCandidateId.has(resolution.candidateId)) {
      throw new TypeError(
        `個人催促relation候補のresolution IDが重複しています。対象: ${resolution.candidateId}`,
      );
    }
    resolutionsByCandidateId.set(resolution.candidateId, resolution);
  }
  const candidateIds = new Set(candidates.map((candidate) => candidate.id));
  for (const candidateId of candidateIds) {
    if (!proofsByCandidateId.has(candidateId) || !resolutionsByCandidateId.has(candidateId)) {
      throw new TypeError(
        `個人催促relation候補のproofまたはresolutionがありません。対象: ${candidateId}`,
      );
    }
  }
  for (const candidateId of proofsByCandidateId.keys()) {
    if (!candidateIds.has(candidateId)) {
      throw new TypeError(`個人催促relation候補のproof対象がありません。対象: ${candidateId}`);
    }
  }
  for (const candidateId of resolutionsByCandidateId.keys()) {
    if (!candidateIds.has(candidateId)) {
      throw new TypeError(`個人催促relation候補のresolution対象がありません。対象: ${candidateId}`);
    }
  }
  return Object.freeze(
    candidates.map((candidate) => {
      const proof = proofsByCandidateId.get(candidate.id);
      const resolution = resolutionsByCandidateId.get(candidate.id);
      assertNonNullable(proof, `個人催促relation候補のproofがありません。対象: ${candidate.id}`);
      assertNonNullable(
        resolution,
        `個人催促relation候補のresolutionがありません。対象: ${candidate.id}`,
      );
      return personalReminderRuntimeCandidateRelation(
        candidate,
        aiDependenciesByCandidateId,
        proof,
        resolution,
      );
    }),
  );
}
