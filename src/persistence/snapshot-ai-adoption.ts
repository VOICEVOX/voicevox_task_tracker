import { z } from "zod";

import { hashCanonicalJson } from "../canonical-json/index.js";
import {
  AI_ANALYSIS_ELEMENT_INPUT_PROJECTION_VERSIONS,
  AI_ANALYSIS_ELEMENT_REVISIONS,
} from "../codex/generic-ai-definition.js";
import {
  aiAnalysisDependencyForApplication,
  aiAnalysisDependencyForMissingRelationCandidateAssessment,
  aiAnalysisDependencyForRelationCandidate,
} from "../domain/ai-analysis-dependencies.js";
import {
  AI_ANALYSIS_ELEMENTS,
  aiAnalysisElementApplicationsSchema,
  aiAnalysisElementApplicationUsesAiValue,
  aiAnalysisElementReuseProofSchema,
  aiAnalysisElementSchema,
  createAiAnalysisMigrationElementResultSchema,
} from "../domain/ai-analysis-elements.js";
import {
  type AiAnalysisDependency,
  type AiAnalysisDependencyProducer,
  type Relation,
  type TrackedItemAiAnalysis,
} from "../domain/index.js";
import { UnreachableError } from "../util/index.js";
import { StateSnapshotSemanticError } from "./errors.js";
import type {
  LegacyRelationWithoutAiDependency,
  LegacyTrackedItemAiAnalysis,
  SnapshotItemForRelationValidation,
  SnapshotTrackedItem,
} from "./snapshot-contracts.js";
import type { ElementSchemaVersion } from "./snapshot-schema.js";
import {
  createElementGenerationSchemaForVersion,
  createMigrationElementResultSchemaForVersion,
} from "./snapshot-schema.js";
import { assertUtcDateTime } from "./snapshot-values.js";

const LEGACY_AI_ANALYSIS_ELEMENT_REVISIONS = Object.freeze({
  status: 1,
  waitingOn: 3,
  nextAction: 1,
  relations: 2,
  progress: 1,
  importance: 1,
  deadline: 1,
  notification: 1,
  selfCommitment: 1,
} satisfies Readonly<Record<(typeof AI_ANALYSIS_ELEMENTS)[number], number>>);

function assertGenerationBackedReuseProofSemantics(
  proof: z.output<typeof aiAnalysisElementReuseProofSchema>,
  generation: Readonly<{
    metadata: Readonly<{
      revision: number;
      inputFingerprint: string;
    }>;
    result: unknown;
  }>,
  result: unknown,
  description: string,
): void {
  if (proof.status === "unknown" || proof.source === "deterministic_update") {
    return;
  }
  if (
    proof.revision !== generation.metadata.revision ||
    proof.inputFingerprint !== generation.metadata.inputFingerprint ||
    hashCanonicalJson(result) !== hashCanonicalJson(generation.result)
  ) {
    throw new StateSnapshotSemanticError(`${description}が生成記録と一致しません`);
  }
}

export function assertAiAnalysisElementMapSemantics(
  elements: unknown,
  description: string,
  elementSchemaVersion: ElementSchemaVersion,
  elementsFormat: "legacy" | "current",
): void {
  const parsedElements = z.record(z.string(), z.unknown()).safeParse(elements);
  if (!parsedElements.success) {
    throw new StateSnapshotSemanticError(`${description}が不正です`, {
      cause: parsedElements.error,
    });
  }
  for (const [key, value] of Object.entries(parsedElements.data)) {
    const elementResult = aiAnalysisElementSchema.safeParse(key);
    if (!elementResult.success) {
      throw new StateSnapshotSemanticError(`${description}が不正です。対象: ${key}`, {
        cause: elementResult.error,
      });
    }
    const evaluatedElement =
      elementsFormat === "current"
        ? z
            .strictObject({
              generation: z.unknown(),
              result: z.unknown(),
              evaluationProof: aiAnalysisElementReuseProofSchema,
            })
            .safeParse(value)
        : { success: true as const, data: { generation: value } };
    if (!evaluatedElement.success) {
      throw new StateSnapshotSemanticError(`${description}の評価記録が不正です。対象: ${key}`, {
        cause: evaluatedElement.error,
      });
    }
    const generationResult = createElementGenerationSchemaForVersion(
      elementResult.data,
      elementSchemaVersion,
    ).safeParse(evaluatedElement.data.generation);
    if (!generationResult.success) {
      throw new StateSnapshotSemanticError(`${description}の生成記録が不正です。対象: ${key}`, {
        cause: generationResult.error,
      });
    }
    assertUtcDateTime(
      generationResult.data.metadata.generatedAt,
      `${description}の生成時刻。対象: ${key}`,
    );
    if (
      hashCanonicalJson(generationResult.data.result) !== generationResult.data.metadata.outputHash
    ) {
      throw new StateSnapshotSemanticError(`${description}の出力hashが一致しません。対象: ${key}`);
    }
    if ("result" in evaluatedElement.data) {
      const resultResult = createAiAnalysisMigrationElementResultSchema(
        elementResult.data,
      ).safeParse(evaluatedElement.data.result);
      if (!resultResult.success) {
        throw new StateSnapshotSemanticError(`${description}の評価結果が不正です。対象: ${key}`, {
          cause: resultResult.error,
        });
      }
      assertGenerationBackedReuseProofSemantics(
        evaluatedElement.data.evaluationProof,
        generationResult.data,
        resultResult.data,
        `${description}の評価証明。対象: ${key}`,
      );
    }
  }
}

