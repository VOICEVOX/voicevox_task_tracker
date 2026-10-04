import { resolve } from "node:path";
import { serializeCanonicalJson } from "../../../../canonical-json/value.js";
import type { SequentialRunDependencies } from "../../sequential-run-contracts.js";

import { completeTrackingRun } from "../../../../application/tracking-run/complete-run.js";
import { createInitialPagesPublicationEvidence } from "../../../../application/tracking-run/initial-pages-evidence.js";
import {
  PagesEffectNotStartedError,
  publishPagesWithEffect,
} from "../../../../application/tracking-run/pages-effect.js";
import {
  RECEIPT_CHAIN_SCHEMA_VERSION,
  receiptChainEnvelopeSchema,
  type ReceiptChainEntry,
  type ReceiptChainEvidence,
} from "../../../../application/tracking-run/receipt-chain-schema.js";
import { verifyReceiptChain } from "../../../../application/tracking-run/receipt-chain.js";
import type {
  InitialStateCommitReceipt,
  NotificationSettlementReceipt,
  PagesBuildReceipt,
  Receipt,
  RunFinalizationReceipt,
} from "../../../../application/tracking-run/receipt-schema.js";
import { nodeContentDigestPort } from "../../content-digest.js";
import type { RecoveryStageInput } from "../../recovery-stage.js";

import type { RunRequest } from "../../../../application/tracking-run/request.js";
import type { DurablePublicationRecord } from "../../../../publication/durable-record-schema.js";
import {
  decodeInitialPagesBuildArtifact,
  parseInitialPagesBuildArtifact,
  type InitialPagesBuildArtifact,
} from "../../initial-pages-build-artifact.js";
import {
  InitialPagesDeploymentFailureError,
  preflightInitialPagesDeployment,
  readInitialPagesDeploymentOutcome,
  recordInitialPagesSequentialDeployment,
  recordInitialPagesSequentialFailure,
} from "../../initial-pages-deployment.js";
import {
  decodeNotificationHistoryPagesBuildArtifact,
  parseNotificationHistoryPagesBuildArtifact,
  type NotificationHistoryPagesBuildArtifact,
} from "../../notification-history-pages-build-artifact.js";
import { readNotificationMessageState } from "../../notification-message-state.js";
import {
  NotificationSettlementFailureError,
  settleNotifications,
} from "../../notification-settlement.js";
import { createNotificationSettlementPort } from "../../notification-stage-runtime.js";
import { readRuntimeCredentials, resolveRuntimeTarget } from "../../production-runtime-setup.js";
import {
  buildDailyNotificationHistoryPages,
  deployDailyNotificationHistoryPages,
} from "../../publication/daily-history-pages.js";
import { buildNotificationHistoryPages } from "../../publication/notification-history-pages.js";
import { buildPublicPages } from "../../publication/pages.js";
import { finalizeRun } from "../../run-finalization.js";
import { sequentialPagesArtifactPath } from "../../sequential-pages-artifact-path.js";
import { sequentialReceiptPath } from "../../sequential-receipt-path.js";
import type { ProductionRuntimeAdapters } from "../adapters.js";
import { readSequentialReceipts } from "./launch.js";

type SequentialStageDependencies = SequentialRunDependencies;
type PendingConfiguration = Readonly<{
  config: Awaited<ReturnType<ProductionRuntimeAdapters["loadConfig"]>>;
  target: Awaited<ReturnType<typeof resolveRuntimeTarget>>;
  credentials: ReturnType<typeof readRuntimeCredentials>;
}>;

