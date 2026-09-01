import { strict as assert } from "node:assert";
import { execFile, spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import {
  DIAGNOSTICS_KEY_ENVIRONMENT_VARIABLE,
  DiagnosticsCliUsageError,
  decryptDiagnosticsBundle,
} from "../diagnostics/index.js";
import { runTrackerCliMain } from "./tracker-run.js";

const TEST_KEY_BASE64 = Buffer.alloc(32, 0x41).toString("base64");
const DIAGNOSTICS_PATH_ENVIRONMENT_VARIABLE = "VOICEVOX_TASK_TRACKER_DIAGNOSTICS_PATH";
const execFileAsync = promisify(execFile);
const DIST_TRACKER_RUN_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "tracker-run.js");
const ENCRYPT_DIAGNOSTICS_SCRIPT_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../.github/scripts/encrypt-diagnostics.sh",
);
const RUNTIME_TRACKER_RUN_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../artifacts/workflow/runtime/tracker-run.mjs",
);
const WORKSPACE_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

async function withTemporaryDirectory(action: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "voicevox-tracker-run-test-"));
  try {
    await action(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function withEnvironment(
  values: Readonly<Record<string, string | undefined>>,
  action: () => Promise<void>,
): Promise<void> {
  const previous = new Map<string, string | undefined>();
  for (const [name, value] of Object.entries(values)) {
    previous.set(name, process.env[name]);
    if (value == null) {
      Reflect.deleteProperty(process.env, name);
    } else {
      process.env[name] = value;
    }
  }
  try {
    await action();
  } finally {
    for (const [name, value] of previous) {
      if (value == null) {
        Reflect.deleteProperty(process.env, name);
      } else {
        process.env[name] = value;
      }
    }
  }
}

function diagnosticsEncryptArguments(inputPath: string, outputPath: string): readonly string[] {
  return [
    "diagnostics",
    "encrypt",
    "--input",
    inputPath,
    "--output",
    outputPath,
    "--run-id",
    "run",
    "--run-attempt",
    "1",
    "--job",
    "quality-eval",
    "--invocation-id",
    "invocation",
  ];
}

function diagnosticsDecryptArguments(
  inputPath: string,
  outputPath: string,
  keyPath: string,
): readonly string[] {
  return [
    "diagnostics",
    "decrypt",
    "--key-file",
    keyPath,
    "--input",
    inputPath,
    "--output",
    outputPath,
  ];
}

async function runRuntimeTrackerCli(
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  await execFileAsync(process.execPath, [RUNTIME_TRACKER_RUN_PATH, ...args], {
    env: environment,
  });
}

type ChildProcessResult = Readonly<{
  exitCode: number | null;
  stdout: string;
  stderr: string;
}>;

function runChildProcess(
  command: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
): Promise<ChildProcessResult> {
  return new Promise<ChildProcessResult>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: WORKSPACE_PATH,
      env: environment,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.once("error", reject);
    child.once("close", (exitCode) => {
      resolve({ exitCode, stdout, stderr });
    });
  });
}

async function runChildProcessWithFileOutput(
  command: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
  outputDirectory: string,
): Promise<ChildProcessResult> {
  const stdoutPath = join(outputDirectory, "stdout");
  const stderrPath = join(outputDirectory, "stderr");
  const stdoutFileDescriptor = openSync(stdoutPath, "w");
  const stderrFileDescriptor = openSync(stderrPath, "w");
  let exitCode: number | null;
  try {
    const child = spawn(command, args, {
      cwd: WORKSPACE_PATH,
      env: environment,
      stdio: ["ignore", stdoutFileDescriptor, stderrFileDescriptor],
    });
    exitCode = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
  } finally {
    closeSync(stdoutFileDescriptor);
    closeSync(stderrFileDescriptor);
  }
  return {
    exitCode,
    stdout: await readFile(stdoutPath, "utf8"),
    stderr: await readFile(stderrPath, "utf8"),
  };
}

