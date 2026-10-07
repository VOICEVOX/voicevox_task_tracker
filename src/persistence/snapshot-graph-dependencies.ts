import { hashCanonicalJson } from "../canonical-json/index.js";
import {
  combineAiAnalysisDependencies,
  normalizeAiAnalysisDependency,
} from "../domain/ai-analysis-dependencies.js";
import {
  type AiAnalysisDependency,
  type AiAnalysisDependencyProducer,
  type GraphNodeId,
  type Relation,
  type TrackedItemAiAnalysis,
} from "../domain/index.js";
import { UnreachableError } from "../util/index.js";
import { StateSnapshotSemanticError } from "./errors.js";
import {
  assertAiAnalysisApplicationsMatchStoredElements,
  assertAiAnalysisCurrentAdoptedMapSemantics,
  assertAiAnalysisElementApplicationsSemantics,
  assertAiAnalysisElementMapSemantics,
  assertAiAnalysisMigrationAdoptedMapSemantics,
  expectedAiAnalysisDependencyForProducer,
} from "./snapshot-ai-adoption.js";
import { aiAnalysisDependencyMatchesExpected } from "./snapshot-ai-integrity.js";
import type {
  LegacyRelationWithoutAiDependency,
  LegacyStateSnapshotFields,
  LegacyStateSnapshotFieldsWithoutAiDependencies,
  LegacyStateSnapshotFieldsWithPersonalReminder,
  LegacyStateSnapshotFieldsWithPersonalReminderVersion17,
  LegacyTrackedItemAiAnalysis,
  SnapshotItemForRelationValidation,
  SnapshotTrackedItem,
  StateSnapshotFields,
} from "./snapshot-contracts.js";
import { preferredBlockerSupportDependency } from "./snapshot-relations.js";
import type { ElementSchemaVersion } from "./snapshot-schema.js";

export function expectedRelationSetAiDependencies(
  snapshot:
    | StateSnapshotFields
    | LegacyStateSnapshotFieldsWithoutAiDependencies
    | LegacyStateSnapshotFields
    | LegacyStateSnapshotFieldsWithPersonalReminder
    | LegacyStateSnapshotFieldsWithPersonalReminderVersion17,
): ReadonlyMap<GraphNodeId, AiAnalysisDependency> {
  const dependenciesByNodeId = new Map<GraphNodeId, AiAnalysisDependency>();
  for (const item of snapshot.items) {
    dependenciesByNodeId.set(item.nodeId, Object.freeze({ status: "not_dependent" }));
  }
  const supportsByNodeId = new Map<GraphNodeId, Map<string, AiAnalysisDependency[]>>();
  const inferredDecisionsByNodeId = new Map<GraphNodeId, AiAnalysisDependency[]>();
  for (const relation of snapshot.relations) {
    if (!relation.active || !("aiDependency" in relation)) {
      continue;
    }
    const key = JSON.stringify([relation.type, relation.fromNodeId, relation.toNodeId]);
    for (const nodeId of [relation.fromNodeId, relation.toNodeId]) {
      if (!dependenciesByNodeId.has(nodeId)) {
        continue;
      }
      if (relation.provenance !== "native") {
        const decisions = inferredDecisionsByNodeId.get(nodeId);
        if (decisions == null) {
          inferredDecisionsByNodeId.set(nodeId, [relation.aiDependency]);
        } else {
          decisions.push(relation.aiDependency);
        }
      }
      const supportsByMeaning = supportsByNodeId.get(nodeId);
      if (supportsByMeaning == null) {
        supportsByNodeId.set(nodeId, new Map([[key, [relation.aiDependency]]]));
        continue;
      }
      const supports = supportsByMeaning.get(key);
      if (supports == null) {
        supportsByMeaning.set(key, [relation.aiDependency]);
      } else {
        supports.push(relation.aiDependency);
      }
    }
  }
  for (const [nodeId, supportsByMeaning] of supportsByNodeId) {
    const dependencies = [...supportsByMeaning.values()].map((supports) =>
      preferredBlockerSupportDependency(supports),
    );
    dependencies.push(...(inferredDecisionsByNodeId.get(nodeId) ?? []));
    dependenciesByNodeId.set(nodeId, combineAiAnalysisDependencies(dependencies));
  }
  return dependenciesByNodeId;
}

