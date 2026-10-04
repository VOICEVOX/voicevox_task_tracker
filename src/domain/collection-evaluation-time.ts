import type { UtcIsoDateTime } from "./types.js";

type TimedCollectedItem = Readonly<{
  createdAt: UtcIsoDateTime;
  state: "open" | "closed";
  closedAt: UtcIsoDateTime | null;
}>;

type TimedObservedItem = TimedCollectedItem &
  Readonly<{ events: readonly Readonly<{ occurredAt: UtcIsoDateTime }>[] }>;

/** 収集途中の追跡候補を選ぶために既知の発生時刻の下限を返す。 */
export function provisionalCollectionEvaluationTime(
  startedAt: UtcIsoDateTime,
  enumeratedItems: readonly TimedCollectedItem[],
  observedItems: readonly TimedObservedItem[],
): UtcIsoDateTime {
  let provisionalTime = startedAt;
  for (const item of enumeratedItems) {
    if (item.createdAt > provisionalTime) {
      provisionalTime = item.createdAt;
    }
    if (item.closedAt != null && item.closedAt > provisionalTime) {
      provisionalTime = item.closedAt;
    }
  }
  for (const item of observedItems) {
    for (const event of item.events) {
      if (event.occurredAt > provisionalTime) {
        provisionalTime = event.occurredAt;
      }
    }
  }
  return provisionalTime;
}
