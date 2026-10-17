import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

import { z } from "zod";
import {
  serializeCanonicalJson,
  serializeCanonicalJsonLine,
} from "../../dist/canonical-json/value.js";
import { strictZeroSnapshotSourceDigests } from "../../dist/infrastructure/tracking-run/runtime/validation/sandbox-strict-zero-source-proof.js";
import { parseStateNotificationLedger } from "../../dist/persistence/state-documents.js";
import { sha256 } from "./sandbox-continuity-result.mjs";

const digest = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
const runId = z.string().regex(/^tracker-run:[0-9a-f]{64}$/u);
const revision = z.string().regex(/^[0-9a-f]{40}$/u);
const sourceDigests = z.strictObject({
  repositories: digest,
  collectionItems: digest,
  references: digest,
  itemSources: digest,
  notificationCurrent: digest,
  timeConditions: digest,
});
const unboundProofSchema = z.strictObject({
  schemaVersion: z.literal(1),
  runId,
  configDigest: digest,
  evaluatedAt: z.iso.datetime({ offset: true }),
  notificationItemCount: z.number().int().positive(),
  sourceDigests,
});
const boundProofSchema = unboundProofSchema.extend({
  checkpointDigest: digest,
  checkpointFileDigest: digest,
  finalStateRevision: revision,
  unboundProofDigest: digest,
});

function assertSame(actual, expected, label) {
  if (serializeCanonicalJson(actual) !== serializeCanonicalJson(expected)) {
    throw new TypeError(`${label}が一致しません`);
  }
}

function keyDigests(keys) {
  const digests = keys.map((key) => sha256(key)).sort();
  if (new Set(digests).size !== digests.length) {
    throw new TypeError("strict-zeroの通知keyに重複があります");
  }
  return digests;
}

function previousLedger(stateRepositoryPath, revision) {
  return parseStateNotificationLedger(
    execFileSync(
      "git",
      ["-C", stateRepositoryPath, "show", `${revision}:state/notification-ledger.json`],
      {
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
      },
    ),
  );
}

function sentEntries(ledger) {
  return ledger.entries.filter((entry) => entry.status === "sent");
}

/** strict-zeroの収集証拠をremote checkpointとsnapshotへ結び付ける。 */
export function bindStrictZeroSourceProof(input) {
  if (input.evidence.kind !== "artifact_cross_checked") {
    throw new TypeError("strict-zeroにはremote recordと照合済みcheckpointが必要です");
  }
  const unboundBytes = readFileSync(input.unboundProofPath);
  if (input.evidence.strictZeroSourceProofDigest == null) {
    throw new TypeError("strict-zeroのcheckpointにsource proof digestがありません");
  }
  const unboundProofDigest = sha256(unboundBytes);
  assertSame(
    unboundProofDigest,
    input.evidence.strictZeroSourceProofDigest,
    "strict-zeroのcheckpoint source proof digest",
  );
  const unbound = unboundProofSchema.parse(JSON.parse(unboundBytes.toString("utf8")));
  assertSame(unbound.runId, input.runId, "strict-zeroのrun ID");
  assertSame(unbound.configDigest, input.record.configDigest, "strict-zeroのconfig digest");
  assertSame(
    unbound.evaluatedAt,
    input.evidence.validatedPayload.validation.core.evaluatedAt,
    "strict-zeroの評価時刻",
  );
  const remoteDigests = strictZeroSnapshotSourceDigests(input.snapshot);
  for (const [name, remoteDigest] of Object.entries(remoteDigests)) {
    assertSame(unbound.sourceDigests[name], remoteDigest, `strict-zeroのremote ${name}`);
  }
  const bound = boundProofSchema.parse({
    ...unbound,
    checkpointDigest: input.record.checkpointDigest,
    checkpointFileDigest: input.record.checkpointFileDigest,
    finalStateRevision: input.finalStateRevision,
    unboundProofDigest,
  });
  const bytes = serializeCanonicalJsonLine(bound);
  writeFileSync(input.outputPath, bytes, { flag: "wx", mode: 0o600 });
  return { proof: bound, digest: sha256(bytes) };
}

