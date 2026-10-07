import { z } from "zod";

import { serializeCanonicalJson } from "../canonical-json/index.js";
import { type AiCacheKey } from "../codex/cache.js";
import {
  aiAnalysisElementEvidenceSchema,
  aiAnalysisNotificationSchema,
  aiAnalysisRelationsSchema,
  createAiAnalysisMigrationElementResultSchema,
  type AiAnalysisElement,
  type AiAnalysisElementMigrationResult,
  type AiAnalysisRelation,
} from "../domain/ai-analysis-elements.js";
import {
  createGitHubNodeId,
  type TrackedItemAiAnalysisMigrationAdoptedElements,
} from "../domain/index.js";
import { UnreachableError } from "../util/index.js";
import { type LegacyAiCacheEntry } from "./ai-cache-migration.js";
import { StateSnapshotSemanticError } from "./errors.js";
import {
  legacyReuseProof,
  migratedAiAnalysisElementApplications,
  migratedTrackedItemAiDependenciesForApplications,
} from "./snapshot-migration-relations.js";
import { migratedPersonalReminderCausePlanning } from "./snapshot-migration-reminders.js";
import type {
  AdoptedLegacyRelation,
  legacyEvidenceSchema,
  LegacyOutput,
  LegacyRelation,
  LegacyTrackedItem,
  LegacyWaitingOnCandidate,
} from "./snapshot-migration-schema.js";
import { legacyIdentifiedAuthorSchema, legacyOutputSchema } from "./snapshot-migration-schema.js";

function resultEvidence(
  values: readonly z.output<typeof legacyEvidenceSchema>[],
): readonly z.output<typeof aiAnalysisElementEvidenceSchema>[] {
  const evidenceByKey = new Map<string, z.output<typeof aiAnalysisElementEvidenceSchema>>();
  for (const value of values) {
    const evidence = aiAnalysisElementEvidenceSchema.parse({
      sourceId: value.sourceId,
      summary: value.summary,
      supports: "element",
    });
    evidenceByKey.set(serializeCanonicalJson([evidence.sourceId, evidence.summary]), evidence);
  }
  return Object.freeze([...evidenceByKey.values()]);
}

function outputEvidenceForElement(
  output: LegacyOutput,
  element: AiAnalysisElement,
  fallback: readonly z.output<typeof legacyEvidenceSchema>[],
): readonly z.output<typeof aiAnalysisElementEvidenceSchema>[] {
  const supports =
    element === "status" || element === "nextAction"
      ? "status"
      : element === "waitingOn"
        ? "waiting_on"
        : element === "relations"
          ? "relation"
          : element === "notification"
            ? "notification"
            : undefined;
  const selected =
    supports == null
      ? output.evidence
      : output.evidence.filter((value) => value.supports === supports);
  if (selected.length !== 0) {
    return resultEvidence(selected);
  }
  return resultEvidence(element === "notification" ? output.evidence : fallback);
}

function createMigrationResult(
  element: AiAnalysisElement,
  value: unknown,
  evidence: readonly z.output<typeof aiAnalysisElementEvidenceSchema>[],
  confidence: number,
  uncertainties: readonly string[],
): AiAnalysisElementMigrationResult {
  if (evidence.length === 0) {
    throw new StateSnapshotSemanticError(`移行AI採用要素の根拠がありません。対象: ${element}`);
  }
  const common = {
    value,
    evidence,
    confidence,
    uncertainties,
  };
  switch (element) {
    case "status":
      return createAiAnalysisMigrationElementResultSchema("status").parse(common);
    case "waitingOn":
      return createAiAnalysisMigrationElementResultSchema("waitingOn").parse(common);
    case "nextAction":
      return createAiAnalysisMigrationElementResultSchema("nextAction").parse(common);
    case "relations":
      return createAiAnalysisMigrationElementResultSchema("relations").parse(common);
    case "progress":
      return createAiAnalysisMigrationElementResultSchema("progress").parse(common);
    case "importance":
      return createAiAnalysisMigrationElementResultSchema("importance").parse(common);
    case "deadline":
      return createAiAnalysisMigrationElementResultSchema("deadline").parse(common);
    case "notification":
      return createAiAnalysisMigrationElementResultSchema("notification").parse(common);
    case "selfCommitment":
      throw new StateSnapshotSemanticError(
        "旧snapshotのAI分析要素にselfCommitmentは指定できません",
      );
  }
}

