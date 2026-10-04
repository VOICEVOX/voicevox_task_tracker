import type { PersonalReminderEvidenceRole } from "../../../codex/personal-reminder-input-contracts.js";
import type { SourceId } from "../../../domain/source-id.js";
import type {
  Evidence,
  EvidenceSupport,
  GitHubNodeId,
  GitHubRepositoryId,
  UtcIsoDateTime,
} from "../../../domain/types.js";
import type { ProductionSourceIdKind } from "../../../github/production-source-id.js";

/** 複数項目から同じIDを参照できるGitHub entityの種別。 */
export type SharedSourceKind = Extract<
  ProductionSourceIdKind,
  | "github_actor"
  | "github_user"
  | "github_team"
  | "github_item"
  | "github_commit"
  | "github_label"
  | "github_check_run"
  | "github_commit_status"
  | "github_status_check_rollup"
>;

/** 一つの項目に所有されるGitHub sourceの種別。 */
export type ItemSourceKind = Exclude<ProductionSourceIdKind, SharedSourceKind>;

/** 現行sourceを確認した収集record。 */
export type CurrentSourceOrigin = "enumerated_item" | "item_detail" | "normalized_item";

/** 収集値から確認できたsourceの不変field。省略したfieldは未確認を表す。 */
export type SourceImmutableFields = Readonly<{
  nodeId?: GitHubNodeId;
  repositoryId?: GitHubRepositoryId;
  itemType?: "issue" | "pull_request";
  itemNumber?: number;
  actorNodeId?: GitHubNodeId;
  occurredAt?: UtcIsoDateTime;
  committedAt?: UtcIsoDateTime;
  sha?: string;
  recordKind?: string;
  relatedNodeId?: GitHubNodeId;
  relationKind?: string;
}>;

type CurrentSourceFactBase = Readonly<{
  sourceId: SourceId;
  origin: CurrentSourceOrigin;
  immutable: SourceImmutableFields;
}>;

/** 複数項目で共有可能な現行entityの観測事実。 */
export type CurrentSharedSourceFact = CurrentSourceFactBase &
  Readonly<{
    scope: "shared";
    sourceKind: SharedSourceKind;
  }>;

/** 項目の所有範囲を持つ現行sourceの観測事実。 */
export type CurrentItemSourceFact = CurrentSourceFactBase &
  Readonly<{
    scope: "item";
    sourceKind: ItemSourceKind;
    itemNodeId: GitHubNodeId;
  }>;

/** 今回の収集recordから確認したsource事実。 */
export type CurrentSourceFact = CurrentSharedSourceFact | CurrentItemSourceFact;

/** 既存Evidenceが保存されていた位置。 */
export type HistoricalEvidenceLocation = Readonly<{
  container: "previous_snapshot" | "retained_value" | "migration";
  path: readonly (string | number)[];
}>;

/** 未知fieldを補わずに保存位置と三字段を保持する履歴根拠。 */
export type HistoricalEvidenceRecord = Readonly<{
  status: "historical";
  location: HistoricalEvidenceLocation;
  evidence: Evidence;
}>;

/** 根拠を利用する値の範囲。 */
export type EvidenceUseScope = Readonly<{
  kind: "tracked_item" | "relation" | "generic_ai" | "personal_reminder" | "migration";
  id: string;
}>;

/** 一つの利用範囲へ付けた根拠の文章。 */
export type EvidenceAnnotation = Readonly<{
  scope: EvidenceUseScope;
  evidence: Evidence;
}>;

/** source IDと利用範囲に付けた役割。 */
export type EvidenceRoleAssignment = Readonly<{
  sourceId: SourceId;
  scope: EvidenceUseScope;
  roles: readonly (EvidenceSupport | PersonalReminderEvidenceRole)[];
}>;

/** source事実、履歴、用途別annotationを並べたcatalog。 */
export type EvidenceCatalogSnapshot = Readonly<{
  currentSources: readonly CurrentSourceFact[];
  historicalRecords: readonly HistoricalEvidenceRecord[];
  annotations: readonly EvidenceAnnotation[];
  roles: readonly EvidenceRoleAssignment[];
  evidence: readonly Evidence[];
}>;
