import { strict as assert } from "node:assert";
import { test } from "node:test";

import { runCodexProcess } from "./process-runner.js";

void test("Codex process runnerはstdoutとstderrを同時に最後までdrainする", async (context) => {
  if (process.env["CODEX_SANDBOX_NETWORK_DISABLED"] === "1") {
    context.skip("この実行環境ではsubprocessのstdioが隔離されています");
    return;
  }
  const path = process.env["PATH"];
  assert.ok(path);
  const outputSize = 1024 * 1024;
  let result;
  try {
    result = await runCodexProcess({
      command: process.execPath,
      arguments: [
        "-e",
        `process.stdout.write("o".repeat(${outputSize.toString()}));process.stderr.write("e".repeat(${outputSize.toString()}));`,
      ],
      workingDirectory: process.cwd(),
      environment: { PATH: path },
      standardInput: "",
      timeoutMilliseconds: 10_000,
    });
  } catch (error: unknown) {
    if (error != null && typeof error === "object" && "code" in error && error.code === "EPERM") {
      context.skip("この実行環境ではsubprocessが許可されていません");
      return;
    }
    throw error;
  }

  assert.equal(result.exitCode, 0);
  assert.equal(result.signal, null);
  assert.equal(result.timedOut, false);
  assert.equal(result.stdout?.length, outputSize);
  assert.equal(result.stderr?.length, outputSize);
});

void test("Codex process runnerはstdin送信失敗後もclose済みの出力を返す", async (context) => {
  if (process.env["CODEX_SANDBOX_NETWORK_DISABLED"] === "1") {
    context.skip("この実行環境ではsubprocessのstdioが隔離されています");
    return;
  }
  const path = process.env["PATH"];
  assert.ok(path);
  let result;
  try {
    result = await runCodexProcess({
      command: process.execPath,
      arguments: [
        "-e",
        'const fs = require("node:fs"); fs.closeSync(0); process.stdout.write("child stdout"); process.stderr.write("child stderr");',
      ],
      workingDirectory: process.cwd(),
      environment: { PATH: path },
      standardInput: "x".repeat(8 * 1024 * 1024),
      timeoutMilliseconds: 10_000,
    });
  } catch (error: unknown) {
    if (error != null && typeof error === "object" && "code" in error && error.code === "EPERM") {
      context.skip("この実行環境ではsubprocessが許可されていません");
      return;
    }
    throw error;
  }

  assert.equal(result.exitCode, 0);
  assert.equal(result.signal, null);
  assert.equal(result.timedOut, false);
  assert.equal(result.stdout, "child stdout");
  assert.equal(result.stderr, "child stderr");
  const standardInputError = result.standardInputError;
  assert.ok(standardInputError instanceof Error);
  assert.ok("code" in standardInputError);
  assert.equal(standardInputError.code, "EPIPE");
});