export function assertAiAnalysisMigrationAdoptedMapSemantics(
  elements: unknown,
  description: string,
  elementSchemaVersion: ElementSchemaVersion,
  requireReuseProof: boolean,
): void {
  const parsedElements = z.record(z.string(), z.unknown()).safeParse(elements);
  if (!parsedElements.success) {
    throw new StateSnapshotSemanticError(`${description}が不正です`, {
      cause: parsedElements.error,
    });
  }
  const adoptedElementShape = z.discriminatedUnion("origin", [
    z.strictObject({
      origin: z.literal("current"),
      generation: z.unknown(),
      result: requireReuseProof ? z.unknown() : z.unknown().optional(),
      reuseProof: requireReuseProof ? z.unknown() : z.unknown().optional(),
    }),
    z.strictObject({
      origin: z.literal("migration"),
      result: z.unknown(),
      reuseProof: requireReuseProof ? z.unknown() : z.unknown().optional(),
    }),
  ]);
  for (const key of Object.keys(parsedElements.data)) {
    const elementResult = aiAnalysisElementSchema.safeParse(key);
    if (!elementResult.success) {
      throw new StateSnapshotSemanticError(`${description}が不正です。対象: ${key}`, {
        cause: elementResult.error,
      });
    }
    const adoptedResult = adoptedElementShape.safeParse(parsedElements.data[key]);
    if (!adoptedResult.success) {
      throw new StateSnapshotSemanticError(`${description}が不正です。対象: ${key}`, {
        cause: adoptedResult.error,
      });
    }
    const adopted = adoptedResult.data;
    const reuseProof = adopted.reuseProof;
    const parsedReuseProof = aiAnalysisElementReuseProofSchema.safeParse(reuseProof);
    if (requireReuseProof) {
      if (!parsedReuseProof.success) {
        throw new StateSnapshotSemanticError(`${description}の再利用証明が不正です。対象: ${key}`, {
          cause: parsedReuseProof.error,
        });
      }
    }
    switch (adopted.origin) {
      case "current": {
        const generationSchema = createElementGenerationSchemaForVersion(
          elementResult.data,
          elementSchemaVersion,
        );
        const parsedGeneration = generationSchema.safeParse(adopted.generation);
        if (!parsedGeneration.success) {
          throw new StateSnapshotSemanticError(`${description}が不正です。対象: ${key}`, {
            cause: parsedGeneration.error,
          });
        }
        if (requireReuseProof) {
          const parsedResult = createMigrationElementResultSchemaForVersion(
            elementResult.data,
            elementSchemaVersion,
          ).safeParse(adopted.result);
          if (!parsedResult.success) {
            throw new StateSnapshotSemanticError(`${description}が不正です。対象: ${key}`, {
              cause: parsedResult.error,
            });
          }
          if (!parsedReuseProof.success) {
            throw new StateSnapshotSemanticError(
              `${description}の再利用証明が不正です。対象: ${key}`,
              { cause: parsedReuseProof.error },
            );
          }
          assertGenerationBackedReuseProofSemantics(
            parsedReuseProof.data,
            parsedGeneration.data,
            parsedResult.data,
            `${description}の再利用証明。対象: ${key}`,
          );
        }
        assertUtcDateTime(
          parsedGeneration.data.metadata.generatedAt,
          `${description}の生成時刻。対象: ${key}`,
        );
        if (
          hashCanonicalJson(parsedGeneration.data.result) !==
          parsedGeneration.data.metadata.outputHash
        ) {
          throw new StateSnapshotSemanticError(
            `${description}の出力hashが一致しません。対象: ${key}`,
          );
        }
        continue;
      }
      case "migration": {
        const resultSchema = createMigrationElementResultSchemaForVersion(
          elementResult.data,
          elementSchemaVersion,
        );
        const parsedResult = resultSchema.safeParse(adopted.result);
        if (!parsedResult.success) {
          throw new StateSnapshotSemanticError(`${description}が不正です。対象: ${key}`, {
            cause: parsedResult.error,
          });
        }
        continue;
      }
      default:
        throw new StateSnapshotSemanticError(`${description}の生成元が不正です。対象: ${key}`);
    }
  }
}

