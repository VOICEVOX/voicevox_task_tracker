import { strict as assert } from "node:assert";
import { readFile, rm, stat, truncate, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { z } from "zod";

import {
  createDiagnosticsRecorder,
  DIAGNOSTICS_MAX_BYTES,
  DiagnosticsValidationError,
  DiagnosticsRecorderError,
} from "./index.js";

async function withTemporaryDirectory(action: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "voicevox-diagnostics-recorder-test-"));
  try {
    await action(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

void test("recorderは受付順sequenceのJSONLをmode600で保存する", async () => {
  await withTemporaryDirectory(async (directory) => {
    const path = join(directory, "diagnostics.jsonl");
    const recorder = await createDiagnosticsRecorder({ path });
    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        recorder.append({
          event: `event-${index.toString()}`,
          details: { index },
          recordedAt: "2026-09-01T00:00:00.000Z",
        }),
      ),
    );
    await recorder.close();

    const recordSchema = z.object({ sequence: z.number() });
    const records = (await readFile(path, "utf8"))
      .trimEnd()
      .split("\n")
      .map((line) => recordSchema.parse(JSON.parse(line)));
    assert.deepEqual(
      records.map((record) => record.sequence),
      Array.from({ length: 20 }, (_, index) => index),
    );
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  });
});

void test("recorderは既存sequenceの続きへ追記する", async () => {
  await withTemporaryDirectory(async (directory) => {
    const path = join(directory, "diagnostics.jsonl");
    const recorder = await createDiagnosticsRecorder({ path });
    await recorder.append({ event: "first", recordedAt: "2026-09-01T00:00:00.000Z" });
    await recorder.close();
    const nextRecorder = await createDiagnosticsRecorder({ path });
    await nextRecorder.append({ event: "second", recordedAt: "2026-09-01T00:00:01.000Z" });
    await nextRecorder.close();

    const sequences = (await readFile(path, "utf8"))
      .trimEnd()
      .split("\n")
      .map((line) => z.object({ sequence: z.number() }).parse(JSON.parse(line)))
      .map((record) => record.sequence);
    assert.deepEqual(sequences, [0, 1]);
  });
});

void test("recorderは64MiBを超えるファイルを開かない", async () => {
  await withTemporaryDirectory(async (directory) => {
    const path = join(directory, "diagnostics.jsonl");
    await writeFile(path, "", { encoding: "utf8", mode: 0o600 });
    await truncate(path, DIAGNOSTICS_MAX_BYTES);
    await assert.rejects(createDiagnosticsRecorder({ path }), DiagnosticsRecorderError);
  });
});

void test("recorderはappend呼び出し時のrecordを保存する", async () => {
  await withTemporaryDirectory(async (directory) => {
    const path = join(directory, "diagnostics.jsonl");
    const recorder = await createDiagnosticsRecorder({ path });
    const details = { nested: { value: "before" } };
    const appendPromise = recorder.append({
      event: "snapshot",
      details,
      recordedAt: "2026-09-01T00:00:00.000Z",
    });
    details.nested.value = "after";
    await appendPromise;
    await recorder.close();

    const record = z
      .object({
        details: z.strictObject({
          nested: z.strictObject({ value: z.string() }),
        }),
      })
      .parse(JSON.parse((await readFile(path, "utf8")).trim()));
    assert.equal(record.details.nested.value, "before");
  });
});

void test("recorderは疎配列をdetailsとして受け付けない", async () => {
  await withTemporaryDirectory(async (directory) => {
    const path = join(directory, "diagnostics.jsonl");
    const recorder = await createDiagnosticsRecorder({ path });
    const sparse: unknown[] = [];
    sparse.length = 1;
    await assert.rejects(
      recorder.append({
        event: "sparse",
        details: { sparse },
        recordedAt: "2026-09-01T00:00:00.000Z",
      }),
      DiagnosticsValidationError,
    );
    await assert.rejects(recorder.close(), DiagnosticsValidationError);
  });
});

void test("recorderはJSON値でないdetailsを受け付けない", async () => {
  const cyclic: Record<string, unknown> = {};
  cyclic["self"] = cyclic;
  const invalidDetails: Readonly<Record<string, unknown>>[] = [
    { value: undefined },
    { value: Number.NaN },
    { value: Number.POSITIVE_INFINITY },
    { value: BigInt(1) },
    { value: new Date("2026-09-01T00:00:00.000Z") },
    cyclic,
  ];
  await withTemporaryDirectory(async (directory) => {
    for (const [index, details] of invalidDetails.entries()) {
      const path = join(directory, `invalid-details-${index.toString()}.jsonl`);
      const recorder = await createDiagnosticsRecorder({ path });
      await assert.rejects(
        recorder.append({
          event: "invalid-details",
          details,
          recordedAt: "2026-09-01T00:00:00.000Z",
        }),
        DiagnosticsValidationError,
      );
      await assert.rejects(recorder.close(), DiagnosticsValidationError);
    }
  });
});

void test("recorderはerrorのundefinedをunknownとして保存する", async () => {
  await withTemporaryDirectory(async (directory) => {
    const path = join(directory, "undefined-error.jsonl");
    const recorder = await createDiagnosticsRecorder({ path });
    await recorder.append({
      event: "undefined-error",
      error: undefined,
      recordedAt: "2026-09-01T00:00:00.000Z",
    });
    await recorder.close();
    const record = z
      .object({
        error: z.object({
          kind: z.literal("unknown"),
          type: z.literal("undefined"),
          value: z.literal("undefined"),
        }),
      })
      .parse(JSON.parse((await readFile(path, "utf8")).trim()));
    assert.deepEqual(record.error, { kind: "unknown", type: "undefined", value: "undefined" });
  });
});

void test("recorderの再openはrecordedAtとserialized error schemaを検証する", async () => {
  await withTemporaryDirectory(async (directory) => {
    const invalidRecords = [
      {
        sequence: 0,
        recordedAt: "2026-09-01",
        event: "invalid-recordedAt",
      },
      {
        sequence: 0,
        recordedAt: "2026-09-01T00:00:00.000Z",
        event: "invalid-error",
        error: { name: "Error" },
      },
    ];
    for (const [index, record] of invalidRecords.entries()) {
      const path = join(directory, `invalid-${index.toString()}.jsonl`);
      await writeFile(path, `${JSON.stringify(record)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      await assert.rejects(createDiagnosticsRecorder({ path }), DiagnosticsRecorderError);
    }
  });
});
