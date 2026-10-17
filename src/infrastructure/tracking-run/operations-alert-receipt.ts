import { randomUUID } from "node:crypto";

import type { PublicFailureArtifact } from "../../application/tracking-run/failure-artifact.js";
import { operationsIncidentKindForFailure } from "../../application/tracking-run/failure-primary.js";
import { createReceipt, decodeReceipt } from "../../application/tracking-run/receipt-codec.js";
import {
  preCheckpointFailureStageSchema,
  type OperationsAlertReceipt,
  type Receipt,
  type ReceiptBinding,
} from "../../application/tracking-run/receipt-schema.js";
import { serializeCanonicalJson } from "../../canonical-json/value.js";
import type { StateBranchCommitResult } from "../../persistence/branch-adapter.js";
import { nodeContentDigestPort } from "./content-digest.js";

function alertBinding(artifact: PublicFailureArtifact): ReceiptBinding {
  const evidence = artifact.failure.evidence;
  switch (evidence.bindingKind) {
    case "checkpoint":
      return {
        bindingKind: "checkpoint",
        runId: evidence.runId,
        checkpointDigest: evidence.checkpointDigest,
        checkpointFileDigest: evidence.checkpointFileDigest,
        runtimeIdentityDigest: evidence.runtimeIdentityDigest,
      };
    case "run_pre_checkpoint_alert": {
      const stage = preCheckpointFailureStageSchema.parse(artifact.failure.failedStage);
      return {
        ...evidence,
        failureArtifactDigest: artifact.failureArtifactDigest,
        failedStage: stage,
      };
    }
    case "state_bootstrap_alert":
      return {
        ...evidence,
        failureArtifactDigest: artifact.failureArtifactDigest,
        failedStage: "runtime_bootstrap",
      };
    case "invocation_pre_run_alert":
      return {
        bindingKind: "invocation_pre_run_alert",
        failureArtifactDigest: artifact.failureArtifactDigest,
        failedStage: artifact.failure.failedStage === "prepare" ? "prepare" : "runtime_bootstrap",
      };
  }
}

function expectedAlertStateRevision(
  artifact: PublicFailureArtifact,
  binding: ReceiptBinding,
): Receipt["expectedStateRevision"] {
  switch (binding.bindingKind) {
    case "invocation_pre_run_alert":
      return undefined;
    case "state_bootstrap_alert":
      return binding.observedStateRevision;
    case "run_pre_checkpoint_alert":
      return binding.baseStateRevision.status === "present"
        ? binding.baseStateRevision.revision
        : { status: "missing" };
    case "checkpoint": {
      if (artifact.failure.lastKnownStateRevision != null) {
        return artifact.failure.lastKnownStateRevision;
      }
      const evidence = artifact.failure.evidence;
      if (evidence.bindingKind !== "checkpoint" || evidence.baseStateRevision == null) {
        return undefined;
      }
      return evidence.baseStateRevision.status === "present"
        ? evidence.baseStateRevision.revision
        : { status: "missing" };
    }
  }
}

