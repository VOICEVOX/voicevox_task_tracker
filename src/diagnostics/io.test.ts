import { strict as assert } from "node:assert";
import { open, rm } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { DiagnosticsError } from "./errors.js";
import { writeDiagnosticsBufferFully } from "./io.js";

async function withTemporaryDirectory(action: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "voicevox-diagnostics-io-test-"));
  try {
    await action(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

void test("FileHandleへの短いwriteを完全な書き込みまで繰り返す", async () => {
  await withTemporaryDirectory(async (directory) => {
    const path = join(directory, "diagnostics.bin");
    const handle = await open(path, "w", 0o600);
    const originalClose = handle.close.bind(handle);
    const writes: Readonly<{ offset: number; length: number }>[] = [];
    Object.defineProperty(handle, "write", {
      value: (
        data: Uint8Array,
        offset: number,
        length: number,
      ): Promise<{ bytesWritten: number; buffer: Uint8Array }> => {
        writes.push({ offset, length });
        return Promise.resolve({ bytesWritten: Math.min(2, length), buffer: data });
      },
      configurable: true,
      writable: true,
    });
    try {
      await writeDiagnosticsBufferFully(handle, Buffer.from("abcdef"), "書き込めません");
      assert.deepEqual(writes, [
        { offset: 0, length: 6 },
        { offset: 2, length: 4 },
        { offset: 4, length: 2 },
      ]);
    } finally {
      Reflect.deleteProperty(handle, "write");
      await originalClose();
    }
  });
});

void test("FileHandleの0byte writeを拒否する", async () => {
  await withTemporaryDirectory(async (directory) => {
    const path = join(directory, "diagnostics.bin");
    const handle = await open(path, "w", 0o600);
    const originalClose = handle.close.bind(handle);
    Object.defineProperty(handle, "write", {
      value: (
        data: Uint8Array,
        offset: number,
        length: number,
      ): Promise<{ bytesWritten: number; buffer: Uint8Array }> => (
        void offset,
        void length,
        Promise.resolve({ bytesWritten: 0, buffer: data })
      ),
      configurable: true,
      writable: true,
    });
    try {
      await assert.rejects(
        writeDiagnosticsBufferFully(handle, Buffer.from("a"), "書き込めません"),
        DiagnosticsError,
      );
    } finally {
      Reflect.deleteProperty(handle, "write");
      await originalClose();
    }
  });
});
