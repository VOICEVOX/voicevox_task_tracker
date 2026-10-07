import {
  createAiCacheMigrationPlan,
  type AiCacheMigrationFile,
  type AiCacheMigrationPlan,
} from "./ai-cache-migration.js";
import type {
  StateBranchAdapter,
  StateBranchHead,
  StatePersistenceConfiguration,
} from "./branch-adapter.js";
import { StateFormatError } from "./errors.js";
import { decodeStateFile } from "./state-file-codec.js";

/** state branchにある旧AI cacheの移行計画を読み取る。 */
export async function readAiCacheMigrationPlan(
  adapter: StateBranchAdapter,
  configuration: StatePersistenceConfiguration,
  head: StateBranchHead,
): Promise<AiCacheMigrationPlan> {
  if (head.status === "missing") {
    return createAiCacheMigrationPlan(configuration.aiCacheDirectory, []);
  }
  const paths = await adapter.listFiles(head.revision, configuration.aiCacheDirectory);
  if (paths.length === 0) {
    return createAiCacheMigrationPlan(configuration.aiCacheDirectory, []);
  }
  const results = await adapter.readFiles(head.revision, paths);
  const files: AiCacheMigrationFile[] = [];
  for (const path of paths) {
    const result = results.get(path);
    if (result == null) {
      throw new StateFormatError("AI cache", {
        cause: new TypeError("一覧にあるAI cacheを一括で読み取れません"),
      });
    }
    const source = decodeStateFile(result, "AI cache");
    if (source == null) {
      throw new StateFormatError("AI cache", {
        cause: new TypeError("一覧にあるAI cacheを読み取れません"),
      });
    }
    files.push(
      Object.freeze({
        path,
        source,
      }),
    );
  }
  return createAiCacheMigrationPlan(configuration.aiCacheDirectory, files);
}
