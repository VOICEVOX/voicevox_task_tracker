import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { BaseStateRevision } from "../../../application/tracking-run/contracts/run-core.js";
import { decodeReceipt } from "../../../application/tracking-run/receipt-codec.js";
import { serializeCanonicalJson } from "../../../canonical-json/value.js";
import type { Config } from "../../../config/index.js";
import type { StateBranchAdapter } from "../../../persistence/index.js";
import { joinStatePath, readExactStateSnapshot } from "../../../persistence/index.js";
import { loadStateNotificationLedgers } from "../../../persistence/state-ledger-files.js";
import type { VerifyCheckpointCliCommand } from "../command-input.js";
import { nodeContentDigestPort } from "../content-digest.js";
import { BoundPublicationFailureError } from "../failure-context-error.js";
import { parseInitialPagesBuildArtifact } from "../initial-pages-build-artifact.js";
import { commitInitialState } from "../initial-state-commit.js";
import { requireEnvironmentValue } from "../production-runtime-setup.js";
import {
  assertBoundPublicationCheckpoint,
  type BoundPublicationCheckpoint,
} from "../publication-checkpoint-binding.js";
import {
  readPublicationCheckpointFile,
  readPublicationCheckpointHeader,
} from "../publication-checkpoint-file.js";
import { readPublicationRuntimeContext } from "../publication-runtime.js";
import type { RunPublicationAdapters } from "./contracts.js";
import type {
  WorkflowInitialPagesBuildInput,
  WorkflowInitialStateCommitInput,
} from "./operation-inputs.js";
import { buildPublicPages } from "./pages.js";
import { projectPublicationSettings } from "./settings.js";

type WorkflowStateAdapters = Pick<
  RunPublicationAdapters,
  | "repositoryPath"
  | "environment"
  | "loadConfig"
  | "openStateSession"
  | "createStateBranchAdapter"
  | "now"
  | "writeJsonArtifact"
>;

function assertWorkflowConfig(artifact: BoundPublicationCheckpoint, config: Config): void {
  if (
    nodeContentDigestPort.sha256Utf8(serializeCanonicalJson(config)) !==
    artifact.checkpoint.configDigest
  ) {
    throw new TypeError("workflow artifactと現在の設定でconfig digestが一致しません");
  }
  const projection = artifact.publicationInputs;
  if (
    serializeCanonicalJson(projectPublicationSettings(config)) !==
      serializeCanonicalJson({
        pages: projection.pages,
        discord: projection.discord,
        configuredTrackingStartAt: projection.configuredTrackingStartAt,
      }) ||
    projection.state.snapshotPath !== config.state.snapshotPath ||
    projection.state.notificationLedgerPath !== config.state.notificationLedgerPath ||
    projection.state.aiCacheDirectory !== config.state.aiCacheDirectory ||
    projection.state.personalReminderAiCacheDirectory !==
      config.state.personalReminderAiCacheDirectory ||
    projection.state.runReportsDirectory !== config.state.runReportsDirectory ||
    projection.state.historyPath !==
      joinStatePath(
        config.state.historyDirectory,
        `${artifact.publicationPlan.initialStateWriteSet.snapshot.generatedAt.slice(0, 10)}.jsonl`,
      )
  ) {
    throw new TypeError("workflow artifactと現在の設定で公開計画の投影が一致しません");
  }
}

async function readWorkflowCheckpoint(
  adapters: WorkflowStateAdapters,
  artifactPath: string,
  config: Config,
  adapter: StateBranchAdapter,
  baseRevision: BaseStateRevision,
): Promise<BoundPublicationCheckpoint> {
  const header = await readPublicationCheckpointHeader(artifactPath);
  if (header.executionPolicy.executionShape !== "split_workflow") {
    throw new TypeError("分割workflowにsequential checkpointは使えません");
  }
  const expectedRunId = adapters.environment["VOICEVOX_EXPECTED_RUN_ID"];
  if (expectedRunId == null || expectedRunId.length === 0) {
    throw new TypeError("workflowから期待するrun IDが渡されていません");
  }
  const previousSnapshot = await readExactStateSnapshot(
    adapter,
    config.state,
    config.staleness.timezone,
    baseRevision,
  );
  const previousNotificationLedger = await loadStateNotificationLedgers(
    adapter,
    config.state,
    baseRevision,
  );
  const runtime = await readPublicationRuntimeContext(
    adapters.repositoryPath,
    header.executionPolicy,
    adapters.environment,
  );
  const bound = await readPublicationCheckpointFile(artifactPath, {
    expectedRunId,
    baseStateRevision: baseRevision,
    configDigest: nodeContentDigestPort.sha256Utf8(serializeCanonicalJson(config)),
    runtime,
    baseWitness: {
      revision: baseRevision,
      previousSnapshot,
      previousNotificationLedger,
    },
  });
  assertBoundPublicationCheckpoint(bound);
  assertWorkflowConfig(bound, config);
  return bound;
}

