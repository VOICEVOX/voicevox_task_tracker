import { z } from "zod";

import type { InitialPagesPublicationEvidence } from "../../application/tracking-run/initial-pages-evidence-codec.js";
import { parseInitialPagesPublicationEvidence } from "../../application/tracking-run/initial-pages-evidence-codec.js";
import type { StateCommitReceiptEvidence } from "../../application/tracking-run/observed-state-commit.js";
import type { ContentDigestPort } from "../../application/tracking-run/contracts/content-digest-port.js";
import type { ReceiptChainEvidence } from "../../application/tracking-run/receipt-chain-schema.js";
import {
  verifyReceiptChain,
  type ReceiptChainProof,
} from "../../application/tracking-run/receipt-chain.js";
import {
  observeInitialPagesDeployment,
  parseReceipt,
} from "../../application/tracking-run/receipt-codec.js";
import type {
  PagesDeploymentReceipt,
  Receipt,
} from "../../application/tracking-run/receipt-schema.js";
import type { RunTransactionMarker } from "../../application/tracking-run/run-transaction-marker.js";
import { serializeCanonicalJson } from "../../canonical-json/value.js";
import {
  durablePublicationRecordSchema,
  parseDurablePublicationRecord,
} from "../../publication/durable-record-schema.js";

import {
  resumeFinalizationInputSchema,
  resumeInitialPagesBuildInputSchema,
  resumeInitialPagesDeployInputSchema,
  resumeNotificationHistoryBuildInputSchema,
  resumeNotificationHistoryDeployInputSchema,
  resumeNotificationsInputSchema,
  type ExactPublicationStateView,
} from "./publication-resume-contracts.js";

const resumeBindingProofBrand: unique symbol = Symbol("resumeBindingProof");
/** record、state、直前receiptの結合を検証した証明。 */
export type ResumeBindingProof = Readonly<{
  recordDigest: string;
  exactStateRevision: string;
  readonly [resumeBindingProofBrand]: true;
}>;

type BoundResume<T> = Readonly<
  T & { bindingProof: ResumeBindingProof; receiptChainProof: ReceiptChainProof }
>;

export type ResumeInitialPagesBuildInput = z.input<typeof resumeInitialPagesBuildInputSchema>;
export type ResumeInitialPagesDeployInput = z.input<typeof resumeInitialPagesDeployInputSchema>;
export type ResumeNotificationsInput = z.input<typeof resumeNotificationsInputSchema>;
export type ResumeFinalizationInput = z.input<typeof resumeFinalizationInputSchema>;
export type ResumeNotificationHistoryBuildInput = z.input<
  typeof resumeNotificationHistoryBuildInputSchema
>;
export type ResumeNotificationHistoryDeployInput = z.input<
  typeof resumeNotificationHistoryDeployInputSchema
>;

export type InitialPagesBuildInput = BoundResume<
  z.output<typeof resumeInitialPagesBuildInputSchema>
>;
export type InitialPagesDeployInput = BoundResume<
  z.output<typeof resumeInitialPagesDeployInputSchema>
>;
export type NotificationsInput = BoundResume<
  z.output<typeof resumeNotificationsInputSchema> & {
    initialPagesDeploymentReceipt: PagesDeploymentReceipt;
  }
>;
export type RunFinalizationInput = BoundResume<z.output<typeof resumeFinalizationInputSchema>>;
export type NotificationHistoryPagesBuildInput = BoundResume<
  z.output<typeof resumeNotificationHistoryBuildInputSchema>
>;
export type NotificationHistoryPagesDeployInput = BoundResume<
  z.output<typeof resumeNotificationHistoryDeployInputSchema>
>;

