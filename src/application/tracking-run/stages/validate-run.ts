import type { RunSnapshot, ValidatedRunPayload } from "./run-validation-contracts.js";
export type { RunSnapshot } from "./run-validation-contracts.js";
import { serializeCanonicalJson } from "../../../canonical-json/value.js";
import type { Sha256Hash } from "../../../canonical-json/sha256.js";
import { parsePublicationInputs, type PublicationInputs } from "../contracts/publication-inputs.js";
import { parsePublicRunDiagnostics } from "../contracts/public-diagnostics.js";
import type { NotificationLedgerEntry, UtcIsoDateTime } from "../../../domain/index.js";
import type { PublicRepository } from "../../../github/public-repository-allowlist.js";
import type {
  EvidenceClosureResult,
  EvidenceHistoryInputEvent,
} from "../contracts/evidence-closure.js";
import type { FinalSnapshotCandidate } from "../contracts/final-snapshot.js";
import type { BaseStateRevision } from "../contracts/run-core.js";
import type { ContentDigestPort } from "../contracts/content-digest-port.js";
import type { RunExecutionPolicy, RunIdentity } from "../request.js";
import type { EvidenceClosureAdditions } from "./evidence-closure.js";
import { createEvidenceClosureWitness } from "./run-validation-artifact-witness.js";
import type { PersonalReminderFinalizedRun } from "./personal-reminder-finalization.js";
import { RunCompletenessError } from "./run-completeness-error.js";
import {
  assertRunValueMatches,
  assertRunValuesMatch,
  frozenRunCopy,
} from "./run-validation-compare.js";
import { assertActualOutwardMatches } from "./run-validation-outward.js";
import { assertFinalSnapshotCandidateMatches } from "./run-validation-snapshot.js";
import { assertRunStageLineage } from "./run-validation-lineage.js";
import { createFinalItemAiLineage } from "./run-validation-ai-lineage.js";
import { assertAiBudgetLedgerMatches } from "./run-validation-budget.js";
import { createRunArtifactValueDigests } from "./run-validation-value-digests.js";
import type {
  RunAiCacheAddition,
  RunPersonalCacheAddition,
} from "./run-validation-cache-witness.js";
import {
  assertSerializedValidatedRun,
  type SerializedValidatedRun,
} from "./run-validation-artifact.js";
import {
  assertNotificationLedger,
  assertPublicUrls,
  assertRunMetrics,
  type RunNotificationSelection,
  type RunValidationLedger,
  type RunValidationMetrics,
} from "./run-validation-final-checks.js";
import type { GenericAiAdoptedRun } from "./generic-ai-adoption.js";
import type { GraphReconciledRun } from "./graph-reconciliation.js";

const runCompletenessProofBrand: unique symbol = Symbol("runCompletenessProof");

/** validatorだけが発行する公開前の完全性証明。 */
export type RunCompletenessProof = Readonly<{ [runCompletenessProofBrand]: true }>;

/** 完全性を満たし公開段階へ渡すrun。 */
export type ValidatedRun<
  Snapshot extends RunSnapshot,
  History extends readonly EvidenceHistoryInputEvent[],
  AiCache extends readonly RunAiCacheAddition[],
  PersonalCache extends readonly RunPersonalCacheAddition[],
  Ledger extends RunValidationLedger,
  Selection extends RunNotificationSelection,
  Metrics extends RunValidationMetrics,
> = ValidatedRunPayload<Snapshot, History, AiCache, PersonalCache, Ledger, Selection, Metrics> &
  Readonly<{ proof: RunCompletenessProof }>;

const issuedValidatedRuns = new WeakSet<object>();

/** validatorへ渡す実保存値と公開安全性の検査口。 */
export type ValidateRunInput<
  Snapshot extends RunSnapshot,
  History extends readonly EvidenceHistoryInputEvent[],
  AiCache extends readonly RunAiCacheAddition[],
  PersonalCache extends readonly RunPersonalCacheAddition[],
  Ledger extends RunValidationLedger,
  Selection extends RunNotificationSelection,
  Metrics extends RunValidationMetrics,
