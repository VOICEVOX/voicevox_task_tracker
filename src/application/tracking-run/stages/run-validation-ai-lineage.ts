import type { GitHubNodeId, GitHubRepositoryId } from "../../../domain/types.js";
import type { TrackedItemAiAnalysis } from "../../../domain/tracked-item-ai-analysis.js";
import type { GenericAiItemAdoption } from "./generic-ai-adoption-contracts.js";
import type { GenericAiAdoptedRun } from "./generic-ai-adoption.js";
import type { AiResultOrigin } from "./evidence-ai-results.js";
import { trackedItemAiAnalysisFromAdoption } from "./graph-reconciliation-ai-analysis.js";
import { RunCompletenessError } from "./run-completeness-error.js";
import { assertRunValueMatches, runValuesById } from "./run-validation-compare.js";
import type { RunSnapshot, FinalItemAiLineage } from "./run-validation-contracts.js";

/** 今回の解析対象と採用結果から全追跡項目の由来を確定する。 */
export function createFinalItemAiLineage(
  items: RunSnapshot["items"],
  analyzedItems: GenericAiAdoptedRun["data"]["facts"]["items"],
  aiItems: readonly GenericAiItemAdoption[],
): readonly FinalItemAiLineage[] {
  const saved = runValuesById(items, (item) => item.nodeId, ["snapshot", "items"]);
  const analyzed = runValuesById(analyzedItems, (entry) => entry.item.nodeId, ["facts", "items"]);
  const adopted = runValuesById(aiItems, (item) => item.nodeId, ["aiItems"]);
  if (analyzed.size !== adopted.size) {
    throw new RunCompletenessError("missing_value", "aiItems", ["aiItems"], undefined);
  }
  for (const [nodeId, entry] of analyzed) {
    const item = saved.get(nodeId);
    const adoption = adopted.get(nodeId);
    if (item == null || adoption == null) {
      throw new RunCompletenessError("missing_value", nodeId, ["aiItems", nodeId], undefined);
    }
    assertRunValueMatches(
      entry.item.repositoryId,
      item.repositoryId,
      ["snapshot", "items", nodeId, "repositoryId"],
      nodeId,
    );
    assertRunValueMatches(
      trackedItemAiAnalysisFromAdoption(adoption),
      item.aiAnalysis,
      ["snapshot", "items", nodeId, "aiAnalysis"],
      nodeId,
    );
  }
  for (const nodeId of adopted.keys()) {
    if (!analyzed.has(nodeId)) {
      throw new RunCompletenessError("wrong_owner", nodeId, ["aiItems", nodeId], undefined);
    }
  }
  return Object.freeze(
    [...saved.values()]
      .map((item): FinalItemAiLineage =>
        Object.freeze({
          nodeId: item.nodeId,
          repositoryId: item.repositoryId,
          kind: analyzed.has(item.nodeId) ? "analyzed" : "retained",
        }),
      )
      .sort((left, right) =>
        left.nodeId < right.nodeId ? -1 : left.nodeId > right.nodeId ? 1 : 0,
      ),
  );
}

function aiOriginItemNodeId(
  snapshot: Pick<RunSnapshot, "items" | "collection">,
  path: readonly (string | number)[],
): GitHubNodeId | undefined {
  if (path[0] !== "snapshot") return undefined;
  if (path[1] === "items" && typeof path[2] === "number") {
    return snapshot.items[path[2]]?.nodeId;
  }
  if (
    path[1] === "collection" &&
    path[2] === "repositories" &&
    typeof path[3] === "number" &&
    path[4] === "items" &&
    typeof path[5] === "number"
  ) {
    return snapshot.collection.repositories[path[3]]?.items[path[5]]?.nodeId;
  }
  return undefined;
}

/** checkpointの由来記録と追跡・収集項目の所有者およびAI状態を照合する。 */
export function assertFinalItemAiLineage(
  snapshot: Pick<RunSnapshot, "items" | "collection">,
  lineage: readonly FinalItemAiLineage[],
  origins: readonly AiResultOrigin[],
): void {
  const items = runValuesById(snapshot.items, (item) => item.nodeId, ["snapshot", "items"]);
  const expected = [...items.values()]
    .map((item) => ({ nodeId: item.nodeId, repositoryId: item.repositoryId }))
    .sort((left, right) => (left.nodeId < right.nodeId ? -1 : left.nodeId > right.nodeId ? 1 : 0));
  const actual = lineage.map((entry) => ({
    nodeId: entry.nodeId,
    repositoryId: entry.repositoryId,
  }));
  assertRunValueMatches(expected, actual, ["finalItemAiLineage"], "items");
  const byId = runValuesById(lineage, (entry) => entry.nodeId, ["finalItemAiLineage"]);
  const collectionItems = snapshot.collection.repositories.flatMap((repository, repositoryIndex) =>
    repository.items.map((item, itemIndex) => {
      assertRunValueMatches(
        repository.repositoryId,
        item.repositoryId,
        [
          "snapshot",
          "collection",
          "repositories",
          repositoryIndex,
          "items",
          itemIndex,
          "repositoryId",
        ],
        item.nodeId,
      );
      return item;
    }),
  );
  runValuesById(collectionItems, (item) => item.nodeId, ["snapshot", "collection", "items"]);
  for (const item of collectionItems) {
    const tracked = items.get(item.nodeId);
    if (tracked == null) continue;
    assertRunValueMatches(
      tracked.repositoryId,
      item.repositoryId,
      ["snapshot", "collection", "items", item.nodeId, "repositoryId"],
      item.nodeId,
    );
    assertRunValueMatches(
      tracked.aiAnalysis,
      item.aiAnalysis,
      ["snapshot", "collection", "items", item.nodeId, "aiAnalysis"],
      item.nodeId,
    );
  }
  for (const origin of origins) {
    if (origin.origin !== "current") continue;
    const nodeId = aiOriginItemNodeId(snapshot, origin.path);
    if (nodeId != null && byId.get(nodeId)?.kind === "retained") {
      throw new RunCompletenessError("invalid_reference", nodeId, origin.path, undefined);
    }
  }
}

/** 固定baseの前回追跡項目と保持したAI状態の全フィールドを照合する。 */
export function assertRetainedItemAiAnalysisMatchesBase(
  snapshot: RunSnapshot,
  lineage: readonly FinalItemAiLineage[],
  previous:
    | Readonly<{
        items: readonly Readonly<{
          nodeId: GitHubNodeId;
          repositoryId: GitHubRepositoryId;
          aiAnalysis: TrackedItemAiAnalysis;
        }>[];
      }>
    | undefined,
): void {
  const saved = runValuesById(snapshot.items, (item) => item.nodeId, ["snapshot", "items"]);
  const previousItems = runValuesById(previous?.items ?? [], (item) => item.nodeId, [
    "previousSnapshot",
    "items",
  ]);
  for (const entry of lineage) {
    if (entry.kind !== "retained") continue;
    const item = saved.get(entry.nodeId);
    const retained = previousItems.get(entry.nodeId);
    if (item == null || retained == null) {
      throw new RunCompletenessError(
        "wrong_owner",
        entry.nodeId,
        ["finalItemAiLineage", entry.nodeId],
        undefined,
      );
    }
    assertRunValueMatches(
      retained.repositoryId,
      item.repositoryId,
      ["snapshot", "items", entry.nodeId, "repositoryId"],
      entry.nodeId,
    );
    assertRunValueMatches(
      retained.aiAnalysis,
      item.aiAnalysis,
      ["snapshot", "items", entry.nodeId, "aiAnalysis"],
      entry.nodeId,
    );
  }
}
