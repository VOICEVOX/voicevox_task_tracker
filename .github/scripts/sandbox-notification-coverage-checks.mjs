import { execFileSync } from "node:child_process";

import { z } from "zod";

import { parseStateNotificationLedger } from "../../dist/persistence/state-documents.js";

const revision = z.string().regex(/^[0-9a-f]{40}$/u);

function candidateCount(outbox) {
  switch (outbox.action) {
    case "send":
      return outbox.selectedContext.action === "create_digest"
        ? outbox.selectedContext.candidates.length
        : 0;
    case "hold":
      return outbox.pendingNotifications.length;
    case "acknowledge-current":
      return outbox.acknowledgedEntries.length;
    default:
      throw new TypeError("通知actionが不正です");
  }
}

export function stateCommits(receipts) {
  return receipts.flatMap((receipt) => {
    if (
      receipt.receiptType === "initial_state_commit" ||
      receipt.receiptType === "notification_settlement" ||
      receipt.receiptType === "run_finalization" ||
      receipt.receiptType === "manual_resolution"
    ) {
      return [receipt.result.resultingStateRevision];
    }
    if (receipt.receiptType === "notification_message") {
      return [receipt.result.reservationStateRevision, receipt.result.ledgerStateRevision];
    }
    return [];
  });
}

export function countApplications(items) {
  const counts = { executed: 0, cache: 0, reused: 0, retained: 0, failed: 0, deferred: 0 };
  for (const item of items) {
    for (const application of Object.values(item.aiAnalysis.applications)) {
      if (application.status === "current_ai") {
        counts[application.origin === "verified_reuse" ? "reused" : application.origin] += 1;
      }
      if (application.status === "retained_ai") {
        counts.retained += 1;
      }
      if (application.reason === "failed" || application.reason === "deferred") {
        counts[application.reason] += 1;
      }
    }
  }
  return counts;
}

export function countPersonal(items) {
  const counts = { planned: 0, failed: 0, deferred: 0, unknown: 0 };
  for (const item of items) {
    for (const cause of item.personalReminderCauses) {
      counts.planned += 1;
      const status = cause.latestAttempt.status;
      if (status === "failed" || status === "deferred") {
        counts[status] += 1;
      }
      if (cause.adoptedAssessment.status === "not_available") {
        counts.unknown += 1;
      }
    }
  }
  return counts;
}

export function verifyPreviousSentMetadata(record, ledger) {
  if (record.baseStateRevision.status !== "present") {
    throw new TypeError("通知scenarioのseed state revisionがありません");
  }
  const base = readLedgerFromGit(record.baseStateRevision.revision);
  const previous = base.entries.filter((entry) => entry.status === "sent");
  for (const entry of previous) {
    const current = ledger.entries.find(
      (candidate) => candidate.notificationKey === entry.notificationKey,
    );
    if (
      current?.status !== "sent" ||
      current.sentAt !== entry.sentAt ||
      current.discordMessageId !== entry.discordMessageId
    ) {
      throw new TypeError("既存sent metadataが保持されていません");
    }
  }
  return previous.length;
}

function readLedgerFromGit(revisionValue) {
  const source = execFileSync(
    "git",
    ["show", `${revision.parse(revisionValue)}:state/notification-ledger.json`],
    { encoding: "utf8" },
  );
  return parseStateNotificationLedger(source);
}

