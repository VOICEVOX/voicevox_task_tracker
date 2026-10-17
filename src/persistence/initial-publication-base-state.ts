import type { InitialStateWriteManifest } from "../application/tracking-run/contracts/initial-state-write-manifest.js";
import { INITIAL_PAGES_PUBLICATION_EVIDENCE_STATE_PATH_V1 } from "../application/tracking-run/contracts/recovery-paths.js";
import type { Sha256Hash } from "../canonical-json/sha256.js";
import { serializeCanonicalJson, serializeCanonicalJsonLine } from "../canonical-json/value.js";
import type { AiCacheEntry } from "../codex/cache.js";
import type { PersonalReminderAiCacheEntry } from "../codex/personal-reminder-cache.js";
import type { Repository } from "../domain/index.js";
import { sortByKey } from "../publication/publication-order.js";
import { nodeContentDigestPort as digest } from "../infrastructure/tracking-run/content-digest.js";
import {
  joinStatePath,
  type StateBranchAdapter,
  type StateBranchHead,
  type StateFileReadResult,
  type StatePersistenceConfiguration,
} from "./branch-adapter.js";
import { appendStateHistoryRecord, createStateHistoryRecord } from "./history.js";
import type { StateHistoryInputEvent } from "./history-contracts.js";
import { createInitialStateWriteManifest } from "./initial-state-write-manifest.js";
import type { StateSnapshot } from "./snapshot-v23.js";
import { assertNonNullable } from "../util/assert-non-nullable.js";
import { cachePath, personalReminderAiCachePath } from "./state-cache-paths.js";

/** 初回公開計画へ固定する親fileと書込みmanifest。 */
export type InitialPublicationBaseState = Readonly<{
  historyPath: string;
  historyBase: InitialPublicationFileState;
  previousInitialPagesEvidence: InitialPublicationFileState;
  oldCacheDeletionPaths: readonly string[];
  initialStateWriteManifest: InitialStateWriteManifest;
}>;

/** 固定revisionにある公開関連fileの有無とbyte digest。 */
export type InitialPublicationFileState =
  Readonly<{ status: "missing" }> | Readonly<{ status: "present"; digest: Sha256Hash }>;

function fileState(file: StateFileReadResult): InitialPublicationFileState {
  return file.status === "missing"
    ? Object.freeze({ status: "missing" })
    : Object.freeze({ status: "present", digest: digest.sha256Bytes(file.bytes) });
}

/** 固定revisionと確定済み業務値から初回書込みの期待manifestを作る。 */
export async function readInitialPublicationBaseState(
  adapter: StateBranchAdapter,
  configuration: StatePersistenceConfiguration,
  head: StateBranchHead,
  previousSnapshot: StateSnapshot | undefined,
  snapshot: StateSnapshot,
  inventory: readonly Repository[],
  historyInputEvents: readonly StateHistoryInputEvent[],
  aiCache: readonly AiCacheEntry[],
  personalCache: readonly PersonalReminderAiCacheEntry[],
  oldCacheDeletionPaths: readonly string[],
): Promise<InitialPublicationBaseState> {
  const historyPath = joinStatePath(
    configuration.historyDirectory,
    `${snapshot.generatedAt.slice(0, 10)}.jsonl`,
  );
  const aiCacheUpdates = aiCache.map((entry) => ({
    path: cachePath(configuration, entry.cacheKey),
    bytes: new TextEncoder().encode(serializeCanonicalJsonLine(entry)),
  }));
  const personalCacheUpdates = personalCache.map((entry) => ({
    path: personalReminderAiCachePath(configuration, entry.cacheKey),
    bytes: new TextEncoder().encode(serializeCanonicalJsonLine(entry)),
  }));
  const paths = [
    ...new Set([
      historyPath,
      INITIAL_PAGES_PUBLICATION_EVIDENCE_STATE_PATH_V1,
      ...oldCacheDeletionPaths,
      ...aiCacheUpdates.map((entry) => entry.path),
      ...personalCacheUpdates.map((entry) => entry.path),
    ]),
  ];
  const before =
    head.status === "missing"
      ? new Map<string, StateFileReadResult>(paths.map((path) => [path, { status: "missing" }]))
      : await adapter.readFiles(head.revision, paths);
  const history = before.get(historyPath);
  const evidence = before.get(INITIAL_PAGES_PUBLICATION_EVIDENCE_STATE_PATH_V1);
  assertNonNullable(history, "公開計画の固定revisionから履歴を読み取れません");
  assertNonNullable(evidence, "公開計画の固定revisionからPages証拠を読み取れません");
  const record = createStateHistoryRecord(
    previousSnapshot,
    snapshot,
    snapshot.generatedAt.slice(0, 10),
    inventory,
    sortByKey(historyInputEvents, (event) => serializeCanonicalJson(event)),
  );
  const historySource = appendStateHistoryRecord(
    history.status === "present"
      ? new TextDecoder("utf-8", { fatal: true }).decode(history.bytes)
      : undefined,
    record,
  );
  const deletions = [
    ...oldCacheDeletionPaths,
    ...(evidence.status === "present" ? [INITIAL_PAGES_PUBLICATION_EVIDENCE_STATE_PATH_V1] : []),
  ].sort();
  return Object.freeze({
    historyPath,
    historyBase: fileState(history),
    previousInitialPagesEvidence: fileState(evidence),
    oldCacheDeletionPaths: Object.freeze([...oldCacheDeletionPaths].sort()),
    initialStateWriteManifest: createInitialStateWriteManifest(
      { path: historyPath, bytes: new TextEncoder().encode(historySource) },
      record,
      aiCacheUpdates,
      personalCacheUpdates,
      deletions,
      before,
    ),
  });
}
