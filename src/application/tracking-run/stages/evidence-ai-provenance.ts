import { serializeCanonicalJson } from "../../../canonical-json/value.js";
import { AI_ANALYSIS_ELEMENTS } from "../../../domain/ai-analysis-elements.js";
import type { TrackedItemAiAnalysis } from "../../../domain/tracked-item-ai-analysis.js";
import type { OwnedHistoricalAiResult } from "../contracts/evidence-closure.js";
import type { GenericAiItemAdoption } from "./generic-ai-adoption-contracts.js";
import {
  collectAiResultSlots,
  matchingHistoricalAiResults,
  type AiResultOrigin,
  type AiResultSlot,
} from "./evidence-ai-results.js";
import { RunCompletenessError } from "./run-completeness-error.js";
import { assertRunValueMatches } from "./run-validation-compare.js";

export type AiAnalysisOwner = Readonly<{
  nodeId: OwnedHistoricalAiResult["owner"]["itemNodeId"];
  repositoryId: OwnedHistoricalAiResult["owner"]["repositoryId"];
  aiAnalysis: TrackedItemAiAnalysis;
}>;
export type LocatedAiAnalysisOwner = Readonly<{
  item: AiAnalysisOwner;
  path: readonly (string | number)[];
}>;

function slotOrigin(
  slot: AiResultSlot,
  adoption: GenericAiItemAdoption | undefined,
): AiResultOrigin["origin"] {
  if (adoption == null) return "historical";
  const sectionIndex = slot.path.indexOf("aiAnalysis") + 1;
  const section = slot.path[sectionIndex];
  const record = adoption.elements[slot.element];
  let value:
    | GenericAiItemAdoption["elements"][typeof slot.element]["evaluated"]
    | GenericAiItemAdoption["elements"][typeof slot.element]["retained"]
    | Extract<GenericAiItemAdoption["elements"][typeof slot.element]["adopted"], { status: "ai" }>
    | undefined;
  if (section === "elements") value = record.evaluated;
  else if (section === "adoptedElements")
    value = record.adopted.status === "ai" ? record.adopted : undefined;
  else if (section === "retainedElements") value = record.retained;
  else
    throw new RunCompletenessError(
      "invalid_reference",
      slot.owner.itemNodeId,
      slot.path,
      undefined,
    );
  if (value == null) {
    throw new RunCompletenessError("missing_value", slot.owner.itemNodeId, slot.path, undefined);
  }
  const result =
    slot.path[sectionIndex + 2] === "generation" ? value.generation?.result : value.result;
  assertRunValueMatches(result, slot.result, slot.path, slot.owner.itemNodeId);
  if (value.origin === "executed" || value.origin === "cache") {
    if (value.generation == null || record.inputFingerprint == null) {
      throw new RunCompletenessError("missing_value", slot.owner.itemNodeId, slot.path, undefined);
    }
    assertRunValueMatches(
      record.inputFingerprint,
      value.generation.metadata.inputFingerprint,
      [...slot.path, "metadata", "inputFingerprint"],
      slot.owner.itemNodeId,
    );
    return "current";
  }
  return "historical";
}

function itemSlots(
  item: AiAnalysisOwner,
  path: readonly (string | number)[],
): readonly AiResultSlot[] {
  return collectAiResultSlots(item.aiAnalysis, path, {
    itemNodeId: item.nodeId,
    repositoryId: item.repositoryId,
  });
}