function equalJson(left: unknown, right: unknown): boolean {
  try {
    return serializeCanonicalJson(left) === serializeCanonicalJson(right);
  } catch (error: unknown) {
    throw new StateSnapshotSemanticError("移行AI採用値を比較できません", {
      cause: error,
    });
  }
}

function waitingOnCandidateMeaningfullyEquals(
  item: LegacyTrackedItem,
  output: LegacyWaitingOnCandidate,
  adopted: LegacyWaitingOnCandidate,
): boolean {
  if (
    output.kind === adopted.kind &&
    output.candidateId === adopted.candidateId &&
    output.role === adopted.role
  ) {
    return true;
  }
  if (
    output.kind !== "user" ||
    output.role !== "author" ||
    adopted.kind !== "role" ||
    adopted.role !== "author" ||
    adopted.candidateId !== "author"
  ) {
    return false;
  }
  const authorResult = legacyIdentifiedAuthorSchema.safeParse(item["author"]);
  return authorResult.success && authorResult.data.actor.login === output.candidateId;
}

function waitingOnMeaningfullyEquals(
  item: LegacyTrackedItem,
  output: readonly LegacyWaitingOnCandidate[],
  adopted: readonly LegacyWaitingOnCandidate[],
): boolean {
  return (
    output.length === adopted.length &&
    output.every((candidate, index) => {
      const adoptedCandidate = adopted[index];
      return (
        adoptedCandidate != null &&
        waitingOnCandidateMeaningfullyEquals(item, candidate, adoptedCandidate)
      );
    })
  );
}

function relationMatchesCandidate(
  relation: LegacyRelation,
  itemNodeId: string,
  candidate: AiAnalysisRelation,
): boolean {
  if (
    !relation.active ||
    relation.provenance === "native" ||
    relation.id !== candidate.candidateId
  ) {
    return false;
  }
  switch (candidate.verdict) {
    case "current_is_blocked_by_target":
      return relation.type === "blocks" && relation.toNodeId === itemNodeId;
    case "current_blocks_target":
      return relation.type === "blocks" && relation.fromNodeId === itemNodeId;
    case "current_implements_target":
      return relation.type === "implements" && relation.fromNodeId === itemNodeId;
    case "target_is_subtask_of_current":
      return relation.type === "parent_of" && relation.fromNodeId === itemNodeId;
    case "current_is_subtask_of_target":
      return relation.type === "parent_of" && relation.toNodeId === itemNodeId;
    case "duplicates":
      return relation.type === "duplicates" && relation.fromNodeId === itemNodeId;
    case "related":
      return relation.type === "related_to" && relation.fromNodeId === itemNodeId;
    case "none":
      return false;
    default:
      throw new UnreachableError(candidate.verdict);
  }
}

function adoptedRelationCandidates(
  item: LegacyTrackedItem,
  output: LegacyOutput,
  legacyRelationsById: ReadonlyMap<string, LegacyRelation>,
): readonly AdoptedLegacyRelation[] {
  const candidates = aiAnalysisRelationsSchema.parse(output.relations);
  const adopted: AdoptedLegacyRelation[] = [];
  const adoptedIds = new Set<string>();
  for (const candidate of candidates) {
    const relation = legacyRelationsById.get(candidate.candidateId);
    if (relation == null || !relationMatchesCandidate(relation, item.nodeId, candidate)) {
      continue;
    }
    if (adoptedIds.has(candidate.candidateId)) {
      throw new StateSnapshotSemanticError(
        `移行AI採用relationsのcandidate IDが重複しています。対象: ${item.nodeId}`,
      );
    }
    adoptedIds.add(candidate.candidateId);
    adopted.push({ candidate, relation });
  }
  return Object.freeze(adopted);
}

