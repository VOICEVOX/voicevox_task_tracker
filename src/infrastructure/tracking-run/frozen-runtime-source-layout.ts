import { lstat, readdir } from "node:fs/promises";
import { resolve } from "node:path";

type RuntimeSourceLayout = "infrastructure" | "frozen_cli";

async function hasSource(repositoryPath: string, path: string): Promise<boolean> {
  try {
    const source = await lstat(resolve(repositoryPath, path));
    if (!source.isFile()) {
      throw new TypeError("runtime identityのsourceは通常fileである必要があります");
    }
    return true;
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function identifyLayout(repositoryPath: string): Promise<RuntimeSourceLayout> {
  const [infrastructure, cli] = await Promise.all([
    hasSource(repositoryPath, "src/infrastructure/tracking-run/publication-runtime.ts"),
    hasSource(repositoryPath, "src/cli/publication-runtime.ts"),
  ]);
  if (infrastructure === cli) {
    throw new TypeError("exact runtimeのsource配置を一意に識別できません");
  }
  return infrastructure ? "infrastructure" : "frozen_cli";
}

/** 選択元の固定source配置に対応するmanifest writerのmodule pathを返す。 */
export async function workflowRuntimeManifestModulePath(repositoryPath: string): Promise<string> {
  const layout = await identifyLayout(repositoryPath);
  return layout === "infrastructure"
    ? "./dist/infrastructure/tracking-run/publication-runtime.js"
    : "./dist/cli/publication-runtime.js";
}

/** 選択元の固定source配置に対応するV2 digestのpath列を返す。 */
export async function workflowV2AdapterSourcePaths(
  repositoryPath: string,
  scope: "full" | "narrow",
): Promise<readonly string[]> {
  const layout = await identifyLayout(repositoryPath);
  const prefix = layout === "infrastructure" ? "src/infrastructure/tracking-run" : "src/cli";
  return Object.freeze([
    "src/application/tracking-run/contracts/runtime-recovery-v2.ts",
    `${prefix}/runtime-recovery-launcher-v2.ts`,
    ...(layout === "infrastructure" ? ["src/cli/runtime-recovery-entrypoint-v2.ts"] : []),
    `${prefix}/initial-pages-deployment.ts`,
    `${prefix}/notification-history-pages-deployment-record.ts`,
    ...(scope === "full"
      ? [
          `${prefix}/notification-history-pages-deployment.ts`,
          `${prefix}/notification-history-pages-deployment-outcome.ts`,
        ]
      : []),
  ]);
}

/** 選択元の固定source配置に対応するV1 digestのpath列を返す。 */
export async function workflowV1AdapterSourcePaths(repositoryPath: string): Promise<
  Readonly<{
    effectSources: readonly string[];
    commandSources: readonly string[];
  }>
> {
  const layout = await identifyLayout(repositoryPath);
  if (layout === "infrastructure") {
    return Object.freeze({
      effectSources: Object.freeze([
        "src/infrastructure/tracking-run/initial-pages-deployment.ts",
        "src/infrastructure/tracking-run/notification-history-pages-deployment.ts",
        "src/infrastructure/tracking-run/notification-history-pages-deployment-record.ts",
        "src/infrastructure/tracking-run/notification-history-pages-deployment-outcome.ts",
        "src/infrastructure/tracking-run/publication/deployment.ts",
        "src/infrastructure/tracking-run/publication/workflow-history-deployment.ts",
      ]),
      commandSources: Object.freeze([
        "src/cli/create-workflow-command-runner.ts",
        "src/infrastructure/tracking-run/manual-delivery-command.ts",
        "src/infrastructure/tracking-run/workflow-report-command.ts",
      ]),
    });
  }
  const directory = "src/cli/production-runtime/workflow";
  const paths = await readdir(resolve(repositoryPath, directory));
  return Object.freeze({
    effectSources: Object.freeze([
      "src/cli/initial-pages-deployment.ts",
      "src/cli/notification-history-pages-deployment.ts",
      "src/cli/notification-history-pages-deployment-record.ts",
      "src/cli/notification-history-pages-deployment-outcome.ts",
      "src/cli/run-publication/deployment.ts",
      "src/cli/run-publication/workflow-history-deployment.ts",
    ]),
    commandSources: Object.freeze(
      paths
        .filter((path) => path.endsWith(".ts"))
        .map((path) => `${directory}/${path}`)
        .sort(),
    ),
  });
}
