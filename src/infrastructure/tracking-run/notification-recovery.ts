import type {
  NotificationRecoveryDecision,
  NotificationRecoveryInput,
} from "./notification-recovery-contracts.js";
import { randomUUID } from "node:crypto";
import { ZodError } from "zod";

import { stateCommitReceiptOperationId } from "../../application/tracking-run/observed-state-commit.js";
import type { Receipt } from "../../application/tracking-run/receipt-schema.js";
import { assertRunTransactionMarkerTransition } from "../../application/tracking-run/run-transaction-marker.js";
import { serializeCanonicalJson } from "../../canonical-json/value.js";
import type {
  StateBranchAdapter,
  StatePersistenceConfiguration,
} from "../../persistence/branch-adapter.js";
import {
  StateBranchConflictError,
  StateFormatError,
  StateHistoryError,
} from "../../persistence/errors.js";
import {
  createStateCommitOperationId,
  isOrthogonalStateCommitScope,
} from "../../persistence/state-commit-metadata.js";
import {
  MAX_INTERVENING_COMMITS,
  authorizeAdvanceAfterOrthogonalCommits,
} from "../../persistence/state-orthogonal-advance.js";
import type { DurablePublicationRecord } from "../../publication/durable-record-schema.js";
import { nodeContentDigestPort as digest } from "./content-digest.js";
import { observeManualResolutionAtRevision } from "./manual-resolution-observation.js";
import { describeNotificationMessage } from "./notification-message-context.js";
import { readNotificationMessageState } from "./notification-message-state.js";

function receiptRevision(receipt: Receipt | undefined): string | undefined {
  if (receipt?.receiptType === "notification_message") {
    return receipt.result.ledgerStateRevision;
  }
  if (receipt?.receiptType === "manual_resolution") {
    return receipt.result.resultingStateRevision;
  }
  return undefined;
}

async function onlyOrthogonalAfter(
  adapter: StateBranchAdapter,
  configuration: StatePersistenceConfiguration,
  expectedRevision: string,
  headRevision: string,
): Promise<boolean> {
  try {
    await authorizeAdvanceAfterOrthogonalCommits(
      adapter,
      configuration,
      expectedRevision,
      headRevision,
    );
    return true;
  } catch (cause: unknown) {
    if (cause instanceof StateBranchConflictError) {
      return false;
    }
    throw cause;
  }
}

async function sameRunAncestors(
  adapter: StateBranchAdapter,
  configuration: StatePersistenceConfiguration,
  initialRevision: string,
  headRevision: string,
  record: DurablePublicationRecord,
): Promise<boolean> {
  let revision = headRevision;
  for (let count = 0; count < MAX_INTERVENING_COMMITS; count += 1) {
    if (revision === initialRevision) {
      return true;
    }
    const commit = await adapter.readCommit(revision);
    if (commit.parent.status !== "present") {
      return false;
    }
    if (isOrthogonalStateCommitScope(commit.metadata.commitScope)) {
      if (!(await onlyOrthogonalAfter(adapter, configuration, commit.parent.revision, revision))) {
        return false;
      }
    } else if (commit.metadata.commitScope === "manual_resolution") {
      if (commit.metadata.runId !== record.runIdentity.runId) {
        return false;
      }
      const current = await readNotificationMessageState(adapter, configuration, revision);
      const resolved = current.ledger.entries.find(
        (entry) => entry.manualResolution?.operationId === commit.metadata.operationId,
      );
      const resolution = resolved?.manualResolution;
      const attempt = resolved?.lastDeliveryAttempt;
      if (resolution == null || attempt == null) {
        return false;
      }
      await observeManualResolutionAtRevision(
        adapter,
        configuration,
        revision,
        {
          runId: record.runIdentity.runId,
          checkpointDigest: record.checkpointDigest,
          deliveryId: resolution.deliveryId,
          attemptId: resolution.attemptId,
          notificationKeys: attempt.notificationKeys,
          decision: resolution.decision,
        },
        {
          invocationId: randomUUID(),
          observedAt: resolution.resolvedAt,
          receiptKind: "observed",
        },
      );
    } else if (commit.metadata.runId !== record.runIdentity.runId) {
      return false;
    } else {
      const [current, parent] = await Promise.all([
        readNotificationMessageState(adapter, configuration, revision),
        readNotificationMessageState(adapter, configuration, commit.parent.revision),
      ]);
      if (
        current.transaction.record.recordDigest !== record.recordDigest ||
        parent.transaction.record.recordDigest !== record.recordDigest
      ) {
        return false;
      }
      try {
        assertRunTransactionMarkerTransition(
          parent.transaction.marker,
          current.transaction.marker,
          commit.parent.revision,
          current.transaction.initialPagesEvidence,
        );
      } catch (cause: unknown) {
        if (cause instanceof TypeError || cause instanceof ZodError) {
          return false;
        }
        throw cause;
      }
      const marker = current.transaction.marker;
      let expectedOperationId: string;
      if (marker.phase === "notifications_settled") {
        expectedOperationId = stateCommitReceiptOperationId(
          "notification_settlement",
          record.runIdentity.runId,
          record.checkpointDigest,
          digest,
        );
      } else if (marker.phase === "run_finalized") {
        expectedOperationId = stateCommitReceiptOperationId(
          "run_finalization",
          record.runIdentity.runId,
          record.checkpointDigest,
          digest,
        );
      } else if (marker.phase === "notifications_in_progress") {
        const match = /:message:([1-9]\d*)$/u.exec(marker.lastMessageDeliveryId ?? "");
        const evidence = current.transaction.initialPagesEvidence;
        if (match == null || evidence == null) {
          return false;
        }
        let described: ReturnType<typeof describeNotificationMessage>;
        try {
          described = describeNotificationMessage(
            record,
            current.snapshot,
            evidence,
            Number(match[1]) - 1,
          );
        } catch (cause: unknown) {
          if (cause instanceof TypeError || cause instanceof ZodError) {
            return false;
          }
          throw cause;
        }
        if (described.deliveryId !== marker.lastMessageDeliveryId) {
          return false;
        }
        const entries = described.notificationKeys.map((key) =>
          current.ledger.entries.find((entry) => entry.notificationKey === key),
        );
        const attempt = entries[0]?.lastDeliveryAttempt;
        if (
          attempt == null ||
          entries.some(
            (entry) =>
              entry?.lastDeliveryAttempt == null ||
              serializeCanonicalJson(entry.lastDeliveryAttempt) !==
                serializeCanonicalJson(attempt) ||
              (attempt.result === "started" && entry.status !== "delivery_started") ||
              (attempt.result === "sent" && entry.status !== "sent") ||
              (attempt.result === "clear_rejection" && entry.status !== "reserved"),
          )
        ) {
          return false;
        }
        expectedOperationId = createStateCommitOperationId({
          kind: "notification_message",
          deliveryOperationId: attempt.operationId,
          deliveryAttemptId: attempt.attemptId,
          transition: attempt.result === "started" ? "reservation" : "result",
        });
      } else {
        return false;
      }
      if (commit.metadata.operationId !== expectedOperationId) {
        return false;
      }
    }
    revision = commit.parent.revision;
  }
  return false;
}

