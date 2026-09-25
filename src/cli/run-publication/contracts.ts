import type { Config, loadConfig } from "../../config/index.js";
import type {
  LabelRule,
  Repository,
  TrackingStartAtState,
  UtcIsoDateTime,
} from "../../domain/index.js";
import type {
  DiscordDigestDelivery,
  DiscordNotificationSelection,
  DiscordWebhookHttpClient,
  sendDiscordDigest,
} from "../../discord/index.js";
import type { PublicRepositoryAllowlist } from "../../github/index.js";
import type { GeneratedPublicData, PublicDataWriteResult } from "../../pages/index.js";
import type {
  PersistStateTransactionResult,
  StateBranchAdapter,
  StateHistoryInputEvent,
  StateHistoryNotificationEvent,
  StateHistoryRecord,
  StateNotificationLedger,
  StatePersistenceConfiguration,
  StatePersistenceSession,
  StateSnapshot,
  StateSnapshotReadResult,
} from "../../persistence/index.js";
import type {
  DailyTransactionDependencies,
  DailyTransactionTypeMap,
} from "../daily-transaction.js";
import type { RuntimeCredentials, RuntimeExecutionTarget } from "../production-runtime-setup.js";
import type { readWorkflowArtifactFile } from "../workflow-artifact.js";

/** 完全性検証を通過し、公開処理へ渡してよいrun。 */
export type ValidatedRun = Readonly<{
  snapshot: StateSnapshot;
  historyInputEvents: readonly StateHistoryInputEvent[];
  notificationLedger: StateNotificationLedger;
  notificationSelection: DiscordNotificationSelection;
}>;

/** 初期保存後にPages生成へ渡す値。 */
export type PersistedRun = Readonly<{
  result: PersistStateTransactionResult;
  historyRecords: readonly StateHistoryRecord[];
  notificationLedger: StateNotificationLedger;
}>;

/** Pages生成と書込みの結果。 */
export type PagesResult = Readonly<{
  data: GeneratedPublicData;
  output: PublicDataWriteResult;
  pagesUrl: string;
}>;

/** Discord配送本体と履歴event。 */
export type DiscordDeliveryResult = Readonly<{
  delivery: DiscordDigestDelivery;
  notificationEvents: readonly StateHistoryNotificationEvent[];
}>;

/** daily transactionが完了保存へ渡すDiscord結果。 */
export type DiscordResult = DiscordDeliveryResult &
  Readonly<{
    notificationLedger: StateNotificationLedger;
  }>;

/** run完了保存に必要な通知結果。 */
export type RunCompletionDelivery = Readonly<{
  notificationLedger: StateNotificationLedger;
  notificationCount: number;
}>;

/** 公開処理が参照してよい設定とcredential。 */
export type PublicationConfiguration = Readonly<{
  config: Config;
  credentials: RuntimeCredentials;
  target: RuntimeExecutionTarget;
}>;

/** 公開処理が参照してよい永続化sessionと読込済み状態。 */
export type PublicationState = Readonly<{
  session: StatePersistenceSession;
  snapshot: StateSnapshotReadResult;
  notificationLedger: StateNotificationLedger;
}>;

/** 公開処理が参照してよいrepository一覧と公開allowlist。 */
export type PublicationRepositoryInventory = Readonly<{
  inventory: readonly Repository[];
  allowlist: PublicRepositoryAllowlist;
}>;

/** 公開処理だけが必要とする外部接続。 */
export type RunPublicationAdapters = Readonly<{
  environment: Readonly<NodeJS.ProcessEnv>;
  repositoryPath: string;
  pagesOutputDirectory: string;
  loadConfig: typeof loadConfig;
  openStateSession: (
    adapter: StateBranchAdapter,
    configuration: StatePersistenceConfiguration,
  ) => Promise<StatePersistenceSession>;
  readWorkflowArtifact: typeof readWorkflowArtifactFile;
  createStateBranchAdapter: () => StateBranchAdapter;
  discordHttpClient: DiscordWebhookHttpClient;
  now: () => Date;
  sleep: (delayMilliseconds: number) => Promise<void>;
  random: () => number;
  writeJsonArtifact: (path: string, value: unknown) => Promise<void>;
  writePublicData: (
    outputDirectory: string,
    data: GeneratedPublicData,
  ) => Promise<PublicDataWriteResult>;
  sendDiscord: typeof sendDiscordDigest;
}>;

/** production-runtimeに残すlabel rule正規化処理。 */
export type NormalizeLabelRules = (config: Config) => readonly LabelRule[];

/** すでに対象configを閉じ込めた遅延label rule取得処理。 */
export type ResolveLabelRules = () => readonly LabelRule[];

/** production-runtimeに残す完了時tracking.startAt確定処理。 */
export type ResolveCompletedTrackingStartAt = (
  config: Config,
  snapshot: StateSnapshot,
  completedAt: UtcIsoDateTime,
) => TrackingStartAtState;

/** 公開stageだけを具体化したdaily transaction型対応表。 */
export type PublicationDailyTypes = DailyTransactionTypeMap &
  Readonly<{
    configuration: PublicationConfiguration;
    state: PublicationState;
    repositoryInventory: PublicationRepositoryInventory;
    validated: ValidatedRun;
    persisted: PersistedRun;
    pages: PagesResult;
    discord: DiscordResult;
  }>;

/** 完全性検証後の出力・永続化stageだけを受け持つ依存。 */
export type DailyPublicationStageHandlers = Pick<
  DailyTransactionDependencies<PublicationDailyTypes>,
  | "persistState"
  | "buildPages"
  | "sendDiscord"
  | "completeRun"
  | "sendOperationsAlert"
  | "writeCollectAnalyzeArtifact"
>;
