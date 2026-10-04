import { randomUUID } from "node:crypto";

import type { StateCommitReceiptEvidence } from "../../application/tracking-run/observed-state-commit.js";
import { parseReceipt } from "../../application/tracking-run/receipt-codec.js";
import type { InitialStateCommitReceipt } from "../../application/tracking-run/receipt-schema.js";
import { serializeCanonicalJson } from "../../canonical-json/value.js";
import type { Config } from "../../config/index.js";
import {
  parseStateHistoryRecords,
  serializeStateHistoryRecords,
  type StateBranchAdapter,
  type StateFileReadResult,
  type StateHistoryRecord,
  type StatePersistenceConfiguration,
  type StateSnapshot,
} from "../../persistence/index.js";
import { assertStateValuesPublicSafety } from "../../persistence/public-safety.js";
import { parseStateSnapshot } from "../../persistence/snapshot-v23.js";
import { verifyRunTransactionFiles } from "../../persistence/state-transaction-files.js";
import { nodeContentDigestPort as digest } from "./content-digest.js";
import {
  resumeInitialPagesBuild,
  type InitialPagesBuildInput,
} from "./publication-resume-inputs.js";
import { projectPublicationSettings } from "./publication/settings.js";
import { observeStateCommitAtRevision } from "./state-receipt-observation.js";

/** 初回state revisionから一度だけPagesへ投影する保存済み入力。 */
export type InitialPagesSource = Readonly<{
  resume: InitialPagesBuildInput;
  snapshot: StateSnapshot;
  historyRecords: readonly StateHistoryRecord[];
}>;

