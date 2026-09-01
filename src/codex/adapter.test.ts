import { strict as assert } from "node:assert";
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { z } from "zod";

import { createDiagnosticsRecorder } from "../diagnostics/index.js";
import {
  createCodexAnalysisInput,
  executeCodexAuthenticationPreflight,
  executeCodexAnalysis,
  executeValidatedCodexAnalysis,
  type CodexAdapterConfiguration,
} from "./index.js";
import { recordCodexDiagnostic } from "./diagnostics.js";
import { CodexNonZeroExitError, CodexProcessStartError } from "./errors.js";
import type { CodexProcessRequest } from "./process-runner.js";

const diagnosticsRecordSchema = z.strictObject({
  sequence: z.number(),
  recordedAt: z.string(),
  event: z.string(),
  details: z.record(z.string(), z.unknown()).optional(),
  error: z.unknown().optional(),
});

async function withTemporaryDirectory(action: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "voicevox-codex-adapter-test-"));
  try {
    await action(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function createInput() {
  return createCodexAnalysisInput({
    schemaVersion: "1",
    now: "2026-09-01T00:00:00.000Z",
    item: {
      nodeId: "item-1",
      url: "https://github.com/VOICEVOX/repository/issues/1",
      type: "issue",
      title: "test issue",
    },
    candidates: {
      waitingOn: [],
      relations: [],
    },
    sources: [
      {
        id: "comment:1",
        kind: "comment",
        actorType: "human",
        createdAt: "2026-08-31T00:00:00.000Z",
      },
    ],
    deterministicSignals: {},
    priorAnalysis: null,
  });
}

function createOutput() {
  return {
    schemaVersion: "4",
    item: {
      nodeId: "item-1",
      url: "https://github.com/VOICEVOX/repository/issues/1",
    },
    status: "terminal_completed",
    waitingOn: [],
    nextAction: "完了を確認する",
    relations: [],
    progress: {
      latestMeaningfulSourceId: "codex_source:0",
      reasonSummary: "完了しています",
      confidence: 0.9,
    },
    importance: {
      significantFeature: false,
      futureRisk: false,
      rationale: "重要な懸念はありません",
    },
    deadline: {
      date: null,
      rationale: "期限の指定はありません",
    },
    evidence: [
      {
        sourceId: "codex_source:0",
        supports: "status",
        summary: "完了を示す記録があります",
      },
    ],
    confidence: 0.9,
    uncertainties: [],
    notification: {
      recommended: false,
      reasonCode: "none",
      reasonSummary: "通知は不要です",
    },
  };
}

const configuration = {
  authentication: "api-key",
  model: "test-model",
  execution: {
    timeoutSeconds: 10,
    maxAttempts: 2,
    sandbox: "read-only",
    approvalPolicy: "never",
    reasoningEffort: "none",
  },
  retry: {
    initialDelaySeconds: 0,
    maxDelaySeconds: 0,
  },
} satisfies CodexAdapterConfiguration;

void test("失敗したCodex attemptのstdout stderr last-messageを診断へ保存する", async () => {
  await withTemporaryDirectory(async (directory) => {
    const diagnosticsPath = join(directory, "diagnostics.jsonl");
    const recorder = await createDiagnosticsRecorder({ path: diagnosticsPath });
    let processCount = 0;
    const result = await executeCodexAnalysis(createInput(), configuration, {
      environment: {
        HOME: "/tmp",
        OPENAI_API_KEY: "test-key",
        PATH: process.env["PATH"] ?? "/usr/bin",
      },
      processRunner: async (request) => {
        processCount += 1;
        const outputPath = request.arguments.at(
          request.arguments.indexOf("--output-last-message") + 1,
        );
        assert.ok(outputPath);
        if (processCount === 1) {
          await writeFile(outputPath, '{"first":true}', "utf8");
          return {
            exitCode: null,
            signal: "SIGTERM",
            timedOut: false,
            stdout: '{"type":"turn.failed","error":{"code":"server_error","status":503}}\n',
            stderr: "first stderr",
          };
        }
        await writeFile(outputPath, JSON.stringify(createOutput()), "utf8");
        return {
          exitCode: 0,
          signal: null,
          timedOut: false,
          stdout: "second stdout",
          stderr: "second stderr",
        };
      },
      runtime: {
        sleep: () => Promise.resolve(),
        random: () => 0,
      },
      diagnostics: {
        recorder,
        runId: "run-1",
        invocationId: "invocation-1",
        candidateId: "item-1",
      },
    });
    await recorder.close();

    assert.equal(result.item.nodeId, "item-1");
    const records = (await readFile(diagnosticsPath, "utf8"))
      .trimEnd()
      .split("\n")
      .map((line) => {
        const value: unknown = JSON.parse(line);
        return diagnosticsRecordSchema.parse(value);
      });
    const completed = records.filter((record) => record.event === "codex.attempt.completed");
    assert.equal(completed.length, 2);
    const [firstCompleted, secondCompleted] = completed;
    assert.ok(firstCompleted);
    assert.ok(secondCompleted);
    assert.ok(firstCompleted.details);
    assert.equal(
      firstCompleted.details["stdout"],
      '{"type":"turn.failed","error":{"code":"server_error","status":503}}\n',
    );
    assert.equal(firstCompleted.details["stderr"], "first stderr");
    assert.equal(firstCompleted.details["lastMessage"], '{"first":true}');
    const turnFailed = records.find((record) => record.event === "codex.stdout.turn_failed");
    assert.ok(turnFailed);
    assert.ok(turnFailed.details);
    assert.deepEqual(turnFailed.details["apiError"], {
      type: "turn.failed",
      code: "server_error",
      status: "503",
    });
    const firstError = firstCompleted.error;
    assert.ok(firstError != null && typeof firstError === "object" && "name" in firstError);
    assert.equal(firstError.name, "CodexNonZeroExitError");
    assert.ok(secondCompleted.details);
    assert.equal(secondCompleted.details["outcome"], "success");
  });
});

void test("Codex出力のschema validation失敗は元Errorとともに診断へ保存する", async () => {
  await withTemporaryDirectory(async (directory) => {
    const diagnosticsPath = join(directory, "diagnostics.jsonl");
    const recorder = await createDiagnosticsRecorder({ path: diagnosticsPath });
    const attempt = await executeValidatedCodexAnalysis(
      createInput(),
      () => Promise.resolve({}),
      async (error) =>
        recordCodexDiagnostic(
          {
            recorder,
            runId: "run-1",
            invocationId: "invocation-1",
            candidateId: "item-1",
          },
          "codex.output.schema_validation_failed",
          {
            phase: "execution",
          },
          error,
        ),
    );
    await recorder.close();

    assert.equal(attempt.status, "unavailable");
    const records = (await readFile(diagnosticsPath, "utf8"))
      .trimEnd()
      .split("\n")
      .map((line) => {
        const value: unknown = JSON.parse(line);
        return diagnosticsRecordSchema.parse(value);
      });
    assert.equal(records.length, 1);
    const [record] = records;
    assert.ok(record);
    assert.equal(record.event, "codex.output.schema_validation_failed");
    const error = record.error;
    assert.ok(error != null && typeof error === "object" && "name" in error);
    assert.equal(error.name, "CodexOutputSchemaValidationError");
  });
});

void test("stdin送信失敗でもdrain済みの3出力を診断へ保存する", async () => {
  await withTemporaryDirectory(async (directory) => {
    const diagnosticsPath = join(directory, "diagnostics.jsonl");
    const recorder = await createDiagnosticsRecorder({ path: diagnosticsPath });
    const singleAttemptConfiguration = {
      ...configuration,
      execution: {
        ...configuration.execution,
        maxAttempts: 1,
      },
    } satisfies CodexAdapterConfiguration;
    const inputError = new Error("stdinが閉じられました");
    Object.assign(inputError, { code: "EPIPE" });
    await assert.rejects(
      executeCodexAnalysis(createInput(), singleAttemptConfiguration, {
        environment: {
          HOME: "/tmp",
          OPENAI_API_KEY: "test-key",
          PATH: process.env["PATH"] ?? "/usr/bin",
        },
        processRunner: async (request) => {
          const outputPath = request.arguments.at(
            request.arguments.indexOf("--output-last-message") + 1,
          );
          assert.ok(outputPath);
          await writeFile(outputPath, '{"last":"message"}', "utf8");
          return {
            exitCode: 0,
            signal: null,
            timedOut: false,
            standardInputError: inputError,
            stdout: "stdin stdout",
            stderr: "stdin stderr",
          };
        },
        runtime: {
          sleep: () => Promise.resolve(),
          random: () => 0,
        },
        diagnostics: {
          recorder,
          runId: "run-1",
          invocationId: "invocation-1",
          candidateId: "item-1",
        },
      }),
      (error: unknown) => {
        assert.ok(error instanceof CodexProcessStartError);
        const cause = error.cause;
        assert.ok(cause instanceof Error);
        assert.equal(cause.message, "stdinが閉じられました");
        assert.ok("code" in cause);
        assert.equal(cause.code, "EPIPE");
        return true;
      },
    );
    await recorder.close();

    const records = (await readFile(diagnosticsPath, "utf8"))
      .trimEnd()
      .split("\n")
      .map((line) => {
        const value: unknown = JSON.parse(line);
        return diagnosticsRecordSchema.parse(value);
      });
    const completed = records.find((record) => record.event === "codex.attempt.completed");
    assert.ok(completed);
    assert.ok(completed.details);
    assert.equal(completed.details["stdout"], "stdin stdout");
    assert.equal(completed.details["stderr"], "stdin stderr");
    assert.equal(completed.details["lastMessage"], '{"last":"message"}');
    const error = completed.error;
    assert.ok(error != null && typeof error === "object" && "name" in error);
    assert.equal(error.name, "CodexProcessStartError");
    assert.ok("cause" in error);
    const cause = error.cause;
    assert.ok(cause != null && typeof cause === "object" && "message" in cause);
    assert.equal(cause.message, "stdinが閉じられました");
  });
});

void test("診断未設定でもCodex adapterの既存実行結果を返す", async () => {
  const result = await executeCodexAnalysis(createInput(), configuration, {
    environment: {
      HOME: "/tmp",
      OPENAI_API_KEY: "test-key",
      PATH: process.env["PATH"] ?? "/usr/bin",
    },
    processRunner: async (request) => {
      const outputPath = request.arguments.at(
        request.arguments.indexOf("--output-last-message") + 1,
      );
      assert.ok(outputPath);
      await writeFile(outputPath, JSON.stringify(createOutput()), "utf8");
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: "",
        stderr: "",
      };
    },
    runtime: {
      sleep: () => Promise.resolve(),
      random: () => 0,
    },
  });

  assert.equal(result.item.nodeId, "item-1");
});

void test("Codex認証preflightは固定promptと空の作業directoryで実行する", async () => {
  let capturedRequest: CodexProcessRequest | undefined;
  let workingDirectory: string | undefined;
  await executeCodexAuthenticationPreflight(
    {
      ...configuration,
      authentication: "auth-json",
    },
    {
      environment: {
        CODEX_HOME: "/tmp/codex-home",
        HOME: "/tmp",
        PATH: process.env["PATH"] ?? "/usr/bin",
      },
      processRunner: async (request) => {
        capturedRequest = request;
        workingDirectory = request.workingDirectory;
        assert.deepEqual(await readdir(request.workingDirectory), []);
        return {
          exitCode: 0,
          signal: null,
          timedOut: false,
          stdout: "候補やsystem promptを含まない応答",
          stderr: "",
        };
      },
      runtime: {
        sleep: () => Promise.resolve(),
        random: () => 0,
      },
    },
  );

  assert.ok(capturedRequest);
  assert.equal(capturedRequest.command, "codex");
  assert.equal(capturedRequest.standardInput, "");
  assert.equal(capturedRequest.arguments[0], "exec");
  assert.equal(capturedRequest.arguments.includes("--strict-config"), true);
  assert.equal(capturedRequest.arguments.includes("--ignore-user-config"), true);
  assert.equal(capturedRequest.arguments.includes("--ignore-rules"), true);
  assert.equal(capturedRequest.arguments.includes("--ephemeral"), true);
  assert.equal(capturedRequest.arguments.includes("--skip-git-repo-check"), true);
  assert.equal(capturedRequest.arguments.includes("--output-schema"), false);
  assert.equal(capturedRequest.arguments.includes("--output-last-message"), false);
  assert.equal(capturedRequest.arguments.includes("test issue"), false);
  assert.equal(capturedRequest.arguments.includes("GitHub"), false);
  assert.deepEqual(capturedRequest.environment, {
    CODEX_HOME: "/tmp/codex-home",
    HOME: "/tmp",
    PATH: process.env["PATH"] ?? "/usr/bin",
  });
  assert.ok(workingDirectory);
  await assert.rejects(readdir(workingDirectory));
});

void test("Codex認証preflightのprocess失敗はcauseとstackを保って伝播しcleanupする", async () => {
  let workingDirectory: string | undefined;
  const processError = new Error("processを起動できません");
  const singleAttemptConfiguration = {
    ...configuration,
    execution: {
      ...configuration.execution,
      maxAttempts: 1,
    },
  } satisfies CodexAdapterConfiguration;

  await assert.rejects(
    executeCodexAuthenticationPreflight(singleAttemptConfiguration, {
      environment: {
        HOME: "/tmp",
        OPENAI_API_KEY: "test-key",
        PATH: process.env["PATH"] ?? "/usr/bin",
      },
      processRunner: (request) => {
        workingDirectory = request.workingDirectory;
        throw processError;
      },
      runtime: {
        sleep: () => Promise.resolve(),
        random: () => 0,
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof CodexProcessStartError);
      assert.equal(error.cause, processError);
      assert.match(error.stack ?? "", /CodexProcessStartError/u);
      return true;
    },
  );

  assert.ok(workingDirectory);
  await assert.rejects(readdir(workingDirectory));
});

void test("Codex認証preflightはtimeoutを逐次retryし各directoryをcleanupする", async () => {
  const directories: string[] = [];
  const waits: number[] = [];
  let processCount = 0;
  let activeProcesses = 0;
  let maximumActiveProcesses = 0;
  await executeCodexAuthenticationPreflight(configuration, {
    environment: {
      HOME: "/tmp",
      OPENAI_API_KEY: "test-key",
      PATH: process.env["PATH"] ?? "/usr/bin",
    },
    processRunner: async (request) => {
      processCount += 1;
      directories.push(request.workingDirectory);
      activeProcesses += 1;
      maximumActiveProcesses = Math.max(maximumActiveProcesses, activeProcesses);
      await Promise.resolve();
      activeProcesses -= 1;
      if (processCount === 1) {
        return {
          exitCode: null,
          signal: "SIGTERM",
          timedOut: true,
          stdout: "first stdout",
          stderr: "first stderr",
        };
      }
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: "second stdout",
        stderr: "second stderr",
      };
    },
    runtime: {
      sleep: (delayMilliseconds) => {
        waits.push(delayMilliseconds);
        return Promise.resolve();
      },
      random: () => 0,
    },
  });

  assert.equal(processCount, 2);
  assert.equal(maximumActiveProcesses, 1);
  assert.deepEqual(waits, [0]);
  assert.equal(new Set(directories).size, 2);
  for (const directory of directories) {
    await assert.rejects(readdir(directory));
  }
});

void test("Codex認証preflightの非zero終了を診断へ保存する", async () => {
  await withTemporaryDirectory(async (directory) => {
    const diagnosticsPath = join(directory, "diagnostics.jsonl");
    const recorder = await createDiagnosticsRecorder({ path: diagnosticsPath });
    const singleAttemptConfiguration = {
      ...configuration,
      execution: {
        ...configuration.execution,
        maxAttempts: 1,
      },
    } satisfies CodexAdapterConfiguration;
    await assert.rejects(
      executeCodexAuthenticationPreflight(singleAttemptConfiguration, {
        environment: {
          HOME: "/tmp",
          OPENAI_API_KEY: "test-key",
          PATH: process.env["PATH"] ?? "/usr/bin",
        },
        processRunner: () =>
          Promise.resolve({
            exitCode: 1,
            signal: null,
            timedOut: false,
            apiError: {
              type: "authentication_error",
              code: "invalid_api_key",
              status: "401",
            },
            stdout: "preflight stdout",
            stderr: "preflight stderr",
          }),
        runtime: {
          sleep: () => Promise.resolve(),
          random: () => 0,
        },
        diagnostics: {
          recorder,
          runId: "run-1",
          invocationId: "invocation-1",
        },
      }),
      (error: unknown) => error instanceof CodexNonZeroExitError,
    );
    await recorder.close();

    const records = (await readFile(diagnosticsPath, "utf8"))
      .trimEnd()
      .split("\n")
      .map((line) => {
        const value: unknown = JSON.parse(line);
        return diagnosticsRecordSchema.parse(value);
      });
    const completed = records.find(
      (record) => record.event === "codex.authentication_preflight.attempt.completed",
    );
    assert.ok(completed);
    assert.ok(completed.details);
    assert.equal(completed.details["stdout"], "preflight stdout");
    assert.equal(completed.details["stderr"], "preflight stderr");
    assert.deepEqual(completed.details["apiError"], {
      type: "authentication_error",
      code: "invalid_api_key",
      status: "401",
    });
    assert.equal(completed.details["outcome"], "failure");
  });
});

void test("Codex認証preflightはstdoutのAPI errorイベントとJSONL解析失敗を診断する", async () => {
  await withTemporaryDirectory(async (directory) => {
    const diagnosticsPath = join(directory, "diagnostics.jsonl");
    const recorder = await createDiagnosticsRecorder({ path: diagnosticsPath });
    const singleAttemptConfiguration = {
      ...configuration,
      execution: {
        ...configuration.execution,
        maxAttempts: 1,
      },
    } satisfies CodexAdapterConfiguration;
    await assert.rejects(
      executeCodexAuthenticationPreflight(singleAttemptConfiguration, {
        environment: {
          HOME: "/tmp",
          OPENAI_API_KEY: "test-key",
          PATH: process.env["PATH"] ?? "/usr/bin",
        },
        processRunner: () =>
          Promise.resolve({
            exitCode: 0,
            signal: null,
            timedOut: false,
            stdout: [
              "not-json",
              JSON.stringify({
                type: "turn.failed",
                error: {
                  code: "server_error",
                  status: 503,
                },
              }),
              JSON.stringify({
                event: "error",
                error: {
                  type: "transport_error",
                },
              }),
            ].join("\n"),
            stderr: "preflight stderr",
          }),
        runtime: {
          sleep: () => Promise.resolve(),
          random: () => 0,
        },
        diagnostics: {
          recorder,
          runId: "run-1",
          invocationId: "invocation-1",
        },
      }),
      (error: unknown) => {
        assert.ok(error instanceof CodexNonZeroExitError);
        assert.equal(error.exitCode, 0);
        assert.deepEqual(error.apiError, {
          type: "turn.failed",
          code: "server_error",
          status: "503",
        });
        return true;
      },
    );
    await recorder.close();

    const records = (await readFile(diagnosticsPath, "utf8"))
      .trimEnd()
      .split("\n")
      .map((line) => {
        const value: unknown = JSON.parse(line);
        return diagnosticsRecordSchema.parse(value);
      });
    const parseFailure = records.find(
      (record) => record.event === "codex.stdout.json_parse_failed",
    );
    assert.ok(parseFailure);
    const apiEvents = records.filter(
      (record) =>
        record.event === "codex.stdout.turn_failed" || record.event === "codex.stdout.error",
    );
    assert.equal(apiEvents.length, 2);
    for (const event of apiEvents) {
      assert.ok(event.details);
      assert.deepEqual(event.details["apiError"], {
        type: "turn.failed",
        code: "server_error",
        status: "503",
      });
      assert.ok(event.error);
    }
  });
});