> = Readonly<{
  expectedCore: Readonly<{
    identity: RunIdentity;
    executionPolicy: RunExecutionPolicy;
    baseRevision: BaseStateRevision;
    configDigest: Sha256Hash;
    allowlistDigest: Sha256Hash;
    evaluatedAt: UtcIsoDateTime;
  }>;
  genericAiAdopted: GenericAiAdoptedRun;
  graphReconciled: GraphReconciledRun;
  finalized: PersonalReminderFinalizedRun;
  candidate: FinalSnapshotCandidate;
  closure: EvidenceClosureResult;
  actualOutwardAdditions: EvidenceClosureAdditions;
  historyInputEvents: History;
  aiCacheAdditions: AiCache;
  personalReminderAiCacheAdditions: PersonalCache;
  previousNotificationLedger: Ledger;
  notificationLedger: Ledger;
  notificationSelection: Selection;
  notificationPreview: Selection;
  publicationInputs: PublicationInputs;
  ledgerEntriesToMerge: readonly NotificationLedgerEntry[];
  repositoryAllowlist: readonly PublicRepository[];
  metrics: Metrics;
  diagnostics: readonly string[];
  digest: ContentDigestPort;
  createCompleteSnapshot: (candidate: FinalSnapshotCandidate) => Snapshot;
  assertPublicSafety: (snapshot: Snapshot, values: readonly unknown[]) => void;
}>;

/** 全候補と実outward値の検証後にだけ証明付きrunを作る。 */
export function validateRun<
  Snapshot extends RunSnapshot,
  History extends readonly EvidenceHistoryInputEvent[],
  AiCache extends readonly RunAiCacheAddition[],
  PersonalCache extends readonly RunPersonalCacheAddition[],
  Ledger extends RunValidationLedger,
  Selection extends RunNotificationSelection,
  Metrics extends RunValidationMetrics,
