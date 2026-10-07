import {
  aiAnalysisDependencyForApplication,
  aiAnalysisDependencyForRelation,
  aiAnalysisDependencySchema,
  combineAiAnalysisDependencies,
} from "../domain/ai-analysis-dependencies.js";
import {
  type AiAnalysisDependency,
  type ExternalGhostNode,
  type GraphNodeId,
  type Relation,
} from "../domain/index.js";
import {
  analyzeGraph,
  type GraphAnalysisNode,
  type ReconciledGraphEdge,
  type RelationCandidateId,
} from "../graph/index.js";
import { StateSnapshotSemanticError } from "./errors.js";
import { assertAiAnalysisDependencyIntegrity } from "./snapshot-ai-integrity.js";
import type {
  LegacyRelationWithoutAiDependency,
  LegacyStateSnapshotFields,
  LegacyStateSnapshotFieldsWithoutAiDependencies,
  LegacyStateSnapshotFieldsWithPersonalReminder,
  LegacyStateSnapshotFieldsWithPersonalReminderVersion17,
  SnapshotItemForRelationValidation,
  StateSnapshotFields,
} from "./snapshot-contracts.js";
import { effectiveGraphStateByNodeId, effectiveGraphStateForNode } from "./snapshot-values.js";

function externalReferenceItemType(reference: ExternalGhostNode): "issue" | "pull_request" {
  let url: URL;
  try {
    url = new URL(reference.url);
  } catch (error: unknown) {
    throw new StateSnapshotSemanticError(
      `外部参照nodeのURLからitem種別を判定できません。対象: ${reference.nodeId}`,
      { cause: error },
    );
  }
  const pathSegments = url.pathname.split("/").filter((segment) => segment.length !== 0);
  const itemPathKind = pathSegments[2];
  const itemNumber = pathSegments[3];
  if (
    url.hostname !== "github.com" ||
    pathSegments.length < 4 ||
    itemNumber == null ||
    !/^[1-9][0-9]*$/u.test(itemNumber)
  ) {
    throw new StateSnapshotSemanticError(
      `外部参照nodeのURLからitem種別を判定できません。対象: ${reference.nodeId}`,
    );
  }
  if (itemPathKind === "issues") {
    return "issue";
  }
  if (itemPathKind === "pull") {
    return "pull_request";
  }
  throw new StateSnapshotSemanticError(
    `外部参照nodeのURLからitem種別を判定できません。対象: ${reference.nodeId}`,
  );
}

function snapshotGraphNodeItemType(
  nodeId: GraphNodeId,
  itemsByNodeId: ReadonlyMap<string, SnapshotItemForRelationValidation>,
  externalReferencesByNodeId: ReadonlyMap<string, ExternalGhostNode>,
): "issue" | "pull_request" {
  const item = itemsByNodeId.get(nodeId);
  if (item != null) {
    return item.type;
  }
  const externalReference = externalReferencesByNodeId.get(nodeId);
  if (externalReference != null) {
    return externalReferenceItemType(externalReference);
  }
  throw new StateSnapshotSemanticError(`relation endpointがsnapshotにありません。対象: ${nodeId}`);
}

export function assertImplementsRelationEndpointTypes(
  relation: Relation | LegacyRelationWithoutAiDependency,
  itemsByNodeId: ReadonlyMap<string, SnapshotItemForRelationValidation>,
  externalReferencesByNodeId: ReadonlyMap<string, ExternalGhostNode>,
): void {
  if (relation.type !== "implements") {
    return;
  }
  const implementationType = snapshotGraphNodeItemType(
    relation.fromNodeId,
    itemsByNodeId,
    externalReferencesByNodeId,
  );
  const targetType = snapshotGraphNodeItemType(
    relation.toNodeId,
    itemsByNodeId,
    externalReferencesByNodeId,
  );
  if (implementationType !== "pull_request" || targetType !== "issue") {
    throw new StateSnapshotSemanticError(
      `implements relation ${relation.id}はPull RequestからIssueへ向けてください`,
    );
  }
}

export function assertRelationAiDependencySemantics(
  dependency: unknown,
  description: string,
): void {
  const parsedDependency = aiAnalysisDependencySchema.safeParse(dependency);
  if (!parsedDependency.success) {
    throw new StateSnapshotSemanticError(`${description}が不正です`, {
      cause: parsedDependency.error,
    });
  }
  if (
    parsedDependency.data.status === "unknown" &&
    parsedDependency.data.reasons.includes("stale_repository")
  ) {
    throw new StateSnapshotSemanticError(`${description}にstale repository依存は指定できません`);
  }
}

