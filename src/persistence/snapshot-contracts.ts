import {
  type AiAnalysisDependency,
  type AiAnalysisDependencyElement,
  type AiAnalysisDependencyProducer,
  type Attention,
  type ExternalGhostNode,
  type GitHubNodeId,
  type NaturalLanguageDeadlineAssessmentState,
  type NaturalLanguageImportanceAssessmentState,
  type PersonalReminderCause,
  type PersonalReminderCausePlanning,
  type PersonalReminderEvaluationAttempt,
  type Relation,
  type Repository,
  type Severity,
  type StalenessSeverityContext,
  type TrackedItem,
  type TrackedItemAiAnalysis,
  type TrackedItemState,
  type TrackingStartAtState,
  type UtcIsoDateTime,
} from "../domain/index.js";
import { type PublicRepositoryId, type Sha256Fingerprint } from "../github/index.js";

type PublicSnapshotRepositoryFields = Repository &
  Readonly<{
    visibility: "public";
    archived: false;
    disabled: false;
  }>;

/** snapshotへ保存する公開リポジトリの最新取得状態。 */
export type SnapshotRepository =
  | (PublicSnapshotRepositoryFields &
      Readonly<{
        freshness: "fresh";
      }>)
  | (PublicSnapshotRepositoryFields &
      Readonly<{
        freshness: "stale";
        failedAt: UtcIsoDateTime;
      }>);

/** snapshotへ保存するseverityと要対応度付き追跡項目。 */
export type SnapshotTrackedItem = TrackedItem &
  Readonly<{
    attention: Attention;
    importanceAssessment: NaturalLanguageImportanceAssessmentState;
    deadlineAssessment: NaturalLanguageDeadlineAssessmentState;
    severity: Severity;
    severityContext: StalenessSeverityContext;
  }>;

/** 次回の増分収集計画とterminal保持判定へ渡す軽量な項目観測値。 */
export type SnapshotAnalysisPlanFingerprint =
  | Readonly<{
      status: "planned";
      fingerprint: Sha256Fingerprint;
    }>
  | Readonly<{
      status: "unplanned";
      reason: "migration" | "detail_required";
    }>;

export type SnapshotCollectionItem = Readonly<{
  freshness: "fresh";
  nodeId: GitHubNodeId;
  repositoryId: PublicRepositoryId;
  itemFingerprint: Sha256Fingerprint;
  analysisPlanFingerprint: SnapshotAnalysisPlanFingerprint;
  aiAnalysis: TrackedItemAiAnalysis;
  observedAt: UtcIsoDateTime;
}> &
  (
    | Readonly<{
        state: "open";
        terminalAt: null;
      }>
    | Readonly<{
        state: "closed";
        terminalAt: UtcIsoDateTime;
      }>
  );

/** repository単位の最終成功時刻と項目fingerprint。 */
export type SnapshotCollectionRepository = Readonly<{
  repositoryId: PublicRepositoryId;
  successfulAt: UtcIsoDateTime;
  items: readonly SnapshotCollectionItem[];
}>;

/** 次回runへ引き継ぐ本番収集の軽量state。 */
export type SnapshotCollectionState = Readonly<{
  repositories: readonly SnapshotCollectionRepository[];
}>;

/** 関係先から取得した追跡項目のgraph用状態観測。 */
export type SnapshotGraphNodeStateObservation = Readonly<{
  nodeId: GitHubNodeId;
  state: TrackedItemState;
  observedAt: UtcIsoDateTime;
}>;

/** snapshotへ保存するAIの有効状態、利用可否、縮退状態。 */
export type SnapshotAiState =
  | Readonly<{
      enabled: false;
      available: false;
      degraded: false;
    }>
  | Readonly<{
      enabled: true;
      available: true;
      degraded: boolean;
    }>
  | Readonly<{
      enabled: true;
      available: false;
      degraded: true;
    }>;

/** 完全runだけを表すsnapshot内のrun情報。 */
export type SnapshotRun = Readonly<{
  id: string;
  status: "success" | "fallback";
  complete: true;
}>;

