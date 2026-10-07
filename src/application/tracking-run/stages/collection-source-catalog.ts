import { buildSourceId, parseSourceId, type SourceId } from "../../../domain/source-id.js";
import type { UtcIsoDateTime } from "../../../domain/types.js";

function sourceIdsFromValue(value: unknown, result: Set<SourceId>): void {
  if (typeof value !== "object" || value == null) {
    return;
  }
  if (Array.isArray(value)) {
    for (const element of value) {
      sourceIdsFromValue(element, result);
    }
    return;
  }
  for (const [key, property] of Object.entries(value)) {
    if ((key === "sourceId" || key.endsWith("SourceId")) && typeof property === "string") {
      const parts = parseSourceId(property);
      result.add(buildSourceId(parts.kind, parts.originalId));
    } else if ((key === "sourceIds" || key.endsWith("SourceIds")) && Array.isArray(property)) {
      for (const sourceId of property) {
        if (typeof sourceId !== "string") {
          throw new TypeError("source ID一覧に文字列以外の値があります");
        }
        const parts = parseSourceId(sourceId);
        result.add(buildSourceId(parts.kind, parts.originalId));
      }
    } else if (key !== "body" && key !== "markdown") {
      sourceIdsFromValue(property, result);
    }
  }
}

/** 正規化済み収集結果から一つのsource ID一覧を作る。 */
export function createCollectionSourceCatalog(collection: unknown): readonly SourceId[] {
  if (
    typeof collection !== "object" ||
    collection == null ||
    !("enumeratedItems" in collection) ||
    !Array.isArray(collection.enumeratedItems) ||
    !("details" in collection) ||
    !Array.isArray(collection.details) ||
    !("observedItems" in collection) ||
    !Array.isArray(collection.observedItems)
  ) {
    throw new TypeError("正規化済みsourceを含む収集結果がありません");
  }
  const sourceIds = new Set<SourceId>();
  sourceIdsFromValue(collection.enumeratedItems, sourceIds);
  sourceIdsFromValue(collection.details, sourceIds);
  sourceIdsFromValue(collection.observedItems, sourceIds);
  return Object.freeze([...sourceIds].sort());
}

function assertNoFutureTimestamp(
  value: unknown,
  evaluatedAt: UtcIsoDateTime,
  parentKey: string,
): void {
  if (typeof value !== "object" || value == null) {
    if (
      typeof value === "string" &&
      (parentKey.endsWith("At") || parentKey === "timestamp") &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) &&
      value > evaluatedAt
    ) {
      throw new RangeError("GitHub sourceの発生時刻が評価時刻より後です");
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const element of value) {
      assertNoFutureTimestamp(element, evaluatedAt, parentKey);
    }
    return;
  }
  for (const [key, property] of Object.entries(value)) {
    const timestampKey = key === "value" ? parentKey : key;
    if (key !== "body" && key !== "markdown") {
      assertNoFutureTimestamp(property, evaluatedAt, timestampKey);
    }
  }
}

/** GitHub由来の構造化された発生時刻が評価時刻を越えないことを検証する。 */
export function assertCollectionSourceTimes(
  collection: unknown,
  evaluatedAt: UtcIsoDateTime,
): void {
  assertNoFutureTimestamp(collection, evaluatedAt, "");
}