function parseLegacyOutput(entry: LegacyAiCacheEntry, item: LegacyTrackedItem): LegacyOutput {
  if (entry.metadata.schemaVersion !== "4") {
    throw new StateSnapshotSemanticError(
      `参照したAI cacheのschema versionがv4ではありません。対象: ${item.nodeId}`,
    );
  }
  const output = legacyOutputSchema.parse(entry.output);
  if (output.item.nodeId !== item.nodeId || output.item.url !== item.url) {
    throw new StateSnapshotSemanticError(
      `参照したAI cacheの項目識別子がsnapshotと一致しません。対象: ${item.nodeId}`,
    );
  }
  return output;
}

function effectiveStateConfidence(output: LegacyOutput): number {
  return output.waitingOn.reduce(
    (confidence, waitingOn) => Math.min(confidence, waitingOn.confidence),
    output.confidence,
  );
}

function createAssessmentResult(
  item: LegacyTrackedItem,
  output: LegacyOutput | undefined,
  element: "importance",
): AiAnalysisElementMigrationResult<"importance"> | undefined;
function createAssessmentResult(
  item: LegacyTrackedItem,
  output: LegacyOutput | undefined,
  element: "deadline",
): AiAnalysisElementMigrationResult<"deadline"> | undefined;
function createAssessmentResult(
  item: LegacyTrackedItem,
  output: LegacyOutput | undefined,
  element: "importance" | "deadline",
): AiAnalysisElementMigrationResult | undefined {
  const assessment = item[`${element}Assessment`];
  if (assessment.status !== "available") {
    return undefined;
  }
  const fallbackEvidence = resultEvidence(item.evidence);
  if (fallbackEvidence.length === 0) {
    return undefined;
  }
  const value = assessment.value;
  const outputValue = output?.[element];
  const matchedOutput = output != null && equalJson(outputValue, value) ? output : undefined;
  const result = createMigrationResult(
    element,
    value,
    matchedOutput == null
      ? fallbackEvidence
      : outputEvidenceForElement(matchedOutput, element, item.evidence),
    matchedOutput?.confidence ?? item.confidence,
    matchedOutput?.uncertainties ?? [],
  );
  return createAiAnalysisMigrationElementResultSchema(element).parse(result);
}

