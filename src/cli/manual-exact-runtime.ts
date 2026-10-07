import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  manualExactCommandSchema as commandSchema,
  type ManualExactCommand,
} from "../infrastructure/tracking-run/manual-command-input.js";
import { parseCliArguments } from "./command.js";

import { z } from "zod";

import { runtimeRecoveryInputV1Schema } from "../application/tracking-run/contracts/runtime-recovery-v1.js";
import { runtimeRecoveryInputV2Schema } from "../application/tracking-run/contracts/runtime-recovery-v2.js";
import { decodePublicFailureArtifact } from "../application/tracking-run/failure-artifact.js";
import { runtimeRecoveryPlanV2Schema } from "../application/tracking-run/recovery-bootstrap.js";
import { serializeCanonicalJsonLine } from "../canonical-json/value.js";
import { nodeContentDigestPort } from "../infrastructure/tracking-run/content-digest.js";
import {
  observeBootstrap,
  type BootstrapFailureObservation,
} from "../infrastructure/tracking-run/failure-context-state.js";
import { writeCliTextFile } from "../infrastructure/tracking-run/file-output.js";
import {
  isExpectedCheckpoint,
  reportManualExactFailure,
  revision,
} from "../infrastructure/tracking-run/manual-exact-failure.js";
import {
  resolveSelectedManualRuntimeV1,
  selectManualRuntimeV1,
} from "../infrastructure/tracking-run/manual-exact-v1.js";
import { resolveSelectedManualRuntimeV2 } from "../infrastructure/tracking-run/manual-exact-v2.js";
import { assertWorkflowV2AdapterCompatibility } from "../infrastructure/tracking-run/publication-runtime.js";
import { verifyRuntimeRecoveryV2 } from "../infrastructure/tracking-run/runtime-recovery-launcher-v2.js";
const environmentSchema = z.strictObject({
  checkout: z.string().min(1),
  runId: z.string().regex(/^tracker-run:[0-9a-f]{64}$/u),
  checkpointDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
  codeRevision: z.string().regex(/^[0-9a-f]{40}$/u),
  sourceRunId: z.string().regex(/^[1-9][0-9]*$/u),
  diagnosticsPath: z.string().min(1),
  failureDirectory: z.string().min(1),
});
const reportingEnvironmentSchema = environmentSchema.pick({
  diagnosticsPath: true,
  failureDirectory: true,
});
const v2SelectionSchema = z.strictObject({
  protocolVersion: z.literal(2),
  exactStateRevision: z.string().regex(/^[0-9a-f]{40}$/u),
  runId: environmentSchema.shape.runId,
  checkpointDigest: environmentSchema.shape.checkpointDigest,
  checkpointFileDigest: environmentSchema.shape.checkpointDigest,
  expectedRecordDigest: environmentSchema.shape.checkpointDigest,
  expectedRuntimeIdentityDigest: environmentSchema.shape.checkpointDigest,
  expectedWorkflowEffectAdapterIdentityDigest: environmentSchema.shape.checkpointDigest,
  runtimeRecoveryPlan: runtimeRecoveryPlanV2Schema,
});