export function aiAnalysisDependencyStatusPriority(status: AiAnalysisDependency["status"]): number {
  switch (status) {
    case "not_dependent":
      return 0;
    case "current":
      return 1;
    case "unverified":
      return 2;
    case "unknown":
      return 3;
    default:
      throw new UnreachableError(status);
  }
}

export function blocksArcKey(fromNodeId: GraphNodeId, toNodeId: GraphNodeId): string {
  return JSON.stringify(["blocks", fromNodeId, toNodeId]);
}

export function aiAnalysisDependencyProducerSignature(
  producer: AiAnalysisDependencyProducer,
): string {
  return hashCanonicalJson(producer);
}

function expectedProducersAreContained(
  expected: AiAnalysisDependency,
  actual: AiAnalysisDependency,
): boolean {
  const expectedProducers = expected.status === "not_dependent" ? undefined : expected.producers;
  const actualProducers = actual.status === "not_dependent" ? undefined : actual.producers;
  if (expectedProducers == null || expectedProducers.length === 0) {
    return true;
  }
  if (actualProducers == null) {
    return false;
  }
  const actualProducerSignatures = new Set(
    actualProducers.map(aiAnalysisDependencyProducerSignature),
  );
  return expectedProducers.every((producer) =>
    actualProducerSignatures.has(aiAnalysisDependencyProducerSignature(producer)),
  );
}

export function assertAiAnalysisDependencyLowerBound(
  expected: AiAnalysisDependency,
  actual: AiAnalysisDependency,
  description: string,
): void {
  if (!aiAnalysisDependencyContainsLowerBound(expected, actual)) {
    throw new StateSnapshotSemanticError(`${description}が導出元のAI依存を含んでいません`);
  }
}

function aiAnalysisDependencyContainsLowerBound(
  expected: AiAnalysisDependency,
  actual: AiAnalysisDependency,
): boolean {
  const producerlessMigration =
    actual.status === "unknown" &&
    actual.reasons.length === 1 &&
    actual.reasons[0] === "migration" &&
    actual.producers == null;
  if (producerlessMigration || expected.status === "not_dependent") {
    return true;
  }
  if (
    aiAnalysisDependencyStatusPriority(actual.status) <
      aiAnalysisDependencyStatusPriority(expected.status) ||
    !expectedProducersAreContained(expected, actual)
  ) {
    return false;
  }
  return true;
}

export function aiAnalysisDependencyContainsRecordedLowerBound(
  expected: AiAnalysisDependency,
  actual: AiAnalysisDependency,
): boolean {
  if (expected.status === "not_dependent") {
    return true;
  }
  return (
    aiAnalysisDependencyStatusPriority(actual.status) >=
      aiAnalysisDependencyStatusPriority(expected.status) &&
    expectedProducersAreContained(expected, actual)
  );
}

function relationDerivedAiDependency(dependency: AiAnalysisDependency): AiAnalysisDependency {
  if (dependency.status === "not_dependent") {
    return dependency;
  }
  const producers = dependency.producers?.filter((producer) => producer.kind !== "item_element");
  if (producers == null || producers.length === 0) {
    return Object.freeze({ status: "not_dependent" });
  }
  if (dependency.status === "unknown") {
    return normalizeAiAnalysisDependency({
      status: dependency.status,
      reasons: dependency.reasons,
      producers,
    });
  }
  return normalizeAiAnalysisDependency({ status: dependency.status, producers });
}