>(
  input: ValidateRunInput<Snapshot, History, AiCache, PersonalCache, Ledger, Selection, Metrics>,
): ValidatedRun<Snapshot, History, AiCache, PersonalCache, Ledger, Selection, Metrics> {
  const run = input.finalized;
  assertRunValueMatches(
    input.expectedCore.identity,
    run.core.identity,
    ["core", "identity"],
    "run",
  );
  assertRunValueMatches(
    input.expectedCore.executionPolicy,
    run.core.executionPolicy,
    ["core", "executionPolicy"],
    "run",
  );
  assertRunValueMatches(
    input.expectedCore.baseRevision,
    run.core.baseRevision,
    ["core", "baseRevision"],
    "run",
  );
  assertRunValueMatches(
    input.expectedCore.configDigest,
    run.core.configDigest,
    ["core", "configDigest"],
    "run",
  );
  assertRunValueMatches(
    input.expectedCore.allowlistDigest,
    run.data.allowlistDigest,
    ["allowlistDigest"],
    "run",
  );
  assertRunValueMatches(
    input.expectedCore.evaluatedAt,
    run.data.sourceRecords.evaluatedAt,
    ["generatedAt"],
    "run",
  );
  assertRunStageLineage(input.genericAiAdopted, input.graphReconciled, run);
  assertFinalSnapshotCandidateMatches(
    run,
    input.closure,
    input.candidate,
    input.genericAiAdopted.data.facts.items,
    input.graphReconciled.core.personalReminderInput.previousAiSnapshot,
    input.digest,
  );
  assertActualOutwardMatches(run, input.closure, input.candidate, input.actualOutwardAdditions);
  assertRunValueMatches(
    input.historyInputEvents,
    input.actualOutwardAdditions.historyInputEvents,
    ["historyInputEvents"],
    "history",
  );
  assertRunValuesMatch(
    run.data.approvedRepositories,
    input.repositoryAllowlist,
    (repository) => repository.id,
    (repository) => repository.id,
    ["repositoryAllowlist"],
  );
  assertRunValuesMatch(
    input.repositoryAllowlist.map((repository) => ({
      id: repository.id,
      owner: repository.owner,
      name: repository.name,
      visibility: repository.visibility,
      archived: repository.archived,
      disabled: repository.disabled,
    })),
    input.candidate.repositories.map((repository) => ({
      id: repository.id,
      owner: repository.owner,
      name: repository.name,
      visibility: repository.visibility,
      archived: repository.archived,
      disabled: repository.disabled,
    })),
    (repository) => repository.id,
    (repository) => repository.id,
    ["repositories"],
  );
  assertRunValuesMatch(
    input.repositoryAllowlist.map((repository) => ({ repositoryId: repository.id })),
    input.candidate.collection.repositories.map((repository) => ({
      repositoryId: repository.repositoryId,
    })),
    (repository) => repository.repositoryId,
    (repository) => repository.repositoryId,
    ["collection", "repositories"],
  );
  assertNotificationLedger(input);
  const budgetSummary = assertAiBudgetLedgerMatches(run.core.aiBudget);
  assertRunMetrics(input, budgetSummary);
  let snapshot: Snapshot;
  try {
    snapshot = input.createCompleteSnapshot(input.candidate);
  } catch (cause: unknown) {
    throw new RunCompletenessError("field_mismatch", "snapshot", ["snapshot"], undefined, cause);
  }
  assertRunValueMatches(
    input.candidate.schemaVersion,
    snapshot.schemaVersion,
    ["snapshot", "schemaVersion"],
    "run",
  );
  assertRunValueMatches(
    input.candidate.run,
    { id: snapshot.run.id, status: snapshot.run.status },
    ["snapshot", "run"],
    "run",
  );
  assertRunValueMatches(true, snapshot.run.complete, ["snapshot", "run", "complete"], "run");
  assertRunValueMatches(
    input.candidate.generatedAt,
    snapshot.generatedAt,
    ["snapshot", "generatedAt"],
    "run",
  );
  assertRunValueMatches(
    input.candidate.trackingStartAt,
    snapshot.trackingStartAt,
    ["snapshot", "trackingStartAt"],
    "run",
  );
  assertRunValueMatches(input.candidate.ai, snapshot.ai, ["snapshot", "ai"], "run");
  assertRunValueMatches(
    input.candidate.finalGraphProjection,
    snapshot.finalGraphProjection,
    ["snapshot", "finalGraphProjection"],
    "graph",
  );
  assertRunValueMatches(
    input.candidate.finalGraphProjectionDigest,
    snapshot.finalGraphProjectionDigest,
    ["snapshot", "finalGraphProjectionDigest"],
    "graph",
  );
  assertRunValuesMatch(
    input.candidate.items,
    snapshot.items,
    (item) => item.nodeId,
    (item) => item.nodeId,
    ["snapshot", "items"],
  );
  assertRunValuesMatch(
    input.candidate.relations,
    snapshot.relations,
    (relation) => relation.id,
    (relation) => relation.id,
    ["snapshot", "relations"],
  );
  assertRunValuesMatch(
    input.candidate.repositories,
    snapshot.repositories,
    (repository) => repository.id,
    (repository) => repository.id,
    ["snapshot", "repositories"],
  );
  assertRunValuesMatch(
    input.candidate.collection.repositories,
    snapshot.collection.repositories,
    (repository) => repository.repositoryId,
    (repository) => repository.repositoryId,
    ["snapshot", "collection", "repositories"],
  );
  assertRunValuesMatch(
    input.candidate.externalReferences,
    snapshot.externalReferences,
    (reference) => reference.nodeId,
    (reference) => reference.nodeId,
    ["snapshot", "externalReferences"],
  );
  assertRunValuesMatch(
    input.candidate.graphNodeStateObservations,
    snapshot.graphNodeStateObservations,
    (observation) => observation.nodeId,
    (observation) => observation.nodeId,
    ["snapshot", "graphNodeStateObservations"],
  );
  const finalItemAiLineage = createFinalItemAiLineage(
    snapshot.items,
    input.genericAiAdopted.data.facts.items,
    run.data.aiItems,
  );
  const evidenceClosureWitness = createEvidenceClosureWitness(
    input.closure,
    run.data.historicalEvidence,
    run.data.historicalAiResults,
    input.graphReconciled.core.personalReminderInput.previousBaseSnapshot,
    run.data.aiItems,
    run.data.sourceRecords.evaluatedAt,
    run.data.approvedRepositories,
    {
      snapshot,
      historyInputEvents: input.historyInputEvents,
      aiCacheAdditions: input.aiCacheAdditions,
      personalReminderAiCacheAdditions: input.personalReminderAiCacheAdditions,
      previousNotificationLedger: input.previousNotificationLedger,
      notificationLedger: input.notificationLedger,
      notificationSelection: input.notificationSelection,
    },
    input.actualOutwardAdditions,
    input.digest,
  );
  const sourceIds = Object.freeze(
    [
      ...new Set(evidenceClosureWitness.resolvedUses.map((resolved) => resolved.use.sourceId)),
    ].sort(),
  );
  const publicationValues = {
    core: {
      identity: run.core.identity,
      executionPolicy: run.core.executionPolicy,
      baseRevision: run.core.baseRevision,
      configDigest: run.core.configDigest,
      allowlistDigest: run.data.allowlistDigest,
      generatedAt: snapshot.generatedAt,
      aiBudget: run.core.aiBudget,
      aiBudgetSummary: budgetSummary,
    },
    snapshot,
    historyInputEvents: input.historyInputEvents,
    aiCacheAdditions: input.aiCacheAdditions,
    personalReminderAiCacheAdditions: input.personalReminderAiCacheAdditions,
    previousNotificationLedger: input.previousNotificationLedger,
    notificationLedger: input.notificationLedger,
    notificationSelection: input.notificationSelection,
    notificationPreview: input.notificationPreview,
    publicationInputs: parsePublicationInputs(input.publicationInputs),
    repositoryAllowlist: [...input.repositoryAllowlist].sort((left, right) =>
      left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
    ),
    metrics: input.metrics,
    diagnostics: parsePublicRunDiagnostics(input.diagnostics),
    evidenceClosureSummary: {
      referenceCount: evidenceClosureWitness.resolvedUses.length,
      sourceIds,
    },
    evidenceClosureWitness,
    finalItemAiLineage,
    publicDiagnosticsSummary: {
      status: snapshot.run.status,
      pendingNotificationCount: input.notificationLedger.pendingNotifications.length,
    },
  };
  const payload = {
    ...publicationValues,
    artifactValueDigests: createRunArtifactValueDigests(publicationValues, input.digest),
  };
  try {
    serializeCanonicalJson(payload);
  } catch (cause: unknown) {
    throw new RunCompletenessError("field_mismatch", "payload", ["payload"], undefined, cause);
  }
  const publicValues = [snapshot, payload, input.actualOutwardAdditions];
  assertPublicUrls(publicValues, ["publicValues"]);
  try {
    input.assertPublicSafety(snapshot, publicValues);
  } catch (cause: unknown) {
    throw new RunCompletenessError(
      "unsafe_public_value",
      "public_boundary",
      ["publicValues"],
      undefined,
      cause,
    );
  }
  const canonicalPayload = frozenRunCopy(payload);
  const proof: RunCompletenessProof = Object.freeze({ [runCompletenessProofBrand]: true });
  const validated = Object.freeze({
    ...canonicalPayload,
    proof,
  });
  issuedValidatedRuns.add(validated);
  return validated;
}

/** validatorが発行したrunだけを公開入口へ通す。 */
export function assertValidatedRun(value: Readonly<{ proof: RunCompletenessProof }>): void {
  if (!issuedValidatedRuns.has(value)) {
    throw new RunCompletenessError("field_mismatch", "proof", ["proof"], undefined);
  }
}

/** checkpoint内の実値を再検証して新しいローカル証明を発行する。 */
export function revalidateSerializedRun<Run extends SerializedValidatedRun>(
  run: Run,
  digest: ContentDigestPort,
  assertPublicSafety: (value: Run) => void,
): Run & Readonly<{ proof: RunCompletenessProof }> {
  assertSerializedValidatedRun(run, digest);
  assertPublicSafety(run);
  const payload = frozenRunCopy(run);
  const proof: RunCompletenessProof = Object.freeze({ [runCompletenessProofBrand]: true });
  const validated = Object.freeze({ ...payload, proof });
  issuedValidatedRuns.add(validated);
  return validated;
}