function createLegacyAdoptedElements(
  item: LegacyTrackedItem,
  output: LegacyOutput | undefined,
  legacyRelationsById: ReadonlyMap<string, LegacyRelation>,
): TrackedItemAiAnalysisMigrationAdoptedElements {
  let adopted: TrackedItemAiAnalysisMigrationAdoptedElements = Object.freeze({});
  const importance = createAssessmentResult(item, output, "importance");
  if (importance != null) {
    adopted = Object.freeze({
      ...adopted,
      importance: Object.freeze({
        origin: "migration",
        result: importance,
        reuseProof: legacyReuseProof(),
      }),
    });
  }
  const deadline = createAssessmentResult(item, output, "deadline");
  if (deadline != null) {
    adopted = Object.freeze({
      ...adopted,
      deadline: Object.freeze({
        origin: "migration",
        result: deadline,
        reuseProof: legacyReuseProof(),
      }),
    });
  }
  if (output == null) {
    return Object.freeze(adopted);
  }
  const statusMatched = equalJson(output.status, item.status);
  const waitingOnMatched = waitingOnMeaningfullyEquals(item, output.waitingOn, item.waitingOn);
  if (statusMatched) {
    adopted = Object.freeze({
      ...adopted,
      status: Object.freeze({
        origin: "migration",
        result: createAiAnalysisMigrationElementResultSchema("status").parse(
          createMigrationResult(
            "status",
            item.status,
            outputEvidenceForElement(output, "status", item.evidence),
            output.confidence,
            output.uncertainties,
          ),
        ),
        reuseProof: legacyReuseProof(),
      }),
    });
  }
  if (waitingOnMatched) {
    adopted = Object.freeze({
      ...adopted,
      waitingOn: Object.freeze({
        origin: "migration",
        result: createAiAnalysisMigrationElementResultSchema("waitingOn").parse(
          createMigrationResult(
            "waitingOn",
            item.waitingOn,
            outputEvidenceForElement(output, "waitingOn", item.evidence),
            output.confidence,
            output.uncertainties,
          ),
        ),
        reuseProof: legacyReuseProof(),
      }),
    });
  }
  if (statusMatched && waitingOnMatched) {
    adopted = Object.freeze({
      ...adopted,
      nextAction: Object.freeze({
        origin: "migration",
        result: createAiAnalysisMigrationElementResultSchema("nextAction").parse(
          createMigrationResult(
            "nextAction",
            item.nextAction,
            outputEvidenceForElement(output, "nextAction", item.evidence),
            output.confidence,
            output.uncertainties,
          ),
        ),
        reuseProof: legacyReuseProof(),
      }),
    });
  }
  const adoptedRelations = adoptedRelationCandidates(item, output, legacyRelationsById);
  if (adoptedRelations.length > 0) {
    adopted = Object.freeze({
      ...adopted,
      relations: Object.freeze({
        origin: "migration",
        result: createAiAnalysisMigrationElementResultSchema("relations").parse(
          createMigrationResult(
            "relations",
            adoptedRelations.map(({ candidate }) => candidate),
            resultEvidence(adoptedRelations.flatMap(({ relation }) => relation.evidence)),
            output.confidence,
            output.uncertainties,
          ),
        ),
        reuseProof: legacyReuseProof(),
      }),
    });
  }
  if (item.severityContext.decisionBasis === "ai_only") {
    const notification = aiAnalysisNotificationSchema.parse(output.notification);
    adopted = Object.freeze({
      ...adopted,
      notification: Object.freeze({
        origin: "migration",
        result: createAiAnalysisMigrationElementResultSchema("notification").parse(
          createMigrationResult(
            "notification",
            notification,
            outputEvidenceForElement(output, "notification", item.evidence),
            effectiveStateConfidence(output),
            output.uncertainties,
          ),
        ),
        reuseProof: legacyReuseProof(),
      }),
    });
  }
  return Object.freeze(adopted);
}

export function migrateTrackedItem(
  item: LegacyTrackedItem,
  legacyEntriesByCacheKey: ReadonlyMap<AiCacheKey, LegacyAiCacheEntry>,
  legacyRelationsById: ReadonlyMap<string, LegacyRelation>,
): Record<string, unknown> {
  let output: LegacyOutput | undefined;
  if (item.aiAnalysis.status === "used") {
    const cacheEntry = legacyEntriesByCacheKey.get(item.aiAnalysis.cacheKey);
    if (cacheEntry == null) {
      throw new StateSnapshotSemanticError(
        `AI分析がusedなのに参照cacheがありません。対象: ${item.nodeId}`,
      );
    }
    output = parseLegacyOutput(cacheEntry, item);
  }
  const applications = migratedAiAnalysisElementApplications();
  return {
    ...item,
    aiAnalysis: {
      origin: "migration",
      status: item.aiAnalysis.status,
      elements: {},
      adoptedElements: createLegacyAdoptedElements(item, output, legacyRelationsById),
      applications,
    },
    aiDependencies: migratedTrackedItemAiDependenciesForApplications(
      createGitHubNodeId(item.nodeId),
      applications,
    ),
    personalReminderCauses: [],
    personalReminderCausePlanning: migratedPersonalReminderCausePlanning(item.status),
  };
}
