import { serializeCanonicalJson } from "../../../canonical-json/value.js";
import {
  aiAnalysisDependencyForRelation,
  type AiAnalysisDependency,
} from "../../../domain/ai-analysis-dependencies.js";
import type {
  GitHubNodeId,
  GraphNodeId,
  SourceId,
  TrackedItem,
  TrackedItemState,
} from "../../../domain/index.js";
import type {
  RelationCandidate,
  RelationCandidateDecisionProof,
  RelationCandidateId,
  RelationCandidateResolution,
  ReconciledGraphEdge,
} from "../../../graph/index.js";
import {
  relationAssessmentOwnerNodeId,
  relationNodes,
} from "../../../graph/relation-candidate-endpoints.js";
import { assertNonNullable } from "../../../util/index.js";
import { relationAiDependenciesForCandidates } from "./graph-reconciliation-candidate-dependencies.js";
import type { GraphFinalItem } from "../contracts/graph-final-item.js";
import type {
  GraphWorkingCollection,
  GraphWorkingResult,
  GraphWorkingState,
} from "./graph-reconciliation-contracts.js";
import { previousSnapshot } from "./graph-reconciliation-previous-items.js";

/** 最終関係候補の端点と判定担当を確定した文脈。 */
export type GraphCandidateRelationContext = Readonly<{
  candidateId: RelationCandidateId;
  endpointNodeIds: readonly [GraphNodeId, GraphNodeId];
  ownerNodeId: GraphNodeId;
  relationType: RelationCandidate["relation"]["type"];
  authority: RelationCandidate["authority"];
  provenance: RelationCandidate["provenance"];
  resolution: RelationCandidateResolution;
  canonicalRelation?: RelationCandidateDecisionProof["canonicalRelation"];
  evidenceSourceIds: readonly [SourceId, ...SourceId[]];
  aiDependency: AiAnalysisDependency;
}>;

/** 関係候補の端点となる追跡項目の確定情報。 */
export type GraphCandidateEndpointItem = Readonly<{
  nodeId: GitHubNodeId;
  type: "issue" | "pull_request";
  state: "open" | "closed" | "merged";
  author:
    | Readonly<{ status: "identified"; type: "human" | "bot"; login: string }>
    | Readonly<{ status: "unavailable" }>;
}>;

/** 個人催促の計画へ渡す最終graphの端点と候補。 */
export type GraphFinalContext = Readonly<{
  candidateRelations: readonly GraphCandidateRelationContext[];
  endpointStates: readonly (readonly [GraphNodeId, "open" | "closed" | "merged" | "missing"])[];
  candidateEndpointItems: readonly (readonly [GraphNodeId, GraphCandidateEndpointItem])[];
}>;