export function assertGraphDerivedAiDependencyLowerBounds(
  item: SnapshotTrackedItem,
  expectedDownstreamImpact: AiAnalysisDependency,
): void {
  assertAiAnalysisDependencyLowerBound(
    expectedDownstreamImpact,
    item.aiDependencies.downstreamImpact,
    `item ${item.nodeId}のdownstream impact AI依存`,
  );
  if (item.importance.factors.some((factor) => factor.kind === "downstreamImpact")) {
    assertAiAnalysisDependencyLowerBound(
      item.aiDependencies.downstreamImpact,
      item.aiDependencies.importance,
      `item ${item.nodeId}のimportance AI依存`,
    );
  }
  const specialWaitClass =
    item.severityContext.waitClass === "notApplicable" ||
    item.severityContext.waitClass === "blockedParent";
  const severitySource = specialWaitClass
    ? relationDerivedAiDependency(item.aiDependencies.status)
    : combineAiAnalysisDependencies([
        relationDerivedAiDependency(item.aiDependencies.stallSince),
        relationDerivedAiDependency(item.aiDependencies.status),
        relationDerivedAiDependency(item.aiDependencies.waitingOn),
      ]);
  assertAiAnalysisDependencyLowerBound(
    severitySource,
    item.aiDependencies.severity,
    `item ${item.nodeId}のseverity AI依存`,
  );
  const attentionSources = specialWaitClass
    ? [relationDerivedAiDependency(item.aiDependencies.status)]
    : [relationDerivedAiDependency(item.aiDependencies.importance)];
  if (!specialWaitClass && item.importance.score !== 0) {
    attentionSources.push(
      relationDerivedAiDependency(item.aiDependencies.stallSince),
      relationDerivedAiDependency(item.aiDependencies.status),
      relationDerivedAiDependency(item.aiDependencies.waitingOn),
    );
  }
  assertAiAnalysisDependencyLowerBound(
    combineAiAnalysisDependencies(attentionSources),
    item.aiDependencies.attention,
    `item ${item.nodeId}のattention AI依存`,
  );
}

function additionalBlockerProducers(
  expected: AiAnalysisDependency,
  actual: AiAnalysisDependency,
): readonly AiAnalysisDependencyProducer[] {
  const expectedProducerSignatures = new Set(
    expected.status === "not_dependent"
      ? []
      : (expected.producers ?? []).map(aiAnalysisDependencyProducerSignature),
  );
  const actualProducers = actual.status === "not_dependent" ? [] : (actual.producers ?? []);
  return Object.freeze(
    actualProducers.filter(
      (producer) =>
        !expectedProducerSignatures.has(aiAnalysisDependencyProducerSignature(producer)),
    ),
  );
}

function relationSetExpectedProducerIsCovered(
  expectedProducer: AiAnalysisDependencyProducer,
  actualProducers: readonly AiAnalysisDependencyProducer[],
  relationsById: ReadonlyMap<string, Relation | LegacyRelationWithoutAiDependency>,
): boolean {
  const expectedSignature = aiAnalysisDependencyProducerSignature(expectedProducer);
  if (
    actualProducers.some(
      (producer) => aiAnalysisDependencyProducerSignature(producer) === expectedSignature,
    )
  ) {
    return true;
  }
  if (expectedProducer.kind !== "relation") {
    return false;
  }
  const relation = relationsById.get(expectedProducer.relationId);
  if (relation == null) {
    throw new StateSnapshotSemanticError(
      `relation set AI依存のrelation ${expectedProducer.relationId}がありません`,
    );
  }
  return actualProducers.some(
    (producer) =>
      producer.kind === "relation_candidate" &&
      producer.candidateId === expectedProducer.relationId &&
      producer.endpointNodeIds.includes(relation.fromNodeId) &&
      producer.endpointNodeIds.includes(relation.toNodeId) &&
      producer.producer.nodeId === expectedProducer.producer.nodeId,
  );
}