/** 保存済みPages証拠と同じexact markerからdeploy receiptを再観測する。 */
export function observeInitialPagesFromState(
  input: Readonly<{
    record: z.output<typeof durablePublicationRecordSchema>;
    marker: Readonly<{
      phase: RunTransactionMarker["phase"];
      runId: string;
      checkpointDigest: string;
      publicationRecordDigest: string;
      initialStateRevision?: string | undefined;
      initialPagesPublicationEvidenceDigest?: string | undefined;
    }>;
    exactStateRevision: string;
    evidence: InitialPagesPublicationEvidence;
    invocationId: string;
    localAttemptIndex: number;
    phaseSequence: number;
    previousReceiptDigest: string;
    observedAt: string;
  }>,
  digest: ContentDigestPort,
): PagesDeploymentReceipt {
  const record = parseDurablePublicationRecord(input.record, digest);
  if (
    input.marker.phase === "initial_state_committed" ||
    input.marker.runId !== record.runIdentity.runId ||
    input.marker.checkpointDigest !== record.checkpointDigest ||
    input.marker.publicationRecordDigest !== record.recordDigest ||
    input.marker.initialStateRevision == null ||
    input.marker.initialPagesPublicationEvidenceDigest == null
  ) {
    throw new TypeError("初回Pages再観測のmarkerと永続recordが一致しません");
  }
  const evidence = parseInitialPagesPublicationEvidence(input.evidence, digest);
  return observeInitialPagesDeployment(
    {
      state: {
        exactStateRevision: input.exactStateRevision,
        marker: {
          runId: input.marker.runId,
          checkpointDigest: input.marker.checkpointDigest,
          phase: input.marker.phase,
          initialPagesPublicationEvidenceDigest: input.marker.initialPagesPublicationEvidenceDigest,
          initialStateRevision: input.marker.initialStateRevision,
        },
        evidence,
      },
      binding: {
        bindingKind: "checkpoint",
        runId: record.runIdentity.runId,
        checkpointDigest: record.checkpointDigest,
        checkpointFileDigest: record.checkpointFileDigest,
        runtimeIdentityDigest: inputDigestRuntimeIdentity(record.runtimeIdentity, digest),
      },
      invocationId: input.invocationId,
      localAttemptIndex: input.localAttemptIndex,
      phaseSequence: input.phaseSequence,
      previousReceiptDigest: input.previousReceiptDigest,
      observedAt: input.observedAt,
    },
    digest,
  );
}

function assertRecordState(
  input: Readonly<{
    record: z.output<typeof durablePublicationRecordSchema>;
    state: ExactPublicationStateView;
    expectedRevision: string;
  }>,
  digest: ContentDigestPort,
): ResumeBindingProof {
  const record = parseDurablePublicationRecord(input.record, digest);
  if (
    input.state.revision !== input.expectedRevision ||
    input.state.marker.runId !== record.runIdentity.runId ||
    input.state.marker.checkpointDigest !== record.checkpointDigest ||
    input.state.marker.publicationRecordDigest !== record.recordDigest
  ) {
    throw new TypeError("再開入力のrecord、marker、exact revisionが一致しません");
  }
  if (
    input.state.marker.phase === "initial_state_committed" &&
    (input.state.snapshotDigest !== record.initialStateContentDigests.snapshot ||
      input.state.normalNotificationLedgerDigest !==
        record.initialStateContentDigests.notificationLedger ||
      input.state.marker.initialStateRevision != null ||
      input.state.marker.initialPagesPublicationEvidenceDigest != null)
  ) {
    throw new TypeError("初回commit段階のstate内容がrecordと一致しません");
  }
  if (
    input.state.marker.phase !== "initial_state_committed" &&
    (input.state.marker.initialStateRevision == null ||
      input.state.marker.initialPagesPublicationEvidenceDigest == null)
  ) {
    throw new TypeError("通知開始後のmarkerに初回Pages証拠がありません");
  }
  const proof: ResumeBindingProof = {
    recordDigest: record.recordDigest,
    exactStateRevision: input.state.revision,
    [resumeBindingProofBrand]: true,
  };
  return Object.freeze(proof);
}

function inputDigestRuntimeIdentity(value: unknown, digest: ContentDigestPort): string {
  return digest.sha256Utf8(serializeCanonicalJson(value));
}

