import type { PerformanceDetailObserver } from "../../application/tracking-run/contracts/performance-detail-observation.js";
import {
  DURABLE_PUBLICATION_RECORD_STATE_PATH_V1,
  INITIAL_PAGES_PUBLICATION_EVIDENCE_STATE_PATH_V1,
  RUN_TRANSACTION_MARKER_STATE_PATH_V1,
} from "../../application/tracking-run/contracts/recovery-paths.js";
import {
  parseRunTransactionMarker,
  serializeRunTransactionMarker,
} from "../../application/tracking-run/run-transaction-marker.js";
import {
  canonicalJsonPieces,
  serializeCanonicalJson,
  serializeCanonicalJsonLine,
} from "../../canonical-json/value.js";
import { createAiCacheEntry } from "../../codex/cache.js";
import { createPersonalReminderAiCacheEntry } from "../../codex/personal-reminder-cache.js";
import {
  joinStatePath,
  type StateBranchAdapter,
  type StateBranchHead,
  type StateFileReadResult,
  type StateFileUpdate,
  type StatePersistenceConfiguration,
} from "../../persistence/branch-adapter.js";
import { readExactStateSnapshot } from "../../persistence/exact-state-snapshot.js";
import {
  appendStateHistoryRecord,
  createStateHistoryRecord,
  parseStateHistoryRecords,
} from "../../persistence/history.js";
import type { InitialPublicationFileState } from "../../persistence/initial-publication-base-state.js";
import { assertStatePublicSafety } from "../../persistence/public-safety.js";
import {
  assertPersonalReminderEvidenceClosure,
  assertPersonalReminderEvidenceRecordsClosure,
  createStateSnapshot,
  serializeStateSnapshot,
} from "../../persistence/snapshot-v23.js";
import { createPersonalReminderEvidenceSourceIndex } from "../../persistence/snapshot-evidence-closure.js";
import { readAiCacheMigrationPlan } from "../../persistence/state-ai-cache-migration-plan.js";
import { cachePath, personalReminderAiCachePath } from "../../persistence/state-cache-paths.js";
import { createStateNotificationLedger } from "../../persistence/state-documents.js";
import { initialNotificationLedger } from "../../persistence/state-initial-notification-transition.js";
import {
  createStateLedgerUpdates,
  loadStateNotificationLedgers,
} from "../../persistence/state-ledger-files.js";
import {
  durablePublicationRecordTemplateSchema,
  encodeDurablePublicationRecord,
} from "../../publication/durable-record-schema.js";
import { normalNotificationLedgerValue } from "../../publication/publication-order.js";
import { createInitialStateWriteManifest } from "../../persistence/initial-state-write-manifest.js";
import { nodeContentDigestPort as digest } from "./content-digest.js";
import { materializeDurablePublicationRecord } from "./durable-record.js";
import type { InitialStateCommitObserver } from "./initial-state-commit-progress.js";
import type { BoundPublicationCheckpoint } from "./publication-checkpoint-binding.js";

type PreparedInitialFiles = Readonly<{
  updates: readonly StateFileUpdate[];
  deletions: readonly string[];
}>;

function assertFileState(file: StateFileReadResult, expected: InitialPublicationFileState): void {
  if (
    file.status !== expected.status ||
    (file.status === "present" &&
      expected.status === "present" &&
      digest.sha256Bytes(file.bytes) !== expected.digest)
  ) {
    throw new TypeError("初回公開計画のbase file byte digestが実際の親treeと一致しません");
  }
}