function relationSetActualProducersAreExpected(
  expectedProducers: readonly AiAnalysisDependencyProducer[],
  actualProducers: readonly AiAnalysisDependencyProducer[],
  relationsById: ReadonlyMap<string, Relation | LegacyRelationWithoutAiDependency>,
): boolean {
  const coverageCountByExpectedSignature = new Map<string, number>();
  for (const actualProducer of actualProducers) {
    if (actualProducer.kind === "item_element") {
      return false;
    }
    const persistedRelation =
      actualProducer.kind === "relation_candidate"
        ? relationsById.get(actualProducer.candidateId)
        : relationsById.get(actualProducer.relationId);
    if (actualProducer.kind === "relation_candidate" && persistedRelation?.active !== true) {
      continue;
    }
    const matchingExpectedProducer = expectedProducers.find((expectedProducer) =>
      relationSetExpectedProducerIsCovered(expectedProducer, [actualProducer], relationsById),
    );
    if (matchingExpectedProducer == null) {
      return false;
    }
    const signature = aiAnalysisDependencyProducerSignature(matchingExpectedProducer);
    const nextCoverageCount = (coverageCountByExpectedSignature.get(signature) ?? 0) + 1;
    if (nextCoverageCount > 1) {
      return false;
    }
    coverageCountByExpectedSignature.set(signature, nextCoverageCount);
  }
  return true;
}

export function relationSetDependencySatisfiesExpected(
  expected: AiAnalysisDependency,
  actual: AiAnalysisDependency,
  relationsById: ReadonlyMap<string, Relation | LegacyRelationWithoutAiDependency>,
): boolean {
  const hiddenSentinelOptions = Object.freeze({
    allowHiddenProducerlessNotRecorded: true,
    allowHiddenProducerlessMigration: true,
    allowHiddenProducerlessStaleRepository: false,
  });
  if (aiAnalysisDependencyMatchesExpected(actual, expected, hiddenSentinelOptions)) {
    return true;
  }
  if (
    aiAnalysisDependencyStatusPriority(actual.status) <
    aiAnalysisDependencyStatusPriority(expected.status)
  ) {
    return false;
  }
  const expectedProducers = expected.status === "not_dependent" ? [] : (expected.producers ?? []);
  const actualProducers = actual.status === "not_dependent" ? [] : (actual.producers ?? []);
  if (!relationSetActualProducersAreExpected(expectedProducers, actualProducers, relationsById)) {
    return false;
  }
  return expectedProducers.every((producer) =>
    relationSetExpectedProducerIsCovered(producer, actualProducers, relationsById),
  );
}

export function assertNegativeBlockerCandidateDirection(
  producer: Extract<AiAnalysisDependencyProducer, { kind: "relation_candidate" }>,
  blockedNodeId: GraphNodeId,
  activeBlocksArcKeys: ReadonlySet<string>,
): void {
  const [firstEndpoint, secondEndpoint] = producer.endpointNodeIds;
  let otherEndpoint: GraphNodeId | undefined;
  if (firstEndpoint === blockedNodeId) {
    otherEndpoint = secondEndpoint;
  } else if (secondEndpoint === blockedNodeId) {
    otherEndpoint = firstEndpoint;
  }
  if (otherEndpoint == null) {
    throw new StateSnapshotSemanticError(
      `item ${blockedNodeId}のblockers AI依存candidate endpointが親itemと一致しません`,
    );
  }
  if (activeBlocksArcKeys.has(blocksArcKey(otherEndpoint, blockedNodeId))) {
    throw new StateSnapshotSemanticError(
      `item ${blockedNodeId}のblockers AI依存にactiveなnegative relation candidateがあります`,
    );
  }
}

