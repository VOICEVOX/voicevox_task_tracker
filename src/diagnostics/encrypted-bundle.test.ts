import { strict as assert } from "node:assert";
import { readFile, readdir, readlink, rm, stat, truncate, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  DIAGNOSTICS_HEADER_LENGTH_BYTES,
  DIAGNOSTICS_ALGORITHM,
  DIAGNOSTICS_BUNDLE_SCHEMA_VERSION,
  DIAGNOSTICS_FORMAT_VERSION,
  DIAGNOSTICS_MAX_BYTES,
  DIAGNOSTICS_MAGIC,
  decryptDiagnosticsBundle,
  DiagnosticsFormatError,
  DiagnosticsOutputExistsError,
  DiagnosticsValidationError,
  encryptDiagnosticsBundle,
  parseDiagnosticsBundleHeader,
  readDiagnosticsBundleHeader,
} from "./index.js";

const TEST_KEY_BASE64 = Buffer.alloc(32, 0x41).toString("base64");
const OTHER_TEST_KEY_BASE64 = Buffer.alloc(32, 0x42).toString("base64");

async function withTemporaryDirectory(action: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "voicevox-diagnostics-test-"));
  try {
    await action(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function hasOpenDescriptor(path: string): Promise<boolean> {
  if (process.platform !== "linux") {
    return false;
  }
  const descriptors = await readdir("/proc/self/fd");
  for (const descriptor of descriptors) {
    try {
      const target = await readlink(join("/proc/self/fd", descriptor));
      if (target === path || target === `${path} (deleted)`) {
        return true;
      }
    } catch (error: unknown) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        throw error;
      }
    }
  }
  return false;
}

function encryptionInput(
  inputPath: string,
  outputPath: string,
): Parameters<typeof encryptDiagnosticsBundle>[0] {
  return {
    inputPath,
    outputPath,
    keyBase64: TEST_KEY_BASE64,
    runId: "run-2026-09-01",
    runAttempt: 2,
    job: "collect-analyze",
    invocationId: "invocation-1",
  };
}

void test("bundleSchemaVersionは現行versionだけを受け付ける", () => {
  assert.throws(
    () =>
      parseDiagnosticsBundleHeader({
        formatVersion: DIAGNOSTICS_FORMAT_VERSION,
        bundleSchemaVersion: DIAGNOSTICS_BUNDLE_SCHEMA_VERSION + 1,
        algorithm: DIAGNOSTICS_ALGORITHM,
        nonce: Buffer.alloc(12).toString("base64"),
        keyId: "0".repeat(64),
        runId: "run",
        runAttempt: 1,
        job: "job",
        invocationId: "invocation",
      }),
    DiagnosticsFormatError,
  );
});

void test("diagnosticsバンドルをストリーム暗号化して復号できる", async () => {
  await withTemporaryDirectory(async (directory) => {
    const inputPath = join(directory, "diagnostics.jsonl");
    const encryptedPath = join(directory, "diagnostics.bundle");
    const decryptedPath = join(directory, "diagnostics.decrypted.jsonl");
    const source = `${JSON.stringify({ sequence: 0, event: "failure" })}\n`;
    await writeFile(inputPath, source, { encoding: "utf8", mode: 0o600 });

    const header = await encryptDiagnosticsBundle(encryptionInput(inputPath, encryptedPath));
    assert.equal(header.algorithm, "aes-256-gcm");
    assert.equal(header.runAttempt, 2);
    assert.deepEqual(await readDiagnosticsBundleHeader(encryptedPath), header);
    const encrypted = await readFile(encryptedPath);
    assert.equal(encrypted.includes(Buffer.from(source)), false);

    const decryptedHeader = await decryptDiagnosticsBundle({
      inputPath: encryptedPath,
      outputPath: decryptedPath,
      keyBase64: TEST_KEY_BASE64,
    });
    assert.deepEqual(decryptedHeader, header);
    assert.equal(await readFile(decryptedPath, "utf8"), source);
    assert.equal(await readFile(inputPath, "utf8"), source);
  });
});

