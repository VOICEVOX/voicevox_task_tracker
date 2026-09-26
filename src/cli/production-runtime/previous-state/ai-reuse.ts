import {
  AI_ANALYSIS_ELEMENT_INPUT_PROJECTION_VERSIONS,
  AI_ANALYSIS_ELEMENT_REVISIONS,
  determineAnalysisElementReuse,
  type AnalysisElementReuseRecord,
} from "../../../codex/index.js";
import {
  isStateAnalysisElement,
  verifiedReuseProof,
  type AnalysisElementDependencyFingerprintMap,
  type AnalysisElementInputFingerprintMap,
} from "../../../codex/analysis-element-dependencies.js";
import {
  AI_ANALYSIS_ELEMENTS,
  aiAnalysisElementReuseProofSchema,
  createAiAnalysisMigrationElementResultSchema,
  type AiAnalysisElement,
  type AiAnalysisElementInputFingerprint,
  type AiAnalysisElementMigrationResult,
  type AiAnalysisElementReuseProof,
} from "../../../domain/ai-analysis-elements.js";
import {
  createAiAnalysisElementSourceGenerationSchema,
  type AiAnalysisElementSourceGeneration,
} from "../../../domain/ai-analysis-source-generations.js";
import type { GitHubNodeId } from "../../../domain/index.js";
import type { DeterministicItemAnalysis } from "../../initial-item-analysis.js";
import { elementDependencyFingerprints } from "../analysis-identity.js";
import type { RuntimeState } from "../contracts.js";
import {
  currentAdoptedResultForElement,
  savedCurrentAdoptedElementsForItem,
  savedMigrationAdoptedElementsForItem,
} from "./saved-ai-elements.js";
import { previousTrackedItem } from "./snapshot.js";

export function savedEvaluationRecordsForItem(
  state: RuntimeState,
  nodeId: GitHubNodeId,
  inputFingerprints: AnalysisElementInputFingerprintMap,
  dependencyFingerprints: AnalysisElementDependencyFingerprintMap,
): Readonly<Partial<Record<AiAnalysisElement, AnalysisElementReuseRecord>>> {
  const records: Partial<Record<AiAnalysisElement, AnalysisElementReuseRecord>> = {};
  const item = previousTrackedItem(state, nodeId);
  if (item == null) {
    return Object.freeze(records);
  }
  for (const element of AI_ANALYSIS_ELEMENTS) {
    const evaluated = item.aiAnalysis.elements[element];
    if (evaluated == null) {
      continue;
    }
    const result = createAiAnalysisMigrationElementResultSchema(element).parse(evaluated.result);
    const proof = aiAnalysisElementReuseProofSchema.parse(evaluated.evaluationProof);
    let normalizedProof = proof;
    if (proof.status === "verified") {
      normalizedProof = proof;
    } else if (proof.reason !== "legacy_migration") {
      normalizedProof = proof;
    } else {
      const generation = createAiAnalysisElementSourceGenerationSchema(element).parse(
        evaluated.generation,
      );
      if (
        generation.metadata.revision === AI_ANALYSIS_ELEMENT_REVISIONS[element] &&
        generation.metadata.inputFingerprint === inputFingerprints[element]
      ) {
        normalizedProof = isStateAnalysisElement(element)
          ? unknownReuseProof("dependency_input_unavailable")
          : verifiedReuseProof(
              element,
              inputFingerprints[element],
              dependencyFingerprints[element],
              "structural_migration",
              ["legacy_evaluation_generation_input_match"],
            );
      }
    }
    records[element] = Object.freeze({ result, proof: normalizedProof });
  }
  return Object.freeze(records);
}

