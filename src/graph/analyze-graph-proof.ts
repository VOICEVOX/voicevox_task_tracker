import { aiAnalysisDependencyForRelation, type AiAnalysisDependency } from "../domain/index.js";
import { compareStrings, indexSnapshot, type IndexedSnapshot } from "./analyze-graph-core.js";
import { candidateDecisionProofSchema } from "./analyze-graph-schema.js";
import type { RelationCandidateDecisionProof } from "./reconcile-graph-types.js";

function aiDependencySignature(dependency: AiAnalysisDependency): string {
  const producers =
    dependency.status === "not_dependent"
      ? undefined
      : dependency.producers
          ?.map((producer) => {
            if (producer.kind === "item_element") {
              return [producer.kind, producer.nodeId, producer.element];
            }
            if (producer.kind === "relation_candidate") {
              return [
                producer.kind,
                producer.candidateId,
                producer.endpointNodeIds[0],
                producer.endpointNodeIds[1],
                producer.producer.nodeId,
                producer.producer.element,
              ];
            }
            return [
              producer.kind,
              producer.relationId,
              producer.producer.nodeId,
              producer.producer.element,
            ];
          })
          .sort((left, right) => compareStrings(JSON.stringify(left), JSON.stringify(right)));
  return JSON.stringify({
    status: dependency.status,
    ...(dependency.status === "unknown" ? { reasons: dependency.reasons } : {}),
    ...(producers == null ? {} : { producers }),
  });
}

