import { serializeCanonicalJson } from "../../../canonical-json/value.js";
import { parsePublicationInputs } from "../contracts/publication-inputs.js";
import { parsePublicRunDiagnostics } from "../contracts/public-diagnostics.js";
import type { ContentDigestPort } from "../contracts/content-digest-port.js";
import type { RunSnapshot, ValidatedRunPayload } from "./run-validation-contracts.js";
import type {
  RunAiCacheAddition,
  RunPersonalCacheAddition,
} from "./run-validation-cache-witness.js";
import type { EvidenceHistoryInputEvent } from "../contracts/evidence-closure.js";
import type {
  RunNotificationSelection,
  RunValidationLedger,
  RunValidationMetrics,
} from "./run-validation-final-checks.js";
import { assertAiBudgetLedgerMatches } from "./run-validation-budget.js";
import { RunCompletenessError } from "./run-completeness-error.js";
import {
  assertRunValueMatches,
  assertRunValuesMatch,
  runValuesById,
} from "./run-validation-compare.js";
import { assertPublicUrls } from "./run-validation-final-checks.js";
import { assertEvidenceClosureWitness } from "./run-validation-artifact-witness.js";
import { assertFinalItemAiLineage } from "./run-validation-ai-lineage.js";
import { createRunArtifactValueDigests } from "./run-validation-value-digests.js";

/** JSONへ保存する証明以外の確定済みrun。 */
export type SerializedValidatedRun = ValidatedRunPayload<
  RunSnapshot,
  readonly EvidenceHistoryInputEvent[],
  readonly RunAiCacheAddition[],
  readonly RunPersonalCacheAddition[],
  RunValidationLedger,
  RunNotificationSelection,
  RunValidationMetrics
>;

function assertLedgerTransition(run: SerializedValidatedRun): void {
  const previous = run.previousNotificationLedger;
  const current = run.notificationLedger;
  const selection = run.notificationSelection;
  const action = run.core.executionPolicy.notificationAction;
  assertRunValueMatches(
    previous.operationsAlerts,
    current.operationsAlerts,
    ["notificationLedger", "operationsAlerts"],
    "notification",
  );
  assertRunValueMatches(
    selection.pendingNotifications,
    current.pendingNotifications,
    ["notificationLedger", "pendingNotifications"],
    "notification",
  );
  if (
    (action === "hold" && (selection.action !== "skip_digest" || selection.reason !== "held")) ||
    (action === "acknowledge-current" &&
      (selection.action !== "skip_digest" || selection.reason !== "no_candidates")) ||
    (action === "send" &&
      selection.action === "skip_digest" &&
      selection.reason !== "no_candidates")
  ) {
    throw new RunCompletenessError(
      "ledger_mismatch",
      "notification",
      ["notificationSelection"],
      undefined,
    );
  }
  const previousByKey = runValuesById(previous.entries, (entry) => entry.notificationKey, [
    "previousNotificationLedger",
    "entries",
  ]);
  const currentByKey = runValuesById(current.entries, (entry) => entry.notificationKey, [
    "notificationLedger",
    "entries",
  ]);
  const reservations = runValuesById(
    selection.ledgerReservations,
    (entry) => entry.notificationKey,
    ["notificationSelection", "ledgerReservations"],
  );
  const reasonKeys = runValuesById(
    selection.candidates.flatMap((candidate) => candidate.reasons),
    (reason) => reason.notificationKey,
    ["notificationSelection", "candidates"],
  );
  if (reasonKeys.size !== reservations.size) {
    throw new RunCompletenessError(
      "ledger_mismatch",
      "notification",
      ["notificationSelection"],
      undefined,
    );
  }
  for (const [key, reservation] of reservations) {
    if (!reasonKeys.has(key)) {
      throw new RunCompletenessError(
        "ledger_mismatch",
        key,
        ["notificationSelection", "ledgerReservations"],
        undefined,
      );
    }
    assertRunValueMatches(
      reservation,
      currentByKey.get(key),
      ["notificationLedger", "entries", key],
      key,
    );
  }
  for (const [key, entry] of currentByKey) {
    if (reservations.has(key)) continue;
    const old = previousByKey.get(key);
    if (old == null) {
      if (action !== "acknowledge-current" || entry.status !== "acknowledged") {
        throw new RunCompletenessError(
          "ledger_mismatch",
          key,
          ["notificationLedger", "entries", key],
          undefined,
        );
      }
      continue;
    }
    if (action === "acknowledge-current" && entry.status === "acknowledged") {
      if (old.status === "sent" || old.status === "acknowledged") {
        assertRunValueMatches(old, entry, ["notificationLedger", "entries", key], key);
      }
      continue;
    }
    assertRunValueMatches(old, entry, ["notificationLedger", "entries", key], key);
  }
  for (const key of previousByKey.keys()) {
    if (!currentByKey.has(key)) {
      throw new RunCompletenessError(
        "ledger_mismatch",
        key,
        ["notificationLedger", "entries"],
        undefined,
      );
    }
  }
}