void test("既存出力を暗号化で上書きしない", async () => {
  await withTemporaryDirectory(async (directory) => {
    const inputPath = join(directory, "diagnostics.jsonl");
    const outputPath = join(directory, "diagnostics.bundle");
    await writeFile(inputPath, "source\n", { encoding: "utf8" });
    await writeFile(outputPath, "existing\n", { encoding: "utf8" });

    await assert.rejects(
      encryptDiagnosticsBundle(encryptionInput(inputPath, outputPath)),
      DiagnosticsOutputExistsError,
    );
    assert.equal(await readFile(outputPath, "utf8"), "existing\n");
  });
});

void test("暗号化中に作られた出力を原子的に上書きしない", async () => {
  await withTemporaryDirectory(async (directory) => {
    const inputPath = join(directory, "diagnostics.jsonl");
    const outputPath = join(directory, "diagnostics.bundle");
    const partialPath = `${outputPath}.partial`;
    await writeFile(inputPath, Buffer.alloc(8 * 1024 * 1024, 0x53), { mode: 0o600 });

    const encryption = encryptDiagnosticsBundle(encryptionInput(inputPath, outputPath));
    let partialObserved = false;
    for (let attempt = 0; attempt < 1000; attempt += 1) {
      try {
        await stat(partialPath);
        partialObserved = true;
        break;
      } catch (error: unknown) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
          throw error;
        }
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }
    assert.equal(partialObserved, true);
    await writeFile(outputPath, "existing\n", { encoding: "utf8", mode: 0o600 });

    await assert.rejects(encryption, DiagnosticsOutputExistsError);
    assert.equal(await readFile(outputPath, "utf8"), "existing\n");
    await assert.rejects(stat(partialPath));
  });
});

void test("暗号化入力が64MiBを超えたらストリーム中に拒否する", async () => {
  await withTemporaryDirectory(async (directory) => {
    const inputPath = join(directory, "diagnostics.jsonl");
    const outputPath = join(directory, "diagnostics.bundle");
    await writeFile(inputPath, "", { encoding: "utf8", mode: 0o600 });
    await truncate(inputPath, DIAGNOSTICS_MAX_BYTES + 1);

    await assert.rejects(
      encryptDiagnosticsBundle(encryptionInput(inputPath, outputPath)),
      DiagnosticsValidationError,
    );
    await assert.rejects(stat(outputPath));
    await assert.rejects(stat(`${outputPath}.partial`));
    assert.equal(await hasOpenDescriptor(`${outputPath}.partial`), false);
  });
});

void test("復号開始前に64MiBを超える暗号文を拒否する", async () => {
  await withTemporaryDirectory(async (directory) => {
    const inputPath = join(directory, "diagnostics.jsonl");
    const encryptedPath = join(directory, "diagnostics.bundle");
    const decryptedPath = join(directory, "diagnostics.decrypted.jsonl");
    await writeFile(inputPath, "source\n", { encoding: "utf8" });
    await encryptDiagnosticsBundle(encryptionInput(inputPath, encryptedPath));
    const encryptedStatistics = await stat(encryptedPath);
    await truncate(encryptedPath, encryptedStatistics.size + DIAGNOSTICS_MAX_BYTES + 1);

    await assert.rejects(
      decryptDiagnosticsBundle({
        inputPath: encryptedPath,
        outputPath: decryptedPath,
        keyBase64: TEST_KEY_BASE64,
      }),
      DiagnosticsFormatError,
    );
    await assert.rejects(stat(decryptedPath));
    await assert.rejects(stat(`${decryptedPath}.partial`));
  });
});

