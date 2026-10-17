import {
  PagesEffectNotStartedError,
  publishPagesWithEffect,
} from "../../../application/tracking-run/pages-effect.js";
import { parseNotificationHistoryPagesBuildArtifact } from "../notification-history-pages-build-artifact.js";
import type { NotificationHistoryPagesDeploymentOutcome } from "../notification-history-pages-deployment-outcome.js";
import {
  recordNotificationHistorySequentialDeployment,
  recordNotificationHistorySequentialFailure,
} from "../notification-history-pages-deployment-record.js";
import { preflightNotificationHistoryPagesDeployment } from "../notification-history-pages-deployment.js";
import { sequentialPagesArtifactPath } from "../sequential-pages-artifact-path.js";
import type {
  NotificationHistoryPagesPreparedRun,
  NotificationHistoryPublishedRun,
  RunPublicationAdapters,
} from "./contracts.js";
import { buildNotificationHistoryPages } from "./notification-history-pages.js";

/** 履歴Pagesの未確定効果をfinal stateを維持したままCLI境界へ渡す。 */
export class NotificationHistoryPagesFailureError extends Error {
  public readonly outcome: Extract<NotificationHistoryPagesDeploymentOutcome, { kind: "failure" }>;

  public constructor(
    outcome: Extract<NotificationHistoryPagesDeploymentOutcome, { kind: "failure" }>,
    cause: unknown,
  ) {
    super(`通知履歴Pages公開を確定できません。種別: ${outcome.reason}`, { cause });
    this.name = "NotificationHistoryPagesFailureError";
    this.outcome = outcome;
  }
}

/** 最終stateとsettlement receiptから通知履歴Pagesを作る。 */
export async function buildDailyNotificationHistoryPages(
  adapters: Pick<
    RunPublicationAdapters,
    | "repositoryPath"
    | "pagesOutputDirectory"
    | "createStateBranchAdapter"
    | "writePublicData"
    | "buildWebOutput"
    | "writeJsonArtifact"
    | "now"
  >,
  input: Readonly<{
    configuration: import("./contracts.js").PublicationConfiguration;
    settlementReceipt: import("../../../application/tracking-run/receipt-schema.js").NotificationSettlementReceipt;
    finalizationReceipt: import("../../../application/tracking-run/receipt-schema.js").RunFinalizationReceipt;
  }>,
): Promise<NotificationHistoryPagesPreparedRun> {
  const built = await buildNotificationHistoryPages({
    adapter: adapters.createStateBranchAdapter(),
    config: input.configuration.config,
    stateConfiguration: input.configuration.target.state,
    settlementReceipt: input.settlementReceipt,
    finalizationReceipt: input.finalizationReceipt,
    repositoryPath: adapters.repositoryPath,
    outputDirectory: adapters.pagesOutputDirectory,
    knownSecrets: input.configuration.credentials.knownSecrets,
    writePublicData: adapters.writePublicData,
    buildWebOutput: adapters.buildWebOutput,
    now: adapters.now,
  });
  const artifact = parseNotificationHistoryPagesBuildArtifact(built);
  if (artifact.receipt.binding.bindingKind !== "checkpoint") {
    throw new TypeError("通知履歴Pages build receiptにcheckpoint結合がありません");
  }
  await adapters.writeJsonArtifact(
    sequentialPagesArtifactPath(
      adapters.repositoryPath,
      artifact.receipt.binding.runId,
      "notification-history",
      "build",
    ),
    artifact,
  );
  return artifact;
}

/** 通知履歴Pagesを公開前に再検証して結果をreceiptへ結ぶ。 */
export async function deployDailyNotificationHistoryPages(
  adapters: Pick<
    RunPublicationAdapters,
    | "repositoryPath"
    | "createStateBranchAdapter"
    | "deployProductionPages"
    | "writeJsonArtifact"
    | "now"
  >,
  input: Readonly<{
    configuration: import("./contracts.js").PublicationConfiguration;
    prepared: NotificationHistoryPagesPreparedRun;
    settlementReceipt: import("../../../application/tracking-run/receipt-schema.js").NotificationSettlementReceipt;
    finalizationReceipt: import("../../../application/tracking-run/receipt-schema.js").RunFinalizationReceipt;
    runId: string;
  }>,
): Promise<NotificationHistoryPublishedRun> {
  const artifact = parseNotificationHistoryPagesBuildArtifact(input.prepared);
  return publishPagesWithEffect(artifact, {
    preflight: (build) =>
      preflightNotificationHistoryPagesDeployment({
        adapter: adapters.createStateBranchAdapter(),
        config: input.configuration.config,
        configuration: input.configuration.target.state,
        repositoryPath: adapters.repositoryPath,
        artifact: build,
        settlementReceipt: input.settlementReceipt,
        finalizationReceipt: input.finalizationReceipt,
        replay: false,
        observedAt: adapters.now().toISOString(),
        effectTarget: input.configuration.target.kind,
      }),
    intent: (build) => {
      if (build.status !== "built") {
        throw new TypeError("不要な通知履歴Pagesへdeploy intentを作れません");
      }
      return build.intent;
    },
    deploy: async (intent) => {
      if (input.configuration.target.kind !== "production") {
        return { kind: "deployed", result: undefined };
      }
      try {
        return { kind: "deployed", result: await adapters.deployProductionPages(intent) };
      } catch (cause: unknown) {
        if (cause instanceof PagesEffectNotStartedError) {
          return { kind: "no_effect", cause };
        }
        throw cause;
      }
    },
    record: async (build, preflight, observation) => {
      const deployed =
        observation.kind === "no_effect" || observation.kind === "ambiguous"
          ? recordNotificationHistorySequentialFailure(
              build,
              preflight,
              observation.kind,
              adapters.now().toISOString(),
            )
          : recordNotificationHistorySequentialDeployment({
              artifact: build,
              preflight,
              target: input.configuration.target.kind === "production" ? "production" : "recording",
              ...(observation.kind !== "deployed" || observation.result == null
                ? {}
                : { productionResult: observation.result }),
              recordingId: `${input.runId}:${build.receipt.receiptDigest}`,
              observedAt: adapters.now().toISOString(),
            });
      await adapters.writeJsonArtifact(
        sequentialPagesArtifactPath(
          adapters.repositoryPath,
          input.runId,
          "notification-history",
          "deployment",
        ),
        deployed,
      );
      return deployed;
    },
    requirePublished: (deployment, observation) => {
      if (deployment.kind === "failure") {
        throw new NotificationHistoryPagesFailureError(
          deployment,
          observation.kind === "ambiguous" || observation.kind === "no_effect"
            ? observation.cause
            : undefined,
        );
      }
      if (deployment.kind === "not_required" && artifact.status === "not_required") {
        return Object.freeze({ kind: "not_required", prepared: artifact, deployment });
      }
      if (deployment.kind === "deployed" && artifact.status === "built") {
        return Object.freeze({ kind: "deployed", prepared: artifact, deployment });
      }
      throw new TypeError("通知履歴Pagesのbuildと公開結果が一致しません");
    },
  });
}
