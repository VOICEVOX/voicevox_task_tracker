import { parseSha256Hash } from "../canonical-json/index.js";
import type { AiCacheKey } from "../codex/cache.js";
import type { PersonalReminderAiCacheKey } from "../codex/personal-reminder-cache.js";
import { joinStatePath, type StatePersistenceConfiguration } from "./branch-adapter.js";

const CACHE_KEY_PREFIX = "sha256:";

export function cachePath(
  configuration: StatePersistenceConfiguration,
  cacheKey: AiCacheKey,
): string {
  parseSha256Hash(cacheKey);
  return joinStatePath(
    configuration.aiCacheDirectory,
    `${cacheKey.slice(CACHE_KEY_PREFIX.length)}.json`,
  );
}

export function personalReminderAiCachePath(
  configuration: StatePersistenceConfiguration,
  cacheKey: PersonalReminderAiCacheKey,
): string {
  parseSha256Hash(cacheKey);
  return joinStatePath(
    configuration.personalReminderAiCacheDirectory,
    `${cacheKey.slice(CACHE_KEY_PREFIX.length)}.json`,
  );
}
