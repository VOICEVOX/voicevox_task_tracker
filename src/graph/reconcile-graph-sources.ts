import { createUtcIsoDateTime, type SourceId, type UtcIsoDateTime } from "../domain/index.js";
import { assertNonNullable } from "../util/index.js";
import { type RelationCandidate } from "./relation-candidate-types.js";

export function compareStrings(left: string, right: string): -1 | 0 | 1 {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

export function validateConfidence(value: number, context: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError(`${context}は0以上1以下で指定してください`);
  }
}

export function validateSourceIds(sourceIds: readonly SourceId[], context: string): void {
  if (sourceIds.length === 0) {
    throw new TypeError(`${context}にはsource IDが1件以上必要です`);
  }
  if (sourceIds.some((sourceId) => sourceId.length === 0)) {
    throw new TypeError(`${context}のsource IDは空にできません`);
  }
  if (new Set(sourceIds).size !== sourceIds.length) {
    throw new TypeError(`${context}のsource IDが重複しています`);
  }
}

export function validateUtcIsoDateTime(value: UtcIsoDateTime, context: string): void {
  if (createUtcIsoDateTime(value) !== value) {
    throw new TypeError(`${context}はUTCへ正規化してください`);
  }
}

export function validateSourceOccurredAtById(
  sourceOccurredAtById: ReadonlyMap<SourceId, UtcIsoDateTime>,
  reconciledAt: UtcIsoDateTime,
): void {
  for (const [sourceId, occurredAt] of sourceOccurredAtById) {
    validateUtcIsoDateTime(occurredAt, `source ${sourceId}の発生時刻`);
    if (occurredAt > reconciledAt) {
      throw new RangeError(`source ${sourceId}の発生時刻がreconcile時刻より後です`);
    }
  }
}

export function resolveCandidateFirstSeenAt(
  candidate: RelationCandidate,
  sourceOccurredAtById: ReadonlyMap<SourceId, UtcIsoDateTime>,
): UtcIsoDateTime {
  const [firstSourceId, ...remainingSourceIds] = candidate.sourceIds;
  const firstOccurredAt = sourceOccurredAtById.get(firstSourceId);
  assertNonNullable(
    firstOccurredAt,
    `関係候補 ${candidate.id}のsource ${firstSourceId}に対応する発生時刻がありません`,
  );
  let earliestOccurredAt = firstOccurredAt;
  for (const sourceId of remainingSourceIds) {
    const occurredAt = sourceOccurredAtById.get(sourceId);
    assertNonNullable(
      occurredAt,
      `関係候補 ${candidate.id}のsource ${sourceId}に対応する発生時刻がありません`,
    );
    if (occurredAt < earliestOccurredAt) {
      earliestOccurredAt = occurredAt;
    }
  }
  return earliestOccurredAt;
}
