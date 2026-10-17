import { INITIAL_PAGES_PUBLICATION_EVIDENCE_STATE_PATH_V1 } from "../application/tracking-run/contracts/recovery-paths.js";
import type { ContentDigestPort } from "../application/tracking-run/contracts/content-digest-port.js";
import { assertValidatedRun } from "../application/tracking-run/stages/validate-run.js";
import { canonicalJsonPieces, serializeCanonicalJson } from "../canonical-json/value.js";
import { PUBLIC_DTO_SCHEMA_VERSION } from "../pages/public-dto-primitives.js";
import { planNotificationOutbox } from "./notification-outbox.js";
import {
  canonicalSelection,
  normalNotificationLedgerValue,
  sortByKey,
} from "./publication-order.js";
import type {
  DurablePublicationRecordTemplate,
  PublicationPlan,
  PublicationPlannedRun,
  PublicationValidatedRun,
} from "./publication-plan-contracts.js";

/** 証明付きrunから副作用を伴わない確定済み公開計画を作る。 */
export function planPublication(
  validated: PublicationValidatedRun,
  digest: ContentDigestPort,
): PublicationPlannedRun {
  assertValidatedRun(validated);
  const state = Object.freeze({
    ...validated.publicationInputs.state,
    oldCacheDeletionPaths: sortByKey(
      validated.publicationInputs.state.oldCacheDeletionPaths,
      (path) => path,
    ),
  });
  const deletions = sortByKey(
    [
      ...state.oldCacheDeletionPaths,
      ...(state.previousInitialPagesEvidence.status === "present"
        ? [INITIAL_PAGES_PUBLICATION_EVIDENCE_STATE_PATH_V1]
        : []),
    ],
    (path) => path,
  );
  if (
    deletions.some(
      (path) =>
        path === state.snapshotPath ||
        path === state.historyPath ||
        path === state.notificationLedgerPath,
    )
  ) {
    throw new TypeError("公開計画の削除pathが初回書込みpathと重複しています");
  }
  const initialStateValues = Object.freeze({
    snapshot: validated.snapshot,
    historyInputEvents: sortByKey(validated.historyInputEvents, (event) =>
      serializeCanonicalJson(event),
    ),
    aiCacheAdditions: sortByKey(validated.aiCacheAdditions, (entry) => entry.cacheKey),
    personalReminderAiCacheAdditions: sortByKey(
      validated.personalReminderAiCacheAdditions,
      (entry) => entry.cacheKey,
    ),
    notificationLedger: validated.notificationLedger,
    paths: state,
    previousInitialPagesEvidence: Object.freeze({
      action: "delete_if_present" as const,
      path: INITIAL_PAGES_PUBLICATION_EVIDENCE_STATE_PATH_V1,
      expectedBase: state.previousInitialPagesEvidence,
    }),
    deletions,
    valueDigests: Object.freeze({
      initialStateWriteManifest: digest.sha256Utf8(
        serializeCanonicalJson(state.initialStateWriteManifest),
      ),
      snapshot: digest.sha256Utf8Chunks(canonicalJsonPieces(validated.snapshot)),
      historyInputEvents: digest.sha256Utf8(
        serializeCanonicalJson(
          sortByKey(validated.historyInputEvents, (event) => serializeCanonicalJson(event)),
        ),
      ),
      aiCacheAdditions: digest.sha256Utf8(
        serializeCanonicalJson(sortByKey(validated.aiCacheAdditions, (entry) => entry.cacheKey)),
      ),
      personalReminderAiCacheAdditions: digest.sha256Utf8(
        serializeCanonicalJson(
          sortByKey(validated.personalReminderAiCacheAdditions, (entry) => entry.cacheKey),
        ),
      ),
      notificationLedger: digest.sha256Utf8(
        serializeCanonicalJson(normalNotificationLedgerValue(validated.notificationLedger)),
      ),
    }),
  });
  const initialPagesProjection = Object.freeze({
    phase: "initial" as const,
    snapshot: Object.freeze({
      kind: "initial_state_snapshot" as const,
      path: state.snapshotPath,
      digest: initialStateValues.valueDigests.snapshot,
    }),
    repositoryAllowlist: sortByKey(validated.repositoryAllowlist, (repository) => repository.id),
    repositoryAllowlistDigest: validated.core.allowlistDigest,
    publicDtoSchemaVersion: PUBLIC_DTO_SCHEMA_VERSION,
    generatedAt: validated.core.generatedAt,
    settings: validated.publicationInputs.pages,
  });
  const outbox = planNotificationOutbox(validated, digest);
  const runFinalizationPolicy = Object.freeze({
    notificationCountSource: "outbox_keys_with_sent_ledger_status" as const,
    metricsSource: "validated_run_and_notification_settlement_receipt" as const,
    completeSuccessRequires: Object.freeze([
      "initial_pages_deployed",
      "notifications_settled",
    ] as const),
    configuredTrackingStartAt: validated.publicationInputs.configuredTrackingStartAt,
    trackingStartAtCondition: "complete_success" as const,
    report: Object.freeze({
      runId: validated.core.identity.runId,
      scheduledFor: validated.core.identity.scheduledFor,
      startedAt: validated.core.identity.startedAt,
      status: validated.snapshot.run.status,
      metrics: validated.metrics,
      diagnostics: validated.diagnostics,
      completionSource: "notification_settlement_receipt" as const,
    }),
    ledgerAndHistorySource: "notification_settlement_receipt" as const,
    markerPhase: "run_finalized" as const,
  });
  const notificationHistoryPagesPolicy =
    outbox.action === "send"
      ? Object.freeze({
          action: "send" as const,
          requirement: "when_sent_history_added" as const,
          context: "outbox_selected_context" as const,
        })
      : Object.freeze({ action: outbox.action, requirement: "not_required" as const });
  const durableRecordTemplate: DurablePublicationRecordTemplate = Object.freeze({
    runIdentity: validated.core.identity,
    executionPolicy: validated.core.executionPolicy,
    baseStateRevision: validated.core.baseRevision,
    configDigest: validated.core.configDigest,
    initialStateValueDigests: initialStateValues.valueDigests,
    initialPagesProjection,
    notificationOutbox: outbox,
    runFinalizationPolicy,
    notificationHistoryPagesPolicy,
  });
  const initialStateWriteSet = Object.freeze({
    ...initialStateValues,
    markerTemplate: Object.freeze({
      phase: "initial_state_committed" as const,
      runIdentity: validated.core.identity,
      baseStateRevision: validated.core.baseRevision,
      initialStateValueDigests: initialStateValues.valueDigests,
    }),
    durableRecordTemplate,
  });
  const publicationPlan: PublicationPlan = Object.freeze({
    initialStateWriteSet,
    initialPagesProjection,
    notificationOutbox: outbox,
    runFinalizationPolicy,
    notificationHistoryPagesPolicy,
    durableRecordTemplate,
    preview: Object.freeze({
      kind: "notification_preview",
      selection: canonicalSelection(validated.notificationPreview),
    }),
  });
  return Object.freeze({ validated, publicationPlan });
}
