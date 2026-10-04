import {
  DURABLE_PUBLICATION_RECORD_STATE_PATH_V1,
  RUN_TRANSACTION_MARKER_STATE_PATH_V1,
} from "../../application/tracking-run/contracts/recovery-paths.js";
import type { RuntimeRecoveryInputV1 } from "../../application/tracking-run/contracts/runtime-recovery-v1.js";
import type { RuntimeRecoveryInputV2 } from "../../application/tracking-run/contracts/runtime-recovery-v2.js";
import type { ObservedStateCommitPosition } from "../../application/tracking-run/observed-state-commit.js";
import type { ReceiptChainEntry } from "../../application/tracking-run/receipt-chain-schema.js";
import { verifyReceiptChain } from "../../application/tracking-run/receipt-chain.js";
import type { Receipt } from "../../application/tracking-run/receipt-schema.js";
import { readRunTransactionMarkerRecoveryBootstrap } from "../../application/tracking-run/recovery-bootstrap.js";
import { serializeCanonicalJson } from "../../canonical-json/value.js";
import {
  validateStatePersistenceConfiguration,
  type StateBranchAdapter,
  type StateBranchHead,
  type StateFileReadResult,
  type StatePersistenceConfiguration,
} from "../../persistence/branch-adapter.js";
import { readExactStateTree } from "../../persistence/state-cas.js";
import {
  parseStateNotificationLedger,
  type StateNotificationLedger,
} from "../../persistence/state-documents.js";
import {
  findInitialStateRevision,
  MAX_INTERVENING_COMMITS,
} from "../../persistence/state-orthogonal-advance.js";
import {
  verifyRunTransactionFiles,
  type VerifiedRunTransactionFiles,
} from "../../persistence/state-transaction-files.js";
import { inspectRunBootstrapState } from "./bootstrap-state.js";
import { nodeContentDigestPort } from "./content-digest.js";
import { selectRecoveryStage, type RecoveryStageInput } from "./recovery-stage.js";
import { assertStateCommitChain } from "../../persistence/state-commit-chain-verification.js";
import { observeStateCommitAtRevision } from "./state-receipt-observation.js";

/** 現行run開始と特定runのexact再開を区別する要求。 */
export type InspectRunStateRequest =
  | Readonly<{ kind: "start_new"; runtime: "current" }>
  | Readonly<{
      kind: "resume_run";
      runtime: "exact";
      runId: string;
      exactStateRevision: string;
      expectedRecordDigest: string;
      expectedRuntimeIdentityDigest: string;
      expectedWorkflowEffectAdapterIdentityDigest: string;
      runtimeRecoveryPlan:
        | RuntimeRecoveryInputV1["runtimeRecoveryPlan"]
        | RuntimeRecoveryInputV2["runtimeRecoveryPlan"];
      observation: Readonly<{ invocationId: string; observedAt: string }>;
      receipts: readonly ReceiptChainEntry[];
    }>;

/** 検証済みstateに基づく起動判断。 */
export type RunStateDecision =
  | Readonly<{ kind: "start_new"; observedStateHead: StateBranchHead }>
  | Readonly<{ kind: "resume_pending"; stageInput: RecoveryStageInput }>
  | Readonly<{ kind: "manual_resolution_required"; cause: Error }>
  | Readonly<{
      kind: "operator_conflict_resolution";
      reason:
        "different_run" | "different_checkpoint" | "state_head_changed" | "superseded_by_newer_run";
    }>;

function requireFile(files: ReadonlyMap<string, StateFileReadResult>, path: string): Uint8Array {
  const file = files.get(path);
  if (file?.status !== "present") {
    throw new TypeError(`再開に必要なstate fileがありません。対象: ${path}`);
  }
  return file.bytes;
}

async function assertReceiptRevision(
  adapter: StateBranchAdapter,
  headRevision: string,
  receipt: Receipt,
  runId: string,
): Promise<void> {
  const result =
    receipt.receiptType === "initial_state_commit" ||
    receipt.receiptType === "notification_settlement" ||
    receipt.receiptType === "manual_resolution" ||
    receipt.receiptType === "run_finalization"
      ? receipt.result
      : undefined;
  if (result == null) {
    return;
  }
  let revision = headRevision;
  for (let count = 0; count < MAX_INTERVENING_COMMITS; count += 1) {
    const commit = await adapter.readCommit(revision);
    if (revision === result.resultingStateRevision) {
      if (
        commit.metadata.runId !== runId ||
        commit.metadata.operationId !== result.commitOperationId ||
        commit.metadata.commitScope !== result.commitScope ||
        commit.metadata.changedPathManifestDigest !== result.changedPathManifestDigest ||
        (commit.parent.status === "present" ? commit.parent.revision : "unborn") !==
          result.actualParentStateRevision
      ) {
        throw new TypeError("receiptとexact state commit metadataが一致しません");
      }
      return;
    }
    if (commit.parent.status !== "present") {
      break;
    }
    revision = commit.parent.revision;
  }
  throw new TypeError("receiptのstate revisionが観測headの祖先ではありません");
}