/** stageで確定した生成元と保存するAI結果を一対一照合する。 */
export function createAiResultOrigins(
  tracked: readonly LocatedAiAnalysisOwner[],
  collection: readonly LocatedAiAnalysisOwner[],
  adoptions: readonly GenericAiItemAdoption[],
  historical: readonly OwnedHistoricalAiResult[],
): readonly AiResultOrigin[] {
  const adoptionsById = new Map(adoptions.map((item) => [item.nodeId, item]));
  if (adoptionsById.size !== adoptions.length)
    throw new RunCompletenessError("duplicate_id", "aiItems", ["aiItems"], undefined);
  const trackedById = new Map(tracked.map(({ item }) => [item.nodeId, item]));
  const origins: AiResultOrigin[] = [];
  for (const { item, path } of tracked) {
    const adoption = adoptionsById.get(item.nodeId);
    for (const slot of itemSlots(item, [...path, "aiAnalysis"])) {
      const origin = slotOrigin(slot, adoption);
      if (origin === "historical") matchingHistoricalAiResults(slot, historical);
      origins.push({ path: slot.path, origin });
    }
  }
  for (const { item, path } of collection) {
    const trackedItem = trackedById.get(item.nodeId);
    if (trackedItem != null) {
      assertRunValueMatches(
        trackedItem.repositoryId,
        item.repositoryId,
        [...path, "repositoryId"],
        item.nodeId,
      );
      assertRunValueMatches(
        trackedItem.aiAnalysis,
        item.aiAnalysis,
        [...path, "aiAnalysis"],
        item.nodeId,
      );
    }
    const adoption = trackedItem == null ? undefined : adoptionsById.get(item.nodeId);
    for (const slot of itemSlots(item, [...path, "aiAnalysis"])) {
      const origin = slotOrigin(slot, adoption);
      if (origin === "historical") matchingHistoricalAiResults(slot, historical);
      origins.push({ path: slot.path, origin });
    }
  }
  return Object.freeze(
    origins.sort((left, right) => {
      const a = serializeCanonicalJson(left.path);
      const b = serializeCanonicalJson(right.path);
      return a < b ? -1 : a > b ? 1 : 0;
    }),
  );
}

/** AI採用stageに残る評価、採用、保持結果の来歴を列挙する。 */
export function collectAdoptionAiResultSlots(
  adoptions: readonly GenericAiItemAdoption[],
  repositories: ReadonlyMap<string, OwnedHistoricalAiResult["owner"]["repositoryId"]>,
): Readonly<{ slots: readonly AiResultSlot[]; origins: readonly AiResultOrigin[] }> {
  const slots: AiResultSlot[] = [];
  const origins: AiResultOrigin[] = [];
  for (const [itemIndex, item] of adoptions.entries()) {
    const repositoryId = repositories.get(item.nodeId);
    if (repositoryId == null)
      throw new RunCompletenessError("wrong_owner", item.nodeId, ["aiItems", itemIndex], undefined);
    for (const element of AI_ANALYSIS_ELEMENTS) {
      const record = item.elements[element];
      const values = [
        record.adopted.status === "ai" ? { name: "adopted", value: record.adopted } : undefined,
        record.retained == null ? undefined : { name: "retained", value: record.retained },
        record.evaluated == null ? undefined : { name: "evaluated", value: record.evaluated },
      ];
      for (const entry of values) {
        if (entry == null) continue;
        const path = ["aiItems", itemIndex, "elements", element, entry.name, "result"];
        slots.push({
          path,
          owner: { itemNodeId: item.nodeId, repositoryId },
          element,
          result: entry.value.result,
        });
        origins.push({
          path,
          origin:
            entry.value.origin === "executed" || entry.value.origin === "cache"
              ? "current"
              : "historical",
        });
      }
    }
  }
  return { slots: Object.freeze(slots), origins: Object.freeze(origins) };
}

/** artifactが主張するAI保存位置と保持結果の前回一致を照合する。 */
export function assertAiResultOrigins(
  slots: readonly AiResultSlot[],
  origins: readonly AiResultOrigin[],
  historical: readonly OwnedHistoricalAiResult[],
): void {
  const sorted = [...origins].sort((left, right) => {
    const a = serializeCanonicalJson(left.path);
    const b = serializeCanonicalJson(right.path);
    return a < b ? -1 : a > b ? 1 : 0;
  });
  assertRunValueMatches(sorted, origins, ["aiResultOrigins"], "ai");
  if (slots.length !== origins.length)
    throw new RunCompletenessError("missing_value", "ai", ["aiResultOrigins"], undefined);
  const byPath = new Map(origins.map((origin) => [serializeCanonicalJson(origin.path), origin]));
  if (byPath.size !== origins.length)
    throw new RunCompletenessError("duplicate_id", "ai", ["aiResultOrigins"], undefined);
  for (const slot of slots) {
    const origin = byPath.get(serializeCanonicalJson(slot.path));
    if (origin == null)
      throw new RunCompletenessError("missing_value", slot.owner.itemNodeId, slot.path, undefined);
    if (origin.origin === "historical") matchingHistoricalAiResults(slot, historical);
  }
}
