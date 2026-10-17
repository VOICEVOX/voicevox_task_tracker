import { serializeCanonicalJson } from "../../canonical-json/value.js";
import type {
  StateFileReadResult,
  StateFileUpdate,
  StatePersistenceConfiguration,
} from "../../persistence/branch-adapter.js";
import { assertInitialStateBusinessContent } from "../../persistence/initial-state-write-manifest.js";
import { assertStatePublicSafety } from "../../persistence/public-safety.js";
import {
  runTransactionSnapshot,
  type VerifiedRunTransactionFiles,
} from "../../persistence/state-transaction-files.js";
import { nodeContentDigestPort as digest } from "./content-digest.js";
import type { InitialStateCommitObserver } from "./initial-state-commit-progress.js";
import type { BoundPublicationCheckpoint } from "./publication-checkpoint-binding.js";
import { materializeDurablePublicationRecord } from "./durable-record.js";

function parseStateValues(path: string, bytes: Uint8Array): readonly unknown[] {
  const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const parseJson: (value: string) => unknown = JSON.parse;
  if (path.endsWith(".jsonl")) {
    if (!source.endsWith("\n")) {
      throw new TypeError("候補stateのJSON Linesが改行で終わっていません");
    }
    return source
      .slice(0, -1)
      .split("\n")
      .map((line) => parseJson(line));
  }
  if (!path.endsWith(".json")) {
    throw new TypeError("候補stateに公開検査できないfileがあります");
  }
  return [parseJson(source)];
}

/** 初回commit候補の実byte、全公開値、transaction結合を公開前に検証する。 */
export function verifyInitialStateCandidate(
  bound: BoundPublicationCheckpoint,
  configuration: StatePersistenceConfiguration,
  files: ReadonlyMap<string, StateFileReadResult>,
  verified: VerifiedRunTransactionFiles,
  updates: readonly StateFileUpdate[],
  knownSecrets: readonly string[],
  observeProgress: InitialStateCommitObserver | undefined,
): void {
  observeProgress?.("candidate_transaction");
  const manifest = verified.record.initialStateWriteManifest;
  if (manifest == null) {
    throw new TypeError("初回commit候補にwrite manifestがありません");
  }
  const record = materializeDurablePublicationRecord(bound, digest, manifest);
  observeProgress?.("candidate_content");
  assertInitialStateBusinessContent(
    manifest,
    record.initialStateContentDigests,
    configuration,
    files,
  );
  if (
    verified.marker.phase !== "initial_state_committed" ||
    verified.initialPagesEvidence != null ||
    verified.record.recordDigest !== record.recordDigest ||
    verified.record.checkpointFileDigest !== bound.binding.checkpointFileDigest ||
    verified.snapshotDigest !== record.initialStateContentDigests.snapshot ||
    verified.notificationLedgerDigest !== record.initialStateContentDigests.notificationLedger
  ) {
    throw new TypeError("初回commit候補のrecord、marker、snapshot、ledgerが一致しません");
  }
  for (const update of updates) {
    if (
      update.path !== bound.publicationPlan.initialStateWriteSet.paths.historyPath &&
      !update.path.startsWith(`${configuration.aiCacheDirectory}/`) &&
      !update.path.startsWith(`${configuration.personalReminderAiCacheDirectory}/`)
    ) {
      continue;
    }
    const file = files.get(update.path);
    if (
      file?.status !== "present" ||
      digest.sha256Bytes(file.bytes) !== digest.sha256Bytes(update.bytes)
    ) {
      throw new TypeError("初回commit候補の履歴またはcacheの実byte digestが一致しません");
    }
  }
  observeProgress?.("candidate_snapshot");
  const snapshot = runTransactionSnapshot(verified);
  if (snapshot.schemaVersion !== "23")
    throw new TypeError("初回commit候補には現行snapshotが必要です");
  observeProgress?.("candidate_public_values");
  const values: unknown[] = [];
  for (const path of files.keys()) {
    if (path === configuration.snapshotPath) {
      values.push(snapshot);
      continue;
    }
    const file = files.get(path);
    if (file?.status !== "present") {
      throw new TypeError("初回commit候補の一覧に欠落したfileがあります");
    }
    values.push(...parseStateValues(path, file.bytes));
  }
  observeProgress?.("candidate_public_safety");
  assertStatePublicSafety({
    snapshot,
    repositoryInventory: bound.repositoryInventory,
    repositoryAllowlist: bound.publicationPlan.initialPagesProjection.repositoryAllowlist,
    additionalValues: values,
    knownSecrets,
  });
  if (
    serializeCanonicalJson(verified.record.initialStateContentDigests) !==
    serializeCanonicalJson(bound.publicationPlan.initialStateWriteSet.valueDigests)
  ) {
    throw new TypeError("初回commit候補の業務digestがcheckpointと一致しません");
  }
  observeProgress?.("candidate_verified");
}
