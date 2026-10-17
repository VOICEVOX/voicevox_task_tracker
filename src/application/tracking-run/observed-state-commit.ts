import { serializeCanonicalJson } from "../../canonical-json/value.js";
import { z } from "zod";
import type { ContentDigestPort } from "./contracts/content-digest-port.js";
import { sealObservedReceipt, type ReceiptDraft } from "./receipt-codec.js";
import type {
  InitialStateCommitReceipt,
  NotificationSettlementReceipt,
  RunFinalizationReceipt,
} from "./receipt-schema.js";
import { runTransactionMarkerSchema } from "./run-transaction-marker.js";

type StateCommitReceipt =
  InitialStateCommitReceipt | NotificationSettlementReceipt | RunFinalizationReceipt;

/** 観測receiptを列先頭または直前receiptへ連結する位置。 */
export type ObservedStateCommitPosition =
  | Readonly<{ kind: "first" }>
  | Readonly<{
      kind: "after";
      previousReceiptDigest: string;
      previousPhaseSequence: number;
    }>;

const sha256Schema = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
const revisionSchema = z.string().regex(/^[0-9a-f]{40}$/u);
const runIdSchema = z.string().regex(/^tracker-run:[0-9a-f]{64}$/u);
const operationIdSchema = z.string().regex(/^operation:v1:[0-9a-f]{64}$/u);
const stateCommitEvidenceBaseSchema = z.strictObject({
  marker: runTransactionMarkerSchema,
  record: z.strictObject({
    runId: runIdSchema,
    checkpointDigest: sha256Schema,
    checkpointFileDigest: sha256Schema,
    runtimeIdentityDigest: sha256Schema,
    recordDigest: sha256Schema,
    notificationAction: z.enum(["send", "hold", "acknowledge-current"]),
  }),
  commit: z.strictObject({
    revision: revisionSchema,
    parentRevision: z.union([revisionSchema, z.literal("unborn")]),
    operationId: operationIdSchema,
    runId: runIdSchema,
    commitScope: z.literal("tracking_run"),
    changedPathManifestDigest: sha256Schema,
  }),
  expectedTrackingStateRevision: z.union([revisionSchema, z.literal("unborn")]),
  interveningOperationsAlertCommits: z.array(revisionSchema),
  snapshotDigest: sha256Schema,
  notificationLedgerDigest: sha256Schema,
});

export const stateCommitReceiptEvidenceSchema = z.discriminatedUnion("receiptType", [
  stateCommitEvidenceBaseSchema.extend({ receiptType: z.literal("initial_state_commit") }),
  stateCommitEvidenceBaseSchema.extend({
    receiptType: z.literal("notification_settlement"),
    notificationHistoryDigest: sha256Schema,
  }),
  stateCommitEvidenceBaseSchema.extend({
    receiptType: z.literal("run_finalization"),
    runReportDigest: sha256Schema,
  }),
]);

/** exact stateとGit commitから検証したstate書き込みの観測根拠。 */
export type StateCommitReceiptEvidence = z.output<typeof stateCommitReceiptEvidenceSchema>;

function assertStateCommitEvidence(evidence: StateCommitReceiptEvidence): void {
  const { marker, record, commit } = evidence;
  if (
    marker.runId !== record.runId ||
    marker.checkpointDigest !== record.checkpointDigest ||
    marker.publicationRecordDigest !== record.recordDigest ||
    marker.snapshotDigest !== evidence.snapshotDigest ||
    marker.notificationLedgerDigest !== evidence.notificationLedgerDigest ||
    marker.expectedParentStateRevision !== commit.parentRevision ||
    commit.runId !== record.runId ||
    (evidence.interveningOperationsAlertCommits.length === 0 &&
      commit.parentRevision !== evidence.expectedTrackingStateRevision) ||
    (evidence.interveningOperationsAlertCommits.length > 0 &&
      evidence.interveningOperationsAlertCommits.at(-1) !== commit.parentRevision)
  ) {
    throw new TypeError("state commitの観測根拠がmarkerまたは親revisionと一致しません");
  }
  if (
    (evidence.receiptType === "initial_state_commit" &&
      (marker.phase !== "initial_state_committed" ||
        marker.baseStateRevision !== evidence.expectedTrackingStateRevision)) ||
    (evidence.receiptType === "notification_settlement" &&
      (marker.phase !== "notifications_settled" ||
        evidence.expectedTrackingStateRevision === "unborn")) ||
    (evidence.receiptType === "run_finalization" &&
      (marker.phase !== "run_finalized" ||
        marker.finalRunReportDigest !== evidence.runReportDigest ||
        evidence.expectedTrackingStateRevision === "unborn"))
  ) {
    throw new TypeError("state commitの観測根拠が対象stageと一致しません");
  }
}

