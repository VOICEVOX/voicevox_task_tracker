import { describe, expect, it } from "vitest";
import { z } from "zod";

import snapshotSchema from "../schemas/snapshot.schema.json" with { type: "json" };
import { SNAPSHOT_SCHEMA_VERSION_8 } from "../src/persistence/snapshot.js";
import { SNAPSHOT_SCHEMA_ENUM_LOCK } from "./state-schema-enum-lock.js";

const LOCK_UPDATE_INSTRUCTIONS = [
  "永続stateの列挙値またはschema versionがロック定義と一致しません。",
  "対象文書のschema versionを上げてマイグレーションを追加し、その後にロック定義を更新してください。",
  "ロック定義: tests/state-schema-enum-lock.ts",
].join("\n");

const snapshotPersistentEnumsSchema = z.object({
  properties: z.object({
    schemaVersion: z.object({
      const: z.string(),
    }),
  }),
  $defs: z.object({
    item: z.object({
      properties: z.object({
        status: z.object({
          enum: z.array(z.string()).min(1),
        }),
        severityContext: z.object({
          properties: z.object({
            waitClass: z.object({
              enum: z.array(z.string()).min(1),
            }),
          }),
        }),
      }),
    }),
  }),
});

function parseSnapshotPersistentEnums(): z.output<typeof snapshotPersistentEnumsSchema> {
  const result = snapshotPersistentEnumsSchema.safeParse(snapshotSchema);
  if (!result.success) {
    throw new TypeError(LOCK_UPDATE_INSTRUCTIONS, {
      cause: result.error,
    });
  }
  return result.data;
}

describe("snapshotの列挙値ロック", () => {
  it("現行schema versionと永続化する列挙値をロック定義に一致させる", () => {
    const snapshotDefinition = parseSnapshotPersistentEnums();
    expect(snapshotDefinition.properties.schemaVersion.const, LOCK_UPDATE_INSTRUCTIONS).toBe(
      SNAPSHOT_SCHEMA_VERSION_8,
    );

    const actual = {
      schemaVersion: SNAPSHOT_SCHEMA_VERSION_8,
      Status: snapshotDefinition.$defs.item.properties.status.enum,
      WaitClass: snapshotDefinition.$defs.item.properties.severityContext.properties.waitClass.enum,
    };

    expect(actual, LOCK_UPDATE_INSTRUCTIONS).toEqual(SNAPSHOT_SCHEMA_ENUM_LOCK);
  });
});