void test("tracker-run共通entryはdiagnostics encryptをbundle生成へroutingする", async () => {
  await withTemporaryDirectory(async (directory) => {
    const inputPath = join(directory, "diagnostics.jsonl");
    const outputPath = join(directory, "diagnostics.bundle");
    const decryptedPath = join(directory, "diagnostics.decrypted.jsonl");
    const source = "diagnostic\n";
    await writeFile(inputPath, source, { encoding: "utf8", mode: 0o600 });

    await withEnvironment({ [DIAGNOSTICS_KEY_ENVIRONMENT_VARIABLE]: TEST_KEY_BASE64 }, async () => {
      assert.equal(await runTrackerCliMain(diagnosticsEncryptArguments(inputPath, outputPath)), 0);
    });
    await decryptDiagnosticsBundle({
      inputPath: outputPath,
      outputPath: decryptedPath,
      keyBase64: TEST_KEY_BASE64,
    });
    assert.equal(await readFile(decryptedPath, "utf8"), source);
  });
});

void test("空JSONLはdistとruntimeの共通entryで暗号化して復号できる", async () => {
  await withTemporaryDirectory(async (directory) => {
    const distInputPath = join(directory, "dist-diagnostics.jsonl");
    const distEncryptedPath = join(directory, "dist-diagnostics.bundle");
    const distDecryptedPath = join(directory, "dist-diagnostics.decrypted.jsonl");
    const runtimeInputPath = join(directory, "runtime-diagnostics.jsonl");
    const runtimeEncryptedPath = join(directory, "runtime-diagnostics.bundle");
    const runtimeDecryptedPath = join(directory, "runtime-diagnostics.decrypted.jsonl");
    const keyPath = join(directory, "diagnostics.key");
    await writeFile(distInputPath, "", { encoding: "utf8", mode: 0o600 });
    await writeFile(runtimeInputPath, "", { encoding: "utf8", mode: 0o600 });
    await writeFile(keyPath, `${TEST_KEY_BASE64}\n`, { encoding: "utf8", mode: 0o600 });

    await withEnvironment({ [DIAGNOSTICS_KEY_ENVIRONMENT_VARIABLE]: TEST_KEY_BASE64 }, async () => {
      assert.equal(
        await runTrackerCliMain(diagnosticsEncryptArguments(distInputPath, distEncryptedPath)),
        0,
      );
      assert.equal(
        await runTrackerCliMain(
          diagnosticsDecryptArguments(distEncryptedPath, distDecryptedPath, keyPath),
        ),
        0,
      );
    });
    const runtimeEnvironment: NodeJS.ProcessEnv = {
      ...process.env,
      [DIAGNOSTICS_KEY_ENVIRONMENT_VARIABLE]: TEST_KEY_BASE64,
    };
    Reflect.deleteProperty(runtimeEnvironment, DIAGNOSTICS_PATH_ENVIRONMENT_VARIABLE);
    await runRuntimeTrackerCli(
      diagnosticsEncryptArguments(runtimeInputPath, runtimeEncryptedPath),
      runtimeEnvironment,
    );
    await runRuntimeTrackerCli(
      diagnosticsDecryptArguments(runtimeEncryptedPath, runtimeDecryptedPath, keyPath),
      runtimeEnvironment,
    );

    assert.equal(await readFile(distDecryptedPath, "utf8"), "");
    assert.equal(await readFile(runtimeDecryptedPath, "utf8"), "");
  });
});

void test("診断暗号化は通常CLIのrecorderを作成しない", async () => {
  await withTemporaryDirectory(async (directory) => {
    const inputPath = join(directory, "diagnostics.jsonl");
    const outputPath = join(directory, "diagnostics.bundle");
    await writeFile(inputPath, "diagnostic\n", { encoding: "utf8", mode: 0o600 });

    await withEnvironment(
      {
        [DIAGNOSTICS_KEY_ENVIRONMENT_VARIABLE]: TEST_KEY_BASE64,
        [DIAGNOSTICS_PATH_ENVIRONMENT_VARIABLE]: outputPath,
      },
      async () => {
        assert.equal(
          await runTrackerCliMain(diagnosticsEncryptArguments(inputPath, outputPath)),
          0,
        );
      },
    );
    assert.equal((await stat(outputPath)).isFile(), true);
  });
});

