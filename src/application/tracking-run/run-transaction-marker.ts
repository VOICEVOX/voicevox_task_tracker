import { z } from "zod";

import { serializeCanonicalJsonLine } from "../../canonical-json/value.js";
import { gitCommitRevisionSchema } from "./contracts/revision.js";
import type { InitialPagesPublicationEvidence } from "./initial-pages-evidence-codec.js";
import { readRunTransactionMarkerRecoveryBootstrap } from "./recovery-bootstrap.js";

const sha256Schema = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
const runIdSchema = z.string().regex(/^tracker-run:[0-9a-f]{64}$/u);
const parentRevisionSchema = z.union([gitCommitRevisionSchema, z.literal("unborn")]);
const markerFields = {
  recoveryBootstrapVersion: z.literal(1),
  schemaVersion: z.literal(1),
  runId: runIdSchema,
  checkpointDigest: sha256Schema,
  baseStateRevision: parentRevisionSchema,
  expectedParentStateRevision: parentRevisionSchema,
  snapshotDigest: sha256Schema,
  notificationLedgerDigest: sha256Schema,
  publicationRecordDigest: sha256Schema,
};
const initialMarkerSchema = z.strictObject({
  ...markerFields,
  phase: z.literal("initial_state_committed"),
  phaseSequence: z.literal(1),
});
const notificationMarkerFields = {
  ...markerFields,
  phaseSequence: z.number().int().min(2),
  initialStateRevision: gitCommitRevisionSchema,
  initialPagesPublicationEvidenceDigest: sha256Schema,
  lastMessageDeliveryId: z.string().min(1).max(1000).optional(),
};
const inProgressMarkerSchema = z.strictObject({
  ...notificationMarkerFields,
  phase: z.literal("notifications_in_progress"),
});
const settledMarkerSchema = z.strictObject({
  ...notificationMarkerFields,
  phase: z.literal("notifications_settled"),
});
const finalizedMarkerSchema = z.strictObject({
  ...notificationMarkerFields,
  phase: z.literal("run_finalized"),
  finalRunReportDigest: sha256Schema,
});

export const RUN_TRANSACTION_MARKER_SCHEMA_VERSION = 1;
export const runTransactionMarkerSchema = z.discriminatedUnion("phase", [
  initialMarkerSchema,
  inProgressMarkerSchema,
  settledMarkerSchema,
  finalizedMarkerSchema,
]);

/** runのstate内進捗を表すV1 marker。 */
export type RunTransactionMarker = z.output<typeof runTransactionMarkerSchema>;

/** markerの全fieldとV1回復入口を検証する。 */
export function parseRunTransactionMarker(value: unknown): RunTransactionMarker {
  const marker = runTransactionMarkerSchema.parse(value);
  readRunTransactionMarkerRecoveryBootstrap(
    new TextEncoder().encode(serializeCanonicalJsonLine(marker)),
  );
  if (
    marker.phase !== "initial_state_committed" &&
    marker.expectedParentStateRevision === "unborn"
  ) {
    throw new TypeError("通知開始後のmarkerには実在する親revisionが必要です");
  }
  return marker;
}

/** canonical JSONとして保存したmarkerを読む。 */
export function decodeRunTransactionMarker(bytes: Uint8Array): RunTransactionMarker {
  const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const bootstrap = readRunTransactionMarkerRecoveryBootstrap(bytes);
  const value: unknown = JSON.parse(source);
  const marker = parseRunTransactionMarker(value);
  if (source !== serializeCanonicalJsonLine(marker)) {
    throw new TypeError("markerがcanonical JSONではありません");
  }
  if (
    marker.runId !== bootstrap.runId ||
    marker.checkpointDigest !== bootstrap.checkpointDigest ||
    marker.publicationRecordDigest !== bootstrap.publicationRecordDigest
  ) {
    throw new TypeError("markerの回復入口と全fieldが一致しません");
  }
  return marker;
}

/** markerをcanonical JSONとして保存する。 */
export function serializeRunTransactionMarker(marker: RunTransactionMarker): string {
  return serializeCanonicalJsonLine(parseRunTransactionMarker(marker));
}

/** 同一runのmarkerを次のstate commitへ進める条件を検証する。 */
export function assertRunTransactionMarkerTransition(
  previous: RunTransactionMarker | undefined,
  next: RunTransactionMarker,
  actualParentStateRevision: string,
  initialPagesEvidence: InitialPagesPublicationEvidence | undefined,
): void {
  parseRunTransactionMarker(next);
  if (next.expectedParentStateRevision !== actualParentStateRevision) {
    throw new TypeError("markerの親revisionがCASの実際の親と一致しません");
  }
  if (previous == null) {
    if (next.phase !== "initial_state_committed" || initialPagesEvidence != null) {
      throw new TypeError("初回state commitのmarkerまたはPages証拠が不正です");
    }
    return;
  }
  if (previous.phase === "run_finalized") {
    if (next.phase !== "initial_state_committed" || next.runId === previous.runId) {
      throw new TypeError("完了済みrunのmarkerを上書きできません");
    }
    return;
  }
  if (
    next.runId !== previous.runId ||
    next.checkpointDigest !== previous.checkpointDigest ||
    next.publicationRecordDigest !== previous.publicationRecordDigest ||
    next.baseStateRevision !== previous.baseStateRevision ||
    next.phaseSequence !== previous.phaseSequence + 1
  ) {
    throw new TypeError("markerのrun identityまたは連続したphase sequenceが不正です");
  }
  const phaseOrder = [
    "initial_state_committed",
    "notifications_in_progress",
    "notifications_settled",
    "run_finalized",
  ];
  if (phaseOrder.indexOf(next.phase) < phaseOrder.indexOf(previous.phase)) {
    throw new TypeError("markerのphaseは後戻りできません");
  }
  if (
    (previous.phase === "initial_state_committed" &&
      next.phase !== "notifications_in_progress" &&
      next.phase !== "notifications_settled") ||
    (previous.phase === "notifications_in_progress" &&
      next.phase !== "notifications_in_progress" &&
      next.phase !== "notifications_settled") ||
    (previous.phase === "notifications_settled" && next.phase !== "run_finalized") ||
    (next.phase !== "run_finalized" && next.snapshotDigest !== previous.snapshotDigest)
  ) {
    throw new TypeError("markerのphase遷移またはsnapshot digestが不正です");
  }
  if (next.phase === "initial_state_committed" || initialPagesEvidence == null) {
    throw new TypeError("通知開始後のmarkerには初回Pages証拠が必要です");
  }
  if (
    next.runId !== initialPagesEvidence.runId ||
    next.checkpointDigest !== initialPagesEvidence.checkpointDigest ||
    next.initialPagesPublicationEvidenceDigest !== initialPagesEvidence.evidenceDigest ||
    next.initialStateRevision !== initialPagesEvidence.sourceStateRevision ||
    (previous.phase !== "initial_state_committed" &&
      (next.initialStateRevision !== previous.initialStateRevision ||
        next.initialPagesPublicationEvidenceDigest !==
          previous.initialPagesPublicationEvidenceDigest))
  ) {
    throw new TypeError("markerと初回Pages証拠が一致しません");
  }
}