function assertValueDigests(
  bound: BoundPublicationCheckpoint,
  observeProgress: InitialStateCommitObserver | undefined,
): void {
  const writeSet = bound.publicationPlan.initialStateWriteSet;
  const initialStateWriteManifest = digest.sha256Utf8(
    serializeCanonicalJson(writeSet.paths.initialStateWriteManifest),
  );
  observeProgress?.("snapshot_digest");
  const snapshot = digest.sha256Utf8Chunks(canonicalJsonPieces(writeSet.snapshot));
  observeProgress?.("history_digest");
  const historyInputEvents = digest.sha256Utf8(serializeCanonicalJson(writeSet.historyInputEvents));
  observeProgress?.("ai_cache_digest");
  const aiCacheAdditions = digest.sha256Utf8(serializeCanonicalJson(writeSet.aiCacheAdditions));
  observeProgress?.("personal_cache_digest");
  const personalReminderAiCacheAdditions = digest.sha256Utf8(
    serializeCanonicalJson(writeSet.personalReminderAiCacheAdditions),
  );
  observeProgress?.("ledger_digest");
  const notificationLedger = digest.sha256Utf8(
    serializeCanonicalJson(normalNotificationLedgerValue(writeSet.notificationLedger)),
  );
  const actual = {
    initialStateWriteManifest,
    snapshot,
    historyInputEvents,
    aiCacheAdditions,
    personalReminderAiCacheAdditions,
    notificationLedger,
  };
  if (serializeCanonicalJson(actual) !== serializeCanonicalJson(writeSet.valueDigests)) {
    throw new TypeError("公開計画の業務値digestがwrite setと一致しません");
  }
}

function assertStatePaths(
  bound: BoundPublicationCheckpoint,
  configuration: StatePersistenceConfiguration,
): void {
  const paths = bound.publicationPlan.initialStateWriteSet.paths;
  const expectedHistoryPath = joinStatePath(
    configuration.historyDirectory,
    `${bound.publicationPlan.initialStateWriteSet.snapshot.generatedAt.slice(0, 10)}.jsonl`,
  );
  if (
    paths.snapshotPath !== configuration.snapshotPath ||
    paths.historyPath !== expectedHistoryPath ||
    paths.notificationLedgerPath !== configuration.notificationLedgerPath ||
    paths.aiCacheDirectory !== configuration.aiCacheDirectory ||
    paths.personalReminderAiCacheDirectory !== configuration.personalReminderAiCacheDirectory ||
    paths.runReportsDirectory !== configuration.runReportsDirectory ||
    bound.publicationPlan.initialPagesProjection.snapshot.path !== configuration.snapshotPath ||
    bound.publicationPlan.initialStateWriteSet.previousInitialPagesEvidence.path !==
      INITIAL_PAGES_PUBLICATION_EVIDENCE_STATE_PATH_V1
  ) {
    throw new TypeError("公開計画のstate pathが保存設定と一致しません");
  }
}

