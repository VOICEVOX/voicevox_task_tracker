import { execFile, spawnSync } from "node:child_process";
import { lstat, mkdtemp, open, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

import { z } from "zod";

import { runtimeToolchainIdentitySchema } from "../../application/tracking-run/contracts/runtime-identity.js";
import type { ContentDigestPort } from "../../application/tracking-run/contracts/content-digest-port.js";
import {
  normalizedBundlePathSchema,
  runtimeRecoveryPlanSchema,
  runtimeRecoveryProtocolV1Schema,
  runtimeRecoveryProtocolV2Schema,
} from "../../application/tracking-run/recovery-bootstrap.js";
import { parseSha256Hash } from "../../canonical-json/sha256.js";
import { serializeCanonicalJson, serializeCanonicalJsonLine } from "../../canonical-json/value.js";
import { nodeContentDigestPort } from "./content-digest.js";
import {
  workflowAdapterIdentity,
  workflowAdapterIdentityV2,
} from "./publication-runtime-adapter-identity.js";
import { hashSources } from "./publication-runtime-source-digest.js";

const execFileAsync = promisify(execFile);
const MANIFEST_FILE_NAME = "runtime-manifest.json";
const sha256Schema = z.string().transform(parseSha256Hash);
const runtimeFileSchema = z.strictObject({
  path: normalizedBundlePathSchema,
  byteLength: z.number().int().nonnegative(),
  digest: sha256Schema,
});
const runtimeManifestV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  codeRevision: z.string().min(1),
  lockfileSha256: sha256Schema,
  toolchain: runtimeToolchainIdentitySchema,
  files: z.array(runtimeFileSchema).min(1),
  recoveryProtocol: runtimeRecoveryProtocolV1Schema,
});
const runtimeManifestV2Schema = runtimeManifestV1Schema.extend({
  schemaVersion: z.literal(2),
  recoveryProtocol: runtimeRecoveryProtocolV2Schema,
});
export const runtimeManifestSchema = z.discriminatedUnion("schemaVersion", [
  runtimeManifestV1Schema,
  runtimeManifestV2Schema,
]);

async function checkedFiles(
  root: string,
  directory: string,
): Promise<readonly z.output<typeof runtimeFileSchema>[]> {
  if (directory === root && (await lstat(root)).isSymbolicLink()) {
    throw new TypeError("runtime bundleのrootにsymlinkは使用できません");
  }
  const files: z.output<typeof runtimeFileSchema>[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === MANIFEST_FILE_NAME && directory === root) continue;
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new TypeError("runtime bundle内のsymlinkは使用できません");
    }
    if (entry.isDirectory()) {
      files.push(...(await checkedFiles(root, path)));
      continue;
    }
    if (!entry.isFile()) {
      throw new TypeError("runtime bundleに通常file以外が含まれています");
    }
    const relativePath = relative(root, path).split(sep).join("/");
    const bytes = await readFile(path);
    files.push(
      runtimeFileSchema.parse({
        path: relativePath,
        byteLength: bytes.length,
        digest: nodeContentDigestPort.sha256Bytes(bytes),
      }),
    );
  }
  return files.sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
}

async function codeRevision(repositoryPath: string, filesDigest: string): Promise<string> {
  const [head, status] = await Promise.all([
    execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repositoryPath }),
    execFileAsync(
      "git",
      [
        "status",
        "--porcelain",
        "--untracked-files=normal",
        "--",
        ".",
        ":(exclude)web/public/data/summary.json",
        ":(exclude)web/public/data/details.json",
        ":(exclude)web/public/data/notification-history.json",
      ],
      { cwd: repositoryPath },
    ),
  ]);
  const revision = head.stdout.trim();
  if (!/^[0-9a-f]{40}$/u.test(revision)) {
    throw new TypeError("runtimeのGit revisionが完全なcommit SHAではありません");
  }
  return status.stdout.length === 0 ? revision : `worktree:${filesDigest}`;
}

async function measuredToolchain(
  repositoryPath: string,
  shape: "sequential" | "split_workflow",
  digest: ContentDigestPort,
): Promise<z.output<typeof runtimeToolchainIdentitySchema>> {
  const packageManagerVersion = await measuredPnpmVersion(repositoryPath);
  const buildConfigDigest = await hashSources(
    repositoryPath,
    shape === "split_workflow"
      ? [
          "package.json",
          ".node-version",
          "tsconfig.json",
          "tsconfig.build.json",
          "workflow.vite.config.ts",
        ]
      : ["package.json", ".node-version", "tsconfig.json", "tsconfig.build.json"],
    digest,
  );
  return runtimeToolchainIdentitySchema.parse({
    nodeVersion: process.version,
    packageManager: "pnpm",
    packageManagerVersion,
    platform: process.platform,
    architecture: process.arch,
    buildCommandId: shape === "split_workflow" ? "pnpm-build-workflow-cli-v1" : "pnpm-build-v1",
    buildConfigDigest,
  });
}

