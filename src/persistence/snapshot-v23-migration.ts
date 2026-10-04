import { z } from "zod";

import type { AiCacheKey } from "../codex/cache.js";
import { normalizeVerifiedExternalReferences } from "../domain/verified-external-reference.js";
import type { LegacyAiCacheEntry } from "./ai-cache-migration.js";
import { StateFormatError } from "./errors.js";
import { migrateStateSnapshot as migrateVersion22Snapshot } from "./snapshot-v22-migration.js";
import { createStateSnapshot, parseStateSnapshot, type StateSnapshot } from "./snapshot-v23.js";

const snapshotVersionSchema = z.object({ schemaVersion: z.string() });

/** 旧世代の検証済み外部ghostだけを公開参照証明へ移して現行形式にする。 */
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
  if (version.data.schemaVersion === "23") {
    return parseStateSnapshot(source);
  }
  const previous = migrateVersion22Snapshot(source, legacyEntriesByCacheKey, timezone);
  return createStateSnapshot({
    ...previous,
    schemaVersion: "23",
    verifiedExternalReferences: normalizeVerifiedExternalReferences(
      previous.externalReferences.map((reference) => ({
        repositoryFullName: reference.repositoryFullName,
        number: reference.number,
        url: reference.url,
      })),
    ),
  });
}