/** stageとcheckpointからstate receiptの論理操作IDを確定する。 */
export function stateCommitReceiptOperationId(
  receiptType: StateCommitReceiptEvidence["receiptType"],
  runId: string,
  checkpointDigest: string,
  digest: ContentDigestPort,
): string {
  let stage: StateCommitReceipt["stage"];
  let phase: StateCommitReceipt["phase"];
  if (receiptType === "initial_state_commit") {
    stage = "initial_state_committed";
    phase = "initial";
  } else if (receiptType === "notification_settlement") {
    stage = "notifications_settled";
    phase = "notification";
  } else {
    stage = "run_finalized";
    phase = "finalization";
  }
  const identity = {
    bindingKind: "checkpoint",
    stage,
    phase,
    logicalTarget: checkpointDigest,
    runId,
  };
  return `operation:v1:${digest.sha256Utf8(serializeCanonicalJson(identity)).slice("sha256:".length)}`;
}

/** exact stateの業務内容からstate receiptの内容digestを作る。 */
export function digestStateCommitReceiptContent(
  evidence: StateCommitReceiptEvidence,
  digest: ContentDigestPort,
): string {
  return digest.sha256Utf8(
    serializeCanonicalJson({
      marker: evidence.marker,
      recordDigest: evidence.record.recordDigest,
      snapshotDigest: evidence.snapshotDigest,
      notificationLedgerDigest: evidence.notificationLedgerDigest,
      ...(evidence.receiptType === "notification_settlement"
        ? { notificationHistoryDigest: evidence.notificationHistoryDigest }
        : {}),
      ...(evidence.receiptType === "run_finalization"
        ? { runReportDigest: evidence.runReportDigest }
        : {}),
    }),
  );
}