export const SNAPSHOT_SCHEMA_VERSION_11 = "11";
export const SNAPSHOT_SCHEMA_VERSION_12 = "12";
export const SNAPSHOT_SCHEMA_VERSION_13 = "13";
export const SNAPSHOT_SCHEMA_VERSION_14 = "14";
export const SNAPSHOT_SCHEMA_VERSION_15 = "15";
export const SNAPSHOT_SCHEMA_VERSION_16 = "16";
export const SNAPSHOT_SCHEMA_VERSION_17 = "17";
export const SNAPSHOT_SCHEMA_VERSION_18 = "18";
export const SNAPSHOT_SCHEMA_VERSION_19 = "19";

export type StateSnapshotFields = Readonly<{
  generatedAt: UtcIsoDateTime;
  trackingStartAt: TrackingStartAtState;
  ai: SnapshotAiState;
  collection: SnapshotCollectionState;
  repositories: readonly SnapshotRepository[];
  items: readonly SnapshotTrackedItem[];
  graphNodeStateObservations: readonly SnapshotGraphNodeStateObservation[];
  externalReferences: readonly ExternalGhostNode[];
  relations: readonly Relation[];
  run: SnapshotRun;
}>;

type LegacySnapshotTrackedItemWithoutAiDependencies = Omit<SnapshotTrackedItem, "aiDependencies">;
export type LegacyRelationWithoutAiDependency = Omit<Relation, "aiDependency">;
export type LegacyStateSnapshotFieldsWithoutAiDependencies = Omit<
  StateSnapshotFields,
  "items" | "graphNodeStateObservations" | "relations"
> &
  Readonly<{
    items: readonly LegacySnapshotTrackedItemWithoutAiDependencies[];
    relations: readonly LegacyRelationWithoutAiDependency[];
  }>;

export type LegacyTrackedItemAiAnalysis =
  | (Omit<Extract<TrackedItemAiAnalysis, { origin: "current" }>, "applications"> &
      Readonly<{
        applications?: never;
      }>)
  | (Omit<Extract<TrackedItemAiAnalysis, { origin: "migration" }>, "applications"> &
      Readonly<{
        applications?: never;
      }>);

/** AI依存が保存される前のpersonal reminder causeのcurrent input。 */
export type LegacyPersonalReminderCauseCurrentInput = Omit<
  PersonalReminderCause["currentInput"],
  "aiDependency"
> &
  Readonly<{
    aiDependency?: never;
  }>;

type LegacyPersonalReminderEvaluationAttempt =
  | Extract<PersonalReminderEvaluationAttempt, { status: "not_evaluated" }>
  | Extract<PersonalReminderEvaluationAttempt, { status: "completed" }>
  | Omit<Extract<PersonalReminderEvaluationAttempt, { status: "failed" }>, "rulesVersion">
  | Omit<Extract<PersonalReminderEvaluationAttempt, { status: "deferred" }>, "rulesVersion">;

/** AI依存が保存される前のpersonal reminder cause。 */
export type LegacyPersonalReminderCause = Omit<
  PersonalReminderCause,
  "aiDependencies" | "responseMembershipAssessmentRequirement" | "currentInput" | "latestAttempt"
> &
  Readonly<{
    aiDependencies?: never;
    responseMembershipAssessmentRequirement?: never;
    currentInput: LegacyPersonalReminderCauseCurrentInput;
    latestAttempt: LegacyPersonalReminderEvaluationAttempt;
  }>;

/** AI依存が保存される前のcompletedなpersonal reminder cause planning。 */
export type LegacyPersonalReminderCausePlanningCompleted = Omit<
  Extract<PersonalReminderCausePlanning, { status: "completed" }>,
  "causeSetAiDependency" | "causeSetSubjectChanges"
> &
  Readonly<{
    causeSetAiDependency?: never;
    causeSetSubjectChanges?: never;
  }>;

/** AI依存が保存される前のpersonal reminder cause planning。 */
export type LegacyPersonalReminderCausePlanning =
  | Extract<PersonalReminderCausePlanning, { status: "pending" }>
  | LegacyPersonalReminderCausePlanningCompleted
  | Extract<PersonalReminderCausePlanning, { status: "excluded" }>;

