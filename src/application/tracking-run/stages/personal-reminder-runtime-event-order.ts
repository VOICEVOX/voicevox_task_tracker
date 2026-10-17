import type { NormalizedEvent } from "../../../domain/types.js";
import { compareSourceIds } from "./personal-reminder-runtime-common.js";

/** 二つのeventの発生順を比較する。 */
export function compareEventOccurrence(left: NormalizedEvent, right: NormalizedEvent): number {
  const leftTime = Date.parse(left.occurredAt);
  const rightTime = Date.parse(right.occurredAt);
  if (!Number.isFinite(leftTime) || !Number.isFinite(rightTime)) {
    throw new TypeError("待機解消イベントの時刻が不正です");
  }
  if (leftTime !== rightTime) {
    return leftTime - rightTime;
  }
  return compareSourceIds(left.sourceId, right.sourceId);
}
