import { type AiCacheKey } from "../codex/cache.js";
import { type LegacyAiCacheEntry } from "./ai-cache-migration.js";
import { StateFormatError } from "./errors.js";
import type { StateSnapshot } from "./snapshot-contracts.js";
import { parseJson, snapshotVersionSchema } from "./snapshot-migration-schema.js";
import {
  migrateLegacyStateSnapshot,
  migrateVersion11StateSnapshot,
  migrateVersion12StateSnapshot,
  migrateVersion13StateSnapshot,
  migrateVersion14StateSnapshot,
  migrateVersion15StateSnapshot,
  migrateVersion16StateSnapshot,
  migrateVersion17StateSnapshot,
  migrateVersion18StateSnapshot,
} from "./snapshot-migration-versions.js";
import { parseStateSnapshot } from "./snapshot.js";

/** snapshotをschema versionに応じて現行形式へ変換する。 */
export function migrateStateSnapshot(
  source: string,
  legacyEntriesByCacheKey: ReadonlyMap<AiCacheKey, LegacyAiCacheEntry>,
): StateSnapshot {
  const versionResult = snapshotVersionSchema.safeParse(parseJson(source));
  if (!versionResult.success) {
    throw StateFormatError.fromZodError("snapshot", versionResult.error);
  }
  switch (versionResult.data.schemaVersion) {
    case "19":
      return parseStateSnapshot(source);
    case "18":
      return migrateVersion18StateSnapshot(source);
    case "10":
      return migrateLegacyStateSnapshot(source, legacyEntriesByCacheKey);
    case "11":
      return migrateVersion11StateSnapshot(source);
    case "12":
      return migrateVersion12StateSnapshot(source);
    case "13":
      return migrateVersion13StateSnapshot(source);
    case "14":
      return migrateVersion14StateSnapshot(source);
    case "15":
      return migrateVersion15StateSnapshot(source);
    case "16":
      return migrateVersion16StateSnapshot(source);
    case "17":
      return migrateVersion17StateSnapshot(source);
    default:
      throw new StateFormatError("snapshot", {
        cause: new TypeError("snapshotのschemaVersionは未対応です"),
      });
  }
}