export function assertInferredRelationAiDependencySemantics(
  relation: Relation,
  itemsByNodeId: ReadonlyMap<string, SnapshotItemForRelationValidation>,
  historicalDependency: boolean,
): void {
  if (relation.provenance === "native") {
    return;
  }
  const dependency = relation.aiDependency;
  if (dependency.status === "not_dependent") {
    throw new StateSnapshotSemanticError(
      `inferred relation ${relation.id}のnot_dependent AI依存は許可されません`,
    );
  }
  if (
    relation.active &&
    historicalDependency &&
    (dependency.status !== "unknown" ||
      !dependency.reasons.every((reason) => reason === "proof_unknown" || reason === "migration"))
  ) {
    throw new StateSnapshotSemanticError(
      `staleなactive inferred relation ${relation.id}のAI依存はunknownにしてください`,
    );
  }
  for (const producer of dependency.producers ?? []) {
    if (producer.kind !== "relation") {
      throw new StateSnapshotSemanticError(
        `inferred relation ${relation.id}のAI依存producer種別が不正です`,
      );
    }
    if (producer.relationId !== relation.id || producer.producer.element !== "relations") {
      throw new StateSnapshotSemanticError(
        `inferred relation ${relation.id}のAI依存producer参照が不正です`,
      );
    }
    if (
      producer.producer.nodeId !== relation.fromNodeId &&
      producer.producer.nodeId !== relation.toNodeId
    ) {
      throw new StateSnapshotSemanticError(
        `inferred relation ${relation.id}のAI依存producer nodeがendpointと一致しません`,
      );
    }
  }
  assertAiAnalysisDependencyIntegrity(dependency, `inferred relation ${relation.id}のAI依存`, {
    allowStaleRepository: false,
    allowProducerlessNotRecorded: !relation.active,
    allowProducerlessMigration: true,
    allowProducerlessStaleRepository: false,
    allowHiddenProducerlessNotRecorded: false,
    allowHiddenProducerlessMigration: false,
    allowHiddenProducerlessStaleRepository: false,
    dependencyForProducer: (producer, description) => {
      if (producer.kind !== "relation") {
        throw new StateSnapshotSemanticError(`${description}のproducer種別が不正です`);
      }
      if (historicalDependency) {
        switch (dependency.status) {
          case "current":
          case "unverified":
            return Object.freeze({
              status: dependency.status,
              producers: Object.freeze([producer]),
            });
          case "unknown":
            return Object.freeze({
              status: dependency.status,
              reasons: dependency.reasons,
              producers: Object.freeze([producer]),
            });
        }
      }
      const producerItem = itemsByNodeId.get(producer.producer.nodeId);
      if (producerItem == null || !("applications" in producerItem.aiAnalysis)) {
        throw new StateSnapshotSemanticError(`${description}の生成元itemにAI適用元がありません`);
      }
      const producerDependency = aiAnalysisDependencyForApplication(
        producerItem.nodeId,
        "relations",
        producerItem.aiAnalysis.applications.relations,
      );
      if (producerDependency.status === "not_dependent") {
        throw new StateSnapshotSemanticError(`${description}の生成元itemにAI依存がありません`);
      }
      return aiAnalysisDependencyForRelation(relation.id, producerDependency);
    },
  });
}

export function preferredBlockerSupportDependency(
  dependencies: readonly AiAnalysisDependency[],
): AiAnalysisDependency {
  if (dependencies.length === 0) {
    throw new StateSnapshotSemanticError("blocker supportがありません");
  }
  if (dependencies.some((dependency) => dependency.status === "not_dependent")) {
    return Object.freeze({ status: "not_dependent" });
  }
  if (dependencies.some((dependency) => dependency.status === "current")) {
    return combineAiAnalysisDependencies(
      dependencies.filter((dependency) => dependency.status === "current"),
    );
  }
  if (dependencies.some((dependency) => dependency.status === "unverified")) {
    return combineAiAnalysisDependencies(
      dependencies.filter((dependency) => dependency.status === "unverified"),
    );
  }
  return combineAiAnalysisDependencies(
    dependencies.filter((dependency) => dependency.status === "unknown"),
  );
}

export function snapshotRelationCandidateId(relationId: string): RelationCandidateId {
  if (!relationId.startsWith("rel:") || relationId.length === "rel:".length) {
    throw new StateSnapshotSemanticError(`relation IDの形式が不正です。対象: ${relationId}`);
  }
  return `rel:${relationId.slice("rel:".length)}`;
}

export function snapshotGraphEdge(relation: Relation): ReconciledGraphEdge {
  const fields = {
    id: snapshotRelationCandidateId(relation.id),
    fromNodeId: relation.fromNodeId,
    toNodeId: relation.toNodeId,
    type: relation.type,
    provenance: relation.provenance,
    confidence: relation.confidence,
    evidence: relation.evidence,
    authoritative: relation.provenance === "native",
    contradictions: Object.freeze(
      relation.contradictions.map((contradiction) =>
        Object.freeze({
          verdict: contradiction.verdict,
          confidence: contradiction.confidence,
          evidence: Object.freeze([]),
        }),
      ),
    ),
    aiDependency: relation.aiDependency,
    firstSeenAt: relation.firstSeenAt,
    lastConfirmedAt: relation.lastConfirmedAt,
  };
  if (relation.active) {
    return Object.freeze({ ...fields, active: true });
  }
  return Object.freeze({ ...fields, active: false, removedAt: relation.removedAt });
}