/** 関係候補の判定証明を現在のgraphへ照合する。 */
export function validateCandidateDecisionProofs(
  current: IndexedSnapshot,
  proofs: readonly RelationCandidateDecisionProof[],
): readonly RelationCandidateDecisionProof[] {
  const normalized = [...proofs].sort((left, right) =>
    compareStrings(left.candidateId, right.candidateId),
  );
  const seenCandidateIds = new Set<string>();
  for (const proof of normalized) {
    const validation = candidateDecisionProofSchema.safeParse(proof);
    if (!validation.success) {
      throw new TypeError(`関係候補 ${proof.candidateId}の判定proofが不正です`, {
        cause: validation.error,
      });
    }
    if (seenCandidateIds.has(proof.candidateId)) {
      throw new TypeError(`関係候補 ${proof.candidateId}の判定proofが重複しています`);
    }
    seenCandidateIds.add(proof.candidateId);
    const [firstEndpoint, secondEndpoint] = proof.endpointNodeIds;
    if (firstEndpoint === secondEndpoint) {
      throw new TypeError(`関係候補 ${proof.candidateId}は同じendpointを指定できません`);
    }
    if (proof.resolution.candidateId !== proof.candidateId) {
      throw new TypeError(`関係候補 ${proof.candidateId}の判定proof IDが不整合です`);
    }
    if (
      proof.dependency.status === "unknown" &&
      proof.dependency.reasons.includes("stale_repository")
    ) {
      throw new TypeError(`関係候補 ${proof.candidateId}にstale repository AI依存は指定できません`);
    }
    if (proof.authority === "authoritative") {
      if (proof.dependency.status !== "not_dependent") {
        throw new TypeError(
          `authoritative relation ${proof.candidateId}のAI依存はnot_dependentでなければなりません`,
        );
      }
      if (proof.resolution.status !== "active") {
        throw new TypeError(
          `authoritative relation ${proof.candidateId}はactiveでなければなりません`,
        );
      }
    } else {
      if (proof.dependency.status === "not_dependent") {
        throw new TypeError(`推定relation ${proof.candidateId}のAI依存はnot_dependentにできません`);
      }
      const producers = proof.dependency.producers;
      if (producers == null) {
        const producerlessNotRecorded =
          proof.resolution.status !== "active" &&
          proof.dependency.status === "unknown" &&
          proof.dependency.reasons.length === 1 &&
          proof.dependency.reasons[0] === "not_recorded";
        if (!producerlessNotRecorded) {
          throw new TypeError(`推定relation ${proof.candidateId}のAI依存producerがありません`);
        }
      } else {
        const endpointNodeIds = new Set(proof.endpointNodeIds);
        for (const producer of producers) {
          if (producer.kind !== "item_element" || producer.element !== "relations") {
            throw new TypeError(`推定relation ${proof.candidateId}のAI依存producerが不正です`);
          }
          if (!endpointNodeIds.has(producer.nodeId)) {
            throw new TypeError(
              `推定relation ${proof.candidateId}のAI依存producerがendpointではありません`,
            );
          }
        }
      }
    }
    if (proof.resolution.status === "active") {
      if (proof.resolution.edgeId !== proof.candidateId) {
        throw new TypeError(`active relation ${proof.candidateId}のedge IDが不整合です`);
      }
      const canonicalRelation = proof.canonicalRelation;
      if (canonicalRelation == null) {
        throw new TypeError(`active relation ${proof.candidateId}のcanonical relationがありません`);
      }
      const endpointNodeIds = new Set(proof.endpointNodeIds);
      if (
        canonicalRelation.fromNodeId === canonicalRelation.toNodeId ||
        !endpointNodeIds.has(canonicalRelation.fromNodeId) ||
        !endpointNodeIds.has(canonicalRelation.toNodeId)
      ) {
        throw new TypeError(`関係候補 ${proof.candidateId}のcanonical relation endpointが不正です`);
      }
      const edge = current.edgesById.get(proof.candidateId);
      if (edge?.active !== true) {
        throw new TypeError(
          `active relation ${proof.candidateId}に対応するcurrent edgeがありません`,
        );
      }
      if (
        edge.fromNodeId !== canonicalRelation.fromNodeId ||
        edge.toNodeId !== canonicalRelation.toNodeId ||
        edge.type !== canonicalRelation.type
      ) {
        throw new TypeError(
          `active relation ${proof.candidateId}のcanonical relationがcurrent edgeと不一致です`,
        );
      }
      const expectedAuthoritative = proof.authority === "authoritative";
      if (edge.authoritative !== expectedAuthoritative) {
        throw new TypeError(
          `active relation ${proof.candidateId}のauthorityがcurrent edgeと不一致です`,
        );
      }
      if (expectedAuthoritative && edge.provenance !== "native") {
        throw new TypeError(`authoritative relation ${proof.candidateId}のprovenanceが不正です`);
      }
      if (!expectedAuthoritative && edge.provenance === "native") {
        throw new TypeError(`inferred relation ${proof.candidateId}のprovenanceが不正です`);
      }
      const expectedDependency = expectedAuthoritative
        ? Object.freeze({ status: "not_dependent" })
        : aiAnalysisDependencyForRelation(proof.candidateId, proof.dependency);
      if (aiDependencySignature(edge.aiDependency) !== aiDependencySignature(expectedDependency)) {
        throw new TypeError(
          `active relation ${proof.candidateId}のAI依存がcurrent edgeと不一致です`,
        );
      }
    } else if (proof.canonicalRelation != null) {
      throw new TypeError(`未採用relation ${proof.candidateId}にcanonical relationがあります`);
    } else if (current.edgesById.get(proof.candidateId)?.active === true) {
      throw new TypeError(`未採用relation ${proof.candidateId}にactiveなcurrent edgeがあります`);
    }
    for (const endpointNodeId of proof.endpointNodeIds) {
      if (!current.nodesById.has(endpointNodeId)) {
        throw new TypeError(
          `関係候補 ${proof.candidateId}のendpoint ${endpointNodeId}がcurrent graphにありません`,
        );
      }
    }
  }
  return Object.freeze(normalized);
}

/** 公開値の感度計算に使うgraph索引を作る。 */
export function createPublicValueSensitivityIndex(
  current: IndexedSnapshot,
  candidateProofSnapshot: IndexedSnapshot,
): IndexedSnapshot {
  const nodes = [
    ...current.nodesById.values(),
    ...[...candidateProofSnapshot.nodesById.values()]
      .filter((node) => node.kind === "external_reference" && !current.nodesById.has(node.nodeId))
      .sort((left, right) => compareStrings(left.nodeId, right.nodeId)),
  ];
  const nodeIds = new Set(nodes.map((node) => node.nodeId));
  const edgesById = new Map(current.edgesById);
  for (const edge of candidateProofSnapshot.edgesById.values()) {
    if (!edgesById.has(edge.id) && nodeIds.has(edge.fromNodeId) && nodeIds.has(edge.toNodeId)) {
      edgesById.set(edge.id, edge);
    }
  }
  return indexSnapshot(
    Object.freeze({
      nodes: Object.freeze(nodes),
      edges: Object.freeze([...edgesById.values()]),
    }),
    "公開値感度snapshot",
  );
}