async function verifiedReceipts(
  adapter: StateBranchAdapter,
  request: Extract<InspectRunStateRequest, { kind: "resume_run" }>,
  headRevision: string,
  verified: VerifiedRunTransactionFiles,
  initialStateRevision: string,
  finalStateRevision: string,
): Promise<readonly Receipt[]> {
  if (request.receipts.length === 0) {
    return Object.freeze([]);
  }
  const chain = verifyReceiptChain(request.receipts, nodeContentDigestPort).receipts;
  const runtimeDigest = nodeContentDigestPort.sha256Utf8(
    serializeCanonicalJson(verified.record.runtimeIdentity),
  );
  for (const receipt of chain) {
    if (
      receipt.binding.bindingKind !== "checkpoint" ||
      receipt.binding.runId !== verified.marker.runId ||
      receipt.binding.checkpointDigest !== verified.record.checkpointDigest ||
      receipt.binding.checkpointFileDigest !== verified.record.checkpointFileDigest ||
      receipt.binding.runtimeIdentityDigest !== runtimeDigest
    ) {
      throw new TypeError("receipt chainとrecordのcheckpoint結合が一致しません");
    }
    await assertReceiptRevision(adapter, headRevision, receipt, verified.marker.runId);
    if (
      (receipt.receiptType === "pages_build" || receipt.receiptType === "pages_deployment") &&
      receipt.result != null &&
      receipt.result.sourceStateRevision !==
        (receipt.phase === "initial" ? initialStateRevision : finalStateRevision)
    ) {
      throw new TypeError("Pages receiptのsource revisionがstate chainと一致しません");
    }
    if (
      receipt.receiptType === "pages_deployment" &&
      receipt.phase === "initial" &&
      receipt.result != null &&
      receipt.result.pageUrl !== verified.record.initialPagesProjection.settings.url
    ) {
      throw new TypeError("初回Pages receiptの公開URLがrecordと一致しません");
    }
  }
  return chain;
}

