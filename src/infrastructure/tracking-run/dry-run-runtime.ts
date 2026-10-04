import { execFile } from "node:child_process";
import { cp, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { GitStateBranchAdapter } from "../../persistence/index.js";
import { inspectRunBootstrapState } from "./bootstrap-state.js";
import type { DryRunCliCommand } from "./command-input.js";
import type { CoordinatedRunResult } from "./run-coordinator.js";
import type { ProductionRuntimeAdapters } from "./runtime/adapters.js";
import { createDailyDependencies } from "./runtime/daily-dependencies.js";
import type { DailyRunExecutionResult } from "./sequential-result.js";
import { SequentialRunRunner } from "./sequential-run.js";

const execFileAsync = promisify(execFile);

async function runGit(arguments_: readonly string[]): Promise<void> {
  await execFileAsync("git", [...arguments_], { maxBuffer: 8 * 1024 * 1024 });
}

async function copySourceForPages(
  repositoryPath: string,
  destination: string,
  configPath: string,
): Promise<void> {
  await runGit(["clone", "--local", "--no-hardlinks", repositoryPath, destination]);
  await runGit(["-C", destination, "remote", "remove", "origin"]);
  for (const directory of ["src", "web", ".github", "dist"]) {
    await cp(join(repositoryPath, directory), join(destination, directory), {
      recursive: true,
      force: true,
    });
  }
  for (const file of [
    "package.json",
    "pnpm-lock.yaml",
    ".node-version",
    "tsconfig.json",
    "tsconfig.build.json",
  ]) {
    await cp(join(repositoryPath, file), join(destination, file), { force: true });
  }
  await cp(configPath, join(destination, "config.yml"), { force: true });
  await symlink(join(repositoryPath, "node_modules"), join(destination, "node_modules"), "dir");
}

async function createIsolatedStateGit(
  repositoryPath: string,
  directory: string,
  branch: string,
  baseRevision: string | undefined,
): Promise<string> {
  const remote = join(directory, "state-remote.git");
  const local = join(directory, "state-local");
  await runGit(["init", "--bare", remote]);
  await runGit(["init", local]);
  await runGit(["-C", local, "remote", "add", "origin", remote]);
  if (baseRevision != null) {
    await runGit([
      "-C",
      local,
      "fetch",
      "--no-tags",
      "--no-write-fetch-head",
      repositoryPath,
      baseRevision,
    ]);
    await runGit(["-C", local, "push", "origin", `${baseRevision}:refs/heads/${branch}`]);
  }
  return local;
}

/** dry-runを隔離Gitと記録用portで共通直列engineの完了まで実行する。 */
export async function runIsolatedDryRun(
  adapters: ProductionRuntimeAdapters,
  command: DryRunCliCommand,
  invocationId: string,
): Promise<CoordinatedRunResult<DailyRunExecutionResult>> {
  const configPath = resolve(adapters.repositoryPath, command.configPath);
  const config = await adapters.loadConfig(configPath);
  const productionState = adapters.createStateBranchAdapter();
  const bootstrap = await inspectRunBootstrapState(productionState, config.state.branch, {
    kind: "start_new",
  });
  if (bootstrap.kind !== "start_with_current_runtime") {
    throw new TypeError("未完了の本番runがあるためdry-runを開始できません");
  }
  const baseRevision =
    bootstrap.observedStateHead.status === "present"
      ? bootstrap.observedStateHead.revision
      : undefined;
  if (baseRevision != null) {
    await productionState.listFiles(baseRevision, "state");
  }
  const directory = await mkdtemp(join(tmpdir(), "voicevox-dry-run-"));
  try {
    const source = join(directory, "source");
    await copySourceForPages(adapters.repositoryPath, source, configPath);
    const localGit = await createIsolatedStateGit(
      adapters.repositoryPath,
      directory,
      config.state.branch,
      baseRevision,
    );
    const recordingAdapters: ProductionRuntimeAdapters = Object.freeze({
      ...adapters,
      repositoryPath: source,
      pagesOutputDirectory: join(source, "web/public/data"),
      loadConfig: () => Promise.resolve(config),
      createStateBranchAdapter: () =>
        new GitStateBranchAdapter({
          repositoryPath: localGit,
          gitExecutable: "git",
          authorName: "VOICEVOX Task Tracker",
          authorEmail: "voicevox-task-tracker@users.noreply.github.com",
        }),
      deployProductionPages: () =>
        Promise.reject(new TypeError("dry-runから本番Pagesへ公開できません")),
      sendDiscord: () => Promise.reject(new TypeError("dry-runからDiscordへ送信できません")),
    });
    const runner = new SequentialRunRunner(createDailyDependencies(recordingAdapters), {
      now: adapters.now,
    });
    return await runner.run(command, invocationId);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
