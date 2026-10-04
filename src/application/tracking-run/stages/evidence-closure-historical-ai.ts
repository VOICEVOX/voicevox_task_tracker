import { serializeCanonicalJson } from "../../../canonical-json/value.js";
import type {
  HistoricalAiSnapshotInput,
  OwnedHistoricalAiResult,
} from "../contracts/evidence-closure.js";
import { collectAiResultSlots } from "./evidence-ai-results.js";

/** 正規化済み前回snapshotの追跡項目と収集項目からAI結果を抽出する。 */
export function collectOwnedHistoricalAiResults(
  snapshot: HistoricalAiSnapshotInput,
): readonly OwnedHistoricalAiResult[] {
  const records: OwnedHistoricalAiResult[] = [];
  for (const [index, item] of snapshot.trackedItems.entries()) {
    records.push(
      ...collectAiResultSlots(item.aiAnalysis, ["trackedItems", index, "aiAnalysis"], {
        itemNodeId: item.nodeId,
        repositoryId: item.repositoryId,
      }),
    );
  }
  for (const [repositoryIndex, repository] of snapshot.collectionRepositories.entries()) {
    for (const [itemIndex, item] of repository.items.entries()) {
      records.push(
        ...collectAiResultSlots(
          item.aiAnalysis,
          ["collectionRepositories", repositoryIndex, "items", itemIndex, "aiAnalysis"],
          { itemNodeId: item.nodeId, repositoryId: item.repositoryId },
        ),
      );
    }
  }
  return Object.freeze(
    records.sort((left, right) => {
      const a = serializeCanonicalJson(left);
      const b = serializeCanonicalJson(right);
      return a < b ? -1 : a > b ? 1 : 0;
    }),
  );
}
