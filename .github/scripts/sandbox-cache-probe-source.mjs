import { execFileSync } from "node:child_process";
import { URL } from "node:url";

import { createAiCacheEntry } from "../../dist/codex/cache.js";
import { loadConfig } from "../../dist/config/index.js";
import { readFirstFileCacheProbeSource } from "../../dist/infrastructure/tracking-run/sandbox-cache-probe-source.js";
import { parseStateSnapshot } from "../../dist/persistence/snapshot-v23.js";
import { parseDurablePublicationRecord } from "../../dist/publication/durable-record-schema.js";
import { nodeContentDigestPort } from "../../dist/infrastructure/tracking-run/content-digest.js";
import { createSandboxGenericAiInputBinding } from "../../dist/infrastructure/tracking-run/sandbox-generic-ai-input-proof.js";

/** F1のsnapshotと実file cacheから候補を読み取る。 */
export async function firstFileCacheProbeSource(repositoryPath, revision, firstRunId) {
  const readFile = (path) =>
    execFileSync("git", ["show", `${revision}:${path}`], {
      cwd: repositoryPath,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
  const snapshot = parseStateSnapshot(readFile("state/snapshot.json"));
  if (snapshot.run.id !== firstRunId) {
    throw new TypeError("firstのsnapshotとtracking run IDが一致しません");
  }
  const config = await loadConfig(new URL("../../config.yml", import.meta.url));
  const cacheDirectory = config.state.aiCacheDirectory;
  const paths = new Set(
    execFileSync("git", ["ls-tree", "-r", "--name-only", revision, "--", cacheDirectory], {
      cwd: repositoryPath,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    })
      .trim()
      .split("\n"),
  );
  return readFirstFileCacheProbeSource(snapshot, {
    read: async (cacheKey) => {
      const path = `${cacheDirectory}/${cacheKey.slice("sha256:".length)}.json`;
      if (!paths.has(path)) {
        return { status: "miss" };
      }
      return { status: "hit", entry: createAiCacheEntry(JSON.parse(readFile(path))) };
    },
  });
}

/** firstの完了情報とexact recordから実入力証拠の期待bindingを作る。 */
export function firstAnalysisInputBinding(repositoryPath, revision, result, context) {
  const record = parseDurablePublicationRecord(
    JSON.parse(
      execFileSync("git", ["show", `${revision}:state/durable-publication-record-v1.json`], {
        cwd: repositoryPath,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
      }),
    ),
    nodeContentDigestPort,
  );
  if (
    record.schemaVersion !== 3 ||
    record.analysisStageRecord.baseStateRevision.status !== "present" ||
    result.continuityPhase !== "first" ||
    result.environmentId !== context.environmentId ||
    result.codeRevision !== context.codeRevision ||
    result.finalStateRevision !== revision ||
    record.runIdentity.runId !== result.trackingRunId ||
    record.runtimeIdentity.codeRevision !== result.codeRevision ||
    record.analysisStageRecord.baseStateRevision.revision !== result.baseStateRevision ||
    record.recordDigest !== result.publicationRecordDigest ||
    record.checkpointDigest !== result.checkpointDigest ||
    record.checkpointFileDigest !== result.checkpointFileDigest
  ) {
    throw new TypeError("firstの実入力証拠の期待bindingが完了情報とexact recordに一致しません");
  }
  return createSandboxGenericAiInputBinding(
    {
      ...context,
      workflowRunId: result.actionsRunId,
      workflowRunAttempt: result.actionsRunAttempt,
      baseStateRevision: result.baseStateRevision,
    },
    record.runIdentity,
  );
}