void test("header改ざんを検出してpartial平文を削除する", async () => {
  await withTemporaryDirectory(async (directory) => {
    const inputPath = join(directory, "diagnostics.jsonl");
    const encryptedPath = join(directory, "diagnostics.bundle");
    const decryptedPath = join(directory, "diagnostics.decrypted.jsonl");
    await writeFile(inputPath, "sensitive diagnostic\n", { encoding: "utf8" });
    await encryptDiagnosticsBundle(encryptionInput(inputPath, encryptedPath));

    const encrypted = await readFile(encryptedPath);
    const headerStart = DIAGNOSTICS_MAGIC.byteLength + DIAGNOSTICS_HEADER_LENGTH_BYTES;
    const runIdMarker = Buffer.from('"runId":"run-2026-09-01"', "utf8");
    const markerIndex = encrypted.indexOf(runIdMarker, headerStart);
    if (markerIndex < 0) {
      throw new Error("header内にrunIdがありません");
    }
    const runIdValueIndex = markerIndex + Buffer.byteLength('"runId":"', "utf8");
    const headerByte = encrypted.at(runIdValueIndex);
    if (headerByte == null) {
      throw new Error("headerのrunIdが空です");
    }
    encrypted[runIdValueIndex] = headerByte === 0x72 ? 0x73 : 0x72;
    await writeFile(encryptedPath, encrypted);
    await assert.rejects(
      decryptDiagnosticsBundle({
        inputPath: encryptedPath,
        outputPath: decryptedPath,
        keyBase64: TEST_KEY_BASE64,
      }),
      DiagnosticsFormatError,
    );
    await assert.rejects(stat(decryptedPath));
    await assert.rejects(stat(`${decryptedPath}.partial`));
  });
});

void test("途中切断を検出してpartial平文を削除する", async () => {
  await withTemporaryDirectory(async (directory) => {
    const inputPath = join(directory, "diagnostics.jsonl");
    const encryptedPath = join(directory, "diagnostics.bundle");
    const decryptedPath = join(directory, "diagnostics.decrypted.jsonl");
    await writeFile(inputPath, "sensitive diagnostic\n", { encoding: "utf8" });
    await encryptDiagnosticsBundle(encryptionInput(inputPath, encryptedPath));

    const encrypted = await readFile(encryptedPath);
    await writeFile(encryptedPath, encrypted.subarray(0, encrypted.length - 1));
    await assert.rejects(
      decryptDiagnosticsBundle({
        inputPath: encryptedPath,
        outputPath: decryptedPath,
        keyBase64: TEST_KEY_BASE64,
      }),
      DiagnosticsFormatError,
    );
    await assert.rejects(stat(decryptedPath));
    await assert.rejects(stat(`${decryptedPath}.partial`));
  });
});

void test("認証タグ改ざんを検出してpartial平文を削除する", async () => {
  await withTemporaryDirectory(async (directory) => {
    const inputPath = join(directory, "diagnostics.jsonl");
    const encryptedPath = join(directory, "diagnostics.bundle");
    const decryptedPath = join(directory, "diagnostics.decrypted.jsonl");
    await writeFile(inputPath, "sensitive diagnostic\n", { encoding: "utf8" });
    await encryptDiagnosticsBundle(encryptionInput(inputPath, encryptedPath));

    const encrypted = await readFile(encryptedPath);
    const tagByte = encrypted.at(-1);
    if (tagByte == null) {
      throw new Error("認証タグがありません");
    }
    encrypted[encrypted.length - 1] = tagByte ^ 1;
    await writeFile(encryptedPath, encrypted);
    await assert.rejects(
      decryptDiagnosticsBundle({
        inputPath: encryptedPath,
        outputPath: decryptedPath,
        keyBase64: TEST_KEY_BASE64,
      }),
      DiagnosticsFormatError,
    );
    await assert.rejects(stat(decryptedPath));
    await assert.rejects(stat(`${decryptedPath}.partial`));
  });
});

void test("復号鍵の識別子が違う場合は出力を作らない", async () => {
  await withTemporaryDirectory(async (directory) => {
    const inputPath = join(directory, "diagnostics.jsonl");
    const encryptedPath = join(directory, "diagnostics.bundle");
    const decryptedPath = join(directory, "diagnostics.decrypted.jsonl");
    await writeFile(inputPath, "source\n", { encoding: "utf8" });
    await encryptDiagnosticsBundle(encryptionInput(inputPath, encryptedPath));

    await assert.rejects(
      decryptDiagnosticsBundle({
        inputPath: encryptedPath,
        outputPath: decryptedPath,
        keyBase64: OTHER_TEST_KEY_BASE64,
      }),
      DiagnosticsFormatError,
    );
    const names = await readdir(directory);
    assert.equal(names.includes("diagnostics.decrypted.jsonl"), false);
    assert.equal(names.includes("diagnostics.decrypted.jsonl.partial"), false);
  });
});
