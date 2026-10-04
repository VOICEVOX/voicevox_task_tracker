import type { AiBudgetLedgerSummary } from "../../../application/tracking-run/contracts/ai-budget-ledger.js";
import type { AnalysisPreviousState } from "../../../application/tracking-run/contracts/previous-state.js";
import type { InventoryCollectedRun } from "../../../application/tracking-run/stages/inventory.js";
import type {
  PersonalReminderExecutedRun,
  PersonalReminderExecutionPort,
} from "../../../application/tracking-run/stages/personal-reminder-execution.js";
import type { PersonalReminderPlannedRun } from "../../../application/tracking-run/stages/personal-reminder-plan.js";
import type { Sha256Hash } from "../../../canonical-json/sha256.js";
import type { AiCacheEntry } from "../../../codex/cache.js";
import type {
  AiBudgetUsage,
  CodexAttemptBudget,
  CodexDiagnosticsContext,
} from "../../../codex/index.js";
import type { PersonalReminderAiCacheEntry } from "../../../codex/personal-reminder-cache.js";
import type { Config } from "../../../config/index.js";
import type { Repository, TrackedItem } from "../../../domain/index.js";
import type { PublicRepositoryAllowlist } from "../../../github/index.js";
import type { StateBranchHead } from "../../../persistence/branch-adapter.js";
import type { StateHistoryRecord } from "../../../persistence/history-contracts.js";
import type {
  StateNotificationLedger,
  StatePersistenceSession,
  StateSnapshotReadResult,
} from "../../../persistence/index.js";
import type { RuntimeCredentials, RuntimeExecutionTarget } from "../production-runtime-setup.js";

export type RuntimeConfiguration = Readonly<{
  config: Config;
  configDigest: Sha256Hash;
  baseStateHead: StateBranchHead;
  credentials: RuntimeCredentials;
  target: RuntimeExecutionTarget;
  ensureCodexReady: () => Promise<void>;
  codexAttemptBudget: CodexAttemptBudget;
}>;

export type RuntimeState = Readonly<{
  session: StatePersistenceSession;
  snapshot: StateSnapshotReadResult;
  history: readonly StateHistoryRecord[];
  aiCache: readonly AiCacheEntry[];
  personalReminderAiCache: readonly PersonalReminderAiCacheEntry[];
  notificationLedger: StateNotificationLedger;
  previousState: AnalysisPreviousState;
}>;

/** 個人催促の計画と実行portを保持する段階成果物。 */
export type PersonalReminderPlannedStage = Readonly<{
  planned: PersonalReminderPlannedRun;
  port: PersonalReminderExecutionPort;
  initialSummary: AiBudgetLedgerSummary;
  initialUsage: AiBudgetUsage;
  fallbackNodeIds: ReadonlySet<string>;
  diagnostics: CodexDiagnosticsContext | undefined;
  configuration: RuntimeConfiguration;
}>;

/** 個人催促の実行結果と最終化に必要な集計値。 */
export type PersonalReminderExecutedStage = Readonly<{
  executed: PersonalReminderExecutedRun;
  initialSummary: AiBudgetLedgerSummary;
  initialUsage: AiBudgetUsage;
  fallbackNodeIds: ReadonlySet<string>;
  diagnostics: CodexDiagnosticsContext | undefined;
  configuration: RuntimeConfiguration;
  candidateCauseCount: number;
  assessmentReuseCount: number;
}>;

export type RepositoryInventory = Readonly<{
  inventory: readonly Repository[];
  allowlist: PublicRepositoryAllowlist;
  allowlistDigest: InventoryCollectedRun["data"]["allowlistDigest"];
}>;

type WithoutImportance<T> = T extends unknown ? Omit<T, "importance"> : never;
export type PendingTrackedItem = WithoutImportance<TrackedItem>;
