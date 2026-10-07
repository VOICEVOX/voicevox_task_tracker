import { hashCanonicalJson } from "../canonical-json/index.js";
import {
  aiAnalysisDependencySchema,
  combineAiAnalysisDependencies,
} from "../domain/ai-analysis-dependencies.js";
import { type AiAnalysisElement } from "../domain/ai-analysis-elements.js";
import {
  type AiAnalysisDependency,
  type AiAnalysisDependencyElement,
  type AiAnalysisDependencyProducer,
  type GraphNodeId,
  type Relation,
} from "../domain/index.js";
import { UnreachableError } from "../util/index.js";
import {
  StateSnapshotSemanticError,
  type ResolvedPersonalReminderAiDependencyProducer,
} from "./errors.js";
import { expectedAiAnalysisDependencyForProducer } from "./snapshot-ai-adoption.js";
import type {
  LegacyRelationWithoutAiDependency,
  SnapshotItemForRelationValidation,
} from "./snapshot-contracts.js";

type AiAnalysisDependencyIntegrityOptions = Readonly<{
  allowStaleRepository: boolean;
  allowProducerlessNotRecorded: boolean;
  allowProducerlessMigration: boolean;
  allowProducerlessStaleRepository: boolean;
  allowHiddenProducerlessNotRecorded: boolean;
  allowHiddenProducerlessMigration: boolean;
  allowHiddenProducerlessStaleRepository: boolean;
  dependencyForProducer: (
    producer: AiAnalysisDependencyProducer,
    description: string,
    containingDependency: AiAnalysisDependency,
  ) => AiAnalysisDependency;
  onMismatch?:
    | ((
        actualDependency: AiAnalysisDependency,
        resolvedProducerDependencies: readonly ResolvedPersonalReminderAiDependencyProducer[],
        expectedDependency: AiAnalysisDependency,
      ) => StateSnapshotSemanticError)
    | undefined;
}>;

const producerlessNotRecordedAiAnalysisDependency = Object.freeze({
  status: "unknown",
  reasons: Object.freeze(["not_recorded"]),
} satisfies AiAnalysisDependency);

const producerlessMigrationAiAnalysisDependency = Object.freeze({
  status: "unknown",
  reasons: Object.freeze(["migration"]),
} satisfies AiAnalysisDependency);

export const producerlessStaleRepositoryAiAnalysisDependency = Object.freeze({
  status: "unknown",
  reasons: Object.freeze(["stale_repository"]),
} satisfies AiAnalysisDependency);

export function aiAnalysisDependencyMatchesExpected(
  actual: AiAnalysisDependency,
  expected: AiAnalysisDependency,
  options: Readonly<{
    allowHiddenProducerlessNotRecorded: boolean;
    allowHiddenProducerlessMigration: boolean;
    allowHiddenProducerlessStaleRepository: boolean;
  }>,
): boolean {
  if (hashCanonicalJson(expected) === hashCanonicalJson(actual)) {
    return true;
  }
  if (actual.status !== "unknown") {
    return false;
  }
  const dependencies = [expected];
  for (const reason of actual.reasons) {
    if (expected.status === "unknown" && expected.reasons.includes(reason)) {
      continue;
    }
    switch (reason) {
      case "not_recorded":
        if (!options.allowHiddenProducerlessNotRecorded) {
          return false;
        }
        dependencies.push(producerlessNotRecordedAiAnalysisDependency);
        break;
      case "migration":
        if (!options.allowHiddenProducerlessMigration) {
          return false;
        }
        dependencies.push(producerlessMigrationAiAnalysisDependency);
        break;
      case "stale_repository":
        if (!options.allowHiddenProducerlessStaleRepository) {
          return false;
        }
        dependencies.push(producerlessStaleRepositoryAiAnalysisDependency);
        break;
      case "proof_unknown":
        return false;
      default:
        throw new UnreachableError(reason);
    }
  }
  return (
    hashCanonicalJson(combineAiAnalysisDependencies(dependencies)) === hashCanonicalJson(actual)
  );
}

