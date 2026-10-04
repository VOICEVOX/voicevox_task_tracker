import { serializeCanonicalJson } from "../../canonical-json/value.js";
import type {
  StateFileReadResult,
  StateFileUpdate,
  StatePersistenceConfiguration,
} from "../../persistence/branch-adapter.js";
import { assertInitialStateBusinessContent } from "../../persistence/initial-state-write-manifest.js";
import { assertStatePublicSafety } from "../../persistence/public-safety.js";
import { parseStateSnapshot } from "../../persistence/snapshot-v23.js";
import { verifyRunTransactionFiles } from "../../persistence/state-transaction-files.js";
import { nodeContentDigestPort as digest } from "./content-digest.js";
import type { BoundPublicationCheckpoint } from "./publication-checkpoint-binding.js";
import { materializeDurablePublicationRecord } from "./durable-record.js";
import { validatedRunPayloadRepositoryInventory } from "./validated-run-payload.js";

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
  updates: readonly StateFileUpdate[],
  knownSecrets: readonly string[],
): void {
  const verified = verifyRunTransactionFiles(files, configuration);
  if (verified == null) {
    throw new TypeError("初回commit候補にrun transactionがありません");
  }
  const manifest = verified.record.initialStateWriteManifest;
  if (manifest == null) {
    throw new TypeError("初回commit候補にwrite manifestがありません");
  }
  const record = materializeDurablePublicationRecord(bound, digest, manifest);
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
  const snapshotFile = files.get(configuration.snapshotPath);
  if (snapshotFile?.status !== "present") {
    throw new TypeError("初回commit候補のsnapshotがありません");
  }
  const snapshot = parseStateSnapshot(
    new TextDecoder("utf-8", { fatal: true }).decode(snapshotFile.bytes),
  );
  const values: unknown[] = [];
  for (const [path, file] of files) {
    if (file.status !== "present") {
      throw new TypeError("初回commit候補の一覧に欠落したfileがあります");
    }
    values.push(...parseStateValues(path, file.bytes));
  }
  assertStatePublicSafety({
    snapshot,
    repositoryInventory: validatedRunPayloadRepositoryInventory(bound.validatedPayload),
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
}
