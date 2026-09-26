import {
  createStateHistoryInputEvents,
  type StateHistoryInputEvent,
} from "../../../persistence/index.js";
import type { ReducedAnalysis } from "../contracts.js";

/** 履歴へ保存する入力イベントを抽出する。 */
export function stateHistoryInputEvents(
  reduction: ReducedAnalysis,
): readonly StateHistoryInputEvent[] {
  return createStateHistoryInputEvents(
    reduction.currentItems.flatMap((analysis) =>
      analysis.item.events.map(
        (event) =>
          ({
            sourceId: event.sourceId,
            itemNodeId: event.itemNodeId,
            kind: event.kind,
            actor: event.actor,
            occurredAt: event.occurredAt,
          }) satisfies StateHistoryInputEvent,
      ),
    ),
  );
}
