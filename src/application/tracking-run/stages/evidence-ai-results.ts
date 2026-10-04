import { serializeCanonicalJson } from "../../../canonical-json/value.js";
import {
  AI_ANALYSIS_ELEMENTS,
  createAiAnalysisElementResultSchema,
  createAiAnalysisMigrationElementResultSchema,
  type AiAnalysisElement,
  type AiAnalysisElementResult,
  type AiAnalysisElementMigrationResult,
} from "../../../domain/ai-analysis-elements.js";
import type { TrackedItemAiAnalysis } from "../../../domain/tracked-item-ai-analysis.js";
import type { OwnedHistoricalAiResult } from "../contracts/evidence-closure.js";
import { RunCompletenessError } from "./run-completeness-error.js";

export type AiResultSlot = Readonly<{
  path: readonly (string | number)[];
  owner: OwnedHistoricalAiResult["owner"];
  element: AiAnalysisElement;
  result: AiAnalysisElementMigrationResult | AiAnalysisElementResult;
}>;

export type AiResultOrigin = Readonly<{
  path: readonly (string | number)[];
  origin: "current" | "historical";
}>;

/** source参照の保存位置に対応するAI resultを探す。 */
export function aiResultSlotForUse(
  path: readonly (string | number)[],
  slots: readonly AiResultSlot[],
): AiResultSlot | undefined {
  return slots.find(
    (slot) =>
      path.length > slot.path.length && slot.path.every((part, index) => part === path[index]),
  );
}

/** AI分析の全保存resultを要素と所有者付きで列挙する。 */
export function collectAiResultSlots(
  analysis: TrackedItemAiAnalysis,
  path: readonly (string | number)[],
  owner: OwnedHistoricalAiResult["owner"],
): readonly AiResultSlot[] {
  const slots: AiResultSlot[] = [];
  for (const element of AI_ANALYSIS_ELEMENTS) {
    const evaluated = analysis.elements[element];
    const adopted = analysis.adoptedElements[element];
    const retained = analysis.retainedElements[element];
    if (evaluated != null) {
      slots.push({
        path: [...path, "elements", element, "result"],
        owner,
        element,
        result: evaluated.result,
      });
      slots.push({
        path: [...path, "elements", element, "generation", "result"],
        owner,
        element,
        result: evaluated.generation.result,
      });
    }
    if (adopted != null) {
      slots.push({
        path: [...path, "adoptedElements", element, "result"],
        owner,
        element,
        result: adopted.result,
      });
      slots.push({
        path: [...path, "adoptedElements", element, "generation", "result"],
        owner,
        element,
        result: adopted.generation.result,
      });
    }
    if (retained != null) {
      slots.push({
        path: [...path, "retainedElements", element, "result"],
        owner,
        element,
        result: retained.result,
      });
      if (retained.origin === "current") {
        slots.push({
          path: [...path, "retainedElements", element, "generation", "result"],
          owner,
          element,
          result: retained.generation.result,
        });
      }
    }
  }
  return Object.freeze(slots);
}

/** resultに含まれる根拠とsource-only参照をすべて取得する。 */
export function aiResultSourceIds(
  element: AiAnalysisElement,
  result: AiAnalysisElementMigrationResult | AiAnalysisElementResult,
): readonly string[] {
  const sourceIds = result.evidence.map((evidence) => evidence.sourceId);
  if (element === "waitingOn") {
    const value = createAiAnalysisMigrationElementResultSchema("waitingOn")
      .or(createAiAnalysisElementResultSchema("waitingOn"))
      .parse(result);
    sourceIds.push(...value.value.flatMap((candidate) => candidate.sourceIds));
  } else if (element === "relations") {
    const value = createAiAnalysisMigrationElementResultSchema("relations")
      .or(createAiAnalysisElementResultSchema("relations"))
      .parse(result);
    sourceIds.push(...value.value.flatMap((relation) => relation.sourceIds));
  } else if (element === "progress") {
    const value = createAiAnalysisMigrationElementResultSchema("progress")
      .or(createAiAnalysisElementResultSchema("progress"))
      .parse(result);
    if (value.value.latestMeaningfulSourceId != null)
      sourceIds.push(value.value.latestMeaningfulSourceId);
  } else if (element === "selfCommitment") {
    const value = createAiAnalysisMigrationElementResultSchema("selfCommitment")
      .or(createAiAnalysisElementResultSchema("selfCommitment"))
      .parse(result);
    sourceIds.push(...value.value.map((commitment) => commitment.sourceId));
  }
  return Object.freeze([...new Set(sourceIds)]);
}

/** 前回の同owner、同要素、同resultだけを保持AIの根拠と認める。 */
export function matchingHistoricalAiResults(
  slot: AiResultSlot,
  historical: readonly OwnedHistoricalAiResult[],
): readonly OwnedHistoricalAiResult[] {
  const ownerRecords = historical.filter(
    (record) =>
      record.owner.itemNodeId === slot.owner.itemNodeId &&
      record.owner.repositoryId === slot.owner.repositoryId &&
      record.element === slot.element,
  );
  const matched = ownerRecords.filter(
    (record) => serializeCanonicalJson(record.result) === serializeCanonicalJson(slot.result),
  );
  if (matched.length === 0) {
    throw new RunCompletenessError(
      ownerRecords.length === 0 ? "wrong_owner" : "missing_source",
      slot.owner.itemNodeId,
      slot.path,
      undefined,
    );
  }
  return Object.freeze(matched);
}