/** 保存済みstateとcommitから新しい試行のobserved receiptを発行する。 */
export function observeStateCommitReceipt(
  evidence: StateCommitReceiptEvidence,
  observation: Readonly<{
    invocationId: string;
    observedAt: string;
    position: ObservedStateCommitPosition;
  }>,
  digest: ContentDigestPort,
): StateCommitReceipt {
  const parsed = stateCommitReceiptEvidenceSchema.parse(evidence);
  assertStateCommitEvidence(parsed);
  if (
    observation.position.kind === "after" &&
    (!Number.isSafeInteger(observation.position.previousPhaseSequence) ||
      observation.position.previousPhaseSequence < 1)
  ) {
    throw new TypeError("観測receiptの先行phase sequenceが不正です");
  }
  const { record, commit } = parsed;
  if (
    commit.operationId !==
    stateCommitReceiptOperationId(parsed.receiptType, record.runId, record.checkpointDigest, digest)
  ) {
    throw new TypeError("state commitのoperation IDがreceipt識別子と一致しません");
  }
  const binding = {
    bindingKind: "checkpoint",
    runId: record.runId,
    checkpointDigest: record.checkpointDigest,
    checkpointFileDigest: record.checkpointFileDigest,
    runtimeIdentityDigest: record.runtimeIdentityDigest,
  } satisfies Extract<InitialStateCommitReceipt["binding"], { bindingKind: "checkpoint" }>;
  const result = {
    expectedTrackingStateRevision: parsed.expectedTrackingStateRevision,
    actualParentStateRevision: commit.parentRevision,
    resultingStateRevision: commit.revision,
    stateContentDigest: digestStateCommitReceiptContent(parsed, digest),
    commitScope: commit.commitScope,
    commitMetadataVersion: 1,
    commitOperationId: commit.operationId,
    commitRunId: commit.runId,
    changedPathManifestVersion: 1,
    changedPathManifestDigest: commit.changedPathManifestDigest,
    interveningOperationsAlertCommits: [...parsed.interveningOperationsAlertCommits],
  } satisfies InitialStateCommitReceipt["result"];
  const common = {
    schemaVersion: 1,
    binding,
    logicalTarget: record.checkpointDigest,
    invocationId: observation.invocationId,
    localAttemptIndex: 0,
    phaseSequence:
      observation.position.kind === "first" ? 1 : observation.position.previousPhaseSequence + 1,
    ...(observation.position.kind === "first"
      ? {}
      : { previousReceiptDigest: observation.position.previousReceiptDigest }),
    receiptKind: "observed",
    observedAt: observation.observedAt,
    effectCertainty: "committed",
  } satisfies Pick<
    ReceiptDraft,
    | "schemaVersion"
    | "binding"
    | "logicalTarget"
    | "invocationId"
    | "localAttemptIndex"
    | "phaseSequence"
    | "receiptKind"
    | "observedAt"
    | "effectCertainty"
  >;
  let receipt;
  if (parsed.receiptType === "initial_state_commit") {
    receipt = sealObservedReceipt(
      {
        ...common,
        receiptType: "initial_state_commit",
        stage: "initial_state_committed",
        phase: "initial",
        expectedStateRevision:
          parsed.expectedTrackingStateRevision === "unborn"
            ? { status: "missing" }
            : parsed.expectedTrackingStateRevision,
        status: "committed",
        result,
      },
      digest,
    );
  } else if (parsed.receiptType === "notification_settlement") {
    receipt = sealObservedReceipt(
      {
        ...common,
        receiptType: "notification_settlement",
        stage: "notifications_settled",
        phase: "notification",
        expectedStateRevision: parsed.expectedTrackingStateRevision,
        status: "settled",
        result: {
          ...result,
          notificationLedgerDigest: parsed.notificationLedgerDigest,
          notificationHistoryDigest: parsed.notificationHistoryDigest,
          action: record.notificationAction,
        },
      },
      digest,
    );
  } else {
    receipt = sealObservedReceipt(
      {
        ...common,
        receiptType: "run_finalization",
        stage: "run_finalized",
        phase: "finalization",
        expectedStateRevision: parsed.expectedTrackingStateRevision,
        status: "finalized",
        result: { ...result, runReportDigest: parsed.runReportDigest },
      },
      digest,
    );
  }
  if (
    (receipt.receiptType !== "initial_state_commit" &&
      receipt.receiptType !== "notification_settlement" &&
      receipt.receiptType !== "run_finalization") ||
    receipt.receiptType !== parsed.receiptType ||
    receipt.operationId !== commit.operationId
  ) {
    throw new TypeError("観測receiptのoperation IDがGit commit metadataと一致しません");
  }
  return receipt;
}

/** observed state receiptを同じexact commitの根拠へ再結合する。 */
export function assertObservedStateCommitReceipt(
  receipt: StateCommitReceipt,
  evidence: StateCommitReceiptEvidence,
  position: ObservedStateCommitPosition,
  digest: ContentDigestPort,
): void {
  const expected = observeStateCommitReceipt(
    evidence,
    {
      invocationId: receipt.invocationId,
      observedAt: receipt.observedAt,
      position,
    },
    digest,
  );
  if (serializeCanonicalJson(receipt) !== serializeCanonicalJson(expected)) {
    throw new TypeError("observed state receiptとexact commitの根拠が一致しません");
  }
}
