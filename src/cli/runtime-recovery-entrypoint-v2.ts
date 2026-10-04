import { readFile } from "node:fs/promises";
import { readInitialPagesDeploymentPreflight } from "../infrastructure/tracking-run/initial-pages-deployment.js";
import { decodeNotificationHistoryPagesBuildArtifact } from "../infrastructure/tracking-run/notification-history-pages-build-artifact.js";
import { parseNotificationHistoryPagesDeploymentPreflight } from "../infrastructure/tracking-run/notification-history-pages-deployment.js";

import { z } from "zod";

import {
  runtimeRecoveryInputV2Schema,
  runtimeRecoveryOutputV2Schema,
  type RuntimeRecoveryInputV2,
  type RuntimeRecoveryOutputV2,
} from "../application/tracking-run/contracts/runtime-recovery-v2.js";
import { serializeCanonicalJson, serializeCanonicalJsonLine } from "../canonical-json/value.js";
import { inspectRunBootstrapState } from "../infrastructure/tracking-run/bootstrap-state.js";
import { nodeContentDigestPort as digest } from "../infrastructure/tracking-run/content-digest.js";
import { resolveExactManualDeliveryV2 } from "../infrastructure/tracking-run/runtime-recovery-manual-v2.js";
import { splitStagePaths } from "../infrastructure/tracking-run/split-stage-paths.js";
import { readSplitReceiptChain } from "../infrastructure/tracking-run/split-stage-receipts.js";
import { GitStateBranchAdapter } from "../persistence/index.js";
import {
  createCliApplication,
  createDefaultCliCompositionAdapters,
  createDefaultProductionRuntimeAdapters,
} from "./composition-root.js";

import { assertExactRuntimeV2 } from "../infrastructure/tracking-run/runtime-recovery-launcher-v2.js";
const MAX_PROTOCOL_BYTES = 1024 * 1024;
const routeOutputSchema = z.looseObject({ runId: z.string(), nextStage: z.string() });
async function assertPagesObservation(
  input: Extract<RuntimeRecoveryInputV2, { operation: "record_pages" }>,
  repositoryPath: string,
): Promise<void> {
  const observation = input.observation;
  if (input.runtimeRecoveryPlan.kind !== "workflow_bundle") {
    throw new TypeError("V2 Pages観測にはworkflow bundleが必要です");
  }
  if (observation.adapterIdentityDigest !== input.expectedWorkflowEffectAdapterIdentityDigest) {
    throw new TypeError("V2 Pages観測の静的adapterがrecordと一致しません");
  }
  const paths = splitStagePaths(repositoryPath, input.runId);
  if (observation.phase === "initial") {
    const preflight = await readInitialPagesDeploymentPreflight(paths.initialPreflight);
    if (observation.deploymentIntentDigest !== preflight.deploymentIntentDigest) {
      throw new TypeError("V2初回Pages観測とpreflight intentが一致しません");
    }
    return;
  }
  const artifact = decodeNotificationHistoryPagesBuildArtifact(await readFile(paths.historyBuild));
  const source = await readFile(paths.historyPreflight, "utf8");
  const raw: unknown = JSON.parse(source);
  if (source !== serializeCanonicalJsonLine(raw)) {
    throw new TypeError("V2通知履歴Pages preflightがcanonical JSONではありません");
  }
  const preflight = parseNotificationHistoryPagesDeploymentPreflight(raw, artifact);
  if (
    ("deploymentIntentDigest" in preflight ? preflight.deploymentIntentDigest : undefined) !==
    observation.deploymentIntentDigest
  ) {
    throw new TypeError("V2通知履歴Pages観測とpreflight intentが一致しません");
  }
}

function pagesEnvironment(
  observation: Extract<RuntimeRecoveryInputV2, { operation: "record_pages" }>["observation"],
): Readonly<NodeJS.ProcessEnv> {
  return {
    PAGES_DEPLOYMENT_INTENT_DIGEST: observation.deploymentIntentDigest,
    PAGES_UPLOAD_OUTCOME: observation.uploadOutcome,
    PAGES_DEPLOYMENT_OUTCOME: observation.deploymentOutcome,
    PAGES_ARTIFACT_NAME: observation.artifactName,
    ...(observation.artifactId == null ? {} : { PAGES_ARTIFACT_ID: observation.artifactId }),
    ...(observation.artifactDigest == null
      ? {}
      : { PAGES_ARTIFACT_DIGEST: observation.artifactDigest }),
    ...(observation.deploymentId == null ? {} : { PAGES_DEPLOYMENT_ID: observation.deploymentId }),
    ...(observation.pageUrl == null ? {} : { PAGES_URL: observation.pageUrl }),
  };
}