/** 元の失敗artifactと専用ledger commitから運用通知receiptを作る。 */
export function createOperationsAlertReceipt(
  artifact: PublicFailureArtifact,
  incidentId: string,
  observedAt: string,
  delivery:
    | Readonly<{ status: "sent"; discordMessageId: string }>
    | Readonly<{ status: "no_effect" }>
    | Readonly<{
        status: "ambiguous";
        discordMessageId?: string;
        observedOperationsLedgerState?: "sent" | "reserved" | "absent" | "unverified";
      }>,
  commit: StateBranchCommitResult | undefined,
): OperationsAlertReceipt {
  if ((delivery.status === "sent") !== (commit != null)) {
    throw new TypeError("運用障害通知の送信結果とledger commitが一致しません");
  }
  const binding = alertBinding(artifact);
  const expectedStateRevision = expectedAlertStateRevision(artifact, binding);
  let effectCertainty: "committed" | "ambiguous" | "no_effect";
  if (delivery.status === "sent") {
    effectCertainty = "committed";
  } else if (delivery.status === "ambiguous") {
    effectCertainty = "ambiguous";
  } else {
    effectCertainty = "no_effect";
  }
  const discordMessageId = delivery.status === "no_effect" ? undefined : delivery.discordMessageId;
  const receipt = createReceipt(
    {
      schemaVersion: 1,
      receiptType: "operations_alert",
      stage: "operations_alert",
      phase: "operations_alert",
      binding,
      logicalTarget: incidentId,
      invocationId: randomUUID(),
      localAttemptIndex: 0,
      phaseSequence: artifact.failure.completedPhaseSequence ?? 1,
      ...(artifact.failure.lastReceiptDigest == null
        ? {}
        : { previousReceiptDigest: artifact.failure.lastReceiptDigest }),
      ...(expectedStateRevision == null ? {} : { expectedStateRevision }),
      receiptKind: delivery.status === "no_effect" ? "not_required" : "executed",
      observedAt,
      status: delivery.status,
      effectCertainty,
      result: {
        incidentId,
        ...(discordMessageId == null ? {} : { discordMessageId }),
        ...(delivery.status === "ambiguous" && delivery.observedOperationsLedgerState != null
          ? { observedOperationsLedgerState: delivery.observedOperationsLedgerState }
          : {}),
        ...(commit == null
          ? {}
          : {
              operationsLedgerRevision: commit.revision,
              operationsLedgerCommitMetadata: {
                commitMetadataVersion: commit.metadata.schemaVersion,
                commitScope: "operations_alert" as const,
                commitOperationId: commit.metadata.operationId,
                ...(commit.metadata.runId == null ? {} : { commitRunId: commit.metadata.runId }),
                changedPathManifestVersion: commit.metadata.changedPathManifestVersion,
                changedPathManifestDigest: commit.metadata.changedPathManifestDigest,
              },
            }),
      },
    },
    nodeContentDigestPort,
  );
  if (receipt.receiptType !== "operations_alert") {
    throw new TypeError("運用障害通知receiptの種別が不正です");
  }
  return receipt;
}

/** 運用通知receiptが同じattemptの失敗主因へ結合することを確かめる。 */
export function decodeOperationsAlertReceiptForFailure(
  bytes: Uint8Array,
  artifact: PublicFailureArtifact,
  incidentId: string,
): OperationsAlertReceipt {
  const receipt = decodeReceipt(bytes, nodeContentDigestPort);
  const binding = alertBinding(artifact);
  if (
    receipt.receiptType !== "operations_alert" ||
    receipt.logicalTarget !== incidentId ||
    receipt.result.incidentId !== incidentId ||
    receipt.phaseSequence !== (artifact.failure.completedPhaseSequence ?? 1) ||
    receipt.previousReceiptDigest !== artifact.failure.lastReceiptDigest ||
    serializeCanonicalJson(receipt.binding) !== serializeCanonicalJson(binding) ||
    serializeCanonicalJson(receipt.expectedStateRevision ?? null) !==
      serializeCanonicalJson(expectedAlertStateRevision(artifact, binding) ?? null)
  ) {
    throw new TypeError("運用障害通知receiptが同じattemptの失敗主因と一致しません");
  }
  return receipt;
}

/** 前回と今回の失敗が同じincidentと実証済みcheckpointを指すことを確かめる。 */
export function assertSameOperationsIncident(
  previous: PublicFailureArtifact,
  current: PublicFailureArtifact,
  workflowRunId: string,
  incidentId: string,
): void {
  const previousIncidentId = `${workflowRunId}:${operationsIncidentKindForFailure(previous.failure)}:${previous.failure.failedStage}`;
  const currentIncidentId = `${workflowRunId}:${operationsIncidentKindForFailure(current.failure)}:${current.failure.failedStage}`;
  if (previousIncidentId !== incidentId || currentIncidentId !== incidentId) {
    throw new TypeError("前回と今回の運用障害通知incidentが一致しません");
  }
  const previousBinding = alertBinding(previous);
  const currentBinding = alertBinding(current);
  if (
    (previousBinding.bindingKind === "checkpoint" || currentBinding.bindingKind === "checkpoint") &&
    serializeCanonicalJson(previousBinding) !== serializeCanonicalJson(currentBinding)
  ) {
    throw new TypeError("前回と今回の運用障害通知checkpointが一致しません");
  }
}