export function assertAiAnalysisCurrentAdoptedMapSemantics(
  elements: unknown,
  description: string,
  elementSchemaVersion: ElementSchemaVersion,
): void {
  const parsedElements = z.record(z.string(), z.unknown()).safeParse(elements);
  if (!parsedElements.success) {
    throw new StateSnapshotSemanticError(`${description}が不正です`, {
      cause: parsedElements.error,
    });
  }
  const adoptedElementShape = z.strictObject({
    origin: z.literal("current"),
    generation: z.unknown(),
    result: z.unknown(),
    reuseProof: aiAnalysisElementReuseProofSchema,
  });
  for (const [key, value] of Object.entries(parsedElements.data)) {
    const elementResult = aiAnalysisElementSchema.safeParse(key);
    if (!elementResult.success) {
      throw new StateSnapshotSemanticError(`${description}が不正です。対象: ${key}`, {
        cause: elementResult.error,
      });
    }
    const adoptedResult = adoptedElementShape.safeParse(value);
    if (!adoptedResult.success) {
      throw new StateSnapshotSemanticError(`${description}が不正です。対象: ${key}`, {
        cause: adoptedResult.error,
      });
    }
    const generationResult = createElementGenerationSchemaForVersion(
      elementResult.data,
      elementSchemaVersion,
    ).safeParse(adoptedResult.data.generation);
    if (!generationResult.success) {
      throw new StateSnapshotSemanticError(`${description}が不正です。対象: ${key}`, {
        cause: generationResult.error,
      });
    }
    const resultResult = createAiAnalysisMigrationElementResultSchema(elementResult.data).safeParse(
      adoptedResult.data.result,
    );
    if (!resultResult.success) {
      throw new StateSnapshotSemanticError(`${description}が不正です。対象: ${key}`, {
        cause: resultResult.error,
      });
    }
    assertUtcDateTime(
      generationResult.data.metadata.generatedAt,
      `${description}の生成時刻。対象: ${key}`,
    );
    if (
      hashCanonicalJson(generationResult.data.result) !== generationResult.data.metadata.outputHash
    ) {
      throw new StateSnapshotSemanticError(`${description}の出力hashが一致しません。対象: ${key}`);
    }
    assertGenerationBackedReuseProofSemantics(
      adoptedResult.data.reuseProof,
      generationResult.data,
      resultResult.data,
      `${description}の再利用証明。対象: ${key}`,
    );
  }
}

export function assertAiAnalysisElementApplicationsSemantics(
  applications: unknown,
  description: string,
): TrackedItemAiAnalysis["applications"] {
  const parsedApplications = aiAnalysisElementApplicationsSchema.safeParse(applications);
  if (!parsedApplications.success) {
    throw new StateSnapshotSemanticError(`${description}が不正です`, {
      cause: parsedApplications.error,
    });
  }
  return parsedApplications.data;
}

