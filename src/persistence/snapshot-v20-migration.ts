import { z } from "zod";

import type { AiCacheKey } from "../codex/cache.js";
import type { LegacyAiCacheEntry } from "./ai-cache-migration.js";
import { StateFormatError } from "./errors.js";
import { migrateVersion19FinalGraphProjection } from "./snapshot-final-graph-migration.js";
import { migrateStateSnapshot as migrateVersion19Snapshot } from "./snapshot-migration.js";
import { parseStateSnapshot } from "./snapshot-v20.js";
import type { StateSnapshot } from "./snapshot-v20-contracts.js";

const snapshotVersionSchema = z.object({ schemaVersion: z.string() });

/** 旧世代snapshotを入口で現行形式へ一方向移行する。 */
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
  if (version.data.schemaVersion === "20") {
    return parseStateSnapshot(source);
  }
  return migrateVersion19FinalGraphProjection(
    migrateVersion19Snapshot(source, legacyEntriesByCacheKey),
    timezone,
  );
}