/** CAS、HTTP、保存済みstateを別軸で照合して通知の復旧先を一意に決める。 */
export async function classifyNotificationRecovery(
  input: NotificationRecoveryInput,
  adapter: StateBranchAdapter,
  configuration: StatePersistenceConfiguration,
): Promise<NotificationRecoveryDecision> {
  const head = await adapter.resolveHead(configuration.branch);
  if (head.status !== "present") {
    throw new TypeError("通知復旧のstate branchがありません");
  }
  const base = {
    stateRevision: head.revision,
    casOutcome: input.casOutcome,
    httpOutcome: input.httpOutcome,
  };
  let state: Awaited<ReturnType<typeof readNotificationMessageState>>;
  try {
    state = await readNotificationMessageState(adapter, configuration, head.revision);
  } catch (cause: unknown) {
    if (
      cause instanceof TypeError ||
      cause instanceof SyntaxError ||
      cause instanceof ZodError ||
      cause instanceof StateFormatError ||
      cause instanceof StateHistoryError
    ) {
      return {
        ...base,
        markerPhase: "unreadable",
        recoveryDisposition: "operator_conflict_resolution",
        observationError: cause,
      };
    }
    throw cause;
  }
  const marker = state.transaction.marker;
  const operator = {
    ...base,
    markerPhase: marker.phase,
    recoveryDisposition: "operator_conflict_resolution" as const,
  };
  if (
    state.transaction.record.recordDigest !== input.record.recordDigest ||
    marker.runId !== input.record.runIdentity.runId ||
    marker.checkpointDigest !== input.record.checkpointDigest ||
    state.snapshot.run.id !== marker.runId
  ) {
    return operator;
  }
  const initialRevision = input.initialStateReceipt.result.resultingStateRevision;
  if (marker.phase === "initial_state_committed") {
    if (
      input.pagesReceipt?.effectCertainty !== "committed" ||
      input.pagesReceipt.result?.sourceStateRevision !== initialRevision ||
      input.httpOutcome !== "not_started" ||
      (input.casOutcome !== "no_effect" && input.casOutcome !== "not_attempted") ||
      !(await onlyOrthogonalAfter(adapter, configuration, initialRevision, head.revision))
    ) {
      return operator;
    }
    return { ...base, markerPhase: marker.phase, recoveryDisposition: "resume_from_receipt" };
  }
  if (
    input.pagesReceipt == null ||
    input.pagesEvidence == null ||
    marker.initialStateRevision !== initialRevision ||
    marker.initialPagesPublicationEvidenceDigest !==
      state.transaction.initialPagesEvidence?.evidenceDigest ||
    serializeCanonicalJson(input.pagesEvidence) !==
      serializeCanonicalJson(state.transaction.initialPagesEvidence)
  ) {
    return operator;
  }
  let sameAncestors: boolean;
  try {
    sameAncestors = await sameRunAncestors(
      adapter,
      configuration,
      initialRevision,
      head.revision,
      input.record,
    );
  } catch (cause: unknown) {
    if (
      cause instanceof TypeError ||
      cause instanceof SyntaxError ||
      cause instanceof ZodError ||
      cause instanceof StateFormatError ||
      cause instanceof StateHistoryError
    ) {
      return { ...operator, observationError: cause };
    }
    throw cause;
  }
  if (!sameAncestors) {
    return operator;
  }
  if (marker.phase === "notifications_in_progress") {
    const started = state.ledger.entries.filter((entry) => entry.status === "delivery_started");
    if (started.length > 0) {
      if (started.every((entry) => entry.deliveryId === marker.lastMessageDeliveryId)) {
        return {
          ...base,
          markerPhase: marker.phase,
          recoveryDisposition: "manual_resolution_required",
        };
      }
      return operator;
    }
    const lastRevision = receiptRevision(input.lastVerifiedReceipt);
    if (
      lastRevision == null ||
      !(await onlyOrthogonalAfter(adapter, configuration, lastRevision, head.revision))
    ) {
      return operator;
    }
  }
  return { ...base, markerPhase: marker.phase, recoveryDisposition: "resume_from_receipt" };
}
