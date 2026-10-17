import { randomUUID } from "node:crypto";

import { RUN_TRANSACTION_MARKER_STATE_PATH_V1 } from "../../application/tracking-run/contracts/recovery-paths.js";
import type { ManualResolutionStateEvidence } from "../../application/tracking-run/receipt-chain-schema.js";
import { parseReceipt } from "../../application/tracking-run/receipt-codec.js";
import type { ManualResolutionReceipt } from "../../application/tracking-run/receipt-schema.js";
import { serializeRunTransactionMarker } from "../../application/tracking-run/run-transaction-marker.js";
import { serializeCanonicalJson } from "../../canonical-json/value.js";
import { createGitHubRepositoryId } from "../../domain/index.js";
import {
  type StateBranchAdapter,
  type StatePersistenceConfiguration,
} from "../../persistence/branch-adapter.js";
import { StateBranchConflictError } from "../../persistence/errors.js";
import { assertStatePublicSafety } from "../../persistence/public-safety.js";
import { writeStateCas, type StateCasCommitRequestFactory } from "../../persistence/state-cas.js";
import { createStateLedgerUpdates } from "../../persistence/state-ledger-files.js";
import { MAX_INTERVENING_COMMITS } from "../../persistence/state-orthogonal-advance.js";
import { advanceMessageMarker } from "../../persistence/state-notification-transition.js";
import { nodeContentDigestPort as digest } from "./content-digest.js";
import {
  manualResolutionOperationId,
  observeManualResolutionAtRevision,
} from "./manual-resolution-observation.js";
import {
  resolveManualNotificationLedger,
  startedManualResolutionAttempt,
  type ManualResolutionTarget,
} from "./manual-resolution-state.js";
import { readNotificationMessageState } from "./notification-message-state.js";

/** 手動解決の状態変更に必要な副作用境界。 */
export type ManualResolutionPort = Readonly<{
  adapter: StateBranchAdapter;
  configuration: StatePersistenceConfiguration;
  knownSecrets: readonly string[];
  now: () => Date;
}>;

/** 手動解決の結果とGitから再観測できる根拠。 */
export type ManualResolutionResult = Readonly<{
  receipt: ManualResolutionReceipt;
  evidence: ManualResolutionStateEvidence;
  stateRevision: string;
}>;

async function findExistingResolution(
  port: ManualResolutionPort,
  headRevision: string,
  target: ManualResolutionTarget,
): Promise<string | undefined> {
  const head = await readNotificationMessageState(port.adapter, port.configuration, headRevision);
  if (
    head.transaction.marker.runId !== target.runId ||
    head.transaction.marker.checkpointDigest !== target.checkpointDigest ||
    head.transaction.record.runIdentity.runId !== target.runId ||
    head.transaction.marker.phase === "initial_state_committed"
  ) {
    throw new TypeError("手動解決対象より新しいrunがstateへ保存されています");
  }
  let revision = headRevision;
  for (let count = 0; count < MAX_INTERVENING_COMMITS; count += 1) {
    if (revision === head.transaction.marker.initialStateRevision) {
      return undefined;
    }
    const commit = await port.adapter.readCommit(revision);
    if (commit.parent.status !== "present") {
      throw new TypeError("手動解決のGit祖先が初回stateへ到達しません");
    }
    if (commit.metadata.commitScope === "manual_resolution") {
      if (commit.metadata.runId !== target.runId) {
        throw new TypeError("手動解決のGit祖先に別runのcommitがあります");
      }
      const current = await readNotificationMessageState(
        port.adapter,
        port.configuration,
        revision,
      );
      const resolution = current.ledger.entries.find(
        (entry) => entry.notificationKey === target.notificationKeys[0],
      )?.manualResolution;
      if (
        resolution?.deliveryId === target.deliveryId &&
        resolution.attemptId === target.attemptId &&
        resolution.operationId === commit.metadata.operationId
      ) {
        if (resolution.decision !== target.decision) {
          throw new TypeError("同じ送達試行へ相反する手動判断を適用できません");
        }
        return revision;
      }
    }
    revision = commit.parent.revision;
  }
  throw new TypeError("手動解決のGit祖先探索が上限を超えました");
}