/** checkpoint内の実保存値と公開witnessを照合する。 */
export function assertSerializedValidatedRun(
  run: SerializedValidatedRun,
  digest: ContentDigestPort,
): void {
  assertRunValueMatches(
    run.core.identity.runId,
    run.snapshot.run.id,
    ["snapshot", "run", "id"],
    "run",
  );
  assertRunValueMatches(
    run.core.generatedAt,
    run.snapshot.generatedAt,
    ["snapshot", "generatedAt"],
    "run",
  );
  assertRunValueMatches(true, run.snapshot.run.complete, ["snapshot", "run", "complete"], "run");
  if (
    run.core.identity.startedAt > run.core.generatedAt ||
    run.core.identity.scheduledFor > run.core.identity.startedAt
  ) {
    throw new RunCompletenessError("field_mismatch", "time", ["core", "identity"], undefined);
  }
  assertRunValueMatches(
    digest.sha256Utf8(serializeCanonicalJson(run.snapshot.finalGraphProjection)),
    run.snapshot.finalGraphProjectionDigest,
    ["snapshot", "finalGraphProjectionDigest"],
    "graph",
  );
  assertRunValueMatches(
    digest.sha256Utf8(
      serializeCanonicalJson(
        run.repositoryAllowlist.map((repository) => ({
          id: repository.id,
          owner: repository.owner,
          name: repository.name,
          visibility: repository.visibility,
          archived: repository.archived,
          disabled: repository.disabled,
        })),
      ),
    ),
    run.core.allowlistDigest,
    ["core", "allowlistDigest"],
    "allowlist",
  );
  assertRunValuesMatch(
    run.repositoryAllowlist.map((repository) => ({
      id: repository.id,
      owner: repository.owner,
      name: repository.name,
      visibility: repository.visibility,
      archived: repository.archived,
      disabled: repository.disabled,
    })),
    run.snapshot.repositories.map((repository) => ({
      id: repository.id,
      owner: repository.owner,
      name: repository.name,
      visibility: repository.visibility,
      archived: repository.archived,
      disabled: repository.disabled,
    })),
    (repository) => repository.id,
    (repository) => repository.id,
    ["snapshot", "repositories"],
  );
  assertRunValuesMatch(
    run.repositoryAllowlist.map((repository) => ({ repositoryId: repository.id })),
    run.snapshot.collection.repositories.map((repository) => ({
      repositoryId: repository.repositoryId,
    })),
    (repository) => repository.repositoryId,
    (repository) => repository.repositoryId,
    ["snapshot", "collection", "repositories"],
  );
  const items = runValuesById(run.snapshot.items, (item) => item.nodeId, ["snapshot", "items"]);
  assertFinalItemAiLineage(
    run.snapshot,
    run.finalItemAiLineage,
    run.evidenceClosureWitness.aiResultOrigins,
  );
  for (const [index, event] of run.historyInputEvents.entries()) {
    if (!items.has(event.itemNodeId)) {
      throw new RunCompletenessError(
        "wrong_owner",
        event.itemNodeId,
        ["historyInputEvents", index],
        undefined,
      );
    }
  }
  for (const [index, candidate] of run.notificationSelection.candidates.entries()) {
    if (!items.has(candidate.itemNodeId)) {
      throw new RunCompletenessError(
        "wrong_owner",
        candidate.itemNodeId,
        ["notificationSelection", "candidates", index],
        undefined,
      );
    }
  }
  for (const [index, pending] of run.notificationSelection.pendingNotifications.entries()) {
    if (!items.has(pending.itemNodeId)) {
      throw new RunCompletenessError(
        "wrong_owner",
        pending.itemNodeId,
        ["notificationSelection", "pendingNotifications", index],
        undefined,
      );
    }
  }
  for (const [index, candidate] of run.notificationPreview.candidates.entries()) {
    if (!items.has(candidate.itemNodeId)) {
      throw new RunCompletenessError(
        "wrong_owner",
        candidate.itemNodeId,
        ["notificationPreview", "candidates", index],
        undefined,
      );
    }
  }
  const publicationInputs = parsePublicationInputs(run.publicationInputs);
  assertRunValueMatches(
    parsePublicRunDiagnostics(run.diagnostics),
    run.diagnostics,
    ["diagnostics"],
    "run",
  );
  assertRunValueMatches(publicationInputs, run.publicationInputs, ["publicationInputs"], "run");
  if (
    !publicationInputs.state.historyPath.endsWith(`/${run.snapshot.generatedAt.slice(0, 10)}.jsonl`)
  ) {
    throw new RunCompletenessError(
      "field_mismatch",
      "historyPath",
      ["publicationInputs", "state", "historyPath"],
      undefined,
    );
  }
  const deletionPaths = publicationInputs.state.oldCacheDeletionPaths;
  if (new Set(deletionPaths).size !== deletionPaths.length) {
    throw new RunCompletenessError(
      "duplicate_id",
      "oldCacheDeletionPaths",
      ["publicationInputs", "state", "oldCacheDeletionPaths"],
      undefined,
    );
  }
  runValuesById(run.snapshot.relations, (relation) => relation.id, ["snapshot", "relations"]);
  runValuesById(run.repositoryAllowlist, (repository) => repository.id, ["repositoryAllowlist"]);
  const budgetSummary = assertAiBudgetLedgerMatches(run.core.aiBudget);
  assertRunValueMatches(
    budgetSummary,
    run.core.aiBudgetSummary,
    ["core", "aiBudgetSummary"],
    "aiBudget",
  );
  assertRunValueMatches(
    run.core.identity.runId,
    run.core.aiBudget.ledgerId,
    ["core", "aiBudget", "ledgerId"],
    "aiBudget",
  );
  const metricCounts: readonly (readonly [
    "repositoryCount" | "itemCount" | "activeEdgeCount" | "aiProcessAttemptCount",
    number,
  ])[] = [
    ["repositoryCount", run.snapshot.repositories.length],
    ["itemCount", run.snapshot.items.length],
    ["activeEdgeCount", run.snapshot.relations.filter((relation) => relation.active).length],
    ["aiProcessAttemptCount", budgetSummary.processAttemptCount],
  ];
  for (const [field, expected] of metricCounts) {
    assertRunValueMatches(expected, run.metrics[field], ["metrics", field], field);
  }
  assertRunValueMatches(
    run.snapshot.run.status,
    run.publicDiagnosticsSummary.status,
    ["publicDiagnosticsSummary", "status"],
    "run",
  );
  assertRunValueMatches(
    run.notificationLedger.pendingNotifications.length,
    run.publicDiagnosticsSummary.pendingNotificationCount,
    ["publicDiagnosticsSummary", "pendingNotificationCount"],
    "notification",
  );
  assertRunValueMatches(
    createRunArtifactValueDigests(run, digest),
    run.artifactValueDigests,
    ["artifactValueDigests"],
    "run",
  );
  assertLedgerTransition(run);
  assertEvidenceClosureWitness(
    run.evidenceClosureWitness,
    run.evidenceClosureSummary,
    run.core.generatedAt,
    run.repositoryAllowlist,
    run,
    digest,
  );
  assertPublicUrls(run, ["validatedRun"]);
}