export function dependencyHasHiddenProducerlessReason(
  dependency: AiAnalysisDependency,
  reason: "not_recorded" | "migration",
  itemsByNodeId: ReadonlyMap<string, SnapshotItemForRelationValidation>,
  relationsById: ReadonlyMap<string, Relation | LegacyRelationWithoutAiDependency>,
): boolean {
  if (
    dependency.status !== "unknown" ||
    !dependency.reasons.includes(reason) ||
    dependency.producers == null
  ) {
    return false;
  }
  const visibleDependency = combineAiAnalysisDependencies(
    dependency.producers.map((producer) =>
      expectedAiAnalysisDependencyForProducer(
        producer,
        "hidden producerless AI依存",
        itemsByNodeId,
        relationsById,
        dependency,
      ),
    ),
  );
  return aiAnalysisDependencyMatchesExpected(dependency, visibleDependency, {
    allowHiddenProducerlessNotRecorded: true,
    allowHiddenProducerlessMigration: true,
    allowHiddenProducerlessStaleRepository: false,
  });
}

export function assertAiAnalysisDependencyIntegrity(
  dependency: unknown,
  description: string,
  options: AiAnalysisDependencyIntegrityOptions,
): AiAnalysisDependency {
  const parsedDependency = aiAnalysisDependencySchema.safeParse(dependency);
  if (!parsedDependency.success) {
    throw new StateSnapshotSemanticError(`${description}が不正です`, {
      cause: parsedDependency.error,
    });
  }
  const dependencyValue = parsedDependency.data;
  if (
    dependencyValue.status === "unknown" &&
    dependencyValue.reasons.includes("stale_repository") &&
    !options.allowStaleRepository
  ) {
    throw new StateSnapshotSemanticError(
      `${description}のstale_repositoryはstale itemの保持値以外に指定できません`,
    );
  }
  if (dependencyValue.status === "not_dependent") {
    return dependencyValue;
  }
  const producers = dependencyValue.producers;
  if (producers == null) {
    if (
      dependencyValue.status === "unknown" &&
      dependencyValue.reasons.every((reason) => {
        switch (reason) {
          case "not_recorded":
            return options.allowProducerlessNotRecorded;
          case "migration":
            return options.allowProducerlessMigration;
          case "stale_repository":
            return options.allowProducerlessStaleRepository;
          case "proof_unknown":
            return false;
          default:
            throw new UnreachableError(reason);
        }
      })
    ) {
      return dependencyValue;
    }
    if (dependencyValue.status === "unknown" && dependencyValue.reasons.includes("proof_unknown")) {
      throw new StateSnapshotSemanticError(
        `${description}のproducerless proof_unknownは許可されません`,
      );
    }
    throw new StateSnapshotSemanticError(`${description}のproducerがありません`);
  }
  const resolvedProducerDependencies = producers.map((producer) => ({
    producer,
    dependency: options.dependencyForProducer(producer, description, dependencyValue),
  }));
  const expected = combineAiAnalysisDependencies(
    resolvedProducerDependencies.map(({ dependency: resolvedDependency }) => resolvedDependency),
  );
  if (!aiAnalysisDependencyMatchesExpected(dependencyValue, expected, options)) {
    if (options.onMismatch != null) {
      throw options.onMismatch(dependencyValue, resolvedProducerDependencies, expected);
    }
    throw new StateSnapshotSemanticError(`${description}とproducerの合成結果が一致しません`);
  }
  return dependencyValue;
}