export function validateNotification(input) {
  const {
    scenarioId,
    phase,
    record,
    ledger,
    receipts,
    historyPages,
    historyBuild,
    pending,
    manualArtifact,
    completedProof,
  } = input;
  const messages = receipts.filter((receipt) => receipt.receiptType === "notification_message");
  const ambiguous = messages.filter((receipt) => receipt.status === "ambiguous");
  const rejected = messages.filter((receipt) => receipt.status === "no_effect");
  const sent = messages.filter((receipt) => receipt.status === "sent");
  const manual = receipts.filter((receipt) => receipt.receiptType === "manual_resolution");
  const selectedCandidateCount = candidateCount(record.notificationOutbox);
  if (selectedCandidateCount === 0) {
    throw new TypeError("通知候補0件のscenarioを成功扱いできません");
  }
  const action = record.notificationOutbox.action;
  if (scenarioId === "send-clear-rejection") {
    if (
      phase !== "first" ||
      action !== "send" ||
      rejected.length < 1 ||
      ambiguous.length !== 0 ||
      manual.length !== 0
    ) {
      throw new TypeError("clear rejectionの通知branchを確認できません");
    }
  } else if (scenarioId === "hold") {
    if (
      phase !== "first" ||
      action !== "hold" ||
      messages.length !== 0 ||
      manual.length !== 0 ||
      historyPages.status !== "not_required" ||
      historyBuild.status !== "not_required"
    ) {
      throw new TypeError("holdの通知branchを確認できません");
    }
  } else if (scenarioId === "acknowledge-current") {
    if (
      phase !== "first" ||
      action !== "acknowledge-current" ||
      messages.length !== 0 ||
      manual.length !== 0 ||
      historyPages.status !== "not_required" ||
      historyBuild.status !== "not_required" ||
      record.notificationOutbox.acknowledgedEntries.some(
        (entry) =>
          ledger.entries.find((candidate) => candidate.notificationKey === entry.notificationKey)
            ?.status !== "acknowledged",
      )
    ) {
      throw new TypeError("acknowledge-currentの通知branchを確認できません");
    }
  } else {
    const decision = scenarioId === "ambiguous-retry" ? "retry" : "acknowledge";
    if (
      phase !== "resolution" ||
      action !== "send" ||
      pending == null ||
      manualArtifact?.receiptType !== "manual_resolution" ||
      manualArtifact.result.decision !== decision ||
      ambiguous.length !== 1 ||
      ambiguous[0].operationId !== pending.deliveryOperationId ||
      ambiguous[0].result.deliveryId !== pending.deliveryId ||
      manual.length !== 1 ||
      manual[0].result.resultingStateRevision !== manualArtifact.result.resultingStateRevision ||
      manual[0].result.deliveryAttemptId !== pending.attemptId ||
      manual[0].result.decision !== decision ||
      pending.originalOperationReservationCommitCount !== 1 ||
      completedProof?.trackingRunId !== pending.trackingRunId ||
      completedProof.pendingStateRevision !== pending.pendingStateRevision ||
      completedProof.originalDeliveryOperationId !== pending.deliveryOperationId ||
      completedProof.originalOperationReservationCommitCount !== 1 ||
      completedProof.manualResolutionCommitCount !== 1 ||
      pending.markerPhase !== "notifications_in_progress" ||
      pending.settled !== false ||
      pending.finalized !== false ||
      pending.newRunStarted !== false ||
      pending.selectedCandidateCount === 0 ||
      pending.recordingOutcome !== "recorded_ambiguous"
    ) {
      throw new TypeError("ambiguous初回と同じrunの手動解決を確認できません");
    }
    if (decision === "retry") {
      if (
        sent.length < 1 ||
        sent.some((receipt) => receipt.operationId === pending.deliveryOperationId) ||
        !sent.some((receipt) => receipt.result.deliveryId === pending.deliveryId) ||
        (historyPages.status !== "deployed" && historyPages.status !== "replayed_same_content")
      ) {
        throw new TypeError("retry後のrecording-successを確認できません");
      }
    } else if (
      messages.filter(
        (receipt) => receipt.result.deliveryId === pending.deliveryId && receipt.status === "sent",
      ).length !== 0 ||
      historyPages.status !== "not_required" ||
      pending.notificationKeys.some(
        (key) =>
          ledger.entries.find((entry) => entry.notificationKey === key)?.status !== "acknowledged",
      )
    ) {
      throw new TypeError("acknowledge後に元送達の送信履歴が増えています");
    }
  }
  return {
    action,
    selectedCandidateCount,
    messageSendCount: messages.length,
    recordedSendCount: sent.length,
    branchCounts: {
      recordedSuccess: sent.length,
      recordedClearRejection: rejected.length,
      recordedAmbiguous: ambiguous.length,
      hold: action === "hold" ? 1 : 0,
      acknowledgeCurrent: action === "acknowledge-current" ? 1 : 0,
      manualRetry: manual[0]?.result.decision === "retry" ? 1 : 0,
      manualAcknowledge: manual[0]?.result.decision === "acknowledge" ? 1 : 0,
    },
    manualResolutionDecision: manual[0]?.result.decision ?? null,
    originalDeliveryOperationId: pending?.deliveryOperationId ?? null,
    originalOperationReservationCommitCount:
      pending?.originalOperationReservationCommitCount ?? null,
  };
}
