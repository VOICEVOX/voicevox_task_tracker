import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { StateVerificationRunner, verifyPersistentStateDirectory } from "../src/cli/index.js";
import {
  createEmptyStateNotificationLedger,
  createStateHistoryRecord,
  createStateSnapshot,
  serializeCanonicalJsonLine,
  type StateSnapshot,
} from "../src/persistence/index.js";

const GENERATED_AT = "2026-08-01T00:00:00.000Z";

function createEmptySnapshot(): StateSnapshot {
  return createStateSnapshot({
    schemaVersion: "7",
    generatedAt: GENERATED_AT,
    trackingStartAt: {
      status: "fixed",
      value: GENERATED_AT,
      source: "first_complete_run",
    },
    ai: {
      enabled: false,
      available: false,
      degraded: false,
    },
    collection: {
      repositories: [],
    },
    repositories: [],
    items: [],
    externalReferences: [],
    relations: [],
    run: {
      id: "verify-state-fixture",
      status: "success",
      complete: true,
    },
  });
}

async function createMigratableStateDirectory(): Promise<string> {
  const stateDirectory = await mkdtemp(join(tmpdir(), "voicevox-verify-state-test-"));
  const historyDirectory = join(stateDirectory, "history");
  await mkdir(historyDirectory);

  const snapshot = createEmptySnapshot();
  const ledger = createEmptyStateNotificationLedger();
  const historyRecord = createStateHistoryRecord(
    undefined,
    snapshot,
    GENERATED_AT.slice(0, 10),
    [],
    [],
  );
  await Promise.all([
    writeFile(
      join(stateDirectory, "snapshot.json"),
      serializeCanonicalJsonLine({
        ...snapshot,
        schemaVersion: "6",
      }),
      "utf8",
    ),
    writeFile(
      join(stateDirectory, "notification-ledger.json"),
      serializeCanonicalJsonLine({
        ...ledger,
        schemaVersion: "1",
      }),
      "utf8",
    ),
    writeFile(
      join(historyDirectory, `${GENERATED_AT.slice(0, 10)}.jsonl`),
      serializeCanonicalJsonLine({
        ...historyRecord,
        schemaVersion: "1",
      }),
      "utf8",
    ),
  ]);
  return stateDirectory;
}

describe("永続state検証", () => {
  it("snapshot、通知ledger、履歴を現行versionへ移行して件数を返す", async () => {
    const stateDirectory = await createMigratableStateDirectory();
    try {
      const result = await verifyPersistentStateDirectory(stateDirectory);

      expect(result).toEqual({
        snapshot: {
          verifiedCount: 1,
          sourceSchemaVersions: ["6"],
          migratedSchemaVersions: ["7"],
        },
        notificationLedger: {
          verifiedCount: 1,
          sourceSchemaVersions: ["1"],
          migratedSchemaVersions: ["2"],
        },
        history: {
          verifiedCount: 1,
          sourceSchemaVersions: ["1"],
          migratedSchemaVersions: ["2"],
        },
      });
    } finally {
      await rm(stateDirectory, {
        recursive: true,
        force: true,
      });
    }
  });

  it("文書ごとの件数と移行前後のschema versionを標準出力へ書く", async () => {
    const stateDirectory = await createMigratableStateDirectory();
    const outputs: string[] = [];
    const runner = new StateVerificationRunner({
      verifyStateDirectory: verifyPersistentStateDirectory,
      writeStandardOutput: (source) => {
        outputs.push(source);
        return Promise.resolve();
      },
    });
    try {
      await runner.run({
        kind: "verify-state",
        stateDirectory,
      });

      expect(outputs).toEqual([
        [
          "snapshot: 1件、schema version 6 -> 7",
          "notification ledger: 1件、schema version 1 -> 2",
          "history: 1件、schema version 1 -> 2",
          "",
        ].join("\n"),
      ]);
    } finally {
      await rm(stateDirectory, {
        recursive: true,
        force: true,
      });
    }
  });

  it("必要な永続state文書がなければ失敗する", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "voicevox-verify-state-missing-test-"));
    try {
      await expect(verifyPersistentStateDirectory(stateDirectory)).rejects.toThrow(
        "永続stateを検証できません",
      );
    } finally {
      await rm(stateDirectory, {
        recursive: true,
        force: true,
      });
    }
  });
});
