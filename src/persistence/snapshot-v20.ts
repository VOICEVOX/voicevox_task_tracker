import type { StateSnapshot } from "./snapshot-v20-contracts.js";
import { Ajv2020 } from "ajv/dist/2020.js";
import { z } from "zod";

import snapshotSchema from "../../schemas/snapshot-v20.schema.json" with { type: "json" };
import snapshotVersion19Schema from "../../schemas/snapshot.schema.json" with { type: "json" };
import { serializeCanonicalJsonLine } from "../canonical-json/index.js";
import type { Evidence, GraphNodeId, SourceId, TrackedItemState } from "../domain/index.js";
import { StateFormatError, StateSnapshotSchemaError } from "./errors.js";
import type { StateSnapshot as StateSnapshotVersion19 } from "./snapshot-contracts.js";
import {
  assertPersonalReminderEvidenceClosure as assertVersion19PersonalReminderEvidenceClosure,
  assertPersonalReminderEvidenceRecordsClosure as assertVersion19PersonalReminderEvidenceRecordsClosure,
} from "./snapshot-evidence-closure.js";
import { assertFinalGraphProjectionSemantics } from "./snapshot-final-graph-validation.js";
import { createStateSnapshot as createVersion19Snapshot } from "./snapshot.js";

const snapshotVersionSchema = z.object({ schemaVersion: z.literal("20") });
const ajv = new Ajv2020({
  allErrors: true,
  coerceTypes: false,
  removeAdditional: false,
  strict: true,
  useDefaults: false,
});
ajv.addFormat("date-time", {
  type: "string",
  validate: (value: string) => {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(value)) {
      return false;
    }
    return !Number.isNaN(Date.parse(value));
  },
});
ajv.addSchema(snapshotVersion19Schema);
const validateSnapshotSchema = ajv.compile<StateSnapshot>(snapshotSchema);

/** 現行snapshotから旧版の共通保存値を取り出す。 */
export function version19SnapshotFields(snapshot: StateSnapshot): StateSnapshotVersion19 {
  const { finalGraphProjection, finalGraphProjectionDigest, ...fields } = snapshot;
  void finalGraphProjection;
  void finalGraphProjectionDigest;
  return createVersion19Snapshot({ ...fields, schemaVersion: "19" });
}

/** 未検証の値をschema検証済みの現行snapshotへ変換する。 */
export function createStateSnapshot(value: unknown): StateSnapshot {
  snapshotVersionSchema.parse(value);
  if (!validateSnapshotSchema(value)) {
    throw new StateSnapshotSchemaError(validateSnapshotSchema.errors?.length ?? 1);
  }
  const { finalGraphProjection, finalGraphProjectionDigest, ...fields } = value;
  const base = createVersion19Snapshot({ ...fields, schemaVersion: "19" });
  const snapshot = Object.freeze({
    ...base,
    schemaVersion: "20",
    finalGraphProjection,
    finalGraphProjectionDigest,
  } satisfies StateSnapshot);
  assertFinalGraphProjectionSemantics(snapshot);
  return snapshot;
}

/** 現行snapshotを末尾改行付きcanonical JSONへ変換する。 */
export function serializeStateSnapshot(snapshot: StateSnapshot): string {
  return serializeCanonicalJsonLine(createStateSnapshot(snapshot));
}

/** canonical JSONから現行snapshotを検証して読み取る。 */
export function parseStateSnapshot(source: string): StateSnapshot {
  let value: unknown;
  try {
    const parseJson: (text: string) => unknown = JSON.parse;
    value = parseJson(source);
  } catch (error: unknown) {
    throw new StateFormatError("snapshot", { cause: error });
  }
  return createStateSnapshot(value);
}

/** 保存済み公開投影に含まれるeffective graph状態を返す。 */
export function snapshotEffectiveGraphStateByNodeId(
  snapshot: StateSnapshot,
): ReadonlyMap<GraphNodeId, TrackedItemState> {
  const nodeIdByValue = new Map<string, GraphNodeId>([
    ...snapshot.items.map((item): [string, GraphNodeId] => [item.nodeId, item.nodeId]),
    ...snapshot.externalReferences.map((reference): [string, GraphNodeId] => [
      reference.nodeId,
      reference.nodeId,
    ]),
  ]);
  const states = new Map<GraphNodeId, TrackedItemState>();
  for (const node of snapshot.finalGraphProjection.nodes) {
    const nodeId = nodeIdByValue.get(node.nodeId);
    if (nodeId == null) {
      throw new StateSnapshotSchemaError(1);
    }
    states.set(nodeId, node.effectiveState);
  }
  return states;
}

/** personal reminderのEvidence参照が現行snapshot内で閉じていることを検証する。 */
export function assertPersonalReminderEvidenceClosure(snapshot: StateSnapshot): void {
  assertVersion19PersonalReminderEvidenceClosure(version19SnapshotFields(snapshot));
}

/** personal reminderのEvidence recordを現行snapshot内で照合する。 */
export function assertPersonalReminderEvidenceRecordsClosure(
  snapshot: StateSnapshot,
  expectedEvidenceBySourceId: ReadonlyMap<SourceId, readonly Evidence[]>,
): void {
  assertVersion19PersonalReminderEvidenceRecordsClosure(
    version19SnapshotFields(snapshot),
    expectedEvidenceBySourceId,
  );
}
