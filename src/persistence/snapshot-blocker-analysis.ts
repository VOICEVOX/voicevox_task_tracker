import {
  AI_ANALYSIS_DEPENDENCY_ELEMENTS,
  aiAnalysisDependencyForApplication,
  aiAnalysisDependencyForMissingRelationCandidateAssessment,
  combineAiAnalysisDependencies,
  normalizeAiAnalysisDependency,
} from "../domain/ai-analysis-dependencies.js";
import {
  type AiAnalysisDependency,
  type AiAnalysisDependencyProducer,
  type GraphNodeId,
  type Relation,
  type UtcIsoDateTime,
} from "../domain/index.js";
import {
  analyzeGraphAiDependencies,
  type BlockerNodeAiDependency,
  type GraphAnalysisNode,
  type RelationCandidateDecisionProof,
} from "../graph/index.js";
import { StateSnapshotSemanticError } from "./errors.js";
import type {
  LegacyStateSnapshotFields,
  LegacyStateSnapshotFieldsWithoutAiDependencies,
  LegacyStateSnapshotFieldsWithPersonalReminder,
  LegacyStateSnapshotFieldsWithPersonalReminderVersion17,
  SnapshotTrackedItem,
  StateSnapshotFields,
} from "./snapshot-contracts.js";
import { blocksArcKey } from "./snapshot-graph-dependencies.js";
import { snapshotGraphEdge, snapshotRelationCandidateId } from "./snapshot-relations.js";
import {
  compareStrings,
  effectiveGraphStateByNodeId,
  effectiveGraphStateForNode,
} from "./snapshot-values.js";

export type SnapshotBlocker = Readonly<{
  blockerNodeId: GraphNodeId;
  authority: "authoritative" | "inferred";
  confidenceValue: number;
  becameBlockingAtValue: UtcIsoDateTime;
  dependency: BlockerNodeAiDependency;
}>;

export type SnapshotBlockerAnalysis = Readonly<{
  blockersByBlockedNodeId: ReadonlyMap<GraphNodeId, readonly SnapshotBlocker[]>;
  blockerSetDependenciesByNodeId: ReadonlyMap<GraphNodeId, AiAnalysisDependency>;
  negativeDependenciesByNodeId: ReadonlyMap<GraphNodeId, AiAnalysisDependency>;
}>;

export type SnapshotBlockerValueAiDependencies = Readonly<{
  stateSupport: "conditional" | "authoritative_blocker";
  statusCandidates: readonly AiAnalysisDependency[] | undefined;
  waitingOn: AiAnalysisDependency | undefined;
  primaryWaitingOn: AiAnalysisDependency | undefined;
  nextAction: AiAnalysisDependency | undefined;
  confidence: AiAnalysisDependency | undefined;
  evidence: AiAnalysisDependency;
  uncertainties: AiAnalysisDependency | undefined;
}>;

type RelationCandidateProducer = Extract<
  AiAnalysisDependencyProducer,
  { kind: "relation_candidate" }
>;

export function notDependentSnapshotAiDependency(): AiAnalysisDependency {
  return Object.freeze({ status: "not_dependent" });
}

export function combineSnapshotAiDependencies(
  dependencies: readonly AiAnalysisDependency[],
): AiAnalysisDependency {
  return dependencies.length === 0
    ? notDependentSnapshotAiDependency()
    : combineAiAnalysisDependencies(dependencies);
}

function candidateProofDependencyForProducer(
  producer: RelationCandidateProducer,
  itemsByNodeId: ReadonlyMap<string, SnapshotTrackedItem>,
): AiAnalysisDependency {
  const item = itemsByNodeId.get(producer.producer.nodeId);
  if (item == null) {
    throw new StateSnapshotSemanticError(
      `relation candidate ${producer.candidateId}の生成元itemがありません`,
    );
  }
  const application = item.aiAnalysis.applications.relations;
  const dependency = aiAnalysisDependencyForApplication(item.nodeId, "relations", application);
  return dependency.status === "not_dependent"
    ? aiAnalysisDependencyForMissingRelationCandidateAssessment(item.nodeId, application)
    : dependency;
}