/** strict-zeroのfirstまたはsecondの通知結果を検証する。 */
export function assertStrictZeroNotificationCoverage(input) {
  const {
    phase,
    record,
    ledger,
    messageReceipts,
    historyBuild,
    historyPages,
    baseStateRevision,
    stateRepositoryPath,
    first,
    sourceProof,
    firstSourceProofPath,
    metrics,
  } = input;
  const previous = previousLedger(stateRepositoryPath, baseStateRevision);
  const previousSent = new Map(
    sentEntries(previous).map((entry) => [entry.notificationKey, entry]),
  );
  const currentSent = sentEntries(ledger);
  const newSent = currentSent.filter((entry) => !previousSent.has(entry.notificationKey));
  const receiptKeys = messageReceipts.flatMap((entry) => entry.result.notificationKeys);
  const selected = record.notificationOutbox.selectedContext;
  if (phase === "first") {
    if (
      record.notificationOutbox.delivery !== "send" ||
      selected.action !== "create_digest" ||
      selected.candidates.length === 0 ||
      ledger.pendingNotifications.length !== 0 ||
      messageReceipts.length === 0 ||
      historyBuild.status !== "built" ||
      historyPages.status !== "deployed"
    ) {
      throw new TypeError("strict-zero firstの送信、pendingまたは履歴Pagesが不正です");
    }
    const selectedKeys = selected.ledgerReservations.map((entry) => entry.notificationKey);
    assertSame(
      keyDigests(selectedKeys),
      keyDigests(receiptKeys),
      "strict-zero firstの選別とreceipt",
    );
    assertSame(
      keyDigests(selectedKeys),
      keyDigests(newSent.map((entry) => entry.notificationKey)),
      "strict-zero firstの選別と新sent",
    );
    return { sourceProofDigest: sourceProof.digest, pendingCount: 0, newSentCount: newSent.length };
  }
  if (first == null || firstSourceProofPath == null) {
    throw new TypeError("strict-zero secondにfirst証拠がありません");
  }
  const firstBytes = readFileSync(firstSourceProofPath);
  const firstProof = boundProofSchema.parse(JSON.parse(firstBytes.toString("utf8")));
  assertSame(firstProof.runId, first.trackingRunId, "strict-zero first proofのrun ID");
  assertSame(
    firstProof.finalStateRevision,
    first.finalStateRevision,
    "strict-zero first proofのF1",
  );
  assertSame(
    firstProof.checkpointDigest,
    first.checkpointDigest,
    "strict-zero first proofのcheckpoint",
  );
  assertSame(
    firstProof.checkpointFileDigest,
    first.checkpointFileDigest,
    "strict-zero first proofのcheckpoint file",
  );
  assertSame(firstProof.configDigest, sourceProof.proof.configDigest, "strict-zeroのconfig digest");
  assertSame(
    firstProof.sourceDigests,
    sourceProof.proof.sourceDigests,
    "strict-zeroの通知実効source入力",
  );
  assertSame(
    firstProof.notificationItemCount,
    sourceProof.proof.notificationItemCount,
    "strict-zeroの通知項目数",
  );
  const firstLedger = previousLedger(stateRepositoryPath, first.finalStateRevision);
  if (
    firstLedger.pendingNotifications.length !== 0 ||
    ledger.pendingNotifications.length !== 0 ||
    record.notificationOutbox.delivery !== "no_candidates" ||
    selected.action !== "skip_digest" ||
    selected.reason !== "no_candidates" ||
    selected.candidates.length !== 0 ||
    selected.ledgerReservations.length !== 0 ||
    messageReceipts.length !== 0 ||
    newSent.length !== 0 ||
    historyBuild.status !== "not_required" ||
    historyPages.status !== "not_required" ||
    metrics.itemCount < 1 ||
    metrics.changedItemCount >= metrics.itemCount
  ) {
    throw new TypeError("strict-zero secondのsend 0件、履歴Pagesまたは増分収集が不正です");
  }
  assertSame(
    currentSent.map((entry) => serializeCanonicalJson(entry)).sort(),
    sentEntries(firstLedger)
      .map((entry) => serializeCanonicalJson(entry))
      .sort(),
    "strict-zeroのsent metadata",
  );
  return { sourceProofDigest: sourceProof.digest, pendingCount: 0, newSentCount: 0 };
}

/** firstのproof artifactとcoverage bindingを照合する。 */
export function assertFirstStrictZeroSourceProof(path, coverage) {
  const bytes = readFileSync(path);
  const proof = boundProofSchema.parse(JSON.parse(bytes.toString("utf8")));
  assertSame(
    sha256(bytes),
    coverage.strictZero.sourceProofDigest,
    "strict-zero first proof digest",
  );
  assertSame(proof.runId, coverage.run.trackingRunId, "strict-zero first proof run ID");
  assertSame(
    proof.checkpointDigest,
    coverage.checkpoint.checkpointDigest,
    "strict-zero first proof checkpoint",
  );
  assertSame(
    proof.finalStateRevision,
    coverage.run.finalStateRevision,
    "strict-zero first proof revision",
  );
  if (coverage.strictZero.pendingCount !== 0 || coverage.strictZero.newSentCount < 1) {
    throw new TypeError("strict-zero first coverageの通知送信が不正です");
  }
}