async function measuredPnpmVersion(repositoryPath: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "voicevox-runtime-toolchain-"));
  const outputPath = join(directory, "pnpm-version.txt");
  try {
    const output = await open(outputPath, "w");
    try {
      const result = spawnSync("pnpm", ["--version"], {
        cwd: repositoryPath,
        stdio: ["ignore", output.fd, "pipe"],
      });
      if (result.error != null) {
        throw result.error;
      }
      if (result.status !== 0) {
        throw new TypeError("pnpm versionの実測に失敗しました");
      }
    } finally {
      await output.close();
    }
    const version = (await readFile(outputPath, "utf8")).trim();
    if (version.length === 0) {
      throw new TypeError("pnpm versionの実測値が空です");
    }
    return version;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** 回復効果の前に記録済みNode、pnpm、実行環境を照合する。 */
export async function assertRecoveryToolchain(
  repositoryPath: string,
  plan: Exclude<z.output<typeof runtimeRecoveryPlanSchema>, { kind: "not_reproducible" }>,
): Promise<void> {
  const expectedBuildCommandId =
    plan.kind === "workflow_bundle" ? "pnpm-build-workflow-cli-v1" : "pnpm-build-v1";
  if (
    plan.toolchain.nodeVersion !== process.version ||
    plan.toolchain.packageManagerVersion !== (await measuredPnpmVersion(repositoryPath)) ||
    plan.toolchain.platform !== process.platform ||
    plan.toolchain.architecture !== process.arch ||
    plan.toolchain.buildCommandId !== expectedBuildCommandId
  ) {
    throw new TypeError("V1回復runtimeのtoolchainが記録済みの値と一致しません");
  }
}

/** 実行byte列とtoolchainからruntime manifestを生成する。 */
export async function createManifest(
  repositoryPath: string,
  shape: "sequential" | "split_workflow",
  digest: ContentDigestPort,
): Promise<z.output<typeof runtimeManifestSchema>> {
  const root = resolve(
    repositoryPath,
    shape === "split_workflow" ? "artifacts/workflow/runtime" : "dist",
  );
  const files = (await checkedFiles(root, root)).filter(
    (file) =>
      shape !== "sequential" ||
      (!file.path.startsWith("web/") &&
        !file.path.endsWith(".d.ts") &&
        !file.path.endsWith(".d.ts.map")),
  );
  const entrypointRelativePath = normalizedBundlePathSchema.parse(
    shape === "split_workflow" ? "tracker-run.mjs" : "cli/tracker-run.js",
  );
  const entrypoint = files.find((file) => file.path === entrypointRelativePath);
  if (entrypoint == null) {
    throw new TypeError("runtime entrypointがbuild outputにありません");
  }
  const filesDigest = digest.sha256Utf8(serializeCanonicalJson(files));
  const adapterIdentity =
    shape === "split_workflow"
      ? await workflowAdapterIdentityV2(repositoryPath, digest)
      : await workflowAdapterIdentity(repositoryPath, digest);
  const recoveryProtocol =
    shape === "split_workflow"
      ? runtimeRecoveryProtocolV2Schema.parse({
          protocolVersion: 2,
          entrypointRelativePath,
          entrypointSha256: entrypoint.digest,
          inputContract: "tracking-run-recovery-input-v2",
          outputContract: "tracking-run-recovery-output-v2",
          workflowEffectObservationContract: "tracking-run-workflow-effect-observation-v2",
          workflowEffectAdapterIdentityDigest: adapterIdentity,
          workflowEffectAdapterVersion: "tracking-run-pages-actions-v2",
          manualResolutionOperation: "resolve_manual_delivery",
        })
      : runtimeRecoveryProtocolV1Schema.parse({
          protocolVersion: 1,
          entrypointRelativePath,
          entrypointSha256: entrypoint.digest,
          inputContract: "tracking-run-recovery-input-v1",
          outputContract: "tracking-run-recovery-output-v1",
          workflowEffectObservationContract: "tracking-run-workflow-effect-observation-v1",
          workflowEffectAdapterIdentityDigest: adapterIdentity,
        });
  return runtimeManifestSchema.parse({
    schemaVersion: shape === "split_workflow" ? 2 : 1,
    codeRevision: await codeRevision(repositoryPath, filesDigest),
    lockfileSha256: digest.sha256Bytes(await readFile(resolve(repositoryPath, "pnpm-lock.yaml"))),
    toolchain: await measuredToolchain(repositoryPath, shape, digest),
    files,
    recoveryProtocol,
  });
}

/** split workflowへ同梱するruntime manifestを生成する。 */
export async function writeWorkflowRuntimeManifest(repositoryPath: string): Promise<void> {
  const manifest = await createManifest(repositoryPath, "split_workflow", nodeContentDigestPort);
  await writeFile(
    resolve(repositoryPath, "artifacts/workflow/runtime", MANIFEST_FILE_NAME),
    serializeCanonicalJsonLine(manifest),
    { flag: "w" },
  );
}

/** workflow runtime manifestと実行byte列を照合する。 */
export async function readWorkflowRuntimeManifest(
  repositoryPath: string,
  digest: ContentDigestPort,
): Promise<z.output<typeof runtimeManifestSchema>> {
  const root = resolve(repositoryPath, "artifacts/workflow/runtime");
  const source = await readFile(resolve(root, MANIFEST_FILE_NAME), "utf8");
  const value: unknown = JSON.parse(source);
  const manifest = runtimeManifestSchema.parse(value);
  if (manifest.schemaVersion !== 2) {
    throw new TypeError("分割workflowのruntime manifestはV2が必要です");
  }
  if (source !== serializeCanonicalJsonLine(manifest)) {
    throw new TypeError("workflow runtime manifestがcanonical JSONではありません");
  }
  const files = await checkedFiles(root, root);
  const filesDigest = digest.sha256Utf8(serializeCanonicalJson(files));
  const entrypoint = files.find(
    (file) => file.path === manifest.recoveryProtocol.entrypointRelativePath,
  );
  if (
    serializeCanonicalJson(files) !== serializeCanonicalJson(manifest.files) ||
    manifest.codeRevision !== (await codeRevision(repositoryPath, filesDigest)) ||
    manifest.lockfileSha256 !==
      digest.sha256Bytes(await readFile(resolve(repositoryPath, "pnpm-lock.yaml"))) ||
    manifest.toolchain.nodeVersion !== process.version ||
    manifest.toolchain.platform !== process.platform ||
    manifest.toolchain.architecture !== process.arch ||
    manifest.toolchain.buildCommandId !== "pnpm-build-workflow-cli-v1" ||
    manifest.toolchain.buildConfigDigest !==
      (await hashSources(
        repositoryPath,
        [
          "package.json",
          ".node-version",
          "tsconfig.json",
          "tsconfig.build.json",
          "workflow.vite.config.ts",
        ],
        digest,
      )) ||
    entrypoint?.digest !== manifest.recoveryProtocol.entrypointSha256 ||
    manifest.recoveryProtocol.workflowEffectAdapterIdentityDigest !==
      (await workflowAdapterIdentityV2(repositoryPath, digest))
  ) {
    throw new TypeError("workflow runtime manifestが実行byte列または静的adapterと一致しません");
  }
  return manifest;
}

/** 取得した旧bundleのfile一覧と固定回復entrypointを実測して照合する。 */
export async function verifyRecoveryBundle(
  root: string,
  plan: Extract<z.output<typeof runtimeRecoveryPlanSchema>, { kind: "workflow_bundle" }>,
): Promise<z.output<typeof runtimeManifestSchema>> {
  if ((await lstat(root)).isSymbolicLink()) {
    throw new TypeError("旧workflow bundleのrootにsymlinkは使用できません");
  }
  const source = await readFile(resolve(root, MANIFEST_FILE_NAME), "utf8");
  const value: unknown = JSON.parse(source);
  const manifest = runtimeManifestSchema.parse(value);
  const files = await checkedFiles(root, root);
  const entrypoint = files.find(
    (file) => file.path === plan.recoveryProtocol.entrypointRelativePath,
  );
  if (
    source !== serializeCanonicalJsonLine(manifest) ||
    nodeContentDigestPort.sha256Utf8(serializeCanonicalJson(manifest)) !== plan.bundleSha256 ||
    serializeCanonicalJson(files) !== serializeCanonicalJson(manifest.files) ||
    serializeCanonicalJson(manifest.recoveryProtocol) !==
      serializeCanonicalJson(plan.recoveryProtocol) ||
    manifest.codeRevision !== plan.codeRevision ||
    manifest.lockfileSha256 !== plan.lockfileSha256 ||
    serializeCanonicalJson(manifest.toolchain) !== serializeCanonicalJson(plan.toolchain) ||
    entrypoint?.digest !== plan.recoveryProtocol.entrypointSha256
  ) {
    throw new TypeError("旧workflow bundleのmanifestと実fileが一致しません");
  }
  return manifest;
}

/** exact revisionから再buildしたsource processを回復計画と照合する。 */
export async function verifyRebuiltRuntime(
  repositoryPath: string,
  plan: Extract<z.output<typeof runtimeRecoveryPlanSchema>, { kind: "rebuild_exact" }>,
): Promise<z.output<typeof runtimeManifestSchema>> {
  const manifest = await createManifest(repositoryPath, "sequential", nodeContentDigestPort);
  if (
    nodeContentDigestPort.sha256Utf8(serializeCanonicalJson(manifest)) !==
      plan.expectedRuntimeManifestSha256 ||
    manifest.codeRevision !== plan.codeRevision ||
    manifest.lockfileSha256 !== plan.lockfileSha256 ||
    serializeCanonicalJson(manifest.toolchain) !== serializeCanonicalJson(plan.toolchain) ||
    serializeCanonicalJson(manifest.recoveryProtocol) !==
      serializeCanonicalJson(plan.recoveryProtocol)
  ) {
    throw new TypeError("再buildしたsource processが回復計画と一致しません");
  }
  return manifest;
}