function activeRelationCandidateProofDependency(
  relation: Relation,
): AiAnalysisDependency | undefined {
  const dependency = relation.aiDependency;
  if (dependency.status === "not_dependent") {
    throw new StateSnapshotSemanticError(`推定relation ${relation.id}のAI依存がnot_dependentです`);
  }
  if (dependency.producers == null) {
    return undefined;
  }
  const producers: AiAnalysisDependencyProducer[] = dependency.producers.map((producer) => {
    if (producer.kind !== "relation" || producer.relationId !== relation.id) {
      throw new StateSnapshotSemanticError(`推定relation ${relation.id}のAI依存producerが不正です`);
    }
    return Object.freeze({
      kind: "item_element",
      nodeId: producer.producer.nodeId,
      element: producer.producer.element,
    });
  });
  if (dependency.status === "unknown") {
    return normalizeAiAnalysisDependency({
      status: dependency.status,
      reasons: dependency.reasons,
      producers: Object.freeze(producers),
    });
  }
  return normalizeAiAnalysisDependency({
    status: dependency.status,
    producers: Object.freeze(producers),
  });
}

function candidateDecisionProofsFromSnapshot(
  items: readonly SnapshotTrackedItem[],
  relations: readonly Relation[],
): readonly RelationCandidateDecisionProof[] {
  const producersByCandidateId = new Map<string, RelationCandidateProducer>();
  for (const item of items) {
    for (const element of AI_ANALYSIS_DEPENDENCY_ELEMENTS) {
      const dependency = item.aiDependencies[element];
      if (dependency.status === "not_dependent") {
        continue;
      }
      for (const producer of dependency.producers ?? []) {
        if (producer.kind === "relation_candidate") {
          producersByCandidateId.set(producer.candidateId, producer);
        }
      }
    }
  }
  const itemsByNodeId = new Map<string, SnapshotTrackedItem>(
    items.map((item) => [item.nodeId, item]),
  );
  const relationsById = new Map(relations.map((relation) => [relation.id, relation]));
  const proofs: RelationCandidateDecisionProof[] = [];
  for (const producer of producersByCandidateId.values()) {
    const candidateId = snapshotRelationCandidateId(producer.candidateId);
    const relation = relationsById.get(candidateId);
    if (relation?.active === true) {
      if (relation.provenance === "native") {
        throw new StateSnapshotSemanticError(
          `relation candidate ${candidateId}がnative relationと衝突しています`,
        );
      }
      const dependency = activeRelationCandidateProofDependency(relation);
      if (dependency == null) {
        continue;
      }
      proofs.push(
        Object.freeze({
          candidateId,
          endpointNodeIds: producer.endpointNodeIds,
          authority: "inferred",
          resolution: Object.freeze({
            candidateId,
            status: "active",
            edgeId: candidateId,
          }),
          dependency,
          canonicalRelation: Object.freeze({
            fromNodeId: relation.fromNodeId,
            toNodeId: relation.toNodeId,
            type: relation.type,
          }),
        }),
      );
      continue;
    }
    proofs.push(
      Object.freeze({
        candidateId,
        endpointNodeIds: producer.endpointNodeIds,
        authority: "inferred",
        resolution: Object.freeze({
          candidateId,
          status: "pending",
          reason: "assessment_missing",
        }),
        dependency: candidateProofDependencyForProducer(producer, itemsByNodeId),
      }),
    );
  }
  return Object.freeze(proofs);
}

function compareSnapshotBlockers(left: SnapshotBlocker, right: SnapshotBlocker): number {
  if (left.authority !== right.authority) {
    return left.authority === "authoritative" ? -1 : 1;
  }
  if (left.confidenceValue !== right.confidenceValue) {
    return right.confidenceValue - left.confidenceValue;
  }
  const becameBlockingAtOrder = compareStrings(
    left.becameBlockingAtValue,
    right.becameBlockingAtValue,
  );
  return becameBlockingAtOrder === 0
    ? compareStrings(left.blockerNodeId, right.blockerNodeId)
    : becameBlockingAtOrder;
}

