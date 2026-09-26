import type { SourceId, UtcIsoDateTime } from "../../domain/index.js";
import type { FreshObservedGitHubItem } from "../../github/index.js";
import {
  addCodexSourceOccurredAtForContext,
  createCodexSourceOccurredAtById,
} from "../codex-input-projection.js";
import type { DeterministicItemAnalysis } from "../initial-item-analysis.js";

function setEarliestRelationSourceOccurredAt(
  sourceOccurredAtById: Map<SourceId, UtcIsoDateTime>,
  sourceId: SourceId,
  occurredAt: UtcIsoDateTime,
): void {
  const existingOccurredAt = sourceOccurredAtById.get(sourceId);
  if (existingOccurredAt == null || occurredAt < existingOccurredAt) {
    sourceOccurredAtById.set(sourceId, occurredAt);
  }
}

/** 関係の証拠となるsource IDごとの最初の発生時刻を作成する。 */
export function createEarliestRelationSourceOccurredAtById(
  items: readonly FreshObservedGitHubItem[],
): ReadonlyMap<SourceId, UtcIsoDateTime> {
  const sourceOccurredAtById = new Map<SourceId, UtcIsoDateTime>();
  for (const item of items) {
    setEarliestRelationSourceOccurredAt(sourceOccurredAtById, item.bodySourceId, item.createdAt);
    for (const event of item.events) {
      setEarliestRelationSourceOccurredAt(sourceOccurredAtById, event.sourceId, event.occurredAt);
    }
  }
  return sourceOccurredAtById;
}

/** 解析に用いるsource IDごとの発生時刻を作る。 */
export function sourceOccurredAtByIdForAnalysis(
  analysis: Readonly<
    Pick<DeterministicItemAnalysis, "item" | "detail" | "effectiveAssigneeCandidates">
  >,
): ReadonlyMap<SourceId, UtcIsoDateTime> {
  const sourceOccurredAtById = new Map(
    createCodexSourceOccurredAtById(
      analysis.item,
      analysis.detail,
      createEarliestRelationSourceOccurredAtById,
    ),
  );
  for (const effectiveCandidateContext of analysis.effectiveAssigneeCandidates) {
    for (const sourceContext of effectiveCandidateContext.sourceContexts) {
      addCodexSourceOccurredAtForContext(
        sourceOccurredAtById,
        sourceContext.item,
        sourceContext.detail,
        createEarliestRelationSourceOccurredAtById,
      );
    }
  }
  return sourceOccurredAtById;
}