/** artifactとsidecarをexact baseへ結合し、効果なしで検証する。 */
export async function verifyWorkflowCheckpoint(
  dependencies: Readonly<{ adapters: WorkflowStateAdapters }>,
  command: VerifyCheckpointCliCommand,
): Promise<void> {
  const config = await dependencies.adapters.loadConfig(
    resolve(dependencies.adapters.repositoryPath, command.configPath),
  );
  const artifactPath = resolve(dependencies.adapters.repositoryPath, command.artifactPath);
  const header = await readPublicationCheckpointHeader(artifactPath);
  const adapter = dependencies.adapters.createStateBranchAdapter();
  await readWorkflowCheckpoint(
    dependencies.adapters,
    artifactPath,
    config,
    adapter,
    header.baseStateRevision,
  );
}

/** workflow artifactの検証済みstateを初期保存する。 */
export async function persistWorkflowState(
  dependencies: Readonly<{ adapters: WorkflowStateAdapters }>,
  command: WorkflowInitialStateCommitInput,
): Promise<void> {
  const config = await dependencies.adapters.loadConfig(
    resolve(dependencies.adapters.repositoryPath, command.configPath),
  );
  const adapter = dependencies.adapters.createStateBranchAdapter();
  const artifactPath = resolve(dependencies.adapters.repositoryPath, command.artifactPath);
  const header = await readPublicationCheckpointHeader(artifactPath);
  const artifact = await readWorkflowCheckpoint(
    dependencies.adapters,
    artifactPath,
    config,
    adapter,
    header.baseStateRevision,
  );
  try {
    const result = await commitInitialState(artifact, {
      adapter,
      configuration: config.state,
      migrationTimezone: config.staleness.timezone,
      knownSecrets: [],
      now: dependencies.adapters.now,
    });
    await dependencies.adapters.writeJsonArtifact(
      resolve(dependencies.adapters.repositoryPath, command.receiptPath),
      result.receipt,
    );
  } catch (error: unknown) {
    throw new BoundPublicationFailureError(artifact, error);
  }
}

/** workflow artifactの検証済みrunからPagesを生成する。 */
export async function buildWorkflowPages(
  dependencies: Readonly<{
    adapters: WorkflowStateAdapters &
      Pick<RunPublicationAdapters, "writePublicData" | "buildWebOutput">;
  }>,
  command: WorkflowInitialPagesBuildInput,
): Promise<void> {
  const config = await dependencies.adapters.loadConfig(
    resolve(dependencies.adapters.repositoryPath, command.configPath),
  );
  const receipt = decodeReceipt(
    await readFile(resolve(dependencies.adapters.repositoryPath, command.initialStateReceiptPath)),
    nodeContentDigestPort,
  );
  if (receipt.receiptType !== "initial_state_commit") {
    throw new TypeError("初回Pages buildには初回state commit receiptが必要です");
  }
  const expectedRunId = requireEnvironmentValue(
    dependencies.adapters.environment,
    "VOICEVOX_EXPECTED_RUN_ID",
  );
  if (receipt.binding.bindingKind !== "checkpoint" || receipt.binding.runId !== expectedRunId) {
    throw new TypeError("初回Pages buildのreceiptと期待run IDが一致しません");
  }
  const adapter = dependencies.adapters.createStateBranchAdapter();
  const result = await buildPublicPages({
    adapter,
    config,
    stateConfiguration: config.state,
    initialStateCommitReceipt: receipt,
    repositoryPath: dependencies.adapters.repositoryPath,
    writePublicData: dependencies.adapters.writePublicData,
    buildWebOutput: dependencies.adapters.buildWebOutput,
    outputDirectory: resolve(dependencies.adapters.repositoryPath, command.outputDirectory),
    knownSecrets: [],
    now: dependencies.adapters.now,
  });
  await dependencies.adapters.writeJsonArtifact(
    resolve(dependencies.adapters.repositoryPath, command.buildArtifactPath),
    parseInitialPagesBuildArtifact({
      schemaVersion: 1,
      manifest: result.manifest,
      intent: result.intent,
      receipt: result.receipt,
    }),
  );
}

export { notifyWorkflowOperations } from "./workflow-operations-alert.js";
