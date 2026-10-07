import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { decodeReceipt } from "../../../application/tracking-run/receipt-codec.js";
import { serializeCanonicalJsonLine } from "../../../canonical-json/value.js";
import { nodeContentDigestPort as digest } from "../content-digest.js";
import { decodeNotificationHistoryPagesBuildArtifact } from "../notification-history-pages-build-artifact.js";
import { decodeNotificationHistoryPagesDeploymentOutcome } from "../notification-history-pages-deployment-outcome.js";
import {
  recordNotificationHistorySequentialDeployment,
  recordNotificationHistoryWorkflowDeployment,
} from "../notification-history-pages-deployment-record.js";
import {
  parseNotificationHistoryPagesDeploymentPreflight,
  preflightNotificationHistoryPagesDeployment,
} from "../notification-history-pages-deployment.js";
import { readNotificationMessageState } from "../notification-message-state.js";
import { readPreviousNotificationHistoryOutcome } from "../previous-notification-history-outcome.js";
import { isWorkflowPublicationReplay, workflowAdapterIdentityV2 } from "../publication-runtime.js";
import type { RunPublicationAdapters } from "./contracts.js";
import type {
  WorkflowNotificationHistoryPagesPreflightInput,
  WorkflowNotificationHistoryPagesRecordInput,
} from "./history-operation-inputs.js";

type WorkflowHistoryDeploymentAdapters = Pick<
  RunPublicationAdapters,
  | "repositoryPath"
  | "environment"
  | "loadConfig"
  | "createStateBranchAdapter"
  | "now"
  | "writeJsonArtifact"
>;

function optionalOutput(
  environment: Readonly<NodeJS.ProcessEnv>,
  name: string,
): string | undefined {
  const value = environment[name];
  return value == null || value.length === 0 ? undefined : value;
}

/** split通知履歴Pages action直前の正本と全fileを検証する。 */
export async function preflightWorkflowNotificationHistoryDeployment(
  adapters: WorkflowHistoryDeploymentAdapters,
  command: WorkflowNotificationHistoryPagesPreflightInput,
): Promise<void> {
  const artifact = decodeNotificationHistoryPagesBuildArtifact(
    await readFile(resolve(adapters.repositoryPath, command.buildArtifactPath)),
  );
  const settlement = decodeReceipt(
    await readFile(resolve(adapters.repositoryPath, command.settlementReceiptPath)),
    digest,
  );
  const finalization = decodeReceipt(
    await readFile(resolve(adapters.repositoryPath, command.finalizationReceiptPath)),
    digest,
  );
  if (
    settlement.receiptType !== "notification_settlement" ||
    finalization.receiptType !== "run_finalization"
  ) {
    throw new TypeError("通知履歴Pages deployにsettlementとfinalizationのreceiptが必要です");
  }
  const previousBytes = await readPreviousNotificationHistoryOutcome(
    resolve(adapters.repositoryPath, command.previousOutcomePath),
    adapters.environment["VOICEVOX_PREVIOUS_HISTORY_OUTCOME_STATUS"],
  );
  const config = await adapters.loadConfig(resolve(adapters.repositoryPath, command.configPath));
  const adapter = adapters.createStateBranchAdapter();
  const source = await readNotificationMessageState(
    adapter,
    config.state,
    finalization.result.resultingStateRevision,
  );
  const preflight = await preflightNotificationHistoryPagesDeployment({
    adapter,
    config,
    configuration: config.state,
    repositoryPath: adapters.repositoryPath,
    artifact,
    settlementReceipt: settlement,
    finalizationReceipt: finalization,
    ...(previousBytes == null
      ? {}
      : {
          previousOutcome: decodeNotificationHistoryPagesDeploymentOutcome(previousBytes, artifact),
        }),
    replay:
      finalization.receiptKind === "observed" ||
      isWorkflowPublicationReplay(
        source.transaction.record.runtimeRecoveryPlan,
        adapters.environment,
      ),
    observedAt: adapters.now().toISOString(),
    effectTarget: source.transaction.record.executionPolicy.effectTarget,
    ...(source.transaction.record.executionPolicy.effectTarget === "production"
      ? { adapterIdentityDigest: await workflowAdapterIdentityV2(adapters.repositoryPath, digest) }
      : {}),
  });
  await adapters.writeJsonArtifact(
    resolve(adapters.repositoryPath, command.preflightPath),
    preflight,
  );
}

