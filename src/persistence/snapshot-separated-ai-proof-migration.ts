import { hashCanonicalJson } from "../canonical-json/index.js";
import { AI_ANALYSIS_ELEMENTS } from "../domain/ai-analysis-elements.js";
import type { TrackedItemAiAnalysis } from "../domain/index.js";
import { createFinalGraphProjection } from "../graph/final-graph-projection.js";
import { assertNonNullable } from "../util/index.js";
import { migrateLegacyCurrentAi } from "./snapshot-ai-proof-migration.js";
import { migratePersonalReminderSubjectChanges } from "./snapshot-v21-personal-reminder-migration.js";
import type { StateSnapshot as StateSnapshotVersion21 } from "./snapshot-v21.js";
import type { StateSnapshot as StateSnapshotVersion22 } from "./snapshot-v22.js";

function currentElementKeys(
  items: readonly Readonly<{ nodeId: string; aiAnalysis: TrackedItemAiAnalysis }>[],
): ReadonlySet<string> {
  return new Set(
    items.flatMap((item) =>
      AI_ANALYSIS_ELEMENTS.filter(
        (element) => item.aiAnalysis.applications[element].status === "current_ai",
      ).map((element) => JSON.stringify([item.nodeId, element])),
    ),
  );
}

function retainAdoptedElements(analysis: TrackedItemAiAnalysis): unknown {
  return {
    ...analysis,
    adoptedElements: {},
    retainedElements: { ...analysis.retainedElements, ...analysis.adoptedElements },
  };
}

/** 当時のschemaと意味検証を通った旧21・22のAI採用値を履歴へ移す。 */
export function migrateSeparatedLegacyCurrentAi(
  snapshot: StateSnapshotVersion21 | StateSnapshotVersion22,
): unknown {
  const keys = {
    tracked: currentElementKeys(snapshot.items),
    collection: currentElementKeys(
      snapshot.collection.repositories.flatMap((repository) => repository.items),
    ),
  };
  if (keys.tracked.size === 0 && keys.collection.size === 0) return snapshot;
  const migrated = migratePersonalReminderSubjectChanges(migrateLegacyCurrentAi(snapshot, keys));
  const projection = snapshot.finalGraphProjection;
  const deadlineLevels = new Map(projection.items.map((item) => [item.nodeId, item.deadlineLevel]));
  const finalGraphProjection = createFinalGraphProjection({
    evaluatedAt: projection.evaluatedAt,
    timezone: projection.timezone,
    items: migrated.items.map((item) => {
      const deadlineLevel = deadlineLevels.get(item.nodeId);
      assertNonNullable(deadlineLevel, "旧snapshotの最終graph投影に項目がありません");
      return { ...item, deadlineLevel };
    }),
    staleRepositoryIds: new Set(
      snapshot.repositories
        .filter((repository) => repository.freshness === "stale")
        .map((repository) => repository.id),
    ),
    relations: migrated.relations,
    effectiveStateByNodeId: projection.nodes.map((node) => [node.nodeId, node.effectiveState]),
    analysis: {
      dependencyCycles: projection.dependencyCycles.map((cycle) => ({
        ...cycle,
        edges: cycle.edgeIds.map((id) => ({ id })),
      })),
      actionableFrontier: projection.frontierNodeIds,
      downstreamImpacts: projection.nodes.map((node) => ({
        nodeId: node.nodeId,
        ...node.downstreamImpact,
      })),
    },
  });
  return {
    ...migrated,
    items: migrated.items.map((item) => ({
      ...item,
      aiAnalysis: retainAdoptedElements(item.aiAnalysis),
    })),
    collection: {
      repositories: migrated.collection.repositories.map((repository) => ({
        ...repository,
        items: repository.items.map((item) => ({
          ...item,
          aiAnalysis: retainAdoptedElements(item.aiAnalysis),
        })),
      })),
    },
    finalGraphProjection,
    finalGraphProjectionDigest: hashCanonicalJson(finalGraphProjection),
  };
}