function candidateEndpointItem(
  item: Pick<TrackedItem, "nodeId" | "type" | "state" | "author">,
): GraphCandidateEndpointItem {
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

function finalCandidateRelation(
  candidate: RelationCandidate,
  dependency: AiAnalysisDependency,
  proof: RelationCandidateDecisionProof,
  resolution: RelationCandidateResolution,
  missingAssessmentDependency: AiAnalysisDependency,
  edge: ReconciledGraphEdge | undefined,
): GraphCandidateRelationContext {
  const [firstNode, secondNode] = relationNodes(candidate.relation);
  if (firstNode.nodeId === secondNode.nodeId) {
    throw new TypeError(`個人催促relation候補のendpointが同一です。対象: ${candidate.id}`);
  }
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
  if (serializeCanonicalJson(proof.resolution) !== serializeCanonicalJson(resolution)) {
    throw new TypeError(`個人催促relation候補の最終判定が一致しません。対象: ${candidate.id}`);
  }
  if (serializeCanonicalJson(proof.dependency) !== serializeCanonicalJson(dependency)) {
    if (
      candidate.authority !== "inferred" ||
      resolution.status !== "active" ||
      proof.dependency.status !== "unknown" ||
      !proof.dependency.reasons.every(
        (reason) => reason === "proof_unknown" || reason === "migration",
      ) ||
      proof.canonicalRelation == null ||
      serializeCanonicalJson(dependency) !== serializeCanonicalJson(missingAssessmentDependency) ||
      (edge != null &&
        (!edge.active ||
          edge.provenance === "native" ||
          edge.type !== proof.canonicalRelation.type ||
          edge.fromNodeId !== proof.canonicalRelation.fromNodeId ||
          edge.toNodeId !== proof.canonicalRelation.toNodeId ||
          serializeCanonicalJson(edge.aiDependency) !==
            serializeCanonicalJson(aiAnalysisDependencyForRelation(edge.id, proof.dependency))))
    ) {
      throw new TypeError(`個人催促relation候補の最終判定が一致しません。対象: ${candidate.id}`);
    }
  }
  const sortedEndpointNodeIds = [firstNode.nodeId, secondNode.nodeId].sort((left, right) =>
    left.localeCompare(right),
  );
  const firstEndpoint = sortedEndpointNodeIds[0];
  const secondEndpoint = sortedEndpointNodeIds[1];
  assertNonNullable(
    firstEndpoint,
    `個人催促relation候補のendpointがありません。対象: ${candidate.id}`,
  );
  assertNonNullable(
    secondEndpoint,
    `個人催促relation候補のendpointがありません。対象: ${candidate.id}`,
  );
  const sourceIds = [...new Set(candidate.sourceIds)].sort((left, right) =>
    left.localeCompare(right),
  );
  const firstSourceId = sourceIds[0];
  assertNonNullable(
    firstSourceId,
    `個人催促relation候補のsourceがありません。対象: ${candidate.id}`,
  );
  const endpointNodeIds: readonly [GraphNodeId, GraphNodeId] = [firstEndpoint, secondEndpoint];
  const evidenceSourceIds: readonly [SourceId, ...SourceId[]] = [
    firstSourceId,
    ...sourceIds.slice(1),
  ];
  return Object.freeze({
    candidateId: candidate.id,
    endpointNodeIds: Object.freeze(endpointNodeIds),
    ownerNodeId: relationAssessmentOwnerNodeId(candidate),
    relationType: candidate.relation.type,
    authority: candidate.authority,
    provenance: candidate.provenance,
    resolution,
    ...(proof.canonicalRelation == null ? {} : { canonicalRelation: proof.canonicalRelation }),
    evidenceSourceIds: Object.freeze(evidenceSourceIds),
    aiDependency: dependency,
  });
}

function finalCandidateRelations(
  candidates: readonly RelationCandidate[],
  finalItems: readonly GraphFinalItem[],
  graph: GraphWorkingResult,
): readonly GraphCandidateRelationContext[] {
  const dependencies = graph.relationCandidateAiDependencies;
  const proofs = new Map(graph.candidateDecisionProofs.map((proof) => [proof.candidateId, proof]));
  const edges = new Map(graph.edges.map((edge) => [edge.id, edge]));
  const missingAssessmentDependencies = relationAiDependenciesForCandidates(
    candidates,
    finalItems,
    [],
  );
  const resolutions = new Map(
    graph.candidateResolutions.map((value) => [value.candidateId, value]),
  );
  const candidateIds = new Set(candidates.map((candidate) => candidate.id));
  if (
    candidateIds.size !== candidates.length ||
    proofs.size !== graph.candidateDecisionProofs.length ||
    resolutions.size !== graph.candidateResolutions.length ||
    dependencies.size !== candidates.length ||
    proofs.size !== candidates.length ||
    resolutions.size !== candidates.length
  ) {
    throw new TypeError("個人催促relation候補の最終判定件数が一致しません");
  }
  return Object.freeze(
    candidates
      .map((candidate) => {
        const proof = proofs.get(candidate.id);
        const resolution = resolutions.get(candidate.id);
        const dependency = dependencies.get(candidate.id);
        const missingAssessmentDependency = missingAssessmentDependencies.get(candidate.id);
        assertNonNullable(proof, `個人催促relation候補のproofがありません。対象: ${candidate.id}`);
        assertNonNullable(
          resolution,
          `個人催促relation候補のresolutionがありません。対象: ${candidate.id}`,
        );
        assertNonNullable(
          dependency,
          `個人催促relation候補のAI依存がありません。対象: ${candidate.id}`,
        );
        assertNonNullable(
          missingAssessmentDependency,
          `個人催促relation候補の判定担当AI依存がありません。対象: ${candidate.id}`,
        );
        return finalCandidateRelation(
          candidate,
          dependency,
          proof,
          resolution,
          missingAssessmentDependency,
          edges.get(candidate.id),
        );
      })
      .sort((left, right) => left.candidateId.localeCompare(right.candidateId)),
  );
}

function finalEndpointStates(
  state: GraphWorkingState,
  collection: GraphWorkingCollection,
  finalItems: readonly GraphFinalItem[],
  graph: GraphWorkingResult,
  candidates: readonly GraphCandidateRelationContext[],
): ReadonlyMap<GraphNodeId, "open" | "closed" | "merged" | "missing"> {
  const states = new Map<GraphNodeId, "open" | "closed" | "merged" | "missing">();
  for (const item of previousSnapshot(state)?.items ?? []) {
    states.set(item.nodeId, item.state);
  }
  for (const reference of graph.externalReferences) {
    states.set(reference.nodeId, reference.state);
  }
  for (const item of collection.observedItems) {
    const merged =
      item.type === "pull_request" &&
      item.events.some((event) => event.kind === "state" && event.state === "merged");
    states.set(item.nodeId, item.state === "open" ? "open" : merged ? "merged" : "closed");
  }
  for (const item of finalItems) {
    states.set(item.nodeId, item.state);
  }
  for (const [nodeId, effectiveState] of graph.effectiveStateByNodeId) {
    states.set(nodeId, effectiveState);
  }
  for (const candidate of candidates) {
    for (const nodeId of candidate.endpointNodeIds) {
      if (!states.has(nodeId)) {
        states.set(nodeId, "missing");
      }
    }
  }
  return states;
}

function finalCandidateEndpointItems(
  state: GraphWorkingState,
  collection: GraphWorkingCollection,
  finalItems: readonly GraphFinalItem[],
  effectiveStateByNodeId: ReadonlyMap<GraphNodeId, TrackedItemState>,
): ReadonlyMap<GraphNodeId, GraphCandidateEndpointItem> {
  const items = new Map<GraphNodeId, GraphCandidateEndpointItem>();
  for (const item of previousSnapshot(state)?.items ?? []) {
    items.set(item.nodeId, candidateEndpointItem(item));
  }
  for (const item of collection.observedItems) {
    items.set(item.nodeId, candidateEndpointItem(item));
  }
  for (const item of finalItems) {
    items.set(item.nodeId, candidateEndpointItem(item));
  }
  for (const [nodeId, effectiveState] of effectiveStateByNodeId) {
    const item = items.get(nodeId);
    if (item != null) {
      items.set(nodeId, Object.freeze({ ...item, state: effectiveState }));
    }
  }
  return items;
}

function sortedEntries<Key extends string, Value>(
  values: ReadonlyMap<Key, Value>,
): readonly (readonly [Key, Value])[] {
  return Object.freeze(
    [...values.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]): readonly [Key, Value] => Object.freeze([key, value])),
  );
}

/** final graphとfinal itemだけを使う後段向け文脈を確定する。 */
export function createGraphFinalContext(
  state: GraphWorkingState,
  collection: GraphWorkingCollection,
  finalItems: readonly GraphFinalItem[],
  graph: GraphWorkingResult,
): GraphFinalContext {
  const candidateRelations = finalCandidateRelations(
    collection.relationCandidates,
    finalItems,
    graph,
  );
  return Object.freeze({
    candidateRelations,
    endpointStates: sortedEntries(
      finalEndpointStates(state, collection, finalItems, graph, candidateRelations),
    ),
    candidateEndpointItems: sortedEntries(
      finalCandidateEndpointItems(state, collection, finalItems, graph.effectiveStateByNodeId),
    ),
  });
}
