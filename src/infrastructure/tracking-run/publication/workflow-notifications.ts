import type { NotificationSettlementOutcome } from "../notification-settlement-contracts.js";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { ZodError } from "zod";

import { decodeReceipt } from "../../../application/tracking-run/receipt-codec.js";
import type {
  InitialStateCommitReceipt,
  ManualResolutionReceipt,
  PagesDeploymentReceipt,
} from "../../../application/tracking-run/receipt-schema.js";
import { serializeCanonicalJson } from "../../../canonical-json/value.js";
import { StateFormatError, StateHistoryError } from "../../../persistence/errors.js";
import { nodeContentDigestPort } from "../content-digest.js";
import {
  decodeInitialPagesBuildArtifact,
  type InitialPagesBuildArtifact,
} from "../initial-pages-build-artifact.js";
import {
  decodeInitialPagesDeploymentEvidence,
  readInitialPagesDeploymentOutcome,
  type InitialPagesDeploymentOutcome,
} from "../initial-pages-deployment.js";
import { readNotificationMessageState } from "../notification-message-state.js";
import {
  NotificationSettlementFailureError,
  settleNotificationsWithPreflight,
} from "../notification-settlement.js";
import { createNotificationSettlementPort } from "../notification-stage-runtime.js";
import { NotificationStructureError } from "../notification-structure-error.js";
import { requireEnvironmentValue } from "../production-runtime-setup.js";
import { observeInitialPagesFromState } from "../publication-resume-inputs.js";
import { finalizeRun } from "../run-finalization.js";
import type { FinalizeRunOutcome } from "../run-finalization-contracts.js";
import type { RunPublicationAdapters } from "./contracts.js";
import type {
  WorkflowNotificationSettlementInput,
  WorkflowRunFinalizationInput,
} from "./operation-inputs.js";

type WorkflowNotificationAdapters = Pick<
  RunPublicationAdapters,
  | "repositoryPath"
  | "environment"
  | "loadConfig"
  | "createStateBranchAdapter"
  | "discordHttpClient"
  | "diagnosticsRecorder"
  | "writeJsonArtifact"
  | "now"
  | "sleep"
  | "random"
>;

function pagesArtifactFailure(cause: unknown): never {
  if (
    cause instanceof SyntaxError ||
    cause instanceof ZodError ||
    cause instanceof TypeError ||
    (cause instanceof Error && "code" in cause && cause.code === "ENOENT")
  ) {
    throw new NotificationStructureError("workflow通知のPages artifactが不正です", "no_effect", {
      cause,
    });
  }
  throw cause;
}

async function optionalPagesArtifact(path: string): Promise<Uint8Array | undefined> {
  try {
    return await readFile(path);
  } catch (cause: unknown) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") {
      return undefined;
    }
    throw cause;
  }
}

async function initialReceipt(
  adapters: WorkflowNotificationAdapters,
  path: string,
  expectedRunId: string | undefined,
): Promise<InitialStateCommitReceipt> {
  const receipt = decodeReceipt(
    await readFile(resolve(adapters.repositoryPath, path)),
    nodeContentDigestPort,
  );
  if (
    receipt.receiptType !== "initial_state_commit" ||
    receipt.binding.bindingKind !== "checkpoint" ||
    receipt.binding.runId !==
      (expectedRunId ??
        requireEnvironmentValue(adapters.environment, "VOICEVOX_EXPECTED_RUN_ID")) ||
    (adapters.environment["VOICEVOX_EXPECTED_RUN_ID"] != null &&
      receipt.binding.runId !== adapters.environment["VOICEVOX_EXPECTED_RUN_ID"])
  ) {
    throw new TypeError("workflow通知の初回state receiptが期待runと一致しません");
  }
  return receipt;
}

