import { execFile, spawn } from "node:child_process";
import { mkdtemp, open, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

import {
  runtimeRecoveryInputV1Schema,
  runtimeRecoveryOutputV1Schema,
  type RuntimeRecoveryInputV1,
  type RuntimeRecoveryOutputV1,
} from "../../application/tracking-run/contracts/runtime-recovery-v1.js";
import { serializeCanonicalJson, serializeCanonicalJsonLine } from "../../canonical-json/value.js";
import { nodeContentDigestPort } from "./content-digest.js";
import {
  assertRecoveryToolchain,
  verifyRebuiltRuntime,
  verifyRecoveryBundle,
  workflowAdapterIdentity,
} from "./publication-runtime.js";

const MAX_PROTOCOL_BYTES = 1024 * 1024;
const execFileAsync = promisify(execFile);

function runtimeIdentity(input: RuntimeRecoveryInputV1): object {
  const plan = input.runtimeRecoveryPlan;
  if (plan.kind === "workflow_bundle") {
    return Object.freeze({
      kind: "workflow_bundle",
      codeRevision: plan.codeRevision,
      bundleSha256: plan.bundleSha256,
      lockfileSha256: plan.lockfileSha256,
      toolchain: plan.toolchain,
    });
  }
  if (plan.kind === "rebuild_exact") {
    return Object.freeze({
      kind: "source_process",
      codeRevision: plan.codeRevision,
      runtimeManifestSha256: plan.expectedRuntimeManifestSha256,
      lockfileSha256: plan.lockfileSha256,
      toolchain: plan.toolchain,
    });
  }
  throw new TypeError("回復不能なruntimeからV1 entrypointは起動できません");
}

/** exact checkoutと固定bundleの実体を照合する。 */
export async function assertRecoveryRuntime(
  repositoryPath: string,
  bundleRoot: string,
  input: RuntimeRecoveryInputV1,
): Promise<string> {
  const plan = input.runtimeRecoveryPlan;
  if (plan.kind === "not_reproducible") {
    throw new TypeError("回復不能なruntimeからV1 entrypointは起動できません");
  }
  if (
    input.expectedRuntimeIdentityDigest !==
      nodeContentDigestPort.sha256Utf8(serializeCanonicalJson(runtimeIdentity(input))) ||
    input.expectedWorkflowEffectAdapterIdentityDigest !==
      plan.recoveryProtocol.workflowEffectAdapterIdentityDigest
  ) {
    throw new TypeError("V1回復入力のruntimeまたはworkflow adapter identityが一致しません");
  }
  await assertRecoveryToolchain(repositoryPath, plan);
  const [checkoutRevision, checkoutStatus] = await Promise.all([
    execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repositoryPath }),
    execFileAsync("git", ["status", "--porcelain", "--untracked-files=normal"], {
      cwd: repositoryPath,
    }),
  ]);
  if (
    checkoutRevision.stdout.trim() !== plan.codeRevision ||
    checkoutStatus.stdout.length !== 0 ||
    (plan.kind === "rebuild_exact" &&
      input.expectedWorkflowEffectAdapterIdentityDigest !==
        (await workflowAdapterIdentity(repositoryPath, nodeContentDigestPort)))
  ) {
    throw new TypeError("exact checkoutのrevisionまたはworkflow adapter identityが一致しません");
  }
  if (plan.kind === "workflow_bundle") {
    await verifyRecoveryBundle(bundleRoot, plan);
  } else {
    if (resolve(bundleRoot) !== resolve(repositoryPath, "dist")) {
      throw new TypeError("再build runtimeのrootが固定pathと一致しません");
    }
    await verifyRebuiltRuntime(repositoryPath, plan);
  }
  const root = await realpath(bundleRoot);
  const entrypointPath = resolve(root, plan.recoveryProtocol.entrypointRelativePath);
  const entrypoint = await realpath(entrypointPath);
  const relativePath = relative(root, entrypoint);
  if (relativePath.length === 0 || relativePath === ".." || relativePath.startsWith(`..${sep}`)) {
    throw new TypeError("V1回復entrypointがruntime rootの外を参照しています");
  }
  if (
    nodeContentDigestPort.sha256Bytes(await readFile(entrypoint)) !==
    plan.recoveryProtocol.entrypointSha256
  ) {
    throw new TypeError("V1回復entrypointの実byte列が回復計画と一致しません");
  }
  return entrypoint;
}

/** 固定V1入力とexact runtimeの識別を副作用なしで検証する。 */
export async function verifyRuntimeRecoveryV1(
  repositoryPath: string,
  bundleRoot: string,
  value: unknown,
): Promise<void> {
  const input = runtimeRecoveryInputV1Schema.parse(value);
  await assertRecoveryRuntime(repositoryPath, bundleRoot, input);
}

/** 固定I/Oだけでexact runtimeのV1 entrypointを起動する。 */
export async function launchRuntimeRecoveryV1(
  repositoryPath: string,
  bundleRoot: string,
  value: unknown,
): Promise<RuntimeRecoveryOutputV1> {
  const input = runtimeRecoveryInputV1Schema.parse(value);
  const entrypoint = await assertRecoveryRuntime(repositoryPath, bundleRoot, input);
  const directory = await mkdtemp(join(tmpdir(), "voicevox-runtime-protocol-"));
  try {
    const inputPath = join(directory, "input.json");
    const outputPath = join(directory, "output.json");
    await writeFile(inputPath, serializeCanonicalJsonLine(input), { flag: "wx", mode: 0o600 });
    const inputFile = await open(inputPath, "r");
    const outputFile = await open(outputPath, "wx", 0o600);
    let exitCode: number;
    try {
      const child = spawn(process.execPath, [entrypoint], {
        cwd: repositoryPath,
        env: {
          ...process.env,
          VOICEVOX_RUNTIME_RECOVERY_PROTOCOL_V1: "1",
          VOICEVOX_RUNTIME_BUNDLE_ROOT: bundleRoot,
        },
        stdio: [inputFile.fd, outputFile.fd, "inherit"],
      });
      exitCode = await new Promise<number>((resolveExit, rejectExit) => {
        child.once("error", rejectExit);
        child.once("close", (code) => {
          resolveExit(code ?? 1);
        });
      });
    } finally {
      await inputFile.close();
      await outputFile.close();
    }
    if (exitCode !== 0 || (await stat(outputPath)).size > MAX_PROTOCOL_BYTES) {
      throw new TypeError("V1回復entrypointが固定I/Oを完了できませんでした");
    }
    const source = await readFile(outputPath, "utf8");
    const valueOutput: unknown = JSON.parse(source);
    if (source !== serializeCanonicalJsonLine(valueOutput)) {
      throw new TypeError("V1回復出力がcanonical JSONではありません");
    }
    return runtimeRecoveryOutputV1Schema.parse(valueOutput);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
