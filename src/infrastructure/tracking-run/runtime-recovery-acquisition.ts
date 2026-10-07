import { execFile } from "node:child_process";
import { cp, lstat, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

import {
  runtimeRecoveryInputV1Schema,
  type RuntimeRecoveryInputV1,
  type RuntimeRecoveryOutputV1,
} from "../../application/tracking-run/contracts/runtime-recovery-v1.js";
import {
  runtimeRecoveryInputV2Schema,
  type RuntimeRecoveryInputV2,
  type RuntimeRecoveryOutputV2,
} from "../../application/tracking-run/contracts/runtime-recovery-v2.js";
import {
  receiptChainEnvelopeSchema,
  type ReceiptChainEntry,
} from "../../application/tracking-run/receipt-chain-schema.js";
import { verifyReceiptChain } from "../../application/tracking-run/receipt-chain.js";
import { serializeCanonicalJsonLine } from "../../canonical-json/value.js";
import { nodeContentDigestPort } from "./content-digest.js";
import { workflowRuntimeManifestModulePath } from "./frozen-runtime-source-layout.js";
import {
  assertRecoveryToolchain,
  assertWorkflowV2AdapterCompatibility,
  verifyRebuiltRuntime,
  verifyRecoveryBundle,
} from "./publication-runtime.js";
import {
  launchRuntimeRecoveryV1,
  verifyRuntimeRecoveryV1,
} from "./runtime-recovery-launcher-v1.js";
import {
  launchRuntimeRecoveryV2,
  verifyRuntimeRecoveryV2,
} from "./runtime-recovery-launcher-v2.js";
import { sequentialReceiptPath } from "./sequential-receipt-path.js";
import { splitStagePaths } from "./split-stage-paths.js";

const execFileAsync = promisify(execFile);
const MAX_COMMAND_OUTPUT_BYTES = 10 * 1024 * 1024;

async function runCommand(
  executable: string,
  arguments_: readonly string[],
  cwd: string,
): Promise<string> {
  const result = await execFileAsync(executable, [...arguments_], {
    cwd,
    maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
  });
  return result.stdout.trim();
}

async function isPresent(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function ensureCodeRevision(repositoryPath: string, revision: string): Promise<void> {
  try {
    await runCommand("git", ["cat-file", "-e", `${revision}^{commit}`], repositoryPath);
  } catch {
    await runCommand("git", ["fetch", "--no-tags", "origin", revision], repositoryPath);
    await runCommand("git", ["cat-file", "-e", `${revision}^{commit}`], repositoryPath);
  }
}

async function withExactWorktree<T>(
  repositoryPath: string,
  revision: string,
  execute: (checkoutPath: string) => Promise<T>,
): Promise<T> {
  await ensureCodeRevision(repositoryPath, revision);
  const gitDirectory = await runCommand(
    "git",
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    repositoryPath,
  );
  const worktreeDirectory = join(dirname(gitDirectory), "hiho_git_worktrees");
  await mkdir(worktreeDirectory, { recursive: true });
  const temporaryDirectory = await mkdtemp(join(worktreeDirectory, "hiho_runtime_recovery_"));
  const checkoutPath = join(temporaryDirectory, "checkout");
  let created = false;
  try {
    await runCommand(
      "git",
      ["worktree", "add", "--detach", checkoutPath, revision],
      repositoryPath,
    );
    created = true;
    return await execute(checkoutPath);
  } finally {
    if (created) {
      await runCommand("git", ["worktree", "remove", "--force", checkoutPath], repositoryPath);
    }
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

async function installExactDependencies(
  checkoutPath: string,
  lockfileSha256: string,
): Promise<void> {
  const lockfile = await readFile(join(checkoutPath, "pnpm-lock.yaml"));
  if (nodeContentDigestPort.sha256Bytes(lockfile) !== lockfileSha256) {
    throw new TypeError("exact revisionのlockfile digestが回復計画と一致しません");
  }
  await runCommand("pnpm", ["install", "--frozen-lockfile"], checkoutPath);
}

async function rebuildWorkflowBundle(
  checkoutPath: string,
  plan: Extract<
    RuntimeRecoveryInputV1["runtimeRecoveryPlan"] | RuntimeRecoveryInputV2["runtimeRecoveryPlan"],
    { kind: "workflow_bundle" }
  >,
): Promise<string> {
  await installExactDependencies(checkoutPath, plan.lockfileSha256);
  await runCommand("pnpm", ["build"], checkoutPath);
  await runCommand("pnpm", ["build:workflow-cli"], checkoutPath);
  await runCommand(
    "node",
    [
      "--input-type=module",
      "-e",
      "const { writeWorkflowRuntimeManifest } = await import(process.argv[1]); await writeWorkflowRuntimeManifest(process.cwd());",
      await workflowRuntimeManifestModulePath(checkoutPath),
    ],
    checkoutPath,
  );
  const root = join(checkoutPath, "artifacts/workflow/runtime");
  await verifyRecoveryBundle(root, plan);
  return root;
}

async function rebuildSourceRuntime(
  checkoutPath: string,
  plan: Extract<RuntimeRecoveryInputV1["runtimeRecoveryPlan"], { kind: "rebuild_exact" }>,
): Promise<string> {
  await installExactDependencies(checkoutPath, plan.lockfileSha256);
  await runCommand("pnpm", ["build"], checkoutPath);
  await verifyRebuiltRuntime(checkoutPath, plan);
  return join(checkoutPath, "dist");
}

async function downloadWorkflowBundle(
  checkoutPath: string,
  plan: Extract<
    RuntimeRecoveryInputV1["runtimeRecoveryPlan"] | RuntimeRecoveryInputV2["runtimeRecoveryPlan"],
    { kind: "workflow_bundle" }
  >,
  destination: string,
): Promise<string | undefined> {
  try {
    await runCommand(
      "gh",
      ["run", "download", plan.workflowRunId, "--name", plan.artifactName, "--dir", destination],
      checkoutPath,
    );
  } catch {
    process.stderr.write("旧workflow artifactを取得できないためexact revisionから再buildします\n");
    return undefined;
  }
  await verifyRecoveryBundle(destination, plan);
  return destination;
}

export type SequentialRuntimeRecoveryV1 = Readonly<{
  output: RuntimeRecoveryOutputV1;
  receiptEntries: readonly ReceiptChainEntry[];
}>;

/** exact V1 processの起動または固定出力が失敗したことを表す。 */
export class RuntimeRecoveryLaunchError extends Error {
  public constructor(cause: unknown) {
    super("exact V1 runtimeを起動できませんでした", { cause });
  }
}

/** exact V1 processの完了証拠を読み取れないことを表す。 */
export class RuntimeRecoveryObservationError extends Error {
  public constructor(cause: unknown) {
    super("exact V1 runtimeの完了証拠を読めませんでした", { cause });
  }
}

async function launchWithReceipts(
  checkoutPath: string,
  root: string,
  input: RuntimeRecoveryInputV1,
): Promise<SequentialRuntimeRecoveryV1> {
  let output: RuntimeRecoveryOutputV1;
  try {
    output = await launchRuntimeRecoveryV1(checkoutPath, root, input);
  } catch (cause: unknown) {
    throw new RuntimeRecoveryLaunchError(cause);
  }
  if (output.status !== "completed") {
    return { output, receiptEntries: [] };
  }
  try {
    const source = await readFile(sequentialReceiptPath(checkoutPath, input.runId), "utf8");
    const value: unknown = JSON.parse(source);
    if (source !== serializeCanonicalJsonLine(value)) {
      throw new TypeError("exact runtimeのreceipt chainがcanonical JSONではありません");
    }
    const receiptEntries = receiptChainEnvelopeSchema.parse(value).entries;
    verifyReceiptChain(receiptEntries, nodeContentDigestPort);
    return { output, receiptEntries };
  } catch (cause: unknown) {
    throw new RuntimeRecoveryObservationError(cause);
  }
}

async function withAcquiredRuntime<T>(
  repositoryPath: string,
  bundleRoot: string | undefined,
  value: unknown,
  execute: (checkoutPath: string, root: string, input: RuntimeRecoveryInputV1) => Promise<T>,
): Promise<T> {
  const input = runtimeRecoveryInputV1Schema.parse(value);
  const plan = input.runtimeRecoveryPlan;
  if (plan.kind === "not_reproducible") {
    throw new TypeError("記録済みrunのruntimeを再現できません");
  }
  await assertRecoveryToolchain(repositoryPath, plan);
  return withExactWorktree(repositoryPath, plan.codeRevision, async (checkoutPath) => {
    if (plan.kind === "rebuild_exact") {
      const root = await rebuildSourceRuntime(checkoutPath, plan);
      return execute(checkoutPath, root, input);
    }
    let root: string | undefined;
    if (bundleRoot != null) {
      if (!(await isPresent(bundleRoot))) {
        throw new TypeError("指定した旧workflow bundleがありません");
      }
      root = resolve(bundleRoot);
      await verifyRecoveryBundle(root, plan);
    } else {
      const downloadDirectory = await mkdtemp(join(tmpdir(), "voicevox-runtime-download-"));
      try {
        root = await downloadWorkflowBundle(checkoutPath, plan, downloadDirectory);
        if (root != null) {
          return await execute(checkoutPath, root, input);
        }
      } finally {
        await rm(downloadDirectory, { recursive: true, force: true });
      }
    }
    root ??= await rebuildWorkflowBundle(checkoutPath, plan);
    return execute(checkoutPath, root, input);
  });
}

/** 記録済みrevisionを隔離し、元artifactまたは一致する再buildからV1入口を起動する。 */
export async function recoverSequentialRuntimeV1(
  repositoryPath: string,
  bundleRoot: string | undefined,
  value: unknown,
): Promise<SequentialRuntimeRecoveryV1> {
  return withAcquiredRuntime(repositoryPath, bundleRoot, value, launchWithReceipts);
}

/** 記録済みrevisionと固定V1入力の実runtimeを副作用なしで検証する。 */
export async function verifyAcquiredRuntimeV1(
  repositoryPath: string,
  bundleRoot: string | undefined,
  value: unknown,
): Promise<void> {
  await withAcquiredRuntime(repositoryPath, bundleRoot, value, verifyRuntimeRecoveryV1);
}

/** V2 bundleを元artifactまたはbyte一致再buildから取得して固定入口を起動する。 */
export async function recoverSplitRuntimeV2(
  repositoryPath: string,
  bundleRoot: string | undefined,
  value: unknown,
): Promise<RuntimeRecoveryOutputV2> {
  const input = runtimeRecoveryInputV2Schema.parse(value);
  const plan = input.runtimeRecoveryPlan;
  if (plan.kind !== "workflow_bundle") {
    throw new TypeError("V2分割回復にはworkflow bundleが必要です");
  }
  await assertRecoveryToolchain(repositoryPath, plan);
  return withExactWorktree(repositoryPath, plan.codeRevision, async (checkoutPath) => {
    await assertWorkflowV2AdapterCompatibility(
      repositoryPath,
      checkoutPath,
      plan.recoveryProtocol.workflowEffectAdapterIdentityDigest,
      nodeContentDigestPort,
    );
    await installExactDependencies(checkoutPath, plan.lockfileSha256);
    const current = splitStagePaths(repositoryPath, input.runId);
    const exact = splitStagePaths(checkoutPath, input.runId);
    const inputs: readonly (readonly [string, string])[] = [
      [current.root, exact.root],
      [join(repositoryPath, "dist/web"), join(checkoutPath, "dist/web")],
      [current.pagesOutput, exact.pagesOutput],
    ];
    for (const [from, to] of inputs) {
      if (await isPresent(from)) {
        await mkdir(dirname(to), { recursive: true });
        await cp(from, to, { recursive: true, force: true });
      }
    }
    try {
      const exactBundleRoot = join(checkoutPath, "artifacts/workflow/runtime");
      if (bundleRoot != null && (await isPresent(bundleRoot))) {
        const root = resolve(bundleRoot);
        await verifyRecoveryBundle(root, plan);
        await mkdir(dirname(exactBundleRoot), { recursive: true });
        await cp(root, exactBundleRoot, { recursive: true, force: true });
        await verifyRuntimeRecoveryV2(checkoutPath, exactBundleRoot, input);
        return await launchRuntimeRecoveryV2(checkoutPath, exactBundleRoot, input);
      }
      if (bundleRoot == null) {
        const downloadDirectory = await mkdtemp(join(tmpdir(), "voicevox-runtime-v2-download-"));
        try {
          const downloaded = await downloadWorkflowBundle(checkoutPath, plan, downloadDirectory);
          if (downloaded != null) {
            await mkdir(dirname(exactBundleRoot), { recursive: true });
            await cp(downloaded, exactBundleRoot, { recursive: true, force: true });
            await verifyRuntimeRecoveryV2(checkoutPath, exactBundleRoot, input);
            return await launchRuntimeRecoveryV2(checkoutPath, exactBundleRoot, input);
          }
        } finally {
          await rm(downloadDirectory, { recursive: true, force: true });
        }
      }
      const rebuilt = await rebuildWorkflowBundle(checkoutPath, plan);
      await verifyRuntimeRecoveryV2(checkoutPath, rebuilt, input);
      return await launchRuntimeRecoveryV2(checkoutPath, rebuilt, input);
    } finally {
      const source = splitStagePaths(checkoutPath, input.runId);
      const destination = splitStagePaths(repositoryPath, input.runId);
      const outputs: readonly (readonly [string, string])[] = [
        [source.root, destination.root],
        [join(checkoutPath, "dist/web"), join(repositoryPath, "dist/web")],
        [source.pagesOutput, destination.pagesOutput],
      ];
      for (const [from, to] of outputs) {
        if (await isPresent(from)) {
          await mkdir(dirname(to), { recursive: true });
          await cp(from, to, { recursive: true, force: true });
        }
      }
    }
  });
}