/** split workflowの通知をexact state recordからsettleする。 */
export async function settleWorkflowNotifications(
  adapters: WorkflowNotificationAdapters,
  command: WorkflowNotificationSettlementInput,
  priorPagesReceipt?: PagesDeploymentReceipt,
): Promise<Extract<NotificationSettlementOutcome, { kind: "settled" }>> {
  const config = await adapters.loadConfig(resolve(adapters.repositoryPath, command.configPath));
  let manualResolutionReceipt: ManualResolutionReceipt | undefined;
  if (command.manualResolutionReceiptPath != null) {
    const receipt = decodeReceipt(
      await readFile(resolve(adapters.repositoryPath, command.manualResolutionReceiptPath)),
      nodeContentDigestPort,
    );
    if (
      receipt.receiptType !== "manual_resolution" ||
      receipt.binding.bindingKind !== "checkpoint"
    ) {
      throw new TypeError("workflow通知の手動解決receiptが不正です");
    }
    manualResolutionReceipt = receipt;
  }
  const initialStateReceipt = await initialReceipt(
    adapters,
    command.initialStateReceiptPath,
    manualResolutionReceipt?.binding.bindingKind === "checkpoint"
      ? manualResolutionReceipt.binding.runId
      : undefined,
  );
  const adapter = adapters.createStateBranchAdapter();
  const initial = await readNotificationMessageState(
    adapter,
    config.state,
    initialStateReceipt.result.resultingStateRevision,
  );
  const record = initial.transaction.record;
  const knownSecrets =
    record.executionPolicy.effectTarget === "production" &&
    record.notificationOutbox.action === "send" &&
    record.notificationOutbox.settings.enabled
      ? [
          requireEnvironmentValue(
            adapters.environment,
            record.notificationOutbox.settings.webhookSecretName,
          ),
          requireEnvironmentValue(
            adapters.environment,
            record.notificationOutbox.settings.operationsWebhookSecretName,
          ),
        ]
      : [];
  const outcome = await settleNotificationsWithPreflight(
    {
      record,
      initialStateReceipt,
      ...(manualResolutionReceipt == null ? {} : { manualResolutionReceipt }),
      loadPages: async () => {
        const head = await adapter.resolveHead(config.state.branch);
        if (head.status !== "present") {
          throw new TypeError("workflow通知のstate branchがありません");
        }
        let current: Awaited<ReturnType<typeof readNotificationMessageState>>;
        try {
          current = await readNotificationMessageState(adapter, config.state, head.revision);
        } catch (cause: unknown) {
          if (
            cause instanceof TypeError ||
            cause instanceof SyntaxError ||
            cause instanceof ZodError ||
            cause instanceof StateFormatError ||
            cause instanceof StateHistoryError
          ) {
            throw new NotificationStructureError("workflow通知の現在stateが不正です", "no_effect", {
              cause,
            });
          }
          throw cause;
        }
        if (
          current.transaction.record.recordDigest !== record.recordDigest ||
          current.transaction.marker.runId !== record.runIdentity.runId ||
          current.transaction.marker.checkpointDigest !== record.checkpointDigest
        ) {
          throw new NotificationStructureError(
            "workflow通知の現在stateが永続runと一致しません",
            "no_effect",
          );
        }
        const buildPath = resolve(adapters.repositoryPath, command.buildArtifactPath);
        const deploymentPath = resolve(adapters.repositoryPath, command.deploymentOutcomePath);
        if (current.transaction.marker.phase !== "initial_state_committed") {
          const evidence = current.transaction.initialPagesEvidence;
          if (evidence == null) {
            throw new NotificationStructureError(
              "workflow通知の保存済みPages証拠がありません",
              "no_effect",
            );
          }
          if (
            evidence.sourceStateRevision !== initialStateReceipt.result.resultingStateRevision ||
            evidence.pageUrl !== record.initialPagesProjection.settings.url
          ) {
            throw new NotificationStructureError(
              "workflow通知の保存済みPages証拠が初回stateと一致しません",
              "no_effect",
            );
          }
          if (priorPagesReceipt != null) {
            if (
              priorPagesReceipt.result?.pagesContentDigest !== evidence.pagesContentDigest ||
              priorPagesReceipt.result.deploymentIntentDigest !== evidence.deploymentIntentDigest ||
              priorPagesReceipt.result.pageUrl !== evidence.pageUrl ||
              (priorPagesReceipt.receiptKind === "observed"
                ? priorPagesReceipt.result.observedSourceReceiptDigest !==
                  evidence.deploymentReceiptDigest
                : priorPagesReceipt.receiptDigest !== evidence.deploymentReceiptDigest)
            ) {
              throw new NotificationStructureError(
                "workflow通知の先行Pages receiptが保存済み証拠と一致しません",
                "no_effect",
              );
            }
            return {
              initialPages: { kind: "state" as const, evidence },
              pagesReceipt: priorPagesReceipt,
            };
          }
          try {
            const buildBytes = await optionalPagesArtifact(buildPath);
            const deploymentBytes = await optionalPagesArtifact(deploymentPath);
            const build =
              buildBytes == null ? undefined : decodeInitialPagesBuildArtifact(buildBytes);
            if (
              build != null &&
              (build.intent.runId !== record.runIdentity.runId ||
                build.intent.checkpointDigest !== record.checkpointDigest ||
                build.intent.sourceStateRevision !== evidence.sourceStateRevision ||
                build.intent.deploymentIntentDigest !== evidence.deploymentIntentDigest ||
                build.intent.pagesContentDigest !== evidence.pagesContentDigest ||
                serializeCanonicalJson(build.receipt.binding) !==
                  serializeCanonicalJson(initialStateReceipt.binding))
            ) {
              throw new TypeError("workflow通知のPages build artifactと保存済み証拠が一致しません");
            }
            if (deploymentBytes != null) {
              const deployment = decodeInitialPagesDeploymentEvidence(deploymentBytes);
              if (
                serializeCanonicalJson(deployment.evidence) !== serializeCanonicalJson(evidence) ||
                (build != null &&
                  deployment.receipt.previousReceiptDigest !== build.receipt.receiptDigest)
              ) {
                throw new TypeError(
                  "workflow通知のPages deploy artifactと保存済み証拠が一致しません",
                );
              }
              if (build != null) {
                return {
                  initialPages: {
                    kind: "published" as const,
                    buildReceipt: build.receipt,
                    deploymentReceipt: deployment.receipt,
                    evidence,
                  },
                  pagesReceipt: deployment.receipt,
                };
              }
            }
          } catch (cause: unknown) {
            pagesArtifactFailure(cause);
          }
          const pagesReceipt = observeInitialPagesFromState(
            {
              record,
              marker: current.transaction.marker,
              exactStateRevision: head.revision,
              evidence,
              invocationId: randomUUID(),
              localAttemptIndex: 0,
              phaseSequence: initialStateReceipt.phaseSequence + 1,
              previousReceiptDigest: initialStateReceipt.receiptDigest,
              observedAt: adapters.now().toISOString(),
            },
            nodeContentDigestPort,
          );
          return { initialPages: { kind: "state" as const, evidence }, pagesReceipt };
        }
        let build: InitialPagesBuildArtifact;
        try {
          build = decodeInitialPagesBuildArtifact(await readFile(buildPath));
        } catch (cause: unknown) {
          pagesArtifactFailure(cause);
        }
        let deployment: InitialPagesDeploymentOutcome;
        try {
          deployment = await readInitialPagesDeploymentOutcome(deploymentPath, build);
        } catch (cause: unknown) {
          pagesArtifactFailure(cause);
        }
        if (
          deployment.kind !== "success" ||
          build.intent.runId !== record.runIdentity.runId ||
          build.intent.checkpointDigest !== record.checkpointDigest ||
          serializeCanonicalJson(build.receipt.binding) !==
            serializeCanonicalJson(initialStateReceipt.binding)
        ) {
          throw new NotificationStructureError(
            "workflow通知のPages証拠とstate recordが一致しません",
            "no_effect",
          );
        }
        return {
          initialPages: {
            kind: "published" as const,
            buildReceipt: build.receipt,
            deploymentReceipt: deployment.receipt,
            evidence: deployment.evidence,
          },
          pagesReceipt: deployment.receipt,
        };
      },
    },
    createNotificationSettlementPort(
      adapters,
      config.state,
      initial.snapshot.repositories,
      knownSecrets,
      record.executionPolicy.effectTarget === "production" ? "production" : "recording",
    ),
  );
  if (outcome.kind !== "settled") {
    throw new NotificationSettlementFailureError(outcome);
  }
  await adapters.writeJsonArtifact(
    resolve(adapters.repositoryPath, command.settlementReceiptPath),
    outcome.receipt,
  );
  return outcome;
}