async function optionalArtifactBytes(
  adapters: ProductionRuntimeAdapters,
  path: string,
): Promise<Uint8Array | undefined> {
  try {
    return await adapters.readArtifactBytes(resolve(adapters.repositoryPath, path));
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function initialReceipt(entries: readonly ReceiptChainEntry[]): InitialStateCommitReceipt {
  const receipt = entries.find(
    (entry) => entry.receipt.receiptType === "initial_state_commit",
  )?.receipt;
  if (receipt?.receiptType !== "initial_state_commit") {
    throw new TypeError("再開に必要なinitial_state_commit receiptが保存されていません");
  }
  return receipt;
}

function initialBuildReceipt(entries: readonly ReceiptChainEntry[]): PagesBuildReceipt {
  const receipt = entries.find(
    (entry) => entry.receipt.receiptType === "pages_build" && entry.receipt.phase === "initial",
  )?.receipt;
  if (receipt?.receiptType !== "pages_build" || receipt.phase !== "initial") {
    throw new TypeError("再開に必要な初回Pages build receiptが保存されていません");
  }
  return receipt;
}

function settlementReceipt(entries: readonly ReceiptChainEntry[]): NotificationSettlementReceipt {
  const receipt = entries.find(
    (entry) => entry.receipt.receiptType === "notification_settlement",
  )?.receipt;
  if (receipt?.receiptType !== "notification_settlement") {
    throw new TypeError("再開に必要なnotification_settlement receiptが保存されていません");
  }
  return receipt;
}

function finalizationReceipt(entries: readonly ReceiptChainEntry[]): RunFinalizationReceipt {
  const receipt = entries.find(
    (entry) => entry.receipt.receiptType === "run_finalization",
  )?.receipt;
  if (receipt?.receiptType !== "run_finalization") {
    throw new TypeError("再開に必要なrun_finalization receiptが保存されていません");
  }
  return receipt;
}

async function pendingConfiguration(
  adapters: ProductionRuntimeAdapters,
  request: RunRequest,
): Promise<PendingConfiguration> {
  const config = await adapters.loadConfig(resolve(adapters.repositoryPath, request.configPath));
  const target = await resolveRuntimeTarget(
    Object.freeze({
      repositoryPath: adapters.repositoryPath,
      ...(adapters.readSandboxContext == null
        ? {}
        : { readSandboxContext: adapters.readSandboxContext }),
      createStateBranchAdapter: adapters.createStateBranchAdapter,
    }),
    config,
    request,
  );
  return Object.freeze({
    config,
    target,
    credentials: readRuntimeCredentials(adapters.environment, config, request),
  });
}

async function initialPagesArtifact(
  adapters: ProductionRuntimeAdapters,
  configuration: PendingConfiguration,
  record: DurablePublicationRecord,
  initialStateRevision: string,
  initial: InitialStateCommitReceipt,
  receipt: PagesBuildReceipt,
): Promise<InitialPagesBuildArtifact> {
  const path = sequentialPagesArtifactPath(
    adapters.repositoryPath,
    record.runIdentity.runId,
    "initial",
    "build",
  );
  const saved = await optionalArtifactBytes(adapters, path);
  if (saved != null) {
    const artifact = decodeInitialPagesBuildArtifact(saved);
    if (
      artifact.receipt.receiptDigest !== receipt.receiptDigest ||
      artifact.intent.runId !== record.runIdentity.runId ||
      artifact.intent.checkpointDigest !== record.checkpointDigest ||
      artifact.intent.sourceStateRevision !== initialStateRevision ||
      artifact.receipt.previousReceiptDigest !== initial.receiptDigest
    ) {
      throw new TypeError("保存済み初回Pages build artifactがexact runと一致しません");
    }
    return artifact;
  }
  const rebuilt = await buildPublicPages({
    adapter: adapters.createStateBranchAdapter(),
    config: configuration.config,
    stateConfiguration: configuration.target.state,
    initialStateCommitReceipt: initial,
    repositoryPath: adapters.repositoryPath,
    outputDirectory: adapters.pagesOutputDirectory,
    knownSecrets: configuration.credentials.knownSecrets,
    writePublicData: adapters.writePublicData,
    buildWebOutput: adapters.buildWebOutput,
    now: adapters.now,
  });
  if (
    receipt.result == null ||
    rebuilt.intent.runId !== record.runIdentity.runId ||
    rebuilt.intent.checkpointDigest !== record.checkpointDigest ||
    rebuilt.intent.sourceStateRevision !== initialStateRevision ||
    rebuilt.intent.deploymentIntentDigest !== receipt.result.deploymentIntentDigest ||
    rebuilt.intent.pagesContentDigest !== receipt.result.pagesContentDigest ||
    rebuilt.intent.outputManifestDigest !== receipt.result.outputManifestDigest ||
    receipt.previousReceiptDigest !== initial.receiptDigest
  ) {
    throw new TypeError("再生成した初回Pagesのdigestが検証済みreceiptと一致しません");
  }
  const artifact = parseInitialPagesBuildArtifact({
    schemaVersion: 1,
    manifest: rebuilt.manifest,
    intent: rebuilt.intent,
    receipt,
  });
  await adapters.writeJsonArtifact(path, artifact);
  return artifact;
}

async function notificationHistoryArtifact(
  adapters: ProductionRuntimeAdapters,
  configuration: PendingConfiguration,
  record: DurablePublicationRecord,
  exactStateRevision: string,
  settlement: NotificationSettlementReceipt,
  finalization: RunFinalizationReceipt,
  receipt: PagesBuildReceipt,
): Promise<NotificationHistoryPagesBuildArtifact> {
  const path = sequentialPagesArtifactPath(
    adapters.repositoryPath,
    record.runIdentity.runId,
    "notification-history",
    "build",
  );
  const saved = await optionalArtifactBytes(adapters, path);
  if (saved != null) {
    const artifact = decodeNotificationHistoryPagesBuildArtifact(saved);
    if (
      artifact.receipt.receiptDigest !== receipt.receiptDigest ||
      artifact.receipt.binding.bindingKind !== "checkpoint" ||
      artifact.receipt.binding.runId !== record.runIdentity.runId ||
      artifact.receipt.binding.checkpointDigest !== record.checkpointDigest ||
      artifact.sourceStateRevision !== exactStateRevision ||
      artifact.receipt.previousReceiptDigest !== finalization.receiptDigest
    ) {
      throw new TypeError("保存済み通知履歴Pages build artifactがexact runと一致しません");
    }
    return artifact;
  }
  const rebuilt = await buildNotificationHistoryPages({
    adapter: adapters.createStateBranchAdapter(),
    config: configuration.config,
    stateConfiguration: configuration.target.state,
    settlementReceipt: settlement,
    finalizationReceipt: finalization,
    repositoryPath: adapters.repositoryPath,
    outputDirectory: adapters.pagesOutputDirectory,
    knownSecrets: configuration.credentials.knownSecrets,
    writePublicData: adapters.writePublicData,
    buildWebOutput: adapters.buildWebOutput,
    now: adapters.now,
  });
  if (
    rebuilt.sourceStateRevision !== exactStateRevision ||
    rebuilt.receipt.binding.bindingKind !== "checkpoint" ||
    rebuilt.receipt.binding.runId !== record.runIdentity.runId ||
    rebuilt.receipt.binding.checkpointDigest !== record.checkpointDigest ||
    receipt.previousReceiptDigest !== finalization.receiptDigest ||
    rebuilt.status !== receipt.status ||
    (rebuilt.status === "built" &&
      (receipt.result?.deploymentIntentDigest !== rebuilt.intent.deploymentIntentDigest ||
        receipt.result.pagesContentDigest !== rebuilt.intent.pagesContentDigest ||
        receipt.result.outputManifestDigest !== rebuilt.intent.outputManifestDigest)) ||
    (rebuilt.status === "not_required" && receipt.notRequiredReason !== rebuilt.reason)
  ) {
    throw new TypeError("再生成した通知履歴Pagesのdigestが検証済みreceiptと一致しません");
  }
  const artifact = parseNotificationHistoryPagesBuildArtifact({ ...rebuilt, receipt });
  await adapters.writeJsonArtifact(path, artifact);
  return artifact;
}

/** 保存済みrunのexact effectを実行するproduction portを作る。 */
export function createPendingRunStage(
  adapters: ProductionRuntimeAdapters,
  request: RunRequest,
  invocationId: string,
  inspectLaunch: SequentialStageDependencies["inspectLaunch"],
  getRunId: () => string,
  onReceiptRecorded: (receipt: Receipt) => void,
): ReturnType<SequentialStageDependencies["pendingRun"]> {
  const readEntries = (): Promise<ReceiptChainEntry[]> =>
    readSequentialReceipts(adapters.repositoryPath, getRunId(), adapters.readArtifactBytes).then(
      (entries) => [...entries],
    );
  const appendEntries = async (...added: readonly ReceiptChainEntry[]): Promise<void> => {
    const entries = await readEntries();
    const recorded: Receipt[] = [];
    for (const entry of added) {
      if (
        entries.some((current) => current.receipt.receiptDigest === entry.receipt.receiptDigest)
      ) {
        continue;
      }
      entries.push(entry);
      recorded.push(entry.receipt);
    }
    verifyReceiptChain(entries, nodeContentDigestPort);
    await adapters.writeJsonArtifact(
      sequentialReceiptPath(adapters.repositoryPath, getRunId()),
      receiptChainEnvelopeSchema.parse({ schemaVersion: RECEIPT_CHAIN_SCHEMA_VERSION, entries }),
    );
    for (const receipt of recorded) {
      onReceiptRecorded(receipt);
    }
  };
  const inspect = async (): Promise<RecoveryStageInput> => {
    const launch = await inspectLaunch(request, invocationId, {
      kind: "retry_run",
      runId: getRunId(),
    });
    if (launch.runtime !== "exact" || launch.decision.kind !== "resume_pending") {
      throw new TypeError("再開中のrunがexact pendingでなくなりました");
    }
    return launch.decision.pending;
  };
  return Object.freeze({
    inspect,
    execute: Object.freeze({
      initial_pages_build: async (value: RecoveryStageInput) => {
        if (value.stage !== "initial_pages_build") {
          throw new TypeError("初回Pages buildの再開段階が一致しません");
        }
        const configuration = await pendingConfiguration(adapters, request);
        const entries = await readEntries();
        const initial =
          entries.length === 0
            ? value.resumeInput.initialStateCommitReceipt
            : initialReceipt(entries);
        if (entries.length === 0) {
          if (value.resumeInput.initialStateCommitEvidence == null) {
            throw new TypeError("初回state commitの再観測証拠がありません");
          }
          await appendEntries({
            receipt: initial,
            evidence: { kind: "state_commit", state: value.resumeInput.initialStateCommitEvidence },
          });
        }
        const buildPath = sequentialPagesArtifactPath(
          adapters.repositoryPath,
          value.record.runIdentity.runId,
          "initial",
          "build",
        );
        const saved = await optionalArtifactBytes(adapters, buildPath);
        if (saved != null) {
          const artifact = decodeInitialPagesBuildArtifact(saved);
          if (
            artifact.intent.runId !== value.record.runIdentity.runId ||
            artifact.intent.checkpointDigest !== value.record.checkpointDigest ||
            artifact.intent.sourceStateRevision !== value.initialStateRevision ||
            artifact.receipt.previousReceiptDigest !== initial.receiptDigest
          ) {
            throw new TypeError("保存済み初回Pages build artifactがexact runと一致しません");
          }
          await appendEntries({ receipt: artifact.receipt, evidence: { kind: "none" } });
          return;
        }
        const built = await buildPublicPages({
          adapter: adapters.createStateBranchAdapter(),
          config: configuration.config,
          stateConfiguration: configuration.target.state,
          initialStateCommitReceipt: initial,
          repositoryPath: adapters.repositoryPath,
          outputDirectory: adapters.pagesOutputDirectory,
          knownSecrets: configuration.credentials.knownSecrets,
          writePublicData: adapters.writePublicData,
          buildWebOutput: adapters.buildWebOutput,
          now: adapters.now,
        });
        await adapters.writeJsonArtifact(
          buildPath,
          parseInitialPagesBuildArtifact({
            schemaVersion: 1,
            manifest: built.manifest,
            intent: built.intent,
            receipt: built.receipt,
          }),
        );
        await appendEntries({ receipt: built.receipt, evidence: { kind: "none" } });
      },
      initial_pages_deploy: async (value: RecoveryStageInput) => {
        if (value.stage !== "initial_pages_deploy") {
          throw new TypeError("初回Pages deployの再開段階が一致しません");
        }
        const configuration = await pendingConfiguration(adapters, request);
        const initial = initialReceipt(await readEntries());
        let artifact: InitialPagesBuildArtifact;
        try {
          artifact = await initialPagesArtifact(
            adapters,
            configuration,
            value.record,
            value.initialStateRevision,
            initial,
            value.buildReceipt,
          );
        } catch (cause: unknown) {
          throw new PagesEffectNotStartedError("初回Pages公開用buildの再読込に失敗しました", {
            cause,
          });
        }
        const deployment = await publishPagesWithEffect(artifact, {
          preflight: (build) =>
            preflightInitialPagesDeployment({
              adapter: adapters.createStateBranchAdapter(),
              configuration: configuration.target.state,
              repositoryPath: adapters.repositoryPath,
              artifact: build,
              initialStateCommitReceipt: initial,
              replay: true,
              observedAt: adapters.now().toISOString(),
              effectTarget: configuration.target.kind,
            }),
          intent: (build) => build.intent,
          deploy: async (intent) => {
            if (configuration.target.kind !== "production") {
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
            const outcome =
              observation.kind === "no_effect" || observation.kind === "ambiguous"
                ? recordInitialPagesSequentialFailure(build, preflight, observation.kind)
                : recordInitialPagesSequentialDeployment({
                    artifact: build,
                    preflight,
                    target: configuration.target.kind === "production" ? "production" : "recording",
                    ...(observation.kind !== "deployed" || observation.result == null
                      ? {}
                      : { productionResult: observation.result }),
                    recordingId: `${value.record.runIdentity.runId}:${build.intent.deploymentIntentDigest}`,
                    observedAt: adapters.now().toISOString(),
                  });
            await adapters.writeJsonArtifact(
              sequentialPagesArtifactPath(
                adapters.repositoryPath,
                value.record.runIdentity.runId,
                "initial",
                "deployment",
              ),
              outcome,
            );
            return outcome;
          },
          requirePublished: (outcome, observation) => {
            if (outcome.kind !== "success") {
              throw new InitialPagesDeploymentFailureError(
                outcome,
                observation.kind === "ambiguous" || observation.kind === "no_effect"
                  ? observation.cause
                  : undefined,
              );
            }
            return outcome;
          },
        });
        let evidence: ReceiptChainEvidence = { kind: "none" };
        if (deployment.receipt.receiptKind === "observed") {
          const revision = deployment.receipt.expectedStateRevision;
          if (typeof revision !== "string") {
            throw new TypeError("再観測した初回Pagesにexact state revisionがありません");
          }
          const state = await readNotificationMessageState(
            adapters.createStateBranchAdapter(),
            configuration.target.state,
            revision,
          );
          const marker = state.transaction.marker;
          if (
            marker.phase === "initial_state_committed" ||
            state.transaction.initialPagesEvidence == null ||
            serializeCanonicalJson(state.transaction.initialPagesEvidence) !==
              serializeCanonicalJson(deployment.evidence)
          ) {
            throw new TypeError("初回Pages再観測receiptとexact state証拠が一致しません");
          }
          evidence = {
            kind: "initial_pages_state",
            state: {
              exactStateRevision: revision,
              marker: {
                runId: marker.runId,
                checkpointDigest: marker.checkpointDigest,
                phase: marker.phase,
                initialPagesPublicationEvidenceDigest: marker.initialPagesPublicationEvidenceDigest,
                initialStateRevision: marker.initialStateRevision,
              },
              evidence: deployment.evidence,
            },
          };
        }
        await appendEntries({ receipt: deployment.receipt, evidence });
      },
      notifications: async (value: RecoveryStageInput) => {
        if (value.stage !== "notifications") {
          throw new TypeError("通知settlementの再開段階が一致しません");
        }
        const configuration = await pendingConfiguration(adapters, request);
        const entries = await readEntries();
        const initial = initialReceipt(entries);
        const build = await initialPagesArtifact(
          adapters,
          configuration,
          value.record,
          value.initialStateRevision,
          initial,
          initialBuildReceipt(entries),
        );
        const deploymentPath = sequentialPagesArtifactPath(
          adapters.repositoryPath,
          value.record.runIdentity.runId,
          "initial",
          "deployment",
        );
        const savedDeployment = await optionalArtifactBytes(adapters, deploymentPath);
        const deploymentReceipt = entries[2]?.receipt;
        if (
          deploymentReceipt?.receiptType !== "pages_deployment" ||
          deploymentReceipt.phase !== "initial"
        ) {
          throw new TypeError("再開に必要な初回Pages deployment receiptが保存されていません");
        }
        const deployed =
          savedDeployment == null
            ? {
                kind: "success" as const,
                receipt: deploymentReceipt,
                evidence: createInitialPagesPublicationEvidence(
                  {
                    buildReceipt: build.receipt,
                    deploymentReceipt,
                    sourceStateRevision: value.initialStateRevision,
                  },
                  nodeContentDigestPort,
                ),
              }
            : await readInitialPagesDeploymentOutcome(deploymentPath, build);
        if (savedDeployment == null) {
          await adapters.writeJsonArtifact(deploymentPath, deployed);
        }
        const initialState = await readNotificationMessageState(
          adapters.createStateBranchAdapter(),
          configuration.target.state,
          value.initialStateRevision,
        );
        if (
          deployed.kind !== "success" ||
          build.receipt.receiptDigest !== entries[1]?.receipt.receiptDigest ||
          deployed.receipt.receiptDigest !== entries[2]?.receipt.receiptDigest ||
          (value.source.kind === "deployment_receipt" &&
            deployed.receipt.receiptDigest !== value.source.receipt.receiptDigest) ||
          (value.source.kind === "state_evidence" &&
            serializeCanonicalJson(deployed.evidence) !==
              serializeCanonicalJson(value.source.evidence))
        ) {
          throw new TypeError("保存済み初回Pages公開artifactとexact receiptが一致しません");
        }
        const outcome = await settleNotifications(
          {
            record: value.record,
            initialStateReceipt: initial,
            initialPages: {
              kind: "published",
              buildReceipt: build.receipt,
              deploymentReceipt: deployed.receipt,
              evidence: deployed.evidence,
            },
            pagesReceipt: deployed.receipt,
          },
          createNotificationSettlementPort(
            adapters,
            configuration.target.state,
            initialState.snapshot.repositories,
            configuration.credentials.knownSecrets,
            configuration.target.kind === "production" ? "production" : "recording",
          ),
        );
        if (outcome.kind !== "settled") {
          throw new NotificationSettlementFailureError(outcome);
        }
        await appendEntries(...outcome.messageReceipts, {
          receipt: outcome.receipt,
          evidence: outcome.receiptEvidence,
        });
      },
      run_finalization: async (value: RecoveryStageInput) => {
        if (value.stage !== "run_finalization") {
          throw new TypeError("run finalizationの再開段階が一致しません");
        }
        const configuration = await pendingConfiguration(adapters, request);
        const entries = await readEntries();
        const initial = initialReceipt(entries);
        const settlement = entries.some(
          (entry) => entry.receipt.receiptType === "notification_settlement",
        )
          ? settlementReceipt(entries)
          : value.resumeInput.notificationSettlementReceipt;
        if (!entries.some((entry) => entry.receipt.receiptType === "notification_settlement")) {
          if (value.resumeInput.notificationSettlementEvidence == null) {
            throw new TypeError("通知settlementの再観測証拠がありません");
          }
          await appendEntries({
            receipt: settlement,
            evidence: {
              kind: "state_commit",
              state: value.resumeInput.notificationSettlementEvidence,
            },
          });
        }
        const settledState = await readNotificationMessageState(
          adapters.createStateBranchAdapter(),
          configuration.target.state,
          value.exactStateRevision,
        );
        const outcome = await finalizeRun(
          { record: value.record, initialStateReceipt: initial, settlementReceipt: settlement },
          createNotificationSettlementPort(
            adapters,
            configuration.target.state,
            settledState.snapshot.repositories,
            configuration.credentials.knownSecrets,
            configuration.target.kind === "production" ? "production" : "recording",
          ),
        );
        if (outcome.kind !== "finalized") {
          throw new TypeError(`run finalizationを確定できません。状態: ${outcome.kind}`);
        }
        await appendEntries({ receipt: outcome.receipt, evidence: outcome.receiptEvidence });
      },
      notification_history_build: async (value: RecoveryStageInput) => {
        if (value.stage !== "notification_history_build") {
          throw new TypeError("通知履歴Pages buildの再開段階が一致しません");
        }
        const configuration = await pendingConfiguration(adapters, request);
        const entries = await readEntries();
        const settlement = settlementReceipt(entries);
        const finalization = entries.some(
          (entry) => entry.receipt.receiptType === "run_finalization",
        )
          ? finalizationReceipt(entries)
          : value.resumeInput.runFinalizationReceipt;
        if (!entries.some((entry) => entry.receipt.receiptType === "run_finalization")) {
          if (value.resumeInput.runFinalizationEvidence == null) {
            throw new TypeError("run finalizationの再観測証拠がありません");
          }
          await appendEntries({
            receipt: finalization,
            evidence: {
              kind: "state_commit",
              state: value.resumeInput.runFinalizationEvidence,
            },
          });
        }
        const buildPath = sequentialPagesArtifactPath(
          adapters.repositoryPath,
          value.record.runIdentity.runId,
          "notification-history",
          "build",
        );
        const saved = await optionalArtifactBytes(adapters, buildPath);
        if (saved != null) {
          const artifact = decodeNotificationHistoryPagesBuildArtifact(saved);
          if (
            artifact.receipt.binding.bindingKind !== "checkpoint" ||
            artifact.receipt.binding.runId !== value.record.runIdentity.runId ||
            artifact.receipt.binding.checkpointDigest !== value.record.checkpointDigest ||
            artifact.sourceStateRevision !== value.exactStateRevision ||
            artifact.receipt.previousReceiptDigest !== finalization.receiptDigest
          ) {
            throw new TypeError("保存済み通知履歴Pages build artifactがexact runと一致しません");
          }
          await appendEntries({ receipt: artifact.receipt, evidence: { kind: "none" } });
          return;
        }
        const built = await buildDailyNotificationHistoryPages(adapters, {
          configuration,
          settlementReceipt: settlement,
          finalizationReceipt: finalization,
        });
        await appendEntries({ receipt: built.receipt, evidence: { kind: "none" } });
      },
      notification_history_deploy: async (value: RecoveryStageInput) => {
        if (value.stage !== "notification_history_deploy") {
          throw new TypeError("通知履歴Pages deployの再開段階が一致しません");
        }
        const configuration = await pendingConfiguration(adapters, request);
        const entries = await readEntries();
        let artifact: NotificationHistoryPagesBuildArtifact;
        try {
          artifact = await notificationHistoryArtifact(
            adapters,
            configuration,
            value.record,
            value.exactStateRevision,
            settlementReceipt(entries),
            finalizationReceipt(entries),
            value.buildReceipt,
          );
        } catch (cause: unknown) {
          throw new PagesEffectNotStartedError("通知履歴Pages公開用buildの再読込に失敗しました", {
            cause,
          });
        }
        const deployment = await deployDailyNotificationHistoryPages(adapters, {
          configuration,
          prepared: artifact,
          settlementReceipt: settlementReceipt(entries),
          finalizationReceipt: finalizationReceipt(entries),
          runId: value.record.runIdentity.runId,
        });
        await appendEntries({ receipt: deployment.deployment.receipt, evidence: { kind: "none" } });
      },
    }),
    complete: async () => {
      const entries = await readEntries();
      const finalization = finalizationReceipt(entries);
      return completeTrackingRun(
        {
          entries,
          finalStateRevision: finalization.result.resultingStateRevision,
          invocationId,
          observedAt: adapters.now().toISOString(),
        },
        nodeContentDigestPort,
      );
    },
  });
}