function verifyResumeReceipts(
  receipts: readonly Receipt[],
  record: z.output<typeof durablePublicationRecordSchema>,
  digest: ContentDigestPort,
  evidence: ReceiptChainEvidence,
): ReceiptChainProof {
  for (const value of receipts) {
    const receipt = parseReceipt(value, digest);
    if (
      receipt.binding.bindingKind !== "checkpoint" ||
      receipt.binding.runId !== record.runIdentity.runId ||
      receipt.binding.checkpointDigest !== record.checkpointDigest ||
      receipt.binding.checkpointFileDigest !== record.checkpointFileDigest ||
      receipt.binding.runtimeIdentityDigest !==
        inputDigestRuntimeIdentity(record.runtimeIdentity, digest)
    ) {
      throw new TypeError("再開receiptのcheckpointまたはruntime結合が一致しません");
    }
  }
  return verifyReceiptChain(
    receipts.map((receipt, index) => ({
      receipt,
      evidence: index === 0 ? evidence : { kind: "none" },
    })),
    digest,
  ).proof;
}

function stateCommitChainEvidence(
  receipt: Receipt,
  state: StateCommitReceiptEvidence | undefined,
): ReceiptChainEvidence {
  if (receipt.receiptKind === "observed") {
    if (state?.receiptType !== receipt.receiptType) {
      throw new TypeError("再観測したstate commit receiptの根拠がありません");
    }
    return { kind: "state_commit", state };
  }
  if (state != null) {
    throw new TypeError("実行時receiptへ再観測のstate根拠を付けられません");
  }
  return { kind: "none" };
}

function verifyStateAndBuildReceipts(
  stateReceipt: Receipt,
  stateEvidence: StateCommitReceiptEvidence | undefined,
  buildReceipt: Receipt,
  record: z.output<typeof durablePublicationRecordSchema>,
  digest: ContentDigestPort,
): ReceiptChainProof {
  const evidence = stateCommitChainEvidence(stateReceipt, stateEvidence);
  if (stateReceipt.receiptKind === "observed") {
    verifyResumeReceipts([stateReceipt], record, digest, evidence);
    return verifyResumeReceipts([buildReceipt], record, digest, { kind: "none" });
  }
  return verifyResumeReceipts([stateReceipt, buildReceipt], record, digest, evidence);
}

/** 初回commitの結果から初回Pages buildだけを再開する。 */
export function resumeInitialPagesBuild(
  input: ResumeInitialPagesBuildInput,
  digest: ContentDigestPort,
): InitialPagesBuildInput {
  const parsed = resumeInitialPagesBuildInputSchema.parse(input);
  const bindingProof = assertRecordState(parsed, digest);
  const receiptChainProof = verifyResumeReceipts(
    [parsed.initialStateCommitReceipt],
    parsed.record,
    digest,
    stateCommitChainEvidence(parsed.initialStateCommitReceipt, parsed.initialStateCommitEvidence),
  );
  if (
    parsed.state.marker.phase !== "initial_state_committed" ||
    parsed.initialStateCommitReceipt.result.resultingStateRevision !== parsed.state.revision
  ) {
    throw new TypeError("初回Pages buildのstate revisionが初回commitと一致しません");
  }
  return Object.freeze({ ...parsed, bindingProof, receiptChainProof });
}

/** 初回Pages build結果から同じintentのdeployだけを再開する。 */
export function resumeInitialPagesDeploy(
  input: ResumeInitialPagesDeployInput,
  digest: ContentDigestPort,
): InitialPagesDeployInput {
  const parsed = resumeInitialPagesDeployInputSchema.parse(input);
  const bindingProof = assertRecordState(parsed, digest);
  const receiptChainProof = verifyStateAndBuildReceipts(
    parsed.initialStateCommitReceipt,
    parsed.initialStateCommitEvidence,
    parsed.initialPagesBuildReceipt,
    parsed.record,
    digest,
  );
  if (
    parsed.state.marker.phase !== "initial_state_committed" ||
    parsed.initialStateCommitReceipt.result.resultingStateRevision !== parsed.state.revision ||
    parsed.initialPagesBuildReceipt.phase !== "initial" ||
    parsed.initialPagesBuildReceipt.status !== "built" ||
    parsed.initialPagesBuildReceipt.result?.sourceStateRevision !== parsed.state.revision ||
    (parsed.initialPagesBuildReceipt.expectedStateRevision != null &&
      parsed.initialPagesBuildReceipt.expectedStateRevision !== parsed.state.revision)
  ) {
    throw new TypeError("初回Pages deployのbuild結果とstate revisionが一致しません");
  }
  return Object.freeze({ ...parsed, bindingProof, receiptChainProof });
}

