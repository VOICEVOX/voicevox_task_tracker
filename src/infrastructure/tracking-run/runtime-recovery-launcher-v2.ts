import { execFile, spawn } from "node:child_process";
import { mkdtemp, open, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

import {
  runtimeRecoveryInputV2Schema,
  runtimeRecoveryOutputV2Schema,
  type RuntimeRecoveryInputV2,
  type RuntimeRecoveryOutputV2,
} from "../../application/tracking-run/contracts/runtime-recovery-v2.js";
import { serializeCanonicalJson, serializeCanonicalJsonLine } from "../../canonical-json/value.js";
import { nodeContentDigestPort as digest } from "./content-digest.js";
import {
  assertRecordedWorkflowAdapterIdentityV2,
  assertRecoveryToolchain,
  verifyRecoveryBundle,
} from "./publication-runtime.js";

const execFileAsync = promisify(execFile);
const MAX_PROTOCOL_BYTES = 1024 * 1024;

function runtimeIdentity(input: RuntimeRecoveryInputV2): object {
  const plan = input.runtimeRecoveryPlan;
  if (plan.kind !== "workflow_bundle") {
    throw new TypeError("V2分割回復にはworkflow bundleが必要です");
  }
  return {
    kind: "workflow_bundle",
    codeRevision: plan.codeRevision,
    bundleSha256: plan.bundleSha256,
    lockfileSha256: plan.lockfileSha256,
    toolchain: plan.toolchain,
  };
}

/** exact checkoutと固定bundleの実体を照合する。 */
export async function assertExactRuntimeV2(
  repositoryPath: string,
  bundleRoot: string,
  input: RuntimeRecoveryInputV2,
): Promise<string> {
  const plan = input.runtimeRecoveryPlan;
  if (plan.kind !== "workflow_bundle") {
    throw new TypeError("V2分割回復にはworkflow bundleが必要です");
  }
  if (
    input.expectedRuntimeIdentityDigest !==
      digest.sha256Utf8(serializeCanonicalJson(runtimeIdentity(input))) ||
    input.expectedWorkflowEffectAdapterIdentityDigest !==
      plan.recoveryProtocol.workflowEffectAdapterIdentityDigest
  ) {
    throw new TypeError("V2回復入力のruntimeまたはadapter identityが一致しません");
  }
  await assertRecoveryToolchain(repositoryPath, plan);
  const [revision, status] = await Promise.all([
    execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repositoryPath }),
    execFileAsync(
      "git",
      [
        "status",
        "--porcelain",
        "--untracked-files=normal",
        "--",
        ".",
        ":(exclude)web/public/data",
        ":(exclude)dist",
        ":(exclude)artifacts",
      ],
      {
        cwd: repositoryPath,
      },
    ),
  ]);
  if (revision.stdout.trim() !== plan.codeRevision || status.stdout.length !== 0) {
    throw new TypeError("V2 exact checkoutと静的adapterが回復計画と一致しません");
  }
  await assertRecordedWorkflowAdapterIdentityV2(
    repositoryPath,
    plan.recoveryProtocol.workflowEffectAdapterIdentityDigest,
    digest,
  );
  await verifyRecoveryBundle(bundleRoot, plan);
  const root = await realpath(bundleRoot);
  const entrypoint = await realpath(resolve(root, plan.recoveryProtocol.entrypointRelativePath));
  const relativePath = relative(root, entrypoint);
  if (relativePath.length === 0 || relativePath === ".." || relativePath.startsWith(`..${sep}`)) {
    throw new TypeError("V2回復entrypointがbundle外を参照しています");
  }
  if (digest.sha256Bytes(await readFile(entrypoint)) !== plan.recoveryProtocol.entrypointSha256) {
    throw new TypeError("V2回復entrypointのbyte列が回復計画と一致しません");
  }
  return entrypoint;
}

/** 固定V2入力とexact bundleの識別を副作用前に検証する。 */
export async function verifyRuntimeRecoveryV2(
  repositoryPath: string,
  bundleRoot: string,
  value: unknown,
): Promise<void> {
  const input = runtimeRecoveryInputV2Schema.parse(value);
  await assertExactRuntimeV2(repositoryPath, bundleRoot, input);
}

/** 固定V2入力だけでexact bundleの入口を起動する。 */
export async function launchRuntimeRecoveryV2(
  repositoryPath: string,
  bundleRoot: string,
  value: unknown,
): Promise<RuntimeRecoveryOutputV2> {
  const input = runtimeRecoveryInputV2Schema.parse(value);
  const entrypoint = await assertExactRuntimeV2(repositoryPath, bundleRoot, input);
  const directory = await mkdtemp(join(tmpdir(), "voicevox-runtime-v2-"));
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
          VOICEVOX_RUNTIME_RECOVERY_PROTOCOL_V2: "2",
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
      throw new TypeError("V2回復entrypointが固定I/Oを完了できませんでした");
    }
    const source = await readFile(outputPath, "utf8");
    const raw: unknown = JSON.parse(source);
    if (source !== serializeCanonicalJsonLine(raw)) {
      throw new TypeError("V2回復出力がcanonical JSONではありません");
    }
    return runtimeRecoveryOutputV2Schema.parse(raw);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