/** split workflowの最終reportをsettlement stateから単一CASへ保存する。 */
export async function finalizeWorkflowRun(
  adapters: WorkflowNotificationAdapters,
  command: WorkflowRunFinalizationInput,
): Promise<Extract<FinalizeRunOutcome, { kind: "finalized" }>> {
  const config = await adapters.loadConfig(resolve(adapters.repositoryPath, command.configPath));
  const settlementReceipt = decodeReceipt(
    await readFile(resolve(adapters.repositoryPath, command.settlementReceiptPath)),
    nodeContentDigestPort,
  );
  if (
    settlementReceipt.receiptType !== "notification_settlement" ||
    settlementReceipt.binding.bindingKind !== "checkpoint"
  ) {
    throw new TypeError("workflow finalizationにsettlement receiptがありません");
  }
  const initialStateReceipt = await initialReceipt(
    adapters,
    command.initialStateReceiptPath,
    settlementReceipt.binding.runId,
  );
  const adapter = adapters.createStateBranchAdapter();
  const settled = await readNotificationMessageState(
    adapter,
    config.state,
    settlementReceipt.result.resultingStateRevision,
  );
  const outcome = await finalizeRun(
    {
      record: settled.transaction.record,
      initialStateReceipt,
      settlementReceipt,
    },
    createNotificationSettlementPort(
      adapters,
      config.state,
      settled.snapshot.repositories,
      [],
      settled.transaction.record.executionPolicy.effectTarget === "production"
        ? "production"
        : "recording",
    ),
  );
  if (outcome.kind !== "finalized") {
    throw new TypeError(`workflow finalizationを確定できません。状態: ${outcome.kind}`);
  }
  await adapters.writeJsonArtifact(
    resolve(adapters.repositoryPath, command.finalizationReceiptPath),
    outcome.receipt,
  );
  return outcome;
}