export function expectedSnapshotBlockerAnalysis(
  snapshot:
    | StateSnapshotFields
    | LegacyStateSnapshotFieldsWithoutAiDependencies
    | LegacyStateSnapshotFields
    | LegacyStateSnapshotFieldsWithPersonalReminder
    | LegacyStateSnapshotFieldsWithPersonalReminderVersion17,
): SnapshotBlockerAnalysis | undefined {
  const stateByNodeId = effectiveGraphStateByNodeId(snapshot);
  const items: SnapshotTrackedItem[] = [];
  for (const item of snapshot.items) {
    if (!("aiDependencies" in item)) {
      return undefined;
    }
    items.push(item);
  }
  const relations: Relation[] = [];
  for (const relation of snapshot.relations) {
    if (!("aiDependency" in relation)) {
      return undefined;
    }
    relations.push(relation);
  }
  const nodes: GraphAnalysisNode[] = [
    ...items.map(
      (item) =>
        Object.freeze({
          kind: item.type,
          nodeId: item.nodeId,
          repositoryId: item.repositoryId,
          state: effectiveGraphStateForNode(stateByNodeId, item.nodeId),
          directNotification: "eligible",
        }) satisfies GraphAnalysisNode,
    ),
    ...snapshot.externalReferences.map(
      (reference) =>
        Object.freeze({
          kind: reference.kind,
          nodeId: reference.nodeId,
          repositoryFullName: reference.repositoryFullName,
          state: reference.state,
          directNotification: "not_eligible",
        }) satisfies GraphAnalysisNode,
    ),
  ];
  const graphSnapshot = Object.freeze({
    nodes: Object.freeze(nodes),
    edges: Object.freeze(relations.map(snapshotGraphEdge)),
  });
  const candidateProofNodeIds = new Set(nodes.map((node) => node.nodeId));
  const candidateDecisionProofs = candidateDecisionProofsFromSnapshot(items, relations).filter(
    (proof) => proof.endpointNodeIds.every((nodeId) => candidateProofNodeIds.has(nodeId)),
  );
  const graphAnalysis = analyzeGraphAiDependencies({
    current: graphSnapshot,
    previous: Object.freeze({ availability: "unavailable" }),
    candidateProofSnapshot: graphSnapshot,
    candidateDecisionProofs,
  });
  const primitiveByArc = new Map(
    graphAnalysis.blockerNodeAiDependencies.map((dependency) => [
      blocksArcKey(dependency.blockerNodeId, dependency.blockedNodeId),
      dependency,
    ]),
  );
  const openNodeIds = new Set<GraphNodeId>([
    ...items
      .filter((item) => effectiveGraphStateForNode(stateByNodeId, item.nodeId) === "open")
      .map((item) => item.nodeId),
    ...snapshot.externalReferences
      .filter((reference) => reference.state === "open")
      .map((reference) => reference.nodeId),
  ]);
  const supportsByArc = new Map<string, Relation[]>();
  for (const relation of relations) {
    if (
      !relation.active ||
      relation.type !== "blocks" ||
      !openNodeIds.has(relation.fromNodeId) ||
      !openNodeIds.has(relation.toNodeId)
    ) {
      continue;
    }
    const key = blocksArcKey(relation.fromNodeId, relation.toNodeId);
    const supports = supportsByArc.get(key);
    if (supports == null) {
      supportsByArc.set(key, [relation]);
    } else {
      supports.push(relation);
    }
  }
  const itemsByNodeId = new Map<string, SnapshotTrackedItem>(
    items.map((item) => [item.nodeId, item]),
  );
  const blockersByBlockedNodeId = new Map<GraphNodeId, SnapshotBlocker[]>();
  for (const [key, supports] of supportsByArc) {
    const firstSupport = supports[0];
    if (firstSupport == null) {
      throw new StateSnapshotSemanticError("blocker supportがありません");
    }
    const dependency = primitiveByArc.get(key);
    if (dependency == null) {
      throw new StateSnapshotSemanticError(
        `blocker ${firstSupport.fromNodeId}のAI依存primitiveがありません`,
      );
    }
    const targetItem = itemsByNodeId.get(firstSupport.toNodeId);
    const becameBlockingAtValue = supports.reduce(
      (earliest, support) => {
        const value =
          support.provenance === "native" && targetItem != null
            ? targetItem.createdAt
            : support.firstSeenAt;
        return value < earliest ? value : earliest;
      },
      firstSupport.provenance === "native" && targetItem != null
        ? targetItem.createdAt
        : firstSupport.firstSeenAt,
    );
    const blocker = Object.freeze({
      blockerNodeId: firstSupport.fromNodeId,
      authority: supports.some((support) => support.provenance === "native")
        ? "authoritative"
        : "inferred",
      confidenceValue: Math.max(...supports.map((support) => support.confidence)),
      becameBlockingAtValue,
      dependency,
    }) satisfies SnapshotBlocker;
    const blockers = blockersByBlockedNodeId.get(firstSupport.toNodeId);
    if (blockers == null) {
      blockersByBlockedNodeId.set(firstSupport.toNodeId, [blocker]);
    } else {
      blockers.push(blocker);
    }
  }
  return Object.freeze({
    blockersByBlockedNodeId: new Map(
      [...blockersByBlockedNodeId].map(([nodeId, blockers]) => [
        nodeId,
        Object.freeze(blockers.sort(compareSnapshotBlockers)),
      ]),
    ),
    blockerSetDependenciesByNodeId: new Map(
      graphAnalysis.blockerSetAiDependencies.map((entry) => [entry.nodeId, entry.dependency]),
    ),
    negativeDependenciesByNodeId: new Map(
      graphAnalysis.negativeBlockerAiDependencies.map((entry) => [entry.nodeId, entry.dependency]),
    ),
  });
}