/** 初回Pages結果または保存済み証拠から通知段階を再開する。 */
export function resumeNotifications(
  input: ResumeNotificationsInput,
  digest: ContentDigestPort,
): NotificationsInput {
  const parsed = resumeNotificationsInputSchema.parse(input);
  const bindingProof = assertRecordState(parsed, digest);
  let initialPagesDeploymentReceipt: PagesDeploymentReceipt;
  let chainEvidence: ReceiptChainEvidence = { kind: "none" };
  if (parsed.source.kind === "deployment_receipt") {
    if (parsed.state.marker.phase !== "initial_state_committed") {
      throw new TypeError("通知の初回開始には初回commit段階のmarkerが必要です");
    }
    const receipt = parseReceipt(parsed.source.initialPagesDeploymentReceipt, digest);
    if (
      receipt.receiptType !== "pages_deployment" ||
      receipt.phase !== "initial" ||
      receipt.effectCertainty !== "committed" ||
      receipt.result?.sourceStateRevision !== parsed.state.revision
    ) {
      throw new TypeError("通知開始の初回Pages公開結果が一致しません");
    }
    initialPagesDeploymentReceipt = receipt;
  } else {
    if (parsed.state.marker.phase !== "notifications_in_progress") {
      throw new TypeError("通知再開には通知処理中のmarkerが必要です");
    }
    if (parsed.source.invocationId === parsed.record.runIdentity.invocationId) {
      throw new TypeError("保存証拠の再観測には新しいinvocation IDが必要です");
    }
    const evidenceDigest = parsed.state.marker.initialPagesPublicationEvidenceDigest;
    const initialStateRevision = parsed.state.marker.initialStateRevision;
    if (evidenceDigest == null || initialStateRevision == null) {
      throw new TypeError("通知再開用のmarkerに初回Pages証拠がありません");
    }
    const evidence = parseInitialPagesPublicationEvidence(
      parsed.source.initialPagesEvidence,
      digest,
    );
    const stateEvidence = {
      exactStateRevision: parsed.state.revision,
      marker: {
        runId: parsed.state.marker.runId,
        checkpointDigest: parsed.state.marker.checkpointDigest,
        phase: parsed.state.marker.phase,
        initialPagesPublicationEvidenceDigest: evidenceDigest,
        initialStateRevision,
      },
      evidence,
    };
    chainEvidence = { kind: "initial_pages_state", state: stateEvidence };
    initialPagesDeploymentReceipt = observeInitialPagesFromState(
      {
        record: parsed.record,
        marker: parsed.state.marker,
        exactStateRevision: parsed.state.revision,
        evidence,
        invocationId: parsed.source.invocationId,
        localAttemptIndex: parsed.source.localAttemptIndex,
        phaseSequence: parsed.source.phaseSequence,
        previousReceiptDigest: parsed.source.previousReceiptDigest,
        observedAt: parsed.source.observedAt,
      },
      digest,
    );
  }
  if (initialPagesDeploymentReceipt.result == null) {
    throw new TypeError("初回Pages公開結果がありません");
  }
  if (
    initialPagesDeploymentReceipt.result.pageUrl !==
      parsed.record.initialPagesProjection.settings.url ||
    (parsed.record.executionPolicy.effectTarget === "production" &&
      initialPagesDeploymentReceipt.result.externalReference.kind === "recording") ||
    (parsed.record.executionPolicy.effectTarget === "recording" &&
      initialPagesDeploymentReceipt.result.externalReference.kind !== "recording")
  ) {
    throw new TypeError("初回Pages公開結果が記録済み公開先と一致しません");
  }
  const receiptChainProof = verifyResumeReceipts(
    [initialPagesDeploymentReceipt],
    parsed.record,
    digest,
    chainEvidence,
  );
  return Object.freeze({
    ...parsed,
    initialPagesDeploymentReceipt,
    bindingProof,
    receiptChainProof,
  });
}