function requiredSource(files: ReadonlyMap<string, StateFileReadResult>, path: string): string {
  const file = files.get(path);
  if (file?.status !== "present") {
    throw new TypeError(`Pages buildに必要なstate fileがありません。対象: ${path}`);
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(file.bytes);
}

/** exact stateの全履歴fileをcanonical形式で読む。 */
export function readPagesHistoryRecords(
  files: ReadonlyMap<string, StateFileReadResult>,
  historyDirectory: string,
): readonly StateHistoryRecord[] {
  const paths = [...files.keys()].filter((path) => path.startsWith(`${historyDirectory}/`)).sort();
  const records: StateHistoryRecord[] = [];
  for (const path of paths) {
    const date = path.slice(historyDirectory.length + 1);
    if (!/^\d{4}-\d{2}-\d{2}\.jsonl$/u.test(date)) {
      throw new TypeError("Pages buildのhistory file名が不正です");
    }
    const source = requiredSource(files, path);
    const fileRecords = parseStateHistoryRecords(source);
    if (
      source !== serializeStateHistoryRecords(fileRecords) ||
      fileRecords.some((record) => `${record.date}.jsonl` !== date)
    ) {
      throw new TypeError("Pages buildのhistory fileがcanonical recordではありません");
    }
    records.push(...fileRecords);
  }
  return Object.freeze(records);
}

/** 初回receiptをexact commitの再観測結果へ結び付ける。 */
export async function verifyInitialStateCommitReceiptAtRevision(
  adapter: StateBranchAdapter,
  stateConfiguration: StatePersistenceConfiguration,
  initialReceipt: InitialStateCommitReceipt,
  observedAt: string,
): Promise<Extract<StateCommitReceiptEvidence, { receiptType: "initial_state_commit" }>> {
  const receipt = parseReceipt(initialReceipt, digest);
  if (
    receipt.receiptType !== "initial_state_commit" ||
    receipt.phaseSequence !== 1 ||
    receipt.previousReceiptDigest != null
  ) {
    throw new TypeError("初回Pagesのstate commit receiptが初回の連鎖位置にありません");
  }
  const revision = receipt.result.resultingStateRevision;
  const observed = await observeStateCommitAtRevision(
    adapter,
    stateConfiguration,
    revision,
    revision,
    "initial_state_commit",
    { invocationId: randomUUID(), observedAt, position: { kind: "first" } },
  );
  if (observed.evidence.receiptType !== "initial_state_commit") {
    throw new TypeError("初回Pagesのstate commit証拠の種別が不正です");
  }
  if (
    serializeCanonicalJson(receipt.result) !== serializeCanonicalJson(observed.receipt.result) ||
    serializeCanonicalJson(receipt.binding) !== serializeCanonicalJson(observed.receipt.binding) ||
    receipt.operationId !== observed.receipt.operationId
  ) {
    throw new TypeError("初回Pagesのstate commit receiptとexact commitが一致しません");
  }
  return observed.evidence;
}

/** receiptのresulting revisionとexact treeのrecord、marker、snapshot、履歴を照合する。 */
export async function readInitialPagesSource(
  adapter: StateBranchAdapter,
  config: Config,
  stateConfiguration: StatePersistenceConfiguration,
  initialReceipt: InitialStateCommitReceipt,
  knownSecrets: readonly string[],
  now: () => Date,
): Promise<InitialPagesSource> {
  const receipt = parseReceipt(initialReceipt, digest);
  if (receipt.receiptType !== "initial_state_commit") {
    throw new TypeError("初回Pages buildには初回state commit receiptが必要です");
  }
  const revision = receipt.result.resultingStateRevision;
  const paths = await adapter.listFiles(revision, "state");
  const files = await adapter.readFiles(revision, paths);
  if (files.size !== paths.length || paths.some((path) => files.get(path)?.status !== "present")) {
    throw new TypeError("初回Pages buildのexact state file一覧が不足しています");
  }
  const transaction = verifyRunTransactionFiles(files, stateConfiguration);
  if (transaction?.marker.phase !== "initial_state_committed") {
    throw new TypeError("初回Pages buildのexact stateに初回run transactionがありません");
  }
  const record = transaction.record;
  const projection = record.initialPagesProjection;
  const evidence = await verifyInitialStateCommitReceiptAtRevision(
    adapter,
    stateConfiguration,
    receipt,
    now().toISOString(),
  );
  if (
    serializeCanonicalJson(projectPublicationSettings(config).pages) !==
      serializeCanonicalJson(projection.settings) ||
    projection.snapshot.path !== stateConfiguration.snapshotPath ||
    projection.snapshot.digest !== transaction.snapshotDigest
  ) {
    throw new TypeError("初回Pages buildのreceipt、record、設定またはsnapshotが一致しません");
  }
  const allowlist = projection.repositoryAllowlist;
  let previousRepositoryId: string | undefined;
  for (const repository of allowlist) {
    if (previousRepositoryId != null && repository.id <= previousRepositoryId) {
      throw new TypeError("初回Pages buildの公開allowlistの順序が不正です");
    }
    previousRepositoryId = repository.id;
  }
  const snapshot = parseStateSnapshot(requiredSource(files, stateConfiguration.snapshotPath));
  const historyRecords = readPagesHistoryRecords(files, stateConfiguration.historyDirectory);
  const matching = historyRecords.filter((record) => record.runId === transaction.marker.runId);
  if (
    snapshot.run.id !== transaction.marker.runId ||
    snapshot.generatedAt !== projection.generatedAt ||
    matching.length !== 1 ||
    matching[0]?.date !== projection.generatedAt.slice(0, 10)
  ) {
    throw new TypeError("初回Pages buildのsnapshotと当日history recordが一致しません");
  }
  assertStateValuesPublicSafety(
    [transaction.marker, record, ...historyRecords],
    allowlist,
    snapshot.verifiedExternalReferences,
    knownSecrets,
  );
  const resume = resumeInitialPagesBuild(
    {
      record,
      state: {
        revision,
        snapshotDigest: transaction.snapshotDigest,
        normalNotificationLedgerDigest: transaction.notificationLedgerDigest,
        marker: transaction.marker,
      },
      expectedRevision: revision,
      initialStateCommitReceipt: receipt,
      ...(receipt.receiptKind === "observed" ? { initialStateCommitEvidence: evidence } : {}),
    },
    digest,
  );
  return Object.freeze({ resume, snapshot, historyRecords });
}
