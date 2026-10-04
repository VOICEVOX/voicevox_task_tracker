import type {
  PagesContentManifest,
  PagesDeploymentIntent,
} from "../../../application/tracking-run/pages-build-contracts.js";
import type { ReceiptChainEvidence } from "../../../application/tracking-run/receipt-chain-schema.js";
import type { PagesBuildReceipt } from "../../../application/tracking-run/receipt-schema.js";
import type { Sha256Hash } from "../../../canonical-json/sha256.js";
import type { Config, loadConfig } from "../../../config/index.js";
import type { DiagnosticsJsonlRecorder } from "../../../diagnostics/recorder.js";
import type { DiscordWebhookHttpClient, sendDiscordDigest } from "../../../discord/index.js";
import type { Repository } from "../../../domain/index.js";
import type { PublicRepositoryAllowlist } from "../../../github/index.js";
import type { GeneratedPublicData, PublicDataWriteResult } from "../../../pages/index.js";
import type {
  StateBranchAdapter,
  StateNotificationLedger,
  StatePersistenceConfiguration,
  StatePersistenceSession,
  StateSnapshotReadResult,
} from "../../../persistence/index.js";
import type {
  InitialPagesDeploymentOutcome,
  SequentialPagesResult,
} from "../initial-pages-deployment.js";
import type { InitialStateCommitResult } from "../initial-state-commit.js";
import type { NotificationHistoryPagesBuildArtifact } from "../notification-history-pages-build-artifact.js";
import type { NotificationHistoryPagesDeploymentOutcome } from "../notification-history-pages-deployment-outcome.js";

import type { RuntimeCredentials, RuntimeExecutionTarget } from "../production-runtime-setup.js";

/** 初期保存後にPages生成へ渡す値。 */
export type PersistedRun = Readonly<{
  result: InitialStateCommitResult;
}>;

/** Pages生成と書込みの結果。 */
export type InitialPagesPreparedRun = Readonly<{
  data: GeneratedPublicData;
  output: PublicDataWriteResult;
  pagesUrl: string;
  manifest: PagesContentManifest;
  intent: PagesDeploymentIntent;
  receipt: PagesBuildReceipt;
}>;

/** 最終state revisionと公開要否を固定した通知履歴Pages結果。 */
export type NotificationHistoryPagesPreparedRun = NotificationHistoryPagesBuildArtifact;

/** 通知履歴Pagesを公開した結果または不要と証明した結果。 */
export type NotificationHistoryPublishedRun =
  | Readonly<{
      kind: "deployed";
      prepared: Extract<NotificationHistoryPagesPreparedRun, { status: "built" }>;
      deployment: Extract<NotificationHistoryPagesDeploymentOutcome, { kind: "deployed" }>;
    }>
  | Readonly<{
      kind: "not_required";
      prepared: Extract<NotificationHistoryPagesPreparedRun, { status: "not_required" }>;
      deployment: Extract<NotificationHistoryPagesDeploymentOutcome, { kind: "not_required" }>;
    }>;

/** deploy receiptと保存候補証拠を持つ初回Pages公開結果。 */
export type InitialPagesPublishedRun = Readonly<{
  prepared: InitialPagesPreparedRun;
  deployment: Extract<InitialPagesDeploymentOutcome, { kind: "success" }>;
  pagesUrl: string;
  receiptEvidence: ReceiptChainEvidence;
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
  allowlistDigest: Sha256Hash;
}>;

/** 公開処理だけが必要とする外部接続。 */
export type RunPublicationAdapters = Readonly<{
  environment: Readonly<NodeJS.ProcessEnv>;
  diagnosticsRecorder?: DiagnosticsJsonlRecorder;
  repositoryPath: string;
  pagesOutputDirectory: string;
  loadConfig: typeof loadConfig;
  openStateSession: (
    adapter: StateBranchAdapter,
    configuration: StatePersistenceConfiguration,
    migrationTimezone: string,
  ) => Promise<StatePersistenceSession>;
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
  buildWebOutput: (repositoryPath: string) => Promise<void>;
  deployProductionPages: (intent: PagesDeploymentIntent) => Promise<SequentialPagesResult>;
  sendDiscord: typeof sendDiscordDigest;
}>;