/** split通知履歴Pages actionの実outputをreceiptまたは失敗artifactへ記録する。 */
export async function recordWorkflowNotificationHistoryDeployment(
  adapters: WorkflowHistoryDeploymentAdapters,
  command: WorkflowNotificationHistoryPagesRecordInput,
): Promise<void> {
  const artifact = decodeNotificationHistoryPagesBuildArtifact(
    await readFile(resolve(adapters.repositoryPath, command.buildArtifactPath)),
  );
  const preflightPath = resolve(adapters.repositoryPath, command.preflightPath);
  const preflightSource = new TextDecoder("utf-8", { fatal: true }).decode(
    await readFile(preflightPath),
  );
  const preflightRaw: unknown = JSON.parse(preflightSource);
  if (preflightSource !== serializeCanonicalJsonLine(preflightRaw)) {
    throw new TypeError("通知履歴Pages preflightがcanonical JSONではありません");
  }
  const preflight = parseNotificationHistoryPagesDeploymentPreflight(preflightRaw, artifact);
  const effectTarget = adapters.environment["TRACKING_EFFECT_TARGET"];
  if (effectTarget !== "production" && effectTarget !== "sandbox") {
    throw new TypeError("通知履歴Pages結果のeffect targetが不正です");
  }
  if (effectTarget === "sandbox") {
    if (
      adapters.environment["PAGES_DEPLOYMENT_OUTCOME"] !== "skipped" ||
      (preflight.kind === "ready" && adapters.environment["PAGES_UPLOAD_OUTCOME"] !== "success") ||
      (preflight.kind !== "ready" && adapters.environment["PAGES_UPLOAD_OUTCOME"] !== "skipped")
    ) {
      throw new TypeError("sandbox通知履歴Pages artifactの結果が不正です");
    }
    let recordingId: string | undefined;
    if (preflight.kind === "ready") {
      const artifactId = optionalOutput(adapters.environment, "PAGES_ARTIFACT_ID");
      const artifactName = optionalOutput(adapters.environment, "PAGES_ARTIFACT_NAME");
      if (artifactId == null || artifactName == null) {
        throw new TypeError("sandbox通知履歴Pages artifactの識別情報がありません");
      }
      recordingId = `${artifactName}:${artifactId}`;
    }
    const outcome = recordNotificationHistorySequentialDeployment({
      artifact,
      preflight,
      target: "recording",
      ...(recordingId == null ? {} : { recordingId }),
      observedAt: adapters.now().toISOString(),
    });
    await adapters.writeJsonArtifact(
      resolve(adapters.repositoryPath, command.outcomePath),
      outcome,
    );
    if (outcome.kind === "failure") {
      throw new TypeError(`sandbox通知履歴Pages結果が確定しませんでした。種別: ${outcome.reason}`);
    }
    return;
  }
  const outcome = recordNotificationHistoryWorkflowDeployment({
    artifact,
    preflight,
    observation: {
      schemaVersion: 1,
      phase: "notification_history",
      ...(optionalOutput(adapters.environment, "PAGES_DEPLOYMENT_INTENT_DIGEST") == null
        ? {}
        : {
            deploymentIntentDigest: optionalOutput(
              adapters.environment,
              "PAGES_DEPLOYMENT_INTENT_DIGEST",
            ),
          }),
      uploadOutcome: adapters.environment["PAGES_UPLOAD_OUTCOME"],
      deploymentOutcome: adapters.environment["PAGES_DEPLOYMENT_OUTCOME"],
      artifactName: adapters.environment["PAGES_ARTIFACT_NAME"],
      ...(optionalOutput(adapters.environment, "PAGES_ARTIFACT_ID") == null
        ? {}
        : { artifactId: optionalOutput(adapters.environment, "PAGES_ARTIFACT_ID") }),
      ...(optionalOutput(adapters.environment, "PAGES_ARTIFACT_DIGEST") == null
        ? {}
        : { artifactDigest: optionalOutput(adapters.environment, "PAGES_ARTIFACT_DIGEST") }),
      ...(optionalOutput(adapters.environment, "PAGES_DEPLOYMENT_ID") == null
        ? {}
        : { deploymentId: optionalOutput(adapters.environment, "PAGES_DEPLOYMENT_ID") }),
      ...(optionalOutput(adapters.environment, "PAGES_URL") == null
        ? {}
        : { pageUrl: optionalOutput(adapters.environment, "PAGES_URL") }),
    },
    adapterIdentityDigest: await workflowAdapterIdentityV2(adapters.repositoryPath, digest),
    observedAt: adapters.now().toISOString(),
  });
  await adapters.writeJsonArtifact(resolve(adapters.repositoryPath, command.outcomePath), outcome);
  if (outcome.kind === "failure") {
    throw new TypeError(`通知履歴Pages公開結果が確定しませんでした。種別: ${outcome.reason}`);
  }
}