export function assertAiAnalysisApplicationsMatchStoredElements(
  aiAnalysis: TrackedItemAiAnalysis | LegacyTrackedItemAiAnalysis,
  applications: TrackedItemAiAnalysis["applications"],
  allowNotRecordedApplicationWithoutAdopted: boolean,
): void {
  for (const element of AI_ANALYSIS_ELEMENTS) {
    const application = applications[element];
    const evaluated = aiAnalysis.elements[element];
    const adopted = aiAnalysis.adoptedElements[element];
    switch (application.status) {
      case "current_ai": {
        if (adopted?.origin !== "current") {
          throw new StateSnapshotSemanticError(
            `current_aiの${element}に現行形式の採用結果がありません`,
          );
        }
        if (adopted.reuseProof.status !== "verified") {
          throw new StateSnapshotSemanticError(
            `current_aiの${element}に検証済みの再利用証明がありません`,
          );
        }
        const currentRevision = AI_ANALYSIS_ELEMENT_REVISIONS[element];
        const currentProof =
          adopted.reuseProof.revision === currentRevision &&
          adopted.reuseProof.inputProjectionVersion ===
            AI_ANALYSIS_ELEMENT_INPUT_PROJECTION_VERSIONS[element];
        const legacyProof =
          adopted.reuseProof.inputProjectionVersion === 1 &&
          (adopted.reuseProof.revision === currentRevision ||
            adopted.reuseProof.revision === LEGACY_AI_ANALYSIS_ELEMENT_REVISIONS[element]);
        if (!currentProof && !legacyProof) {
          throw new StateSnapshotSemanticError(
            `current_aiの${element}の再利用証明が現在の要素規則と一致しません`,
          );
        }
        if (application.origin === "verified_reuse") {
          if (
            (adopted.reuseProof.source === "current_generation" ||
              adopted.reuseProof.source === "structural_migration") &&
            (adopted.reuseProof.revision !== adopted.generation.metadata.revision ||
              adopted.reuseProof.inputFingerprint !==
                adopted.generation.metadata.inputFingerprint ||
              hashCanonicalJson(adopted.result) !== hashCanonicalJson(adopted.generation.result))
          ) {
            throw new StateSnapshotSemanticError(
              `verified_reuseの${element}が生成結果と一致しません`,
            );
          }
          break;
        }
        if (evaluated == null) {
          throw new StateSnapshotSemanticError(
            `実行結果を使うcurrent_aiの${element}に現行の生成記録がありません`,
          );
        }
        if (
          hashCanonicalJson(evaluated.generation) !== hashCanonicalJson(adopted.generation) ||
          adopted.reuseProof.source !== "current_generation" ||
          adopted.reuseProof.revision !== adopted.generation.metadata.revision ||
          adopted.reuseProof.inputFingerprint !== adopted.generation.metadata.inputFingerprint ||
          hashCanonicalJson(adopted.result) !== hashCanonicalJson(adopted.generation.result)
        ) {
          throw new StateSnapshotSemanticError(
            `実行結果を使うcurrent_aiの${element}が生成結果と一致しません`,
          );
        }
        break;
      }
      case "retained_ai":
        if (adopted?.origin !== "current") {
          throw new StateSnapshotSemanticError(
            `retained_aiの${element}に現行形式の採用結果がありません`,
          );
        }
        if (application.reason === "failed" && aiAnalysis.status !== "failed") {
          throw new StateSnapshotSemanticError(`retained_aiの${element}の失敗理由が不整合です`);
        }
        if (application.reason === "deferred" && aiAnalysis.status !== "deferred") {
          throw new StateSnapshotSemanticError(`retained_aiの${element}の延期理由が不整合です`);
        }
        if (application.reason === "current_evaluation_not_adopted" && evaluated == null) {
          throw new StateSnapshotSemanticError(
            `retained_aiの${element}に不採用の現行評価記録がありません`,
          );
        }
        break;
      case "unavailable":
        if (application.reason === "failed" && aiAnalysis.status !== "failed") {
          throw new StateSnapshotSemanticError(`unavailableの${element}の失敗理由が不整合です`);
        }
        if (application.reason === "deferred" && aiAnalysis.status !== "deferred") {
          throw new StateSnapshotSemanticError(`unavailableの${element}の延期理由が不整合です`);
        }
        if (application.reason === "current_evaluation_not_adopted" && evaluated == null) {
          throw new StateSnapshotSemanticError(
            `unavailableの${element}に不採用の現行評価記録がありません`,
          );
        }
        break;
      case "unknown":
        if (
          application.reason === "migration" ||
          (application.reason === "not_recorded" &&
            aiAnalysis.status === "not_recorded" &&
            allowNotRecordedApplicationWithoutAdopted)
        ) {
          break;
        }
        if (adopted == null) {
          throw new StateSnapshotSemanticError(
            `適用元不明の${element}に対応する採用結果がありません`,
          );
        }
        break;
      case "not_required":
      case "deterministic_fallback":
      case "disabled":
        break;
      default:
        throw new UnreachableError(application);
    }
  }
}

