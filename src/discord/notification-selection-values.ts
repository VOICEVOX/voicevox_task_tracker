import { type UtcIsoDateTime, type WaitingOn } from "../domain/index.js";
import { MILLISECONDS_PER_HOUR } from "./notification-selection-contracts.js";

export function parseTimestamp(value: UtcIsoDateTime, context: string): number {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new TypeError(`${context}は有効な日時ではありません`);
  }
  return timestamp;
}

type WaitingOnReference = Readonly<Pick<WaitingOn, "kind" | "candidateId" | "role">>;

export function waitingOnKeySignature(waitingOnValues: readonly WaitingOn[]): string {
  return JSON.stringify(
    waitingOnValues.map((waitingOn) => [waitingOn.kind, waitingOn.candidateId, waitingOn.role]),
  );
}

export function waitingOnComparisonSignature(
  waitingOnValues: readonly WaitingOnReference[],
): string {
  return JSON.stringify(normalizedResponsibilityForComparison(waitingOnValues));
}

export function hoursBetween(earlier: UtcIsoDateTime, laterTimestamp: number): number {
  return (laterTimestamp - parseTimestamp(earlier, "経過時間の起点")) / MILLISECONDS_PER_HOUR;
}

export function compareStrings(left: string, right: string): -1 | 0 | 1 {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

export function normalizedResponsibilityForComparison(
  responsible: readonly WaitingOnReference[],
): readonly (readonly [string, string, string])[] {
  return Object.freeze(
    responsible
      .map((value): readonly [string, string, string] => [
        value.kind,
        value.candidateId.toLowerCase(),
        value.role,
      ])
      .sort((left, right) => compareStrings(JSON.stringify(left), JSON.stringify(right))),
  );
}