/** checkpointのwrite setを実際のCAS親treeから初回commit fileへ変換する。 */
export async function prepareInitialStateFiles(
  bound: BoundPublicationCheckpoint,
  adapter: StateBranchAdapter,
  configuration: StatePersistenceConfiguration,
  migrationTimezone: string,
  parent: StateBranchHead,
  knownSecrets: readonly string[],
  observeProgress: InitialStateCommitObserver | undefined,
  observePerformanceDetail: PerformanceDetailObserver | undefined,
): Promise<PreparedInitialFiles> {
  assertStatePaths(bound, configuration);
  observeProgress?.("value_digests");
  assertValueDigests(bound, observeProgress);
  const writeSet = bound.publicationPlan.initialStateWriteSet;
  observeProgress?.("snapshot_normalization");
  const snapshot = createStateSnapshot(writeSet.snapshot);
  const ledger = createStateNotificationLedger(writeSet.notificationLedger);
  const inventory = bound.repositoryInventory;
  const aiCachePaths = writeSet.aiCacheAdditions.map((entry) =>
    cachePath(configuration, entry.cacheKey),
  );
  const personalCachePaths = writeSet.personalReminderAiCacheAdditions.map((entry) =>
    personalReminderAiCachePath(configuration, entry.cacheKey),
  );
  const basePaths = [
    writeSet.paths.historyPath,
    INITIAL_PAGES_PUBLICATION_EVIDENCE_STATE_PATH_V1,
    ...writeSet.paths.oldCacheDeletionPaths,
    ...aiCachePaths,
    ...personalCachePaths,
  ];
  observeProgress?.("base_state_read");
  const [previous, migration, previousLedger, baseFiles] = await Promise.all([
    readExactStateSnapshot(adapter, configuration, migrationTimezone, parent),
    readAiCacheMigrationPlan(adapter, configuration, parent),
    loadStateNotificationLedgers(adapter, configuration, parent),
    parent.status === "missing"
      ? Promise.resolve(
          new Map<string, StateFileReadResult>(
            basePaths.map((path) => [path, { status: "missing" }]),
          ),
        )
      : adapter.readFiles(parent.revision, [...new Set(basePaths)]),
  ]);
  observeProgress?.("base_state_validation");
  if (
    digest.sha256Utf8(serializeCanonicalJson(normalNotificationLedgerValue(previousLedger))) !==
    bound.publicationPlan.notificationOutbox.previousLedgerDigest
  ) {
    throw new TypeError("公開計画の前回通常ledgerがCAS親と一致しません");
  }
  const previousSnapshot = previous.status === "available" ? previous.snapshot : undefined;
  if (
    (parent.status === "missing" && previous.status !== "missing_branch") ||
    (parent.status === "present" && previous.status === "missing_branch")
  ) {
    throw new TypeError("CAS親のsnapshot状態が不正です");
  }
  const historyFile = baseFiles.get(writeSet.paths.historyPath) ?? { status: "missing" };
  const evidenceFile = baseFiles.get(INITIAL_PAGES_PUBLICATION_EVIDENCE_STATE_PATH_V1) ?? {
    status: "missing",
  };
  assertFileState(historyFile, writeSet.paths.historyBase);
  assertFileState(evidenceFile, writeSet.previousInitialPagesEvidence.expectedBase);
  if (
    serializeCanonicalJson(migration.legacyCachePaths) !==
      serializeCanonicalJson(writeSet.paths.oldCacheDeletionPaths) ||
    serializeCanonicalJson(writeSet.deletions) !==
      serializeCanonicalJson(
        [
          ...migration.legacyCachePaths,
          ...(evidenceFile.status === "present"
            ? [INITIAL_PAGES_PUBLICATION_EVIDENCE_STATE_PATH_V1]
            : []),
        ].sort(),
      )
  ) {
    throw new TypeError("公開計画の旧cacheまたはPages証拠削除pathがCAS親と一致しません");
  }
  for (const path of writeSet.deletions) {
    if (baseFiles.get(path)?.status !== "present") {
      throw new TypeError("削除対象の旧state fileがCAS親にありません");
    }
  }
  observeProgress?.("evidence_closure");
  assertPersonalReminderEvidenceClosure(snapshot);
  observePerformanceDetail?.({
    step: "closure_current_complete",
    count: snapshot.items.length + snapshot.relations.length,
  });
  if (previousSnapshot != null) {
    const evidenceIndex = createPersonalReminderEvidenceSourceIndex([
      ...snapshot.items.map((item) => item.evidence),
      ...snapshot.relations.map((relation) => relation.evidence),
      ...previousSnapshot.items.map((item) => item.evidence),
      ...previousSnapshot.relations.map((relation) => relation.evidence),
    ]);
    assertPersonalReminderEvidenceRecordsClosure(snapshot, evidenceIndex);
  }
  observePerformanceDetail?.({
    step: "closure_prior_records_complete",
    count:
      previousSnapshot == null
        ? 0
        : previousSnapshot.items.length + previousSnapshot.relations.length,
  });
  observeProgress?.("history");
  const historyRecord = createStateHistoryRecord(
    previousSnapshot,
    snapshot,
    snapshot.generatedAt.slice(0, 10),
    inventory,
    writeSet.historyInputEvents,
  );
  const oldHistory =
    historyFile.status === "present"
      ? new TextDecoder("utf-8", { fatal: true }).decode(historyFile.bytes)
      : undefined;
  const historySource = appendStateHistoryRecord(oldHistory, historyRecord);
  const historyRecords = parseStateHistoryRecords(historySource);
  observeProgress?.("cache_normalization");
  const aiCache = writeSet.aiCacheAdditions.map((value) => createAiCacheEntry(value));
  const personalCache = writeSet.personalReminderAiCacheAdditions.map((value) =>
    createPersonalReminderAiCacheEntry(value),
  );
  if (
    serializeCanonicalJson(aiCache) !== serializeCanonicalJson(writeSet.aiCacheAdditions) ||
    serializeCanonicalJson(personalCache) !==
      serializeCanonicalJson(writeSet.personalReminderAiCacheAdditions)
  ) {
    throw new TypeError("初回cache entryが公開計画の業務値から変化しました");
  }
  observeProgress?.("ledger_validation");
  const mergedLedger = createStateNotificationLedger({
    ...ledger,
    operationsAlerts: previousLedger.operationsAlerts,
  });
  const recordTemplate = durablePublicationRecordTemplateSchema.parse(
    bound.publicationPlan.durableRecordTemplate,
  );
  if (
    serializeCanonicalJson(normalNotificationLedgerValue(mergedLedger)) !==
    serializeCanonicalJson(
      normalNotificationLedgerValue(initialNotificationLedger(previousLedger, recordTemplate)),
    )
  ) {
    throw new TypeError("初回commitのledgerが固定outboxと親stateから導出した値と一致しません");
  }
  const historyUpdate = {
    path: writeSet.paths.historyPath,
    bytes: new TextEncoder().encode(historySource),
  };
  observeProgress?.("cache_encoding");
  const aiCacheUpdates = aiCache.map((entry) => ({
    path: cachePath(configuration, entry.cacheKey),
    bytes: new TextEncoder().encode(serializeCanonicalJsonLine(entry)),
  }));
  const personalCacheUpdates = personalCache.map((entry) => ({
    path: personalReminderAiCachePath(configuration, entry.cacheKey),
    bytes: new TextEncoder().encode(serializeCanonicalJsonLine(entry)),
  }));
  const manifest = createInitialStateWriteManifest(
    historyUpdate,
    historyRecord,
    aiCacheUpdates,
    personalCacheUpdates,
    writeSet.deletions,
    baseFiles,
  );
  observeProgress?.("record_materialization");
  const record = materializeDurablePublicationRecord(bound, digest, manifest);
  const marker = parseRunTransactionMarker({
    recoveryBootstrapVersion: 1,
    schemaVersion: 1,
    runId: record.runIdentity.runId,
    checkpointDigest: record.checkpointDigest,
    baseStateRevision:
      bound.checkpoint.baseStateRevision.status === "missing"
        ? "unborn"
        : bound.checkpoint.baseStateRevision.revision,
    phase: "initial_state_committed",
    phaseSequence: 1,
    expectedParentStateRevision: parent.status === "missing" ? "unborn" : parent.revision,
    snapshotDigest: record.initialStateContentDigests.snapshot,
    notificationLedgerDigest: record.initialStateContentDigests.notificationLedger,
    publicationRecordDigest: record.recordDigest,
  });
  observeProgress?.("public_safety");
  assertStatePublicSafety({
    snapshot,
    repositoryInventory: inventory,
    repositoryAllowlist: bound.publicationPlan.initialPagesProjection.repositoryAllowlist,
    additionalValues: [
      ...historyRecords,
      ...aiCache,
      ...personalCache,
      mergedLedger,
      record,
      marker,
    ],
    knownSecrets,
  });
  observeProgress?.("snapshot_encoding");
  const snapshotUpdate = {
    path: configuration.snapshotPath,
    bytes: new TextEncoder().encode(serializeStateSnapshot(snapshot)),
  };
  observeProgress?.("ledger_encoding");
  const ledgerUpdates = await createStateLedgerUpdates(
    adapter,
    configuration,
    parent,
    mergedLedger,
    "tracking_run",
  );
  observeProgress?.("record_encoding");
  const updates: StateFileUpdate[] = [
    snapshotUpdate,
    historyUpdate,
    ...ledgerUpdates,
    ...aiCacheUpdates,
    ...personalCacheUpdates,
    {
      path: DURABLE_PUBLICATION_RECORD_STATE_PATH_V1,
      bytes: encodeDurablePublicationRecord(record, digest),
    },
    {
      path: RUN_TRANSACTION_MARKER_STATE_PATH_V1,
      bytes: new TextEncoder().encode(serializeRunTransactionMarker(marker)),
    },
  ];
  updates.sort((left, right) => left.path.localeCompare(right.path, "en"));
  observeProgress?.("files_prepared");
  return Object.freeze({ updates, deletions: writeSet.deletions });
}