export function savedAdoptionRecordsForItem(
  state: RuntimeState,
  nodeId: GitHubNodeId,
  inputFingerprints: AnalysisElementInputFingerprintMap,
  dependencyFingerprints: AnalysisElementDependencyFingerprintMap,
): Readonly<Partial<Record<AiAnalysisElement, AnalysisElementReuseRecord>>> {
  const records: Partial<Record<AiAnalysisElement, AnalysisElementReuseRecord>> = {};
  const item = previousTrackedItem(state, nodeId);
  if (item == null) {
    return Object.freeze(records);
  }
  for (const element of AI_ANALYSIS_ELEMENTS) {
    const adopted = item.aiAnalysis.adoptedElements[element];
    if (adopted == null) {
      continue;
    }
    const result = createAiAnalysisMigrationElementResultSchema(element).parse(adopted.result);
    const proof = aiAnalysisElementReuseProofSchema.parse(adopted.reuseProof);
    let normalizedProof = proof;
    if (proof.status === "verified") {
      normalizedProof = proof;
    } else if (adopted.origin !== "current" || proof.reason !== "legacy_migration") {
      normalizedProof = proof;
    } else {
      const generation = createAiAnalysisElementSourceGenerationSchema(element).parse(
        adopted.generation,
      );
      if (
        generation.metadata.revision === AI_ANALYSIS_ELEMENT_REVISIONS[element] &&
        generation.metadata.inputFingerprint === inputFingerprints[element]
      ) {
        normalizedProof = isStateAnalysisElement(element)
          ? unknownReuseProof("dependency_input_unavailable")
          : verifiedReuseProof(
              element,
              inputFingerprints[element],
              dependencyFingerprints[element],
              "structural_migration",
              ["legacy_current_generation_input_match"],
            );
      }
    }
    records[element] = Object.freeze({ result, proof: normalizedProof });
  }
  return Object.freeze(records);
}

export function unknownReuseProof(
  reason:
    | "legacy_migration"
    | "source_input_unavailable"
    | "source_contract_unavailable"
    | "dependency_input_unavailable"
    | "compatibility_route_missing"
    | "semantic_impact_unknown",
): AiAnalysisElementReuseProof {
  return aiAnalysisElementReuseProofSchema.parse({
    status: "unknown",
    reuseSchemaVersion: "1",
    reason,
  });
}

export function currentAdoptedGenerationForElement(
  state: RuntimeState,
  analysis: DeterministicItemAnalysis,
  element: AiAnalysisElement,
  inputFingerprint: AiAnalysisElementInputFingerprint,
  savedRecord: AnalysisElementReuseRecord | undefined,
): AiAnalysisElementSourceGeneration | undefined {
  const adopted = savedCurrentAdoptedElementsForItem(state, analysis.item.nodeId)[element];
  if (adopted == null) {
    return undefined;
  }
  const dependencyFingerprint = elementDependencyFingerprints(state, analysis)[element];
  if (
    determineAnalysisElementReuse({
      element,
      inputFingerprint,
      inputProjectionVersion: AI_ANALYSIS_ELEMENT_INPUT_PROJECTION_VERSIONS[element],
      dependencyFingerprint,
      savedProof: savedRecord?.proof ?? adopted.reuseProof,
    }) !== "verified"
  ) {
    return undefined;
  }
  const parsedGeneration = createAiAnalysisElementSourceGenerationSchema(element).parse(
    adopted.generation,
  );
  return parsedGeneration;
}

export function verifiedCurrentAdoptedResultForElement(
  state: RuntimeState,
  analysis: DeterministicItemAnalysis,
  element: AiAnalysisElement,
  inputFingerprint: AiAnalysisElementInputFingerprint,
  savedRecord: AnalysisElementReuseRecord | undefined,
): AiAnalysisElementMigrationResult | undefined {
  if (
    currentAdoptedGenerationForElement(state, analysis, element, inputFingerprint, savedRecord) ==
    null
  ) {
    return undefined;
  }
  return currentAdoptedResultForElement(state, analysis, element);
}

export function verifiedMigrationAdoptedResultForElement(
  state: RuntimeState,
  analysis: DeterministicItemAnalysis,
  element: AiAnalysisElement,
  inputFingerprint: AiAnalysisElementInputFingerprint,
  savedRecord: AnalysisElementReuseRecord | undefined,
): AiAnalysisElementMigrationResult | undefined {
  const adopted = savedMigrationAdoptedElementsForItem(state, analysis.item.nodeId)[element];
  if (adopted == null) {
    return undefined;
  }
  const dependencyFingerprint = elementDependencyFingerprints(state, analysis)[element];
  if (
    determineAnalysisElementReuse({
      element,
      inputFingerprint,
      inputProjectionVersion: AI_ANALYSIS_ELEMENT_INPUT_PROJECTION_VERSIONS[element],
      dependencyFingerprint,
      savedProof: savedRecord?.proof ?? adopted.reuseProof,
    }) !== "verified"
  ) {
    return undefined;
  }
  if (adopted.origin === "current") {
    return createAiAnalysisMigrationElementResultSchema(element).parse(adopted.result);
  }
  return createAiAnalysisMigrationElementResultSchema(element).parse(adopted.result);
}