class ExactCommandExitError extends Error {
  public constructor(command: string, exitCode: number | null, signal: string | null) {
    super(
      `手動解決runtimeの${command}が失敗しました。exit code: ${String(exitCode)}、signal: ${String(signal)}`,
    );
  }
}
async function failureNames(directory: string): Promise<readonly string[]> {
  try {
    return (await readdir(directory)).filter((name) => name.endsWith(".json"));
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function runExactCli(
  entrypoint: string,
  args: readonly string[],
  captureOutput: boolean,
): Promise<string> {
  const child = spawn(process.execPath, ["--enable-source-maps", entrypoint, ...args], {
    cwd: process.cwd(),
    env: process.env,
    stdio: ["inherit", captureOutput ? "pipe" : "inherit", "inherit"],
  });
  const chunks: Buffer[] = [];
  let byteLength = 0;
  if (captureOutput) {
    const stdout = child.stdout;
    if (stdout == null) {
      throw new TypeError("手動解決runtimeの標準出力を取得できません");
    }
    stdout.on("data", (chunk: Buffer) => {
      byteLength += chunk.byteLength;
      if (byteLength > 1024 * 1024) {
        child.kill();
      } else {
        chunks.push(chunk);
      }
    });
  }
  const result = await new Promise<{ code: number | null; signal: string | null }>(
    (resolveExit, rejectExit) => {
      child.on("error", rejectExit);
      child.on("close", (code, signal) => {
        resolveExit({ code, signal });
      });
    },
  );
  if (result.code !== 0 || byteLength > 1024 * 1024) {
    throw new ExactCommandExitError(args[0] ?? "unknown", result.code, result.signal);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function selectRuntime(
  controlEntrypoint: string,
  controlRepositoryPath: string,
  checkout: string,
  runId: string,
  checkpointDigest: string,
  checkpointFileDigest: string,
  runtimeIdentityDigest: string,
  codeRevision: string,
  sourceRunId: string,
  stateRevision: string,
): Promise<void> {
  const source = await runExactCli(
    controlEntrypoint,
    ["inspect-run-state", "--run-id", runId, "--state-revision", stateRevision],
    true,
  );
  const value: unknown = JSON.parse(source);
  const decision = z
    .looseObject({
      kind: z.literal("resume_with_exact_runtime"),
      recoveryInput: z.union([runtimeRecoveryInputV1Schema, v2SelectionSchema]),
    })
    .parse(value);
  const input = decision.recoveryInput;
  if (input.runId !== runId || input.exactStateRevision !== stateRevision) {
    throw new TypeError("旧runのruntime選択が指定したrunとcode revisionに一致しません");
  }
  if (input.protocolVersion === 1) {
    await selectManualRuntimeV1(checkout, input, {
      sourceRunId,
      runId,
      checkpointDigest,
      checkpointFileDigest,
      runtimeIdentityDigest,
      codeRevision,
      stateRevision,
    });
    return;
  }
  const plan = input.runtimeRecoveryPlan;
  if (
    plan.kind !== "workflow_bundle" ||
    plan.codeRevision !== codeRevision ||
    plan.workflowRunId !== sourceRunId
  ) {
    throw new TypeError("手動復旧のworkflow bundleを選べません");
  }
  const bundleRoot = resolve("artifacts/workflow/runtime");
  if (
    input.checkpointDigest !== checkpointDigest ||
    input.checkpointFileDigest !== checkpointFileDigest ||
    input.expectedRuntimeIdentityDigest !== runtimeIdentityDigest ||
    input.expectedWorkflowEffectAdapterIdentityDigest !==
      plan.recoveryProtocol.workflowEffectAdapterIdentityDigest ||
    input.runtimeRecoveryPlan.kind !== "workflow_bundle" ||
    input.runtimeRecoveryPlan.recoveryProtocol.manualResolutionOperation !==
      "resolve_manual_delivery"
  ) {
    throw new TypeError("V2手動解決の固定操作またはrun、record、checkpoint結合が一致しません");
  }
  await assertWorkflowV2AdapterCompatibility(
    controlRepositoryPath,
    checkout,
    input.expectedWorkflowEffectAdapterIdentityDigest,
    nodeContentDigestPort,
  );
  const fixedInput = runtimeRecoveryInputV2Schema.parse({
    protocolVersion: 2,
    inputContract: "tracking-run-recovery-input-v2",
    operation: "inspect",
    invocationId: randomUUID(),
    configPath: "config.yml",
    stateRef: "tracker-state",
    exactStateRevision: stateRevision,
    runId,
    runAttempt: z.coerce.number().int().positive().parse(process.env["GITHUB_RUN_ATTEMPT"]),
    expectedRecordDigest: input.expectedRecordDigest,
    expectedRuntimeIdentityDigest: input.expectedRuntimeIdentityDigest,
    expectedWorkflowEffectAdapterIdentityDigest: input.expectedWorkflowEffectAdapterIdentityDigest,
    runtimeRecoveryPlan: plan,
  });
  await verifyRuntimeRecoveryV2(checkout, bundleRoot, fixedInput);
  await writeCliTextFile(
    "artifacts/workflow/manual-recovery-input.json",
    serializeCanonicalJsonLine(fixedInput),
  );
  return;
}

/** 手動workflowの現行制御CLIを実行し、未報告の失敗を記録する。 */
export async function runManualExactRuntime(args: readonly string[]): Promise<number> {
  const environment = {
    checkout: process.env["VOICEVOX_MANUAL_EXACT_CHECKOUT"],
    runId: process.env["VOICEVOX_EXPECTED_RUN_ID"],
    checkpointDigest: process.env["VOICEVOX_MANUAL_CHECKPOINT_DIGEST"],
    codeRevision: process.env["VOICEVOX_MANUAL_CODE_REVISION"],
    sourceRunId: process.env["VOICEVOX_MANUAL_SOURCE_RUN_ID"],
    diagnosticsPath: process.env["VOICEVOX_TASK_TRACKER_DIAGNOSTICS_PATH"],
    failureDirectory: process.env["VOICEVOX_TASK_TRACKER_FAILURE_DIRECTORY"],
  };
  let command: ManualExactCommand | undefined;
  let input: z.output<typeof environmentSchema> | undefined;
  let existingFailures: Set<string> | undefined;
  let inCheckout = false;
  let inputValidated = false;
  let childStarted = false;
  let before: BootstrapFailureObservation | undefined;
  try {
    command = commandSchema.parse(args[0]);
    input = environmentSchema.parse(environment);
    inputValidated = true;
    const controlRepositoryPath = process.cwd();
    const checkout = resolve(input.checkout);
    const controlEntrypoint = resolve("dist/cli/tracker-run.js");
    const failureDirectory = resolve(input.failureDirectory);
    const priorFailures = new Set(await failureNames(failureDirectory));
    existingFailures = priorFailures;
    process.chdir(checkout);
    inCheckout = true;
    before = await observeBootstrap("config.yml", input.runId);
    if (!isExpectedCheckpoint(before, input.runId, input.checkpointDigest)) {
      throw new TypeError("手動解決前のstateと指定したrun/checkpointが一致しません");
    }
    if (command === "select-runtime") {
      const stateRevision = revision(before);
      if (
        before == null ||
        stateRevision == null ||
        before.evidence?.bindingKind !== "checkpoint"
      ) {
        throw new TypeError("手動解決runtime選択に必要なstate revisionがありません");
      }
      childStarted = true;
      await selectRuntime(
        controlEntrypoint,
        controlRepositoryPath,
        checkout,
        input.runId,
        input.checkpointDigest,
        before.evidence.checkpointFileDigest,
        before.evidence.runtimeIdentityDigest,
        input.codeRevision,
        input.sourceRunId,
        stateRevision,
      );
    } else {
      const resolution = parseCliArguments(["resolve-discord-delivery", ...args.slice(1)]);
      if (resolution.kind !== "resolve-discord-delivery") {
        throw new TypeError("手動送達のcommandが不正です");
      }
      childStarted = true;
      const selectedSource = await readFile(
        "artifacts/workflow/manual-recovery-input.json",
        "utf8",
      );
      const selectedRaw: unknown = JSON.parse(selectedSource);
      if (selectedSource !== serializeCanonicalJsonLine(selectedRaw)) {
        throw new TypeError("手動回復の固定入力がcanonical JSONではありません");
      }
      const selected = z
        .union([runtimeRecoveryInputV1Schema, runtimeRecoveryInputV2Schema])
        .parse(selectedRaw);
      if (selected.protocolVersion === 1) {
        await resolveSelectedManualRuntimeV1(
          checkout,
          selected,
          input.sourceRunId,
          resolution,
          async (entrypoint, arguments_) => {
            await runExactCli(entrypoint, arguments_, false);
          },
        );
      } else {
        if (
          selected.runtimeRecoveryPlan.kind !== "workflow_bundle" ||
          selected.runtimeRecoveryPlan.workflowRunId !== input.sourceRunId
        ) {
          throw new TypeError("V2手動解決の元runが固定bundleと一致しません");
        }
        await resolveSelectedManualRuntimeV2(checkout, resolution);
      }
    }
    return 0;
  } catch (error: unknown) {
    let failure: unknown = error;
    let after: BootstrapFailureObservation | undefined;
    if (inCheckout && input != null) {
      try {
        after = await observeBootstrap("config.yml", input.runId);
      } catch (observationError: unknown) {
        failure = new AggregateError(
          [failure, observationError],
          "手動解決runtime失敗後のstate観測にも失敗しました",
          { cause: failure },
        );
      }
    }
    const priorFailures = existingFailures;
    if (priorFailures != null && input != null) {
      let createdFailures: readonly string[] = [];
      try {
        createdFailures = (await failureNames(resolve(input.failureDirectory))).filter(
          (name) => !priorFailures.has(name),
        );
        for (const name of createdFailures) {
          decodePublicFailureArtifact(
            await readFile(resolve(input.failureDirectory, name)),
            nodeContentDigestPort,
          );
        }
      } catch (artifactError: unknown) {
        failure = new AggregateError(
          [failure, artifactError],
          "手動解決runtime失敗後の公開artifact観測にも失敗しました",
          { cause: failure },
        );
        createdFailures = [];
      }
      if (createdFailures.length > 0) {
        throw failure;
      }
    }
    let reporting;
    try {
      const paths = reportingEnvironmentSchema.parse({
        diagnosticsPath: environment.diagnosticsPath,
        failureDirectory: environment.failureDirectory,
      });
      reporting = {
        ...(input == null ? {} : { runId: input.runId, checkpointDigest: input.checkpointDigest }),
        diagnosticsPath: resolve(paths.diagnosticsPath),
        failureDirectory: resolve(paths.failureDirectory),
        inputInvalid: !inputValidated,
        childStarted,
      };
    } catch (reportingError: unknown) {
      throw new AggregateError(
        [failure, reportingError],
        "手動解決runtime失敗と公開失敗報告先の検証に失敗しました",
        { cause: failure },
      );
    }
    try {
      await reportManualExactFailure(command, failure, before, after, reporting);
    } catch (reportingError: unknown) {
      throw new AggregateError(
        [failure, reportingError],
        "手動解決runtime失敗と公開失敗artifactの作成に失敗しました",
        { cause: failure },
      );
    }
    throw failure;
  }
}

if (process.argv[1] != null && pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.exitCode = await runManualExactRuntime(process.argv.slice(2));
}
