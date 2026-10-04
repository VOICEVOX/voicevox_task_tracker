import {
  INITIAL_PAGES_PUBLICATION_EVIDENCE_STATE_PATH_V1,
  RUN_TRANSACTION_MARKER_STATE_PATH_V1,
} from "../../application/tracking-run/contracts/recovery-paths.js";
import {
  serializeInitialPagesPublicationEvidence,
  type InitialPagesPublicationEvidence,
} from "../../application/tracking-run/initial-pages-evidence-codec.js";
import { stateCommitReceiptOperationId } from "../../application/tracking-run/observed-state-commit.js";
import type {
  ManualResolutionReceipt,
  NotificationMessageReceipt,
} from "../../application/tracking-run/receipt-schema.js";
import { serializeRunTransactionMarker } from "../../application/tracking-run/run-transaction-marker.js";
import { serializeCanonicalJson } from "../../canonical-json/value.js";
import type { PreparedDiscordDigestMessage } from "../../discord/payload-contracts.js";
import { createGitHubRepositoryId } from "../../domain/index.js";
import { assertStatePublicSafety } from "../../persistence/public-safety.js";
import { writeStateCas, type StateCasCommitRequestFactory } from "../../persistence/state-cas.js";
import { verifyRunTransactionFiles } from "../../persistence/state-transaction-files.js";
import { advanceSettlementMarker } from "../../persistence/state-notification-transition.js";
import { nodeContentDigestPort as digest } from "./content-digest.js";
import {
  readNotificationMessageState,
  type NotificationMessageState,
} from "./notification-message-state.js";
import { assertSettledNotificationContent } from "./notification-settlement-validation.js";
import type {
  NotificationSettlementInput,
  NotificationSettlementPort,
} from "./notification-settlement-contracts.js";
import { NotificationStructureError } from "./notification-structure-error.js";

/** 全message確定後にmarkerと必要な初回Pages証拠を一度のCASへ保存する。 */
export async function commitNotificationSettlement(
  input: NotificationSettlementInput,
  port: NotificationSettlementPort,
  initial: NotificationMessageState,
  messages: readonly PreparedDiscordDigestMessage[],
  receipts: readonly (NotificationMessageReceipt | ManualResolutionReceipt)[],
  evidence: InitialPagesPublicationEvidence,
  expectedStateRevision: string,
): Promise<
  | Readonly<{ kind: "committed"; revision: string; observed: boolean }>
  | Readonly<{ kind: "no_effect" }>
  | Readonly<{ kind: "conflict"; observedHeadRevision: string }>
> {
  const operationId = stateCommitReceiptOperationId(
    "notification_settlement",
    input.record.runIdentity.runId,
    input.record.checkpointDigest,
    digest,
  );
  const commitIdentity = Object.freeze({
    commitScope: "tracking_run" as const,
    operationId,
    runId: input.record.runIdentity.runId,
  });
  const request: StateCasCommitRequestFactory = {
    commitIdentity,
    build: async (parent) => {
      if (parent.status !== "present") {
        throw new TypeError("通知settlementのCAS親がありません");
      }
      const state = await readNotificationMessageState(
        port.adapter,
        port.configuration,
        parent.revision,
      );
      const previousMarker = state.transaction.marker;
      if (
        state.transaction.record.recordDigest !== input.record.recordDigest ||
        (messages.length === 0 && previousMarker.phase !== "initial_state_committed") ||
        (messages.length > 0 && previousMarker.phase !== "notifications_in_progress") ||
        (messages.length > 0 &&
          previousMarker.phase === "notifications_in_progress" &&
          (previousMarker.initialStateRevision !==
            input.initialStateReceipt.result.resultingStateRevision ||
            state.transaction.initialPagesEvidence == null ||
            serializeCanonicalJson(state.transaction.initialPagesEvidence) !==
              serializeCanonicalJson(evidence)))
      ) {
        throw new NotificationStructureError(
          "通知settlementの親stateが未確定runの段階と一致しません",
          "no_effect",
        );
      }
      const content = assertSettledNotificationContent(
        input.record,
        initial,
        state,
        messages,
        receipts,
        port.configuration,
      );
      const marker = advanceSettlementMarker(
        previousMarker,
        evidence,
        input.initialStateReceipt.result.resultingStateRevision,
        parent.revision,
        content.ledgerDigest,
      );
      const updates = [
        ...(messages.length === 0
          ? [
              {
                path: INITIAL_PAGES_PUBLICATION_EVIDENCE_STATE_PATH_V1,
                bytes: new TextEncoder().encode(
                  serializeInitialPagesPublicationEvidence(evidence, digest),
                ),
              },
            ]
          : []),
        {
          path: RUN_TRANSACTION_MARKER_STATE_PATH_V1,
          bytes: new TextEncoder().encode(serializeRunTransactionMarker(marker)),
        },
      ];
      assertStatePublicSafety({
        snapshot: state.snapshot,
        repositoryInventory: port.repositoryInventory,
        repositoryAllowlist: input.record.initialPagesProjection.repositoryAllowlist.map(
          (repository) => ({ ...repository, id: createGitHubRepositoryId(repository.id) }),
        ),
        additionalValues: [input.record, state.ledger, marker, evidence],
        knownSecrets: port.knownSecrets,
      });
      return {
        updates,
        deletions: [],
        message: `tracker notification settled ${input.record.runIdentity.runId}`,
        committedAt: port.now().toISOString(),
        commitIdentity,
      };
    },
    verifyCandidate: (files) => {
      const verified = verifyRunTransactionFiles(files, port.configuration);
      if (
        verified?.marker.phase !== "notifications_settled" ||
        verified.record.recordDigest !== input.record.recordDigest ||
        verified.marker.notificationLedgerDigest !== verified.notificationLedgerDigest ||
        verified.initialPagesEvidence?.evidenceDigest !== evidence.evidenceDigest ||
        verified.marker.initialStateRevision !==
          input.initialStateReceipt.result.resultingStateRevision
      ) {
        throw new TypeError("通知settlementのCAS候補が固定runと一致しません");
      }
    },
  };
  let written = await writeStateCas(
    port.adapter,
    port.configuration,
    { status: "present", revision: expectedStateRevision },
    request,
  );
  for (let retry = 0; retry < 2 && written.status === "no_effect"; retry += 1) {
    written = await writeStateCas(
      port.adapter,
      port.configuration,
      { status: "present", revision: expectedStateRevision },
      request,
    );
  }
  if (written.status === "no_effect") {
    return { kind: "no_effect" };
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