export function blockerDependencySatisfiesExpected(
  expected: AiAnalysisDependency,
  actual: AiAnalysisDependency,
  itemNodeId: GraphNodeId,
  itemsByNodeId: ReadonlyMap<string, SnapshotItemForRelationValidation>,
  relationsById: ReadonlyMap<string, Relation | LegacyRelationWithoutAiDependency>,
  activeBlocksArcKeys: ReadonlySet<string>,
): boolean {
  const hiddenSentinelOptions = Object.freeze({
    allowHiddenProducerlessNotRecorded: true,
    allowHiddenProducerlessMigration: true,
    allowHiddenProducerlessStaleRepository: false,
  });
  if (aiAnalysisDependencyMatchesExpected(actual, expected, hiddenSentinelOptions)) {
    return true;
  }
  if (
    aiAnalysisDependencyStatusPriority(actual.status) <
    aiAnalysisDependencyStatusPriority(expected.status)
  ) {
    return false;
  }
  if (!expectedProducersAreContained(expected, actual)) {
    return false;
  }
  const additionalProducers = additionalBlockerProducers(expected, actual);
  if (additionalProducers.length !== 0) {
    for (const producer of additionalProducers) {
      if (producer.kind === "relation") {
        const relation = relationsById.get(producer.relationId);
        if (
          relation == null ||
          !relation.active ||
          relation.type !== "blocks" ||
          relation.toNodeId !== itemNodeId
        ) {
          return false;
        }
        continue;
      }
      if (producer.kind === "relation_candidate") {
        assertNegativeBlockerCandidateDirection(producer, itemNodeId, activeBlocksArcKeys);
        continue;
      }
      return false;
    }
    const reconstructed = combineAiAnalysisDependencies([
      expected,
      ...additionalProducers.map((producer) =>
        expectedAiAnalysisDependencyForProducer(
          producer,
          `item ${itemNodeId}のblockers AI依存`,
          itemsByNodeId,
          relationsById,
          actual,
        ),
      ),
    ]);
    if (hashCanonicalJson(reconstructed) === hashCanonicalJson(actual)) {
      return true;
    }
    return aiAnalysisDependencyMatchesExpected(actual, reconstructed, hiddenSentinelOptions);
  }
  return false;
}

export function assertAiAnalysisSemantics(
  aiAnalysis: TrackedItemAiAnalysis | LegacyTrackedItemAiAnalysis,
  elementSchemaVersion: ElementSchemaVersion,
  adoptedElementsFormat: "legacy" | "current",
  requireApplications: boolean,
  allowNotRecordedApplicationWithoutAdopted: boolean,
): void {
  let applications: TrackedItemAiAnalysis["applications"] | undefined;
  if (requireApplications) {
    if (!("applications" in aiAnalysis)) {
      throw new StateSnapshotSemanticError("AI適用元がありません");
    }
    applications = assertAiAnalysisElementApplicationsSemantics(
      aiAnalysis.applications,
      "AI適用元",
    );
  }
  if (aiAnalysis.origin === "current") {
    if (aiAnalysis.status === "used" && Object.keys(aiAnalysis.elements).length === 0) {
      throw new StateSnapshotSemanticError("AI分析がusedなのに生成記録がありません");
    }
    assertAiAnalysisElementMapSemantics(
      aiAnalysis.elements,
      "AI判定要素",
      elementSchemaVersion,
      adoptedElementsFormat,
    );
    if (adoptedElementsFormat === "current") {
      assertAiAnalysisCurrentAdoptedMapSemantics(
        aiAnalysis.adoptedElements,
        "AI採用要素",
        elementSchemaVersion,
      );
    } else {
      assertAiAnalysisElementMapSemantics(
        aiAnalysis.adoptedElements,
        "AI採用要素",
        elementSchemaVersion,
        adoptedElementsFormat,
      );
    }
    if (applications != null) {
      assertAiAnalysisApplicationsMatchStoredElements(
        aiAnalysis,
        applications,
        allowNotRecordedApplicationWithoutAdopted,
      );
    }
    return;
  }
  assertAiAnalysisElementMapSemantics(
    aiAnalysis.elements,
    "AI判定要素",
    elementSchemaVersion,
    adoptedElementsFormat,
  );
  assertAiAnalysisMigrationAdoptedMapSemantics(
    aiAnalysis.adoptedElements,
    "移行AI採用要素",
    elementSchemaVersion,
    adoptedElementsFormat === "current",
  );
  if (applications != null) {
    assertAiAnalysisApplicationsMatchStoredElements(
      aiAnalysis,
      applications,
      allowNotRecordedApplicationWithoutAdopted,
    );
  }
}