/** 通知settlementの結果からrun finalizationだけを再開する。 */
export function resumeFinalization(
  input: ResumeFinalizationInput,
  digest: ContentDigestPort,
): RunFinalizationInput {
  const parsed = resumeFinalizationInputSchema.parse(input);
  const bindingProof = assertRecordState(parsed, digest);
  const receiptChainProof = verifyResumeReceipts(
    [parsed.notificationSettlementReceipt],
    parsed.record,
    digest,
    stateCommitChainEvidence(
      parsed.notificationSettlementReceipt,
      parsed.notificationSettlementEvidence,
    ),
  );
  if (
    parsed.state.marker.phase !== "notifications_settled" ||
    parsed.notificationSettlementReceipt.result.resultingStateRevision !== parsed.state.revision ||
    parsed.notificationSettlementReceipt.result.notificationLedgerDigest !==
      parsed.state.normalNotificationLedgerDigest
  ) {
    throw new TypeError("finalizationのstate revisionがsettlementと一致しません");
  }
  return Object.freeze({ ...parsed, bindingProof, receiptChainProof });
}

/** final stateから通知履歴Pages buildだけを再開する。 */
export function resumeNotificationHistoryBuild(
  input: ResumeNotificationHistoryBuildInput,
  digest: ContentDigestPort,
): NotificationHistoryPagesBuildInput {
  const parsed = resumeNotificationHistoryBuildInputSchema.parse(input);
  const bindingProof = assertRecordState(parsed, digest);
  const receiptChainProof = verifyResumeReceipts(
    [parsed.runFinalizationReceipt],
    parsed.record,
    digest,
    stateCommitChainEvidence(parsed.runFinalizationReceipt, parsed.runFinalizationEvidence),
  );
  if (
    parsed.state.marker.phase !== "run_finalized" ||
    parsed.runFinalizationReceipt.result.resultingStateRevision !== parsed.state.revision
  ) {
    throw new TypeError("通知履歴Pages buildのrevisionがfinal stateと一致しません");
  }
  return Object.freeze({ ...parsed, bindingProof, receiptChainProof });
}

/** 通知履歴Pages buildの結果からdeployだけを再開する。 */
export function resumeNotificationHistoryDeploy(
  input: ResumeNotificationHistoryDeployInput,
  digest: ContentDigestPort,
): NotificationHistoryPagesDeployInput {
  const parsed = resumeNotificationHistoryDeployInputSchema.parse(input);
  const bindingProof = assertRecordState(parsed, digest);
  const receiptChainProof = verifyStateAndBuildReceipts(
    parsed.runFinalizationReceipt,
    parsed.runFinalizationEvidence,
    parsed.notificationHistoryPagesBuildReceipt,
    parsed.record,
    digest,
  );
  if (
    parsed.state.marker.phase !== "run_finalized" ||
    parsed.runFinalizationReceipt.result.resultingStateRevision !== parsed.state.revision ||
    parsed.notificationHistoryPagesBuildReceipt.phase !== "notification_history" ||
    (parsed.notificationHistoryPagesBuildReceipt.status === "built"
      ? parsed.notificationHistoryPagesBuildReceipt.result?.sourceStateRevision !==
        parsed.state.revision
      : parsed.notificationHistoryPagesBuildReceipt.logicalTarget !== parsed.state.revision) ||
    (parsed.notificationHistoryPagesBuildReceipt.expectedStateRevision != null &&
      parsed.notificationHistoryPagesBuildReceipt.expectedStateRevision !== parsed.state.revision)
  ) {
    throw new TypeError("通知履歴Pages deployのbuild結果とfinal stateが一致しません");
  }
  return Object.freeze({ ...parsed, bindingProof, receiptChainProof });
}