type SnapshotTrackedItemPersonalReminderCommonFields = Pick<
  SnapshotTrackedItem,
  "nodeId" | "status" | "createdAt" | "observedAt"
>;
export type SnapshotTrackedItemPersonalReminderFields =
  | (SnapshotTrackedItemPersonalReminderCommonFields &
      Readonly<{
        personalReminderCauses: readonly PersonalReminderCause[];
        personalReminderCausePlanning: PersonalReminderCausePlanning;
      }>)
  | (SnapshotTrackedItemPersonalReminderCommonFields &
      Readonly<{
        personalReminderCauses: readonly LegacyPersonalReminderCause[];
        personalReminderCausePlanning: LegacyPersonalReminderCausePlanning;
      }>);
type LegacySnapshotTrackedItem = Omit<
  SnapshotTrackedItem,
  "personalReminderCauses" | "personalReminderCausePlanning" | "aiAnalysis" | "aiDependencies"
> &
  Readonly<{
    aiAnalysis: LegacyTrackedItemAiAnalysis;
  }>;
type LegacySnapshotTrackedItemWithPersonalReminder = Omit<
  SnapshotTrackedItem,
  "aiAnalysis" | "aiDependencies" | "personalReminderCauses" | "personalReminderCausePlanning"
> &
  Readonly<{
    aiAnalysis: LegacyTrackedItemAiAnalysis;
    personalReminderCauses: readonly LegacyPersonalReminderCause[];
    personalReminderCausePlanning: LegacyPersonalReminderCausePlanning;
  }>;
type LegacySnapshotTrackedItemWithPersonalReminderVersion17 = Omit<
  SnapshotTrackedItem,
  "aiDependencies" | "personalReminderCauses" | "personalReminderCausePlanning"
> &
  Readonly<{
    personalReminderCauses: readonly LegacyPersonalReminderCause[];
    personalReminderCausePlanning: LegacyPersonalReminderCausePlanning;
  }>;
export type SnapshotItemForRelationValidation =
  | SnapshotTrackedItem
  | LegacySnapshotTrackedItemWithoutAiDependencies
  | LegacySnapshotTrackedItem
  | LegacySnapshotTrackedItemWithPersonalReminder
  | LegacySnapshotTrackedItemWithPersonalReminderVersion17;
type LegacySnapshotCollectionItem = Omit<
  SnapshotCollectionItem,
  "aiAnalysis" | "state" | "terminalAt"
> &
  Readonly<{
    aiAnalysis: LegacyTrackedItemAiAnalysis;
  }> &
  (
    | Readonly<{
        state: "open";
        terminalAt: null;
      }>
    | Readonly<{
        state: "closed";
        terminalAt: UtcIsoDateTime;
      }>
  );
type LegacySnapshotCollectionRepository = Omit<SnapshotCollectionRepository, "items"> &
  Readonly<{
    items: readonly LegacySnapshotCollectionItem[];
  }>;
type LegacySnapshotCollectionState = Omit<SnapshotCollectionState, "repositories"> &
  Readonly<{
    repositories: readonly LegacySnapshotCollectionRepository[];
  }>;
export type LegacyStateSnapshotFields = Omit<
  LegacyStateSnapshotFieldsWithoutAiDependencies,
  "collection" | "items"
> &
  Readonly<{
    collection: LegacySnapshotCollectionState;
    items: readonly LegacySnapshotTrackedItem[];
  }>;
export type LegacyStateSnapshotFieldsWithPersonalReminder = Omit<
  LegacyStateSnapshotFieldsWithoutAiDependencies,
  "collection" | "items"
> &
  Readonly<{
    collection: LegacySnapshotCollectionState;
    items: readonly LegacySnapshotTrackedItemWithPersonalReminder[];
  }>;
export type LegacyStateSnapshotFieldsWithPersonalReminderVersion17 = Omit<
  LegacyStateSnapshotFieldsWithoutAiDependencies,
  "items"
> &
  Readonly<{
    items: readonly LegacySnapshotTrackedItemWithPersonalReminderVersion17[];
  }>;

