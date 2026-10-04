import type { Sha256Hash } from "../../../canonical-json/sha256.js";
import type { GitHubNodeId, GitHubRepositoryId } from "../../../domain/types.js";
import type { TrackedItemAiAnalysis } from "../../../domain/tracked-item-ai-analysis.js";
import type { PublicRepository } from "../../../github/public-repository-allowlist.js";
import type { AiBudgetLedgerSummary } from "../contracts/ai-budget-ledger.js";
import type { EvidenceHistoryInputEvent } from "../contracts/evidence-closure.js";
import type { FinalSnapshotCandidate } from "../contracts/final-snapshot.js";
import type { BaseStateRevision } from "../contracts/run-core.js";
import type { PublicationInputs } from "../contracts/publication-inputs.js";
import type { RunExecutionPolicy, RunIdentity } from "../request.js";
import type { PersonalReminderFinalizedRun } from "./personal-reminder-finalization.js";
import type {
  RunAiCacheAddition,
  RunPersonalCacheAddition,
} from "./run-validation-cache-witness.js";
import type {
  RunNotificationSelection,
  RunValidationLedger,
  RunValidationMetrics,
} from "./run-validation-final-checks.js";
import type { EvidenceClosureWitness } from "./run-validation-artifact-witness.js";
import type { RunArtifactValueDigests } from "./run-validation-value-digests.js";

/** 最終追跡項目の汎用AI状態が今回の解析値か前回からの保持値かを示す。 */
export type FinalItemAiLineage = Readonly<{
  nodeId: GitHubNodeId;
  repositoryId: GitHubRepositoryId;
  kind: "analyzed" | "retained";
}>;

export type RunSnapshot = Readonly<{
  schemaVersion: "23";
  generatedAt: FinalSnapshotCandidate["generatedAt"];
  trackingStartAt: FinalSnapshotCandidate["trackingStartAt"];
  ai: FinalSnapshotCandidate["ai"];
  finalGraphProjection: FinalSnapshotCandidate["finalGraphProjection"];
  finalGraphProjectionDigest: FinalSnapshotCandidate["finalGraphProjectionDigest"];
  items: readonly Readonly<{
    nodeId: GitHubNodeId;
    repositoryId: GitHubRepositoryId;
    aiAnalysis: TrackedItemAiAnalysis;
    personalReminderCauses: readonly Readonly<{ causeId: string }>[];
  }>[];
  relations: readonly Readonly<{ id: string; active: boolean }>[];
  repositories: readonly Readonly<{
    id: string;
    owner: string;
    name: string;
    visibility: "public";
    archived: false;
    disabled: false;
  }>[];
  collection: FinalSnapshotCandidate["collection"];
  externalReferences: readonly Readonly<{ nodeId: string }>[];
  verifiedExternalReferences: FinalSnapshotCandidate["verifiedExternalReferences"];
  graphNodeStateObservations: readonly Readonly<{ nodeId: string }>[];
  run: Readonly<{ id: string; status: "success" | "fallback"; complete: true }>;
}>;

/** 完全性を検証したrunの保存用payload。 */
export type ValidatedRunPayload<
  Snapshot extends RunSnapshot,
  History extends readonly EvidenceHistoryInputEvent[],
  AiCache extends readonly RunAiCacheAddition[],
  PersonalCache extends readonly RunPersonalCacheAddition[],
  Ledger extends RunValidationLedger,
  Selection extends RunNotificationSelection,
  Metrics extends RunValidationMetrics,
> = Readonly<{
  core: Readonly<{
    identity: RunIdentity;
    executionPolicy: RunExecutionPolicy;
    baseRevision: BaseStateRevision;
    configDigest: Sha256Hash;
    allowlistDigest: Sha256Hash;
    generatedAt: Snapshot["generatedAt"];
    aiBudget: PersonalReminderFinalizedRun["core"]["aiBudget"];
    aiBudgetSummary: AiBudgetLedgerSummary;
  }>;
  snapshot: Snapshot;
  historyInputEvents: History;
  aiCacheAdditions: AiCache;
  personalReminderAiCacheAdditions: PersonalCache;
  previousNotificationLedger: Ledger;
  notificationLedger: Ledger;
  notificationSelection: Selection;
  notificationPreview: Selection;
  publicationInputs: PublicationInputs;
  repositoryAllowlist: readonly PublicRepository[];
  metrics: Metrics;
  diagnostics: readonly string[];
  evidenceClosureSummary: Readonly<{
    referenceCount: number;
    sourceIds: readonly string[];
  }>;
  evidenceClosureWitness: EvidenceClosureWitness;
  finalItemAiLineage: readonly FinalItemAiLineage[];
  publicDiagnosticsSummary: Readonly<{
    status: "success" | "fallback";
    pendingNotificationCount: number;
  }>;
  artifactValueDigests: RunArtifactValueDigests;
}>;