export function assertRelationCandidateProducerDefinitions(
  dependencies: readonly Readonly<{
    description: string;
    dependency: AiAnalysisDependency;
    targetNodeId?: GraphNodeId;
  }>[],
  itemsByNodeId: ReadonlyMap<string, SnapshotItemForRelationValidation>,
  relationsById: ReadonlyMap<string, Relation | LegacyRelationWithoutAiDependency>,
): void {
  const definitionsByCandidateId = new Map<string, string>();
  for (const entry of dependencies) {
    if (entry.dependency.status === "not_dependent") {
      continue;
    }
    for (const producer of entry.dependency.producers ?? []) {
      if (producer.kind !== "relation_candidate") {
        continue;
      }
      const firstEndpoint = producer.endpointNodeIds[0];
      const secondEndpoint = producer.endpointNodeIds[1];
      if (firstEndpoint === secondEndpoint || firstEndpoint > secondEndpoint) {
        throw new StateSnapshotSemanticError(
          `${entry.description}のrelation candidate endpointが正規化されていません`,
        );
      }
      if (
        !producer.endpointNodeIds.includes(producer.producer.nodeId) ||
        (entry.targetNodeId != null && !producer.endpointNodeIds.includes(entry.targetNodeId))
      ) {
        throw new StateSnapshotSemanticError(
          `${entry.description}のrelation candidate producer参照が不正です`,
        );
      }
      const producerItem = itemsByNodeId.get(producer.producer.nodeId);
      if (producerItem == null || !("applications" in producerItem.aiAnalysis)) {
        throw new StateSnapshotSemanticError(
          `${entry.description}のrelation candidate producerにAI適用元がありません`,
        );
      }
      const definition = JSON.stringify([firstEndpoint, secondEndpoint, producer.producer.nodeId]);
      const previousDefinition = definitionsByCandidateId.get(producer.candidateId);
      if (previousDefinition == null) {
        definitionsByCandidateId.set(producer.candidateId, definition);
      } else if (previousDefinition !== definition) {
        throw new StateSnapshotSemanticError(
          `${entry.description}のrelation candidate IDに異なるendpointまたはownerがあります`,
        );
      }
      const persistedRelation = relationsById.get(producer.candidateId);
      if (persistedRelation != null) {
        if (persistedRelation.provenance === "native") {
          throw new StateSnapshotSemanticError(
            `${entry.description}のrelation candidate IDがnative relationと衝突しています`,
          );
        }
        const sameEndpoints =
          (persistedRelation.fromNodeId === firstEndpoint &&
            persistedRelation.toNodeId === secondEndpoint) ||
          (persistedRelation.fromNodeId === secondEndpoint &&
            persistedRelation.toNodeId === firstEndpoint);
        if (!sameEndpoints) {
          throw new StateSnapshotSemanticError(
            `${entry.description}のrelation candidate endpointがpersisted relationと一致しません`,
          );
        }
        if ("aiDependency" in persistedRelation) {
          const persistedDependency = persistedRelation.aiDependency;
          if (persistedDependency.status === "not_dependent") {
            throw new StateSnapshotSemanticError(
              `${entry.description}のrelation candidate IDがAI非依存relationと衝突しています`,
            );
          }
          const producerlessMigration =
            persistedDependency.status === "unknown" &&
            persistedDependency.reasons.length === 1 &&
            persistedDependency.reasons[0] === "migration" &&
            persistedDependency.producers == null;
          if (producerlessMigration) {
            continue;
          }
          const persistedProducers = persistedDependency.producers;
          if (
            persistedProducers?.some(
              (persistedProducer) =>
                persistedProducer.kind === "relation" &&
                persistedProducer.relationId === producer.candidateId &&
                persistedProducer.producer.nodeId === producer.producer.nodeId,
            ) !== true
          ) {
            throw new StateSnapshotSemanticError(
              `${entry.description}のrelation candidate ownerがpersisted relationと一致しません`,
            );
          }
        }
      }
    }
  }
}

export function directAiAnalysisDependencyProducerElement(
  element: AiAnalysisDependencyElement,
): AiAnalysisElement | undefined {
  switch (element) {
    case "status":
      return "status";
    case "waitingOn":
      return "waitingOn";
    case "nextAction":
      return "nextAction";
    case "primaryWaitingOn":
    case "uncertainties":
    case "relationSet":
      return undefined;
    case "deadline":
    case "deadlineLevel":
      return "deadline";
    case "confidence":
    case "evidence":
    case "lastProgressAt":
    case "stallSince":
    case "severity":
    case "downstreamImpact":
    case "importance":
    case "attention":
    case "blockers":
      return undefined;
    default:
      throw new UnreachableError(element);
  }
}

export const BLOCKER_STATE_DEPENDENCY_ELEMENTS = Object.freeze([
  "status",
  "waitingOn",
  "primaryWaitingOn",
  "nextAction",
  "confidence",
  "evidence",
  "uncertainties",
] satisfies readonly AiAnalysisDependencyElement[]);