export function assertAiAnalysisApplicationsMatchTrackedItemValues(
  item: SnapshotTrackedItem,
): void {
  if (!("applications" in item.aiAnalysis)) {
    throw new StateSnapshotSemanticError("itemのAI適用元がありません");
  }
  const values = Object.freeze({
    status: item.status,
    waitingOn: item.waitingOn,
    nextAction: item.nextAction,
  });
  const stateElements: readonly ("status" | "waitingOn" | "nextAction")[] = [
    "status",
    "waitingOn",
    "nextAction",
  ];
  for (const element of stateElements) {
    const application = item.aiAnalysis.applications[element];
    if (application.status === "unknown" && application.reason === "migration") {
      continue;
    }
    if (!aiAnalysisElementApplicationUsesAiValue(application)) {
      continue;
    }
    const adopted = item.aiAnalysis.adoptedElements[element];
    if (adopted == null) {
      throw new StateSnapshotSemanticError(`AI値を使う${element}に対応する採用結果がありません`);
    }
    if (hashCanonicalJson(adopted.result.value) !== hashCanonicalJson(values[element])) {
      throw new StateSnapshotSemanticError(`AI値を使う${element}がitemの表示値と一致しません`);
    }
  }
}

export function expectedAiAnalysisDependencyForProducer(
  producer: AiAnalysisDependencyProducer,
  description: string,
  itemsByNodeId: ReadonlyMap<string, SnapshotItemForRelationValidation>,
  relationsById: ReadonlyMap<string, Relation | LegacyRelationWithoutAiDependency>,
  containingDependency: AiAnalysisDependency,
): AiAnalysisDependency {
  if (producer.kind === "item_element") {
    const producerItem = itemsByNodeId.get(producer.nodeId);
    if (producerItem == null || !("applications" in producerItem.aiAnalysis)) {
      throw new StateSnapshotSemanticError(`${description}のitem producerにAI適用元がありません`);
    }
    return aiAnalysisDependencyForApplication(
      producerItem.nodeId,
      producer.element,
      producerItem.aiAnalysis.applications[producer.element],
    );
  }
  if (producer.kind === "relation_candidate") {
    const producerItem = itemsByNodeId.get(producer.producer.nodeId);
    if (producerItem == null || !("applications" in producerItem.aiAnalysis)) {
      throw new StateSnapshotSemanticError(
        `${description}のrelation candidate producerにAI適用元がありません`,
      );
    }
    if (!producer.endpointNodeIds.includes(producer.producer.nodeId)) {
      throw new StateSnapshotSemanticError(
        `${description}のrelation candidate producer nodeがendpointと一致しません`,
      );
    }
    const application = producerItem.aiAnalysis.applications.relations;
    let expected = aiAnalysisDependencyForApplication(
      producerItem.nodeId,
      "relations",
      application,
    );
    if (
      containingDependency.status === "unknown" &&
      containingDependency.reasons.includes("proof_unknown")
    ) {
      expected = aiAnalysisDependencyForMissingRelationCandidateAssessment(
        producerItem.nodeId,
        application,
      );
    }
    if (expected.status === "not_dependent") {
      throw new StateSnapshotSemanticError(
        `${description}のrelation candidate producerにAI依存がありません`,
      );
    }
    return aiAnalysisDependencyForRelationCandidate(
      producer.candidateId,
      producer.endpointNodeIds,
      expected,
    );
  }
  const relation = relationsById.get(producer.relationId);
  if (relation == null || !("aiDependency" in relation)) {
    throw new StateSnapshotSemanticError(`${description}のrelation producerが存在しません`);
  }
  if (producer.producer.element !== "relations") {
    throw new StateSnapshotSemanticError(
      `${description}のrelation producer elementがrelationsではありません`,
    );
  }
  if (
    producer.producer.nodeId !== relation.fromNodeId &&
    producer.producer.nodeId !== relation.toNodeId
  ) {
    throw new StateSnapshotSemanticError(
      `${description}のrelation producer nodeがrelation endpointと一致しません`,
    );
  }
  if (relation.aiDependency.status === "not_dependent") {
    throw new StateSnapshotSemanticError(
      `${description}のrelation producerに対応するAI依存がありません`,
    );
  }
  const relationProducers = relation.aiDependency.producers;
  if (relationProducers == null) {
    throw new StateSnapshotSemanticError(
      `${description}のrelation producerに対応するAI依存がありません`,
    );
  }
  const matchesRelationProducer = relationProducers.some(
    (relationProducer) =>
      relationProducer.kind === "relation" &&
      relationProducer.relationId === producer.relationId &&
      relationProducer.producer.nodeId === producer.producer.nodeId &&
      relationProducer.producer.element === producer.producer.element,
  );
  if (!matchesRelationProducer) {
    throw new StateSnapshotSemanticError(
      `${description}のrelation producerがrelationのAI依存と一致しません`,
    );
  }
  return relation.aiDependency;
}
