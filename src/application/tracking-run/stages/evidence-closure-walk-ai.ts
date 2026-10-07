import {
  AI_ANALYSIS_ELEMENTS,
  createAiAnalysisMigrationElementResultSchema,
  type AiAnalysisElement,
  type AiAnalysisElementResult,
  type AiAnalysisElementMigrationResult,
} from "../../../domain/ai-analysis-elements.js";
import type { GitHubNodeId } from "../../../domain/types.js";
import type { TrackedItemAiAnalysis } from "../../../domain/tracked-item-ai-analysis.js";
import type { GenericAiItemAdoption } from "./generic-ai-adoption-contracts.js";
import type { EvidenceUse } from "../contracts/evidence-closure.js";
import type { EvidenceUseSink } from "./evidence-closure-walk-common.js";

function emitResult(
  emit: EvidenceUseSink,
  element: AiAnalysisElement,
  result: AiAnalysisElementMigrationResult | AiAnalysisElementResult,
  path: readonly (string | number)[],
  destination: EvidenceUse["destination"],
  requiredCurrentness: EvidenceUse["requiredCurrentness"],
  allowedOwnerNodeIds: readonly string[],
  allowedRelationIds: readonly string[],
): void {
  for (const [index, evidence] of result.evidence.entries()) {
    emit(
      evidence.sourceId,
      [...path, "evidence", index, "sourceId"],
      destination,
      `ai_${element}_evidence`,
      requiredCurrentness,
      allowedOwnerNodeIds,
      allowedRelationIds,
    );
  }
  if (element === "waitingOn") {
    const waitingOn = createAiAnalysisMigrationElementResultSchema("waitingOn").parse(result);
    for (const [index, candidate] of waitingOn.value.entries()) {
      for (const [sourceIndex, sourceId] of candidate.sourceIds.entries()) {
        emit(
          sourceId,
          [...path, "value", index, "sourceIds", sourceIndex],
          destination,
          "ai_waiting_on_candidate",
          requiredCurrentness,
          allowedOwnerNodeIds,
          allowedRelationIds,
        );
      }
    }
  } else if (element === "relations") {
    const relations = createAiAnalysisMigrationElementResultSchema("relations").parse(result);
    for (const [index, relation] of relations.value.entries()) {
      for (const [sourceIndex, sourceId] of relation.sourceIds.entries()) {
        emit(
          sourceId,
          [...path, "value", index, "sourceIds", sourceIndex],
          destination,
          "ai_relation_candidate",
          requiredCurrentness,
          allowedOwnerNodeIds,
          allowedRelationIds,
        );
      }
    }
  } else if (element === "progress") {
    const progress = createAiAnalysisMigrationElementResultSchema("progress").parse(result);
    if (progress.value.latestMeaningfulSourceId != null) {
      emit(
        progress.value.latestMeaningfulSourceId,
        [...path, "value", "latestMeaningfulSourceId"],
        destination,
        "ai_progress",
        requiredCurrentness,
        allowedOwnerNodeIds,
        allowedRelationIds,
      );
    }
  } else if (element === "selfCommitment") {
    const commitments =
      createAiAnalysisMigrationElementResultSchema("selfCommitment").parse(result);
    for (const [index, commitment] of commitments.value.entries()) {
      emit(
        commitment.sourceId,
        [...path, "value", index, "sourceId"],
        destination,
        "ai_self_commitment",
        requiredCurrentness,
        allowedOwnerNodeIds,
        allowedRelationIds,
      );
    }
  }
}

/** 保存する現在・採用・保持AI要素の参照を列挙する。 */
export function walkTrackedItemAiAnalysis(
  emit: EvidenceUseSink,
  analysis: TrackedItemAiAnalysis,
  path: readonly (string | number)[],
  destination: EvidenceUse["destination"],
  itemNodeId: string,
): void {
  for (const element of AI_ANALYSIS_ELEMENTS) {
    const current = analysis.elements[element];
    if (current != null) {
      emitResult(
        emit,
        element,
        current.result,
        [...path, "elements", element, "result"],
        destination,
        "historical_allowed",
        [itemNodeId],
        [],
      );
      emitResult(
        emit,
        element,
        current.generation.result,
        [...path, "elements", element, "generation", "result"],
        destination,
        "historical_allowed",
        [itemNodeId],
        [],
      );
    }
    const adopted = analysis.adoptedElements[element];
    if (adopted != null) {
      emitResult(
        emit,
        element,
        adopted.result,
        [...path, "adoptedElements", element, "result"],
        destination,
        "historical_allowed",
        [itemNodeId],
        [],
      );
      emitResult(
        emit,
        element,
        adopted.generation.result,
        [...path, "adoptedElements", element, "generation", "result"],
        destination,
        "historical_allowed",
        [itemNodeId],
        [],
      );
    }
    const retained = analysis.retainedElements[element];
    if (retained != null) {
      emitResult(
        emit,
        element,
        retained.result,
        [...path, "retainedElements", element, "result"],
        destination,
        "historical_allowed",
        [itemNodeId],
        [],
      );
      if (retained.origin === "current") {
        emitResult(
          emit,
          element,
          retained.generation.result,
          [...path, "retainedElements", element, "generation", "result"],
          destination,
          "historical_allowed",
          [itemNodeId],
          [],
        );
      }
    }
  }
}

/** 採用記録に残る評価値と保持値の参照を列挙する。 */
export function walkGenericAiAdoptions(
  emit: EvidenceUseSink,
  items: readonly GenericAiItemAdoption[],
): void {
  for (const [itemIndex, item] of items.entries()) {
    const destination: EvidenceUse["destination"] = Object.freeze({
      kind: "item",
      itemNodeId: item.nodeId,
    });
    for (const element of AI_ANALYSIS_ELEMENTS) {
      const record = item.elements[element];
      const base = ["aiItems", itemIndex, "elements", element];
      if (record.adopted.status === "ai") {
        emitResult(
          emit,
          element,
          record.adopted.result,
          [...base, "adopted", "result"],
          destination,
          "historical_allowed",
          [item.nodeId],
          [],
        );
      }
      if (record.retained != null) {
        emitResult(
          emit,
          element,
          record.retained.result,
          [...base, "retained", "result"],
          destination,
          "historical_allowed",
          [item.nodeId],
          [],
        );
      }
      if (record.evaluated != null) {
        emitResult(
          emit,
          element,
          record.evaluated.result,
          [...base, "evaluated", "result"],
          destination,
          record.evaluated.origin === "executed" ? "current" : "historical_allowed",
          [item.nodeId],
          [],
        );
      }
    }
  }
}

/** cacheへ追加する汎用AI要素の参照を列挙する。 */
export function walkAiCacheResult(
  emit: EvidenceUseSink,
  element: AiAnalysisElement,
  result: AiAnalysisElementMigrationResult,
  path: readonly (string | number)[],
  itemNodeId: GitHubNodeId,
): void {
  emitResult(
    emit,
    element,
    result,
    path,
    Object.freeze({ kind: "item", itemNodeId }),
    "current",
    [itemNodeId],
    [],
  );
}