export type StateSnapshotVersion11 = LegacyStateSnapshotFields &
  Readonly<{
    schemaVersion: typeof SNAPSHOT_SCHEMA_VERSION_11;
  }>;
export type StateSnapshotVersion12 = LegacyStateSnapshotFields &
  Readonly<{
    schemaVersion: typeof SNAPSHOT_SCHEMA_VERSION_12;
  }>;
export type StateSnapshotVersion13 = LegacyStateSnapshotFields &
  Readonly<{
    schemaVersion: typeof SNAPSHOT_SCHEMA_VERSION_13;
  }>;
export type StateSnapshotVersion14 = LegacyStateSnapshotFields &
  Readonly<{
    schemaVersion: typeof SNAPSHOT_SCHEMA_VERSION_14;
  }>;

export type StateSnapshotVersion15 = LegacyStateSnapshotFieldsWithPersonalReminder &
  Readonly<{
    schemaVersion: typeof SNAPSHOT_SCHEMA_VERSION_15;
  }>;

export type StateSnapshotVersion16 = LegacyStateSnapshotFieldsWithPersonalReminder &
  Readonly<{
    schemaVersion: typeof SNAPSHOT_SCHEMA_VERSION_16;
  }>;

export type StateSnapshotVersion17 = LegacyStateSnapshotFieldsWithPersonalReminderVersion17 &
  Readonly<{
    schemaVersion: typeof SNAPSHOT_SCHEMA_VERSION_17;
  }>;

/** schema version 18で保存される単一理由のAI依存。 */
export type LegacyAiAnalysisDependencyVersion18 =
  | Exclude<AiAnalysisDependency, { status: "unknown" }>
  | Readonly<{
      status: "unknown";
      reason: "migration" | "not_recorded" | "stale_repository";
      producers?: readonly AiAnalysisDependencyProducer[] | undefined;
    }>
  | Readonly<{
      status: "unknown";
      reason: "proof_unknown";
      producers: readonly AiAnalysisDependencyProducer[];
    }>;

type LegacyPersonalReminderCauseVersion18 = Omit<
  PersonalReminderCause,
  "aiDependencies" | "currentInput"
> &
  Readonly<{
    aiDependencies: Readonly<
      Record<keyof PersonalReminderCause["aiDependencies"], LegacyAiAnalysisDependencyVersion18>
    >;
    currentInput: Omit<PersonalReminderCause["currentInput"], "aiDependency"> &
      Readonly<{
        aiDependency: LegacyAiAnalysisDependencyVersion18;
      }>;
  }>;

type LegacyPersonalReminderCausePlanningVersion18 =
  | Exclude<PersonalReminderCausePlanning, { status: "completed" }>
  | (Omit<Extract<PersonalReminderCausePlanning, { status: "completed" }>, "causeSetAiDependency"> &
      Readonly<{
        causeSetAiDependency: LegacyAiAnalysisDependencyVersion18;
      }>);

type LegacySnapshotTrackedItemVersion18 = Omit<
  SnapshotTrackedItem,
  "aiDependencies" | "personalReminderCauses" | "personalReminderCausePlanning"
> &
  Readonly<{
    aiDependencies: Readonly<
      Record<AiAnalysisDependencyElement, LegacyAiAnalysisDependencyVersion18>
    >;
    personalReminderCauses: readonly LegacyPersonalReminderCauseVersion18[];
    personalReminderCausePlanning: LegacyPersonalReminderCausePlanningVersion18;
  }>;

export type StateSnapshotVersion18 = Omit<StateSnapshotFields, "items" | "relations"> &
  Readonly<{
    schemaVersion: typeof SNAPSHOT_SCHEMA_VERSION_18;
    items: readonly LegacySnapshotTrackedItemVersion18[];
    relations: readonly (Omit<Relation, "aiDependency"> &
      Readonly<{
        aiDependency: LegacyAiAnalysisDependencyVersion18;
      }>)[];
  }>;

/** tracker-stateへ保存するschema version 19のcurrent snapshot。 */
export type StateSnapshot = StateSnapshotFields &
  Readonly<{
    schemaVersion: typeof SNAPSHOT_SCHEMA_VERSION_19;
  }>;