export function expectedDownstreamImpactAiDependencies(
  snapshot:
    | StateSnapshotFields
    | LegacyStateSnapshotFieldsWithoutAiDependencies
    | LegacyStateSnapshotFields
    | LegacyStateSnapshotFieldsWithPersonalReminder
    | LegacyStateSnapshotFieldsWithPersonalReminderVersion17,
): ReadonlyMap<GraphNodeId, AiAnalysisDependency> | undefined {
  const stateByNodeId = effectiveGraphStateByNodeId(snapshot);
  const relations: ReconciledGraphEdge[] = [];
  for (const relation of snapshot.relations) {
    if (!("aiDependency" in relation)) {
      return undefined;
    }
    relations.push(snapshotGraphEdge(relation));
  }
  const nodes: GraphAnalysisNode[] = [
    ...snapshot.items.map((item) =>
      Object.freeze({
        kind: item.type,
        nodeId: item.nodeId,
        repositoryId: item.repositoryId,
        state: effectiveGraphStateForNode(stateByNodeId, item.nodeId),
        directNotification: "eligible",
      }),
    ),
    ...snapshot.externalReferences.map((reference) =>
      Object.freeze({
        kind: reference.kind,
        nodeId: reference.nodeId,
        repositoryFullName: reference.repositoryFullName,
        state: reference.state,
        directNotification: reference.directNotification,
      }),
    ),
  ];
  const analysis = analyzeGraph({
    current: Object.freeze({
      nodes: Object.freeze(nodes),
      edges: Object.freeze(relations),
    }),
    previous: Object.freeze({ availability: "unavailable" }),
  });
  return new Map(
    analysis.downstreamImpactAiDependencies.map((entry) => [entry.nodeId, entry.dependency]),
  );
}

export function expectedBlockersAiDependencies(
  snapshot:
    | StateSnapshotFields
    | LegacyStateSnapshotFieldsWithoutAiDependencies
    | LegacyStateSnapshotFields
    | LegacyStateSnapshotFieldsWithPersonalReminder
    | LegacyStateSnapshotFieldsWithPersonalReminderVersion17,
): ReadonlyMap<GraphNodeId, AiAnalysisDependency> {
  const stateByNodeId = effectiveGraphStateByNodeId(snapshot);
  const openNodeIds = new Set<GraphNodeId>([
    ...snapshot.items
      .filter((item) => effectiveGraphStateForNode(stateByNodeId, item.nodeId) === "open")
      .map((item) => item.nodeId),
    ...snapshot.externalReferences
      .filter((reference) => reference.state === "open")
      .map((reference) => reference.nodeId),
  ]);
  const dependenciesByNodeId = new Map<GraphNodeId, AiAnalysisDependency>();
  for (const item of snapshot.items) {
    dependenciesByNodeId.set(item.nodeId, Object.freeze({ status: "not_dependent" }));
  }
  for (const reference of snapshot.externalReferences) {
    dependenciesByNodeId.set(reference.nodeId, Object.freeze({ status: "not_dependent" }));
  }
  const supportsByNodeId = new Map<GraphNodeId, Map<string, AiAnalysisDependency[]>>();
  for (const relation of snapshot.relations) {
    if (
      !relation.active ||
      relation.type !== "blocks" ||
      !openNodeIds.has(relation.fromNodeId) ||
      !openNodeIds.has(relation.toNodeId) ||
      !("aiDependency" in relation)
    ) {
      continue;
    }
    const supportsByMeaning = supportsByNodeId.get(relation.toNodeId);
    const key = `${relation.type}\u0000${relation.fromNodeId}\u0000${relation.toNodeId}`;
    if (supportsByMeaning == null) {
      supportsByNodeId.set(relation.toNodeId, new Map([[key, [relation.aiDependency]]]));
      continue;
    }
    const supports = supportsByMeaning.get(key);
    if (supports == null) {
      supportsByMeaning.set(key, [relation.aiDependency]);
      continue;
    }
    supports.push(relation.aiDependency);
  }
  for (const [nodeId, supportsByMeaning] of supportsByNodeId) {
    const selectedSupports = [...supportsByMeaning.values()].map((dependencies) =>
      preferredBlockerSupportDependency(dependencies),
    );
    if (selectedSupports.length !== 0) {
      dependenciesByNodeId.set(nodeId, combineAiAnalysisDependencies(selectedSupports));
    }
  }
  return dependenciesByNodeId;
}