void test("診断暗号化はsecretなしで失敗し入力を作成しない", async () => {
  await withTemporaryDirectory(async (directory) => {
    const inputPath = join(directory, "diagnostics.jsonl");
    const outputPath = join(directory, "diagnostics.bundle");
    const recorderPath = join(directory, "recorder.jsonl");
    await writeFile(inputPath, "diagnostic\n", { encoding: "utf8", mode: 0o600 });

    await withEnvironment(
      {
        [DIAGNOSTICS_KEY_ENVIRONMENT_VARIABLE]: undefined,
        [DIAGNOSTICS_PATH_ENVIRONMENT_VARIABLE]: recorderPath,
      },
      async () => {
        await assert.rejects(
          runTrackerCliMain(diagnosticsEncryptArguments(inputPath, outputPath)),
          DiagnosticsCliUsageError,
        );
      },
    );
    await assert.rejects(stat(recorderPath));
    await assert.rejects(stat(outputPath));
  });
});

void test("tracker-runのmain境界はdiagnosticsのthrowを固定メッセージへ変換する", async () => {
  await withTemporaryDirectory(async (directory) => {
    const inputPath = join(directory, "diagnostics.jsonl");
    const outputPath = join(directory, "diagnostics.bundle");
    const environment: NodeJS.ProcessEnv = { ...process.env };
    Reflect.deleteProperty(environment, DIAGNOSTICS_KEY_ENVIRONMENT_VARIABLE);
    Reflect.deleteProperty(environment, DIAGNOSTICS_PATH_ENVIRONMENT_VARIABLE);

    const result = await runChildProcessWithFileOutput(
      process.execPath,
      [DIST_TRACKER_RUN_PATH, ...diagnosticsEncryptArguments(inputPath, outputPath)],
      environment,
      directory,
    );
    assert.equal(result.exitCode, 1);
    assert.equal(
      result.stderr,
      `diagnostics CLI引数が不正です。${DIAGNOSTICS_KEY_ENVIRONMENT_VARIABLE}が必要です\n`,
    );
    assert.equal(result.stderr.includes("at "), false);
  });
});

void test("暗号化scriptは鍵なしでも既存平文を削除する", async () => {
  await withTemporaryDirectory(async (directory) => {
    const runnerTemp = join(directory, "runner-temp");
    await mkdir(runnerTemp, { recursive: true });
    const job = "quality-eval";
    const diagnosticsPath = join(runnerTemp, `voicevox-task-tracker-diagnostics-${job}.jsonl`);
    await writeFile(diagnosticsPath, "diagnostic\n", { encoding: "utf8", mode: 0o600 });
    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      RUNNER_TEMP: runnerTemp,
      GITHUB_JOB: job,
      GITHUB_RUN_ID: "run",
      GITHUB_RUN_ATTEMPT: "1",
    };
    Reflect.deleteProperty(environment, DIAGNOSTICS_KEY_ENVIRONMENT_VARIABLE);

    const result = await runChildProcess(
      ENCRYPT_DIAGNOSTICS_SCRIPT_PATH,
      ["dist/cli/tracker-run.js"],
      environment,
    );
    assert.notEqual(result.exitCode, 0);
    await assert.rejects(stat(diagnosticsPath));
  });
});

void test("診断暗号化は入力なしで失敗し入力を作成しない", async () => {
  await withTemporaryDirectory(async (directory) => {
    const inputPath = join(directory, "diagnostics.jsonl");
    const outputPath = join(directory, "diagnostics.bundle");

    await withEnvironment({ [DIAGNOSTICS_KEY_ENVIRONMENT_VARIABLE]: TEST_KEY_BASE64 }, async () => {
      await assert.rejects(runTrackerCliMain(diagnosticsEncryptArguments(inputPath, outputPath)));
    });
    await assert.rejects(stat(inputPath));
    await assert.rejects(stat(outputPath));
  });
});
