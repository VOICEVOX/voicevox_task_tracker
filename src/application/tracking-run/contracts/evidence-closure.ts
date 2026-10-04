import type {
  AiAnalysisElement,
  AiAnalysisElementResult,
  AiAnalysisElementMigrationResult,
} from "../../../domain/ai-analysis-elements.js";
import type { PersonalReminderCauseAssessment } from "../../../domain/personal-reminder-causes.js";
import type { SourceId } from "../../../domain/source-id.js";
import type {
  Evidence,
  GitHubNodeId,
  GitHubRepositoryId,
  NormalizedEvent,
  UtcIsoDateTime,
} from "../../../domain/types.js";
import type { PendingNotification } from "../../../domain/pending-notification.js";
import type { TrackedItemAiAnalysis } from "../../../domain/tracked-item-ai-analysis.js";
import type { PublicRepository } from "../../../github/public-repository-allowlist.js";
import type { PersonalReminderFinalizedItem } from "./personal-reminder-outcome.js";
import type { ReconciledGraphEdge } from "../../../graph/reconcile-graph-types.js";
import type { GenericAiItemAdoption } from "../stages/generic-ai-adoption-contracts.js";
import type { EvidenceCatalogSnapshot, HistoricalEvidenceRecord } from "./evidence-catalog.js";

/** 前回の保存位置と所有範囲を保持した根拠。 */
export type OwnedHistoricalEvidence = Readonly<{
  record: HistoricalEvidenceRecord;
  owner:
    | Readonly<{ kind: "item"; itemNodeId: GitHubNodeId; repositoryId: GitHubRepositoryId }>
    | Readonly<{
        kind: "relation";
        relationId: string;
        fromNodeId: string;
        toNodeId: string;
      }>;
}>;

/** 前回snapshotのAI結果を元の所有者、要素、保存位置付きで保持する。 */
export type OwnedHistoricalAiResult = Readonly<{
  owner: Readonly<{
    itemNodeId: GitHubNodeId;
    repositoryId: GitHubRepositoryId;
  }>;
  element: AiAnalysisElement;
  path: readonly (string | number)[];
  result: AiAnalysisElementMigrationResult | AiAnalysisElementResult;
}>;

/** 前回snapshotからAI履歴だけを取り出す入力。 */
export type HistoricalAiSnapshotInput = Readonly<{
  trackedItems: readonly Readonly<{
    nodeId: GitHubNodeId;
    repositoryId: GitHubRepositoryId;
    aiAnalysis: TrackedItemAiAnalysis;
  }>[];
  collectionRepositories: readonly Readonly<{
    repositoryId: GitHubRepositoryId;
    items: readonly Readonly<{
      nodeId: GitHubNodeId;
      repositoryId: GitHubRepositoryId;
      aiAnalysis: TrackedItemAiAnalysis;
    }>[];
  }>[];
}>;

/** outward値が使う一つのsource参照。 */
export type EvidenceUse = Readonly<{
  sourceId: SourceId;
  path: readonly (string | number)[];
  destination:
    | Readonly<{ kind: "item"; itemNodeId: GitHubNodeId }>
    | Readonly<{ kind: "relation"; relationId: string }>;
  purpose: string;
  requiredCurrentness: "current" | "historical_allowed";
  allowedOwnerNodeIds: readonly string[];
  allowedRelationIds: readonly string[];
}>;

/** source参照がcatalogのどの事実に解決されたかを示す記録。 */
export type ResolvedEvidenceUse = Readonly<{
  use: EvidenceUse;
  resolution: "current" | "historical";
  recordIdentity: string;
}>;

/** 保存予定の汎用AI cache要素が参照する値。 */
export type EvidenceAiCacheAddition = Readonly<{
  itemNodeId: GitHubNodeId;
  element: AiAnalysisElement;
  result: AiAnalysisElementMigrationResult;
}>;

/** 保存予定の個人催促AI cache要素が参照する値。 */
export type EvidencePersonalReminderAiCacheAddition = Readonly<{
  itemNodeId: GitHubNodeId;
  result: PersonalReminderCauseAssessment;
}>;

type NotificationSourceCause =
  | Readonly<{
      status: "complete";
      evidence: readonly Readonly<{
        sourceId: SourceId;
        occurredAt: UtcIsoDateTime;
        actor: Readonly<{ nodeId: string }>;
      }>[];
    }>
  | Readonly<{ status: "indeterminate" }>;

/** 通知原因に保持するsource参照。 */
export type EvidenceNotificationCause = Readonly<{
  itemNodeId: GitHubNodeId;
  causes: Readonly<{
    responsibility_changed: NotificationSourceCause;
    newly_unblocked: NotificationSourceCause;
  }>;
  dependencyCause: NotificationSourceCause | Readonly<{ status: "not_applicable" }>;
}>;

/** 履歴へ保存する正規化イベントの参照。 */
export type EvidenceHistoryInputEvent = Readonly<{
  sourceId: string;
  itemNodeId: string;
  kind: NormalizedEvent["kind"];
  occurredAt: string;
  actor: Readonly<{ type: "human" | "bot"; nodeId: string }> | Readonly<{ type: "system" }>;
}>;

/** 最終値と追加の公開出力候補を照合する入力。 */
export type EvidenceClosureOutward = Readonly<{
  items: readonly PersonalReminderFinalizedItem[];
  collectionAiItems: readonly Readonly<{
    nodeId: GitHubNodeId;
    repositoryId: GitHubRepositoryId;
    aiAnalysis: TrackedItemAiAnalysis;
  }>[];
  relations: readonly ReconciledGraphEdge[];
  aiItems: readonly GenericAiItemAdoption[];
  historyInputEvents: readonly EvidenceHistoryInputEvent[];
  aiCacheAdditions: readonly EvidenceAiCacheAddition[];
  personalReminderAiCacheAdditions: readonly EvidencePersonalReminderAiCacheAddition[];
  notificationCauses: readonly EvidenceNotificationCause[];
  pendingNotifications: readonly PendingNotification[];
}>;

/** 閉包へ渡す今回の時刻、公開範囲、履歴正本。 */
export type EvidenceClosureContext = Readonly<{
  evaluatedAt: UtcIsoDateTime;
  approvedRepositories: readonly PublicRepository[];
  historicalEvidence: readonly OwnedHistoricalEvidence[];
  historicalAiResults: readonly OwnedHistoricalAiResult[];
}>;

/** 最終outward値を再走査して照合できる決定論的な閉包成果。 */
export type EvidenceClosureResult = Readonly<{
  outward: EvidenceClosureOutward;
  catalog: EvidenceCatalogSnapshot;
  uses: readonly EvidenceUse[];
  resolvedUses: readonly ResolvedEvidenceUse[];
  addedEvidence: readonly Readonly<{
    destination: EvidenceUse["destination"];
    evidence: Evidence;
  }>[];
}>;