async function executeExactInput(
  repositoryPath: string,
  input: RuntimeRecoveryInputV2,
): Promise<RuntimeRecoveryOutputV2> {
  const adapter = new GitStateBranchAdapter({
    repositoryPath,
    gitExecutable: "git",
    authorName: "VOICEVOX Task Tracker",
    authorEmail: "voicevox-task-tracker@users.noreply.github.com",
  });
  const head = await adapter.resolveHead(input.stateRef);
  if (head.status !== "present" || head.revision !== input.exactStateRevision) {
    throw new TypeError("V2回復入力のexact state revisionがremote headと一致しません");
  }
  const bootstrap = await inspectRunBootstrapState(adapter, input.stateRef, {
    kind: "retry_run",
    runId: input.runId,
    exactStateRevision: input.exactStateRevision,
  });
  if (
    bootstrap.kind !== "resume_with_exact_runtime" ||
    (bootstrap.record.recordSchemaVersion !== 2 && bootstrap.record.recordSchemaVersion !== 3) ||
    bootstrap.record.recordDigest !== input.expectedRecordDigest ||
    bootstrap.record.runtimeIdentityDigest !== input.expectedRuntimeIdentityDigest ||
    serializeCanonicalJson(bootstrap.record.runtimeRecoveryPlan) !==
      serializeCanonicalJson(input.runtimeRecoveryPlan)
  ) {
    throw new TypeError("V2回復入力と永続stateのbootstrapが一致しません");
  }
  if (input.operation === "resolve_manual_delivery") {
    if (
      input.runtimeRecoveryPlan.kind !== "workflow_bundle" ||
      input.runtimeRecoveryPlan.recoveryProtocol.manualResolutionOperation !== input.operation
    ) {
      throw new TypeError("記録済みV2 bundleに手動判断の固定操作がありません");
    }
    const resolved = await resolveExactManualDeliveryV2(
      repositoryPath,
      input,
      adapter,
      createDefaultProductionRuntimeAdapters(),
    );
    return runtimeRecoveryOutputV2Schema.parse({
      protocolVersion: 2,
      outputContract: "tracking-run-recovery-output-v2",
      runId: input.runId,
      stateRevision: resolved.stateRevision,
      receiptChainDigest: resolved.receiptChainDigest,
      workflowEffectAdapterIdentityDigest: input.expectedWorkflowEffectAdapterIdentityDigest,
      status: "manual_resolved",
      decision: input.target.decision,
      manualResolutionReceiptDigest: resolved.manualResolutionReceiptDigest,
      receiptKind: resolved.receiptKind,
    });
  }
  if (input.operation === "record_pages") {
    await assertPagesObservation(input, repositoryPath);
  }
  const output: string[] = [];
  const base = createDefaultCliCompositionAdapters();
  const environment: NodeJS.ProcessEnv = {
    ...base.environment,
    TRACKING_STATE_REF: input.stateRef,
    GITHUB_RUN_ATTEMPT: String(input.runAttempt),
    ...(input.operation === "record_pages" ? pagesEnvironment(input.observation) : {}),
  };
  const application = createCliApplication({
    ...base,
    environment,
    writeStandardOutput: (source) => {
      output.push(source);
      return Promise.resolve();
    },
  });
  const arguments_ =
    input.operation === "inspect"
      ? [
          "route-stage",
          "--config",
          input.configPath,
          "--state-ref",
          input.stateRef,
          "--run-id",
          input.runId,
          "--effect-target",
          environment["TRACKING_EFFECT_TARGET"] ?? "production",
        ]
      : [
          "run-stage",
          "--stage",
          input.operation === "record_pages"
            ? input.observation.phase === "initial"
              ? "record-initial-pages-deployment"
              : "record-history-pages-deployment"
            : input.stage,
          "--config",
          input.configPath,
          "--run-id",
          input.runId,
          "--run-attempt",
          String(input.runAttempt),
          ...(input.operation === "execute_stage" && input.manualResolutionReceiptPath != null
            ? ["--manual-resolution-receipt", input.manualResolutionReceiptPath]
            : []),
        ];
  const result = await application.run(arguments_, input.invocationId);
  if (result.exitCode !== 0 || output.length !== 1) {
    throw new TypeError("V2固定段階の実行結果が不正です");
  }
  const entries = await readSplitReceiptChain(
    splitStagePaths(repositoryPath, input.runId).receiptChain,
    input.runId,
  );
  const receiptChainDigest = digest.sha256Utf8(serializeCanonicalJson(entries));
  const finalHead = await adapter.resolveHead(input.stateRef);
  if (finalHead.status !== "present") {
    throw new TypeError("V2固定段階の後にremote stateがありません");
  }
  const common = {
    protocolVersion: 2,
    outputContract: "tracking-run-recovery-output-v2",
    runId: input.runId,
    stateRevision: finalHead.revision,
    receiptChainDigest,
    workflowEffectAdapterIdentityDigest: input.expectedWorkflowEffectAdapterIdentityDigest,
  };
  if (input.operation === "inspect") {
    const route = routeOutputSchema.parse(JSON.parse(output[0] ?? ""));
    if (route.runId !== input.runId) {
      throw new TypeError("V2 inspectのrun IDが一致しません");
    }
    return runtimeRecoveryOutputV2Schema.parse({
      ...common,
      status: "inspected",
      nextStage: route.nextStage,
    });
  }
  return runtimeRecoveryOutputV2Schema.parse(
    input.operation === "record_pages"
      ? { ...common, status: "pages_recorded", phase: input.observation.phase }
      : { ...common, status: "executed", stage: input.stage },
  );
}

/** exact bundle内で固定V2入力を検証し、一段だけ実行する。 */
export async function runRuntimeRecoveryEntrypointV2(
  repositoryPath: string,
  bundleRoot: string,
): Promise<void> {
  let source = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) {
    source += String(chunk);
    if (Buffer.byteLength(source, "utf8") > MAX_PROTOCOL_BYTES) {
      throw new TypeError("V2回復入力が許容するbyte数を超えています");
    }
  }
  const raw: unknown = JSON.parse(source);
  if (source !== serializeCanonicalJsonLine(raw)) {
    throw new TypeError("V2回復入力がcanonical JSONではありません");
  }
  const input = runtimeRecoveryInputV2Schema.parse(raw);
  await assertExactRuntimeV2(repositoryPath, bundleRoot, input);
  process.stdout.write(serializeCanonicalJsonLine(await executeExactInput(repositoryPath, input)));
}