/** exact Git stateに記録された手動解決receiptを検証する。 */
export async function verifyManualResolutionReceipt(
  port: ManualResolutionPort,
  receiptValue: unknown,
  observedHeadRevision: string,
): Promise<ManualResolutionResult> {
  const receipt = parseReceipt(receiptValue, digest);
  if (receipt.receiptType !== "manual_resolution" || receipt.binding.bindingKind !== "checkpoint") {
    throw new TypeError("手動解決receiptがありません");
  }
  const target: ManualResolutionTarget = {
    runId: receipt.binding.runId,
    checkpointDigest: receipt.binding.checkpointDigest,
    deliveryId: receipt.result.deliveryId,
    attemptId: receipt.result.deliveryAttemptId,
    notificationKeys: receipt.result.notificationKeys,
    decision: receipt.result.decision,
  };
  const revision = await findExistingResolution(port, observedHeadRevision, target);
  if (revision !== receipt.result.resultingStateRevision) {
    throw new TypeError("手動解決receiptの結果revisionが同じrunのGit祖先にありません");
  }
  const observed = await observeManualResolutionAtRevision(
    port.adapter,
    port.configuration,
    revision,
    target,
    {
      invocationId: receipt.invocationId,
      observedAt: receipt.observedAt,
      receiptKind: receipt.receiptKind === "executed" ? "executed" : "observed",
      ...(receipt.previousReceiptDigest == null
        ? {}
        : {
            previousReceipt: {
              phaseSequence: receipt.phaseSequence - 1,
              receiptDigest: receipt.previousReceiptDigest,
            },
          }),
    },
  );
  if (serializeCanonicalJson(receipt) !== serializeCanonicalJson(observed.receipt)) {
    throw new TypeError("手動解決receiptがGit親子stateと一致しません");
  }
  return { ...observed, stateRevision: revision };
}

/** 一つの曖昧な送達試行だけを同じpending runで手動解決する。 */
export async function resolveManualNotificationDelivery(
  port: ManualResolutionPort,
  target: ManualResolutionTarget,
): Promise<ManualResolutionResult> {
  const head = await port.adapter.resolveHead(port.configuration.branch);
  if (head.status !== "present") {
    throw new TypeError("手動解決のstate branchがありません");
  }
  const existing = await findExistingResolution(port, head.revision, target);
  const invocationId = randomUUID();
  const observedAt = port.now().toISOString();
  if (existing != null) {
    const observed = await observeManualResolutionAtRevision(
      port.adapter,
      port.configuration,
      existing,
      target,
      { invocationId, observedAt, receiptKind: "observed" },
    );
    return { ...observed, stateRevision: existing };
  }
  const state = await readNotificationMessageState(port.adapter, port.configuration, head.revision);
  startedManualResolutionAttempt(state, target);
  const operationId = manualResolutionOperationId(state.transaction.record, target);
  const commitIdentity = {
    commitScope: "manual_resolution" as const,
    operationId,
    runId: target.runId,
  };
  const request: StateCasCommitRequestFactory = {
    commitIdentity,
    build: async (parent) => {
      if (parent.status !== "present") {
        throw new TypeError("手動解決のCAS親がありません");
      }
      const current = await readNotificationMessageState(
        port.adapter,
        port.configuration,
        parent.revision,
      );
      const evidence = current.transaction.initialPagesEvidence;
      if (evidence == null) {
        throw new TypeError("手動解決の初回Pages証拠がありません");
      }
      const ledger = resolveManualNotificationLedger(current, target, operationId, observedAt);
      const marker = advanceMessageMarker(
        current.transaction.marker,
        ledger,
        evidence,
        evidence.sourceStateRevision,
        parent.revision,
        target.deliveryId,
      );
      assertStatePublicSafety({
        snapshot: current.snapshot,
        repositoryInventory: current.snapshot.repositories,
        repositoryAllowlist:
          current.transaction.record.initialPagesProjection.repositoryAllowlist.map(
            (repository) => ({ ...repository, id: createGitHubRepositoryId(repository.id) }),
          ),
        additionalValues: [ledger, marker, current.transaction.record, evidence],
        knownSecrets: port.knownSecrets,
      });
      const updates = [
        ...(await createStateLedgerUpdates(
          port.adapter,
          port.configuration,
          parent,
          ledger,
          "manual_resolution",
        )),
        {
          path: RUN_TRANSACTION_MARKER_STATE_PATH_V1,
          bytes: new TextEncoder().encode(serializeRunTransactionMarker(marker)),
        },
      ];
      return {
        updates,
        deletions: [],
        message: `tracker manual resolution ${target.runId} ${target.deliveryId}`,
        committedAt: observedAt,
        commitIdentity,
      };
    },
    verifyCandidate: (_files, _revision, _request, verified) => {
      if (
        verified?.marker.phase !== "notifications_in_progress" ||
        verified.marker.runId !== target.runId ||
        verified.marker.checkpointDigest !== target.checkpointDigest ||
        verified.marker.lastMessageDeliveryId !== target.deliveryId ||
        verified.marker.notificationLedgerDigest !== verified.notificationLedgerDigest
      ) {
        throw new TypeError("手動解決のCAS候補が同じpending runと一致しません");
      }
    },
  };
  let written = await writeStateCas(port.adapter, port.configuration, head, request);
  for (let retry = 0; retry < 2 && written.status === "no_effect"; retry += 1) {
    written = await writeStateCas(port.adapter, port.configuration, head, request);
  }
  if (written.status === "conflict") {
    throw new StateBranchConflictError();
  }
  if (written.status === "no_effect") {
    throw new TypeError("手動解決commitをremote stateで確定できません");
  }
  const observed = await observeManualResolutionAtRevision(
    port.adapter,
    port.configuration,
    written.commit.revision,
    target,
    { invocationId, observedAt, receiptKind: written.observed ? "observed" : "executed" },
  );
  return { ...observed, stateRevision: written.commit.revision };
}
