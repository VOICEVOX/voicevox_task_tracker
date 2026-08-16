import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  createTrackerRunCliArguments,
  parseCliArguments,
  runTrackerCommand,
  type BackfillCliCommand,
  type DryRunCliCommand,
} from "../src/cli/index.js";

describe("tracker:run実行入口", () => {
  it("ビルド済みJavaScriptをpackage scriptから起動する", async () => {
    const packageSchema = z
      .object({
        scripts: z
          .object({
            "tracker:run": z.string(),
          })
          .loose(),
      })
      .loose();
    const source = await readFile(join(import.meta.dirname, "..", "package.json"), "utf8");
    const packageDefinition = packageSchema.parse(JSON.parse(source));

    expect(packageDefinition.scripts["tracker:run"]).toBe("node dist/cli/tracker-run.js");
  });

  it("backfill modeとrepository filterを既存CLIへ渡す", async () => {
    const runCli = vi.fn((args: readonly string[]): Promise<BackfillCliCommand> => {
      const command = parseCliArguments(args);
      if (command.kind !== "backfill") {
        throw new TypeError("backfill commandではありません");
      }
      return Promise.resolve(command);
    });

    const result = await runTrackerCommand(
      [
        "--backfill",
        "all-open",
        "--repository-filter",
        "VOICEVOX/voicevox_engine, VOICEVOX/voicevox",
        "--scheduled-for",
        "2026-07-30T23:00:00.000Z",
      ],
      runCli,
    );

    expect(runCli).toHaveBeenCalledWith([
      "backfill",
      "--mode",
      "all-open",
      "--scheduled-for",
      "2026-07-30T23:00:00.000Z",
      "--repository",
      "VOICEVOX/voicevox_engine",
      "--repository",
      "VOICEVOX/voicevox",
    ]);
    expect(result).toMatchObject({
      kind: "backfill",
      mode: "all-open",
      repositoryFilter: ["VOICEVOX/voicevox", "VOICEVOX/voicevox_engine"],
    });
  });

  it("--backfill noneをdailyへ変換する", () => {
    expect(createTrackerRunCliArguments(["--backfill", "none"])).toEqual(["daily"]);
  });

  it("--helpをhelpサブコマンドへ変換する", () => {
    expect(createTrackerRunCliArguments(["--help"])).toEqual(["help"]);
  });

  it("evalサブコマンドをgolden fixture指定とともに既存CLIへ渡す", () => {
    expect(
      createTrackerRunCliArguments([
        "eval",
        "--fixtures",
        "tests/fixtures/golden",
        "--artifact",
        "artifacts/eval.json",
      ]),
    ).toEqual(["eval", "--fixtures", "tests/fixtures/golden", "--artifact", "artifacts/eval.json"]);
  });

  it("dry-runサブコマンドをartifact指定とともに既存CLIへ渡す", async () => {
    const runCli = vi.fn((args: readonly string[]): Promise<DryRunCliCommand> => {
      const command = parseCliArguments(args);
      if (command.kind !== "dry-run") {
        throw new TypeError("dry-run commandではありません");
      }
      return Promise.resolve(command);
    });

    const result = await runTrackerCommand(
      ["dry-run", "--artifact", "artifacts/dry-run.json"],
      runCli,
    );

    expect(runCli).toHaveBeenCalledWith(["dry-run", "--artifact", "artifacts/dry-run.json"]);
    expect(result).toMatchObject({
      kind: "dry-run",
      artifactPath: "artifacts/dry-run.json",
    });
  });

  it("verify-stateサブコマンドをstateディレクトリ指定とともに既存CLIへ渡す", () => {
    expect(
      createTrackerRunCliArguments(["verify-state", "--state-directory", "tracker-state-v4/state"]),
    ).toEqual(["verify-state", "--state-directory", "tracker-state-v4/state"]);
  });

  it("workflow stageサブコマンドを検証してそのまま渡す", () => {
    expect(
      createTrackerRunCliArguments([
        "collect-analyze",
        "--mode",
        "none",
        "--artifact",
        "artifacts/workflow/validated-run.json",
      ]),
    ).toEqual([
      "collect-analyze",
      "--mode",
      "none",
      "--artifact",
      "artifacts/workflow/validated-run.json",
    ]);
  });

  it("トップレベル例外を固定文言と安全な診断行として標準エラーへ出す", async () => {
    const githubValueCanaries = [
      "I_kwDO_TOP_LEVEL_NODE_ID_CANARY",
      "https://github.com/VOICEVOX/voicevox/issues/987654",
      "top-level-github-user-canary",
    ];
    const error = new Error(githubValueCanaries.join(" "));
    delete error.stack;
    vi.resetModules();
    vi.doMock("../src/cli/composition-root.js", () => ({
      createDefaultCliApplication: () => ({
        run: () => Promise.reject(error),
      }),
    }));
    const trackerRunPath = fileURLToPath(new URL("../src/cli/tracker-run.ts", import.meta.url));
    const originalArgv = [...process.argv];
    const originalExitCode = process.exitCode;
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    try {
      process.argv.splice(0, process.argv.length, "node", trackerRunPath, "--backfill", "none");
      await import("../src/cli/tracker-run.js");

      expect(stderrWrite).toHaveBeenCalledTimes(2);
      expect(stderrWrite).toHaveBeenNthCalledWith(1, "tracker:runの実行に失敗しました\n");
      expect(stderrWrite).toHaveBeenNthCalledWith(2, "stage=unknown errorType=Error\n");
      const standardError = stderrWrite.mock.calls.map((call) => call[0].toString()).join("");
      for (const canary of githubValueCanaries) {
        expect(standardError).not.toContain(canary);
      }
      expect(process.exitCode).toBe(1);
    } finally {
      process.argv.splice(0, process.argv.length, ...originalArgv);
      process.exitCode = originalExitCode;
      stderrWrite.mockRestore();
      vi.doUnmock("../src/cli/composition-root.js");
      vi.resetModules();
    }
  });

  it("build-pagesのトップレベル例外へ固定stageを付けて安全に出す", async () => {
    const githubValueCanaries = [
      "I_kwDO_TOP_LEVEL_NODE_ID_CANARY",
      "https://github.com/VOICEVOX/voicevox/issues/987654",
      "top-level-github-user-canary",
    ];
    const outputDirectoryCanary = "web/public/data-user-input-canary";
    const error = new Error(githubValueCanaries.join(" "));
    delete error.stack;
    vi.resetModules();
    vi.doMock("../src/cli/composition-root.js", () => ({
      createDefaultCliApplication: () => ({
        run: () => Promise.reject(error),
      }),
    }));
    const trackerRunPath = fileURLToPath(new URL("../src/cli/tracker-run.ts", import.meta.url));
    const originalArgv = [...process.argv];
    const originalExitCode = process.exitCode;
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    try {
      process.argv.splice(
        0,
        process.argv.length,
        "node",
        trackerRunPath,
        "build-pages",
        "--output",
        outputDirectoryCanary,
      );
      await import("../src/cli/tracker-run.js");

      expect(stderrWrite).toHaveBeenCalledTimes(2);
      expect(stderrWrite).toHaveBeenNthCalledWith(1, "tracker:runの実行に失敗しました\n");
      expect(stderrWrite).toHaveBeenNthCalledWith(2, "stage=pages errorType=Error\n");
      const standardError = stderrWrite.mock.calls.map((call) => call[0].toString()).join("");
      for (const canary of githubValueCanaries) {
        expect(standardError).not.toContain(canary);
      }
      expect(standardError).not.toContain(outputDirectoryCanary);
      expect(process.exitCode).toBe(1);
    } finally {
      process.argv.splice(0, process.argv.length, ...originalArgv);
      process.exitCode = originalExitCode;
      stderrWrite.mockRestore();
      vi.doUnmock("../src/cli/composition-root.js");
      vi.resetModules();
    }
  });
});
