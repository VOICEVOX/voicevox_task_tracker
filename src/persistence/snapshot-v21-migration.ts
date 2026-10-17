import { z } from "zod";

import type { AiCacheKey } from "../codex/cache.js";
import { AI_ANALYSIS_ELEMENTS } from "../domain/ai-analysis-elements.js";
import type { LegacyAiCacheEntry } from "./ai-cache-migration.js";
import { StateFormatError } from "./errors.js";
import { migrateVersion19FinalGraphProjection } from "./snapshot-final-graph-migration.js";
import { migrateStateSnapshot as migrateVersion20Snapshot } from "./snapshot-v20-migration.js";
import type { StateSnapshot as StateSnapshotVersion20 } from "./snapshot-v20-contracts.js";
import { version19SnapshotFields } from "./snapshot-v20.js";
import { collectLegacyProofsForMigration } from "./snapshot-v21-legacy-proof.js";
import { migrateLegacyCurrentAi } from "./snapshot-ai-proof-migration.js";
import { migrateSeparatedLegacyCurrentAi } from "./snapshot-separated-ai-proof-migration.js";
import { migratePersonalReminderSubjectChanges } from "./snapshot-v21-personal-reminder-migration.js";
import {
  createStateSnapshot,
  createLegacyStateSnapshot,
  type StateSnapshot,
} from "./snapshot-v21.js";

const snapshotVersionSchema = z.object({ schemaVersion: z.string() });

function currentAiAnalysis(
  analysis: StateSnapshotVersion20["items"][number]["aiAnalysis"],
): unknown {
  const current: Record<string, unknown> = {};
  const retained: Record<string, unknown> = {};
  for (const element of AI_ANALYSIS_ELEMENTS) {
    const adopted = analysis.adoptedElements[element];
    if (adopted == null) {
      continue;
    }
    if (analysis.applications[element].status === "current_ai") {
      current[element] = adopted;
    } else {
      retained[element] = adopted;
    }
  }
  return {
    ...analysis,
    adoptedElements: current,
    retainedElements: retained,
  };
}

/** 旧世代snapshotのAI採用値を現在値と履歴へ分離する。 */
export function migrateStateSnapshot(
  source: string,
  legacyEntriesByCacheKey: ReadonlyMap<AiCacheKey, LegacyAiCacheEntry>,
  timezone: string,
): StateSnapshot {
  let value: unknown;
  try {
    const parseJson: (text: string) => unknown = JSON.parse;
    value = parseJson(source);
  } catch (error: unknown) {
    throw new StateFormatError("snapshot", { cause: error });
  }
  const version = snapshotVersionSchema.safeParse(value);
  if (!version.success) {
    throw StateFormatError.fromZodError("snapshot", version.error);
  }
  if (version.data.schemaVersion === "21") {
    return createStateSnapshot(migrateSeparatedLegacyCurrentAi(createLegacyStateSnapshot(value)));
  }
  const legacy =
    version.data.schemaVersion === "19" || version.data.schemaVersion === "20"
      ? collectLegacyProofsForMigration(value, version.data.schemaVersion)
      : null;
  const previous = migrateVersion20Snapshot(source, legacyEntriesByCacheKey, timezone);
  const migrated = legacy == null ? previous : migrateLegacyCurrentAi(previous, legacy);
  const current =
    migrated === previous
      ? previous
      : migrateVersion19FinalGraphProjection(
          version19SnapshotFields(migratePersonalReminderSubjectChanges(migrated)),
          previous.finalGraphProjection.timezone,
        );
  return createStateSnapshot({
    ...current,
    schemaVersion: "21",
    items: current.items.map((item) => ({
      ...item,
      aiAnalysis: currentAiAnalysis(item.aiAnalysis),
    })),
    collection: {
      repositories: current.collection.repositories.map((repository) => ({
        ...repository,
        items: repository.items.map((item) => ({
          ...item,
          aiAnalysis: currentAiAnalysis(item.aiAnalysis),
        })),
      })),
    },
  });
}