/** current ingressとexact runtimeの復旧判断を分けて検証する。 */
export async function inspectRunState(
  adapter: StateBranchAdapter,
  configuration: StatePersistenceConfiguration,
  request: InspectRunStateRequest,
): Promise<RunStateDecision> {
  validateStatePersistenceConfiguration(configuration);
  if (request.kind === "start_new") {
    const bootstrap = await inspectRunBootstrapState(adapter, configuration.branch, {
      kind: "start_new",
    });
    if (bootstrap.kind === "start_with_current_runtime") {
      if (bootstrap.observedStateHead.status === "present") {
        const tree = await readExactStateTree(adapter, configuration.branch);
        if (
          tree.observedHead.status !== "present" ||
          tree.observedHead.revision !== bootstrap.observedStateHead.revision
        ) {
          throw new TypeError("new runのstate headがbootstrap後に変化しました");
        }
        const verified = verifyRunTransactionFiles(tree.files, configuration);
        if (verified != null) {
          if (verified.marker.phase !== "run_finalized") {
            throw new TypeError("未完了runから新しいrunを開始できません");
          }
          await assertStateCommitChain(
            adapter,
            configuration,
            tree.observedHead.revision,
            verified,
            verified.marker.initialStateRevision,
          );
        }
      }
      return Object.freeze({ kind: "start_new", observedStateHead: bootstrap.observedStateHead });
    }
    if (bootstrap.kind === "manual_resolution_required") {
      return Object.freeze({ kind: "manual_resolution_required", cause: bootstrap.cause });
    }
    return Object.freeze({ kind: "operator_conflict_resolution", reason: "different_run" });
  }
  const head = await adapter.resolveHead(configuration.branch);
  if (head.status === "missing") {
    return Object.freeze({ kind: "operator_conflict_resolution", reason: "different_run" });
  }
  if (head.revision !== request.exactStateRevision) {
    const headFiles = await adapter.readFiles(head.revision, [
      RUN_TRANSACTION_MARKER_STATE_PATH_V1,
      DURABLE_PUBLICATION_RECORD_STATE_PATH_V1,
    ]);
    const markerFile = headFiles.get(RUN_TRANSACTION_MARKER_STATE_PATH_V1);
    if (markerFile?.status === "present") {
      let headMarker: ReturnType<typeof readRunTransactionMarkerRecoveryBootstrap>;
      try {
        headMarker = readRunTransactionMarkerRecoveryBootstrap(markerFile.bytes);
      } catch (error: unknown) {
        return Object.freeze({
          kind: "manual_resolution_required",
          cause: new TypeError("現在headのmarkerが不正です", { cause: error }),
        });
      }
      if (headMarker.runId !== request.runId) {
        return Object.freeze({
          kind: "operator_conflict_resolution",
          reason: "superseded_by_newer_run",
        });
      }
    }
    return Object.freeze({ kind: "operator_conflict_resolution", reason: "state_head_changed" });
  }
  try {
    const tree = await readExactStateTree(adapter, configuration.branch);
    if (tree.observedHead.status !== "present" || tree.observedHead.revision !== head.revision) {
      return Object.freeze({ kind: "operator_conflict_resolution", reason: "state_head_changed" });
    }
    const verified = verifyRunTransactionFiles(tree.files, configuration);
    if (verified == null) {
      throw new TypeError("exact revisionにrun transactionがありません");
    }
    if (verified.marker.runId !== request.runId) {
      return Object.freeze({ kind: "operator_conflict_resolution", reason: "different_run" });
    }
    if (verified.record.recordDigest !== request.expectedRecordDigest) {
      return Object.freeze({
        kind: "operator_conflict_resolution",
        reason: "different_checkpoint",
      });
    }
    if (
      nodeContentDigestPort.sha256Utf8(serializeCanonicalJson(verified.record.runtimeIdentity)) !==
      request.expectedRuntimeIdentityDigest
    ) {
      throw new TypeError("exact runtime identityとrecordが一致しません");
    }
    if (
      serializeCanonicalJson(verified.record.runtimeRecoveryPlan) !==
        serializeCanonicalJson(request.runtimeRecoveryPlan) ||
      verified.record.runtimeRecoveryPlan.kind === "not_reproducible" ||
      verified.record.runtimeRecoveryPlan.recoveryProtocol.workflowEffectAdapterIdentityDigest !==
        request.expectedWorkflowEffectAdapterIdentityDigest
    ) {
      throw new TypeError("exact runtime回復計画とrecordが一致しません");
    }
    if (
      verified.initialPagesEvidence != null &&
      verified.initialPagesEvidence.externalReference.adapterIdentityDigest !==
        request.expectedWorkflowEffectAdapterIdentityDigest
    ) {
      throw new TypeError("初回Pages証拠のadapter identityがruntimeと一致しません");
    }
    const initialStateRevision =
      verified.marker.phase === "initial_state_committed"
        ? await findInitialStateRevision(adapter, configuration, head.revision, request.runId)
        : verified.marker.initialStateRevision;
    const finalStateRevision = await assertStateCommitChain(
      adapter,
      configuration,
      head.revision,
      verified,
      initialStateRevision,
    );
    const ledgerSource = new TextDecoder("utf-8", { fatal: true }).decode(
      requireFile(tree.files, configuration.notificationLedgerPath),
    );
    const notificationLedger: StateNotificationLedger = parseStateNotificationLedger(ledgerSource);
    const receipts = await verifiedReceipts(
      adapter,
      request,
      head.revision,
      verified,
      initialStateRevision,
      finalStateRevision,
    );
    let stateReceipt: Awaited<ReturnType<typeof observeStateCommitAtRevision>> | undefined;
    const precedingReceipt = receipts.at(-1);
    const position: ObservedStateCommitPosition =
      precedingReceipt == null
        ? { kind: "first" }
        : {
            kind: "after",
            previousReceiptDigest: precedingReceipt.receiptDigest,
            previousPhaseSequence: precedingReceipt.phaseSequence,
          };
    const stateObservation = { ...request.observation, position };
    if (verified.marker.phase === "initial_state_committed") {
      stateReceipt = await observeStateCommitAtRevision(
        adapter,
        configuration,
        initialStateRevision,
        initialStateRevision,
        "initial_state_commit",
        stateObservation,
      );
    } else if (verified.marker.phase === "notifications_settled") {
      stateReceipt = await observeStateCommitAtRevision(
        adapter,
        configuration,
        finalStateRevision,
        initialStateRevision,
        "notification_settlement",
        stateObservation,
      );
    } else if (verified.marker.phase === "run_finalized") {
      stateReceipt = await observeStateCommitAtRevision(
        adapter,
        configuration,
        finalStateRevision,
        initialStateRevision,
        "run_finalization",
        stateObservation,
      );
    }
    const stageInput = selectRecoveryStage(
      {
        record: verified.record,
        marker: verified.marker,
        exactStateRevision: head.revision,
        initialStateRevision,
        snapshotDigest: verified.snapshotDigest,
        normalNotificationLedgerDigest: verified.notificationLedgerDigest,
        receiptChain: receipts,
      },
      notificationLedger,
      verified.initialPagesEvidence,
      stateReceipt,
      request.observation,
      nodeContentDigestPort,
    );
    return Object.freeze({ kind: "resume_pending", stageInput });
  } catch (error: unknown) {
    return Object.freeze({
      kind: "manual_resolution_required",
      cause: new TypeError("exact run stateの検証に失敗しました", { cause: error }),
    });
  }
}
