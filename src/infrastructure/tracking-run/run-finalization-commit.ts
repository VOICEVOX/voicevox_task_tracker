import { RUN_TRANSACTION_MARKER_STATE_PATH_V1 } from "../../application/tracking-run/contracts/recovery-paths.js";
import { stateCommitReceiptOperationId } from "../../application/tracking-run/observed-state-commit.js";
import { serializeRunTransactionMarker } from "../../application/tracking-run/run-transaction-marker.js";
import { hashCanonicalJson } from "../../canonical-json/index.js";
import { serializeCanonicalJson } from "../../canonical-json/value.js";
import { createGitHubRepositoryId } from "../../domain/index.js";
import { joinStatePath } from "../../persistence/branch-adapter.js";
import { assertStatePublicSafety } from "../../persistence/public-safety.js";
import { serializeStateSnapshot } from "../../persistence/snapshot-v23.js";
import { writeStateCas, type StateCasCommitRequestFactory } from "../../persistence/state-cas.js";
import {
  createStateRunReport,
  serializeStateRunReport,
} from "../../persistence/state-run-report.js";
import { advanceFinalizationMarker } from "../../persistence/state-finalization-values.js";
import { nodeContentDigestPort as digest } from "./content-digest.js";
import {
  readNotificationMessageState,
  type NotificationMessageState,
} from "./notification-message-state.js";
import { finalRunValues } from "./run-finalization-state.js";
import type { FinalizeRunInput, FinalizeRunPort } from "./run-finalization-contracts.js";

/** report、snapshot、markerを一つのtracking CASへ保存する。 */
export async function commitRunFinalization(
  input: FinalizeRunInput,
  port: FinalizeRunPort,
  settled: NotificationMessageState,
  finishedAt: string,
): Promise<
  | Readonly<{ kind: "committed"; revision: string; observed: boolean }>
  | Readonly<{ kind: "state_unconfirmed" }>
  | Readonly<{ kind: "conflict"; observedHeadRevision: string }>
> {
  const record = input.record;
  if (settled.transaction.marker.phase !== "notifications_settled") {
    throw new TypeError("run finalizationのsettlement markerがありません");
  }
  const settledMarker = settled.transaction.marker;
  const expectedRevision = input.settlementReceipt.result.resultingStateRevision;
  const operationId = stateCommitReceiptOperationId(
    "run_finalization",
    record.runIdentity.runId,
    record.checkpointDigest,
    digest,
  );
  const commitIdentity = Object.freeze({
    commitScope: "tracking_run" as const,
    operationId,
    runId: record.runIdentity.runId,
  });
  const reportPath = joinStatePath(
    port.configuration.runReportsDirectory,
    `${record.runFinalizationPolicy.report.startedAt.slice(0, 10)}.json`,
  );
  const request: StateCasCommitRequestFactory = {
    commitIdentity,
    build: async (parent, _advance, readingAdapter) => {
      if (parent.status !== "present") {
        throw new TypeError("run finalizationのCAS親がありません");
      }
      const current = await readNotificationMessageState(
        readingAdapter,
        port.configuration,
        parent.revision,
      );
      if (
        current.transaction.marker.phase !== "notifications_settled" ||
        current.transaction.record.recordDigest !== record.recordDigest ||
        current.transaction.snapshotDigest !== settled.transaction.snapshotDigest ||
        current.transaction.notificationLedgerDigest !==
          settled.transaction.notificationLedgerDigest ||
        serializeCanonicalJson(current.transaction.initialPagesEvidence) !==
          serializeCanonicalJson(settled.transaction.initialPagesEvidence)
      ) {
        throw new TypeError("run finalizationのCAS親がsettlement正本と一致しません");
      }
      const values = finalRunValues(record, current, finishedAt);
      const snapshotBytes = new TextEncoder().encode(serializeStateSnapshot(values.snapshot));
      const marker = advanceFinalizationMarker(
        current.transaction.marker,
        digest.sha256Bytes(snapshotBytes.subarray(0, snapshotBytes.length - 1)),
        values.report,
        parent.revision,
      );
      assertStatePublicSafety({
        snapshot: values.snapshot,
        repositoryInventory: port.repositoryInventory,
        repositoryAllowlist: record.initialPagesProjection.repositoryAllowlist.map(
          (repository) => ({
            ...repository,
            id: createGitHubRepositoryId(repository.id),
          }),
        ),
        additionalValues: [
          record,
          current.ledger,
          marker,
          current.transaction.initialPagesEvidence,
          values.report,
        ],
        knownSecrets: port.knownSecrets,
      });
      return {
        updates: [
          {
            path: port.configuration.snapshotPath,
            bytes: snapshotBytes,
          },
          {
            path: reportPath,
            bytes: new TextEncoder().encode(serializeStateRunReport(values.report)),
          },
          {
            path: RUN_TRANSACTION_MARKER_STATE_PATH_V1,
            bytes: new TextEncoder().encode(serializeRunTransactionMarker(marker)),
          },
        ],
        deletions: [],
        message: `tracker run finalized ${record.runIdentity.runId}`,
        committedAt: port.now().toISOString(),
        commitIdentity,
      };
    },
    verifyCandidate: (files, _revision, _request, verified) => {
      const reportFile = files.get(reportPath);
      if (reportFile?.status !== "present") {
        throw new TypeError("run finalization候補のreportがありません");
      }
      const source = new TextDecoder("utf-8", { fatal: true }).decode(reportFile.bytes);
      const report = createStateRunReport(JSON.parse(source));
      if (
        source !== serializeStateRunReport(report) ||
        verified?.marker.phase !== "run_finalized" ||
        verified.record.recordDigest !== record.recordDigest ||
        verified.marker.initialPagesPublicationEvidenceDigest !==
          settledMarker.initialPagesPublicationEvidenceDigest ||
        verified.marker.finalRunReportDigest !== hashCanonicalJson(report) ||
        report.finishedAt !== finishedAt ||
        verified.notificationLedgerDigest !== settled.transaction.notificationLedgerDigest
      ) {
        throw new TypeError("run finalizationのCAS候補がsettlementと一致しません");
      }
    },
  };
  port.observePerformanceDetail?.({ step: "run_finalization_cas_started" });
  let attempts = 1;
  let written = await writeStateCas(
    port.adapter,
    port.configuration,
    { status: "present", revision: expectedRevision },
    request,
    port.observePerformanceDetail,
  );
  for (let retry = 0; retry < 2 && written.status === "no_effect"; retry += 1) {
    attempts += 1;
    written = await writeStateCas(
      port.adapter,
      port.configuration,
      { status: "present", revision: expectedRevision },
      request,
      port.observePerformanceDetail,
    );
  }
  port.observePerformanceDetail?.({ step: "run_finalization_cas_completed", count: attempts });
  if (written.status === "no_effect") {
    return { kind: "state_unconfirmed" };
  }
  if (written.status === "conflict") {
    return {
      kind: "conflict",
      observedHeadRevision:
        written.observedHead.status === "present" ? written.observedHead.revision : "unborn",
    };
  }
  return { kind: "committed", revision: written.commit.revision, observed: written.observed };
}
