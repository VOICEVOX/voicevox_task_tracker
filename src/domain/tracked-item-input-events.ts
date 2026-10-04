import type { TrackedItemInputEvent } from "./types.js";

/** 追跡項目の入力イベントをsource ID順に正規化する。 */
export function normalizeTrackedItemInputEvents(
  events: readonly TrackedItemInputEvent[],
): readonly TrackedItemInputEvent[] {
  return Object.freeze(
    [...events]
      .sort((left, right) => {
        if (left.sourceId < right.sourceId) return -1;
        return left.sourceId > right.sourceId ? 1 : 0;
      })
      .map((event) => Object.freeze({ ...event })),
  );
}
