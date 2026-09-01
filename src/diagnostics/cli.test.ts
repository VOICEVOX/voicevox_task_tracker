import { strict as assert } from "node:assert";
import { chmod, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  DIAGNOSTICS_KEY_ENVIRONMENT_VARIABLE,
  DiagnosticsCliUsageError,
  runDiagnosticsCli,
} from "./index.js";

const TEST_KEY_BASE64 = Buffer.alloc(32, 0x41).toString("base64");

async function withTemporaryDirectory(action: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "voicevox-diagnostics-cli-test-"));
  try {
    await action(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

void test("CLIは固定環境変数で暗号化しkey-fileで復号する", async () => {
  await withTemporaryDirectory(async (directory) => {
    const inputPath = join(directory, "diagnostics.jsonl");
    const encryptedPath = join(directory, "diagnostics.bundle");
    const outputPath = join(directory, "diagnostics.decrypted.jsonl");
    const keyPath = join(directory, "diagnostics.key");
    await writeFile(inputPath, "diagnostic\n", { encoding: "utf8" });
    await writeFile(keyPath, `${TEST_KEY_BASE64}\n`, { encoding: "utf8", mode: 0o600 });

    const environment: NodeJS.ProcessEnv = {
      [DIAGNOSTICS_KEY_ENVIRONMENT_VARIABLE]: TEST_KEY_BASE64,
    };
    assert.equal(
      await runDiagnosticsCli(
        [
          "encrypt",
          "--input",
          inputPath,
          "--output",
          encryptedPath,
          "--run-id",
          "run",
          "--run-attempt",
          "1",
          "--job",
          "collect-analyze",
          "--invocation-id",
          "invocation",
        ],
        environment,
      ),
      0,
    );
    const insecureKeyPath = join(directory, "diagnostics.insecure.key");
    await writeFile(insecureKeyPath, `${TEST_KEY_BASE64}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await chmod(insecureKeyPath, 0o640);
    await assert.rejects(
      runDiagnosticsCli(
        [
          "decrypt",
          "--key-file",
          insecureKeyPath,
          "--input",
          encryptedPath,
          "--output",
          outputPath,
        ],
        {},
      ),
      DiagnosticsCliUsageError,
    );
    const oversizedKeyPath = join(directory, "diagnostics.oversized.key");
    await writeFile(oversizedKeyPath, Buffer.alloc(5000, 0x41), {
      mode: 0o600,
    });
    await assert.rejects(
      runDiagnosticsCli(
        [
          "decrypt",
          "--key-file",
          oversizedKeyPath,
          "--input",
          encryptedPath,
          "--output",
          outputPath,
        ],
        {},
      ),
      DiagnosticsCliUsageError,
    );
    const symlinkKeyPath = join(directory, "diagnostics.symlink.key");
    await symlink(keyPath, symlinkKeyPath);
    await assert.rejects(
      runDiagnosticsCli(
        ["decrypt", "--key-file", symlinkKeyPath, "--input", encryptedPath, "--output", outputPath],
        {},
      ),
      DiagnosticsCliUsageError,
    );
    assert.equal(
      await runDiagnosticsCli(
        ["decrypt", "--key-file", keyPath, "--input", encryptedPath, "--output", outputPath],
        {},
      ),
      0,
    );
    assert.equal(await readFile(outputPath, "utf8"), "diagnostic\n");
  });
});
