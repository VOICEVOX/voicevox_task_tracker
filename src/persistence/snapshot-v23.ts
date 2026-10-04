import { Ajv2020 } from "ajv/dist/2020.js";
import { z } from "zod";

import snapshotSchema from "../../schemas/snapshot-v23.schema.json" with { type: "json" };
import { serializeCanonicalJsonLine } from "../canonical-json/index.js";
import type { Evidence, GraphNodeId, TrackedItemState } from "../domain/types.js";
import type { SourceId } from "../domain/source-id.js";
import {
  normalizeVerifiedExternalReferences,
  type VerifiedExternalReference,
} from "../domain/verified-external-reference.js";
import {
  StateFormatError,
  StateSnapshotSchemaError,
  StateSnapshotSemanticError,
} from "./errors.js";
import {
  assertPersonalReminderEvidenceClosure as assertVersion22EvidenceClosure,
  assertPersonalReminderEvidenceRecordsClosure as assertVersion22EvidenceRecordsClosure,
  createStateSnapshot as createVersion22Snapshot,
  parseStateSnapshot as parseVersion22Snapshot,
  serializeStateSnapshot as serializeVersion22Snapshot,
  snapshotEffectiveGraphStateByNodeId as version22EffectiveGraphStateByNodeId,
  version19SnapshotFields as version22ToVersion19Fields,
  type StateSnapshot as StateSnapshotVersion22,
} from "./snapshot-v22.js";

/** tracker-stateへ保存するschema version 23のcurrent snapshot。 */
export type StateSnapshot = Omit<StateSnapshotVersion22, "schemaVersion"> &
  Readonly<{
    schemaVersion: "23";
    verifiedExternalReferences: readonly VerifiedExternalReference[];
  }>;

const snapshotVersionSchema = z.object({ schemaVersion: z.literal("23") });
const ajv = new Ajv2020({
  allErrors: true,
  coerceTypes: false,
  removeAdditional: false,
  strict: true,
  useDefaults: false,
});
ajv.addFormat("date-time", {
  type: "string",
  validate: (value: string) =>
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(value) &&
    !Number.isNaN(Date.parse(value)),
});
const validateSnapshotSchema = ajv.compile<StateSnapshot>(snapshotSchema);

function version22Projection(snapshot: StateSnapshot): StateSnapshotVersion22 {
  const { schemaVersion, verifiedExternalReferences, ...fields } = snapshot;
  void schemaVersion;
  void verifiedExternalReferences;
  return Object.freeze({ ...fields, schemaVersion: "22" });
}

function assertExternalReferenceProof(snapshot: StateSnapshot): void {
  const proofs = new Map(
    snapshot.verifiedExternalReferences.map((reference) => [
      reference.url.toLowerCase(),
      reference,
    ]),
  );
  for (const reference of snapshot.externalReferences) {
    const proof = proofs.get(reference.url.toLowerCase());
    if (
      proof?.repositoryFullName.toLowerCase() !== reference.repositoryFullName.toLowerCase() ||
      proof.number !== reference.number
    ) {
      throw new StateSnapshotSemanticError("外部graph参照に対応する公開確認済み項目がありません");
    }
  }
}

/** 未検証値を現行snapshotのschemaと公開参照契約で検証する。 */
export function createStateSnapshot(value: unknown): StateSnapshot {
  snapshotVersionSchema.parse(value);
  if (!validateSnapshotSchema(value)) {
    throw new StateSnapshotSchemaError(validateSnapshotSchema.errors?.length ?? 1);
  }
  const base = createVersion22Snapshot(version22Projection(value));
  const verifiedExternalReferences = normalizeVerifiedExternalReferences(
    value.verifiedExternalReferences,
  );
  const snapshot = Object.freeze({
    ...base,
    schemaVersion: "23",
    verifiedExternalReferences,
  } satisfies StateSnapshot);
  assertExternalReferenceProof(snapshot);
  return snapshot;
}

/** 現行snapshotを末尾改行付きcanonical JSONへ変換する。 */
export function serializeStateSnapshot(snapshot: StateSnapshot): string {
  const validated = createStateSnapshot(snapshot);
  serializeVersion22Snapshot(version22Projection(validated));
  return serializeCanonicalJsonLine(validated);
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
  const snapshot = createStateSnapshot(value);
  parseVersion22Snapshot(serializeCanonicalJsonLine(version22Projection(snapshot)));
  return snapshot;
}

/** 旧schemaの共通保存値だけを取り出す。 */
export function version19SnapshotFields(
  snapshot: StateSnapshot,
): ReturnType<typeof version22ToVersion19Fields> {
  return version22ToVersion19Fields(version22Projection(snapshot));
}

/** 保存済み公開投影のeffective graph状態を返す。 */
export function snapshotEffectiveGraphStateByNodeId(
  snapshot: StateSnapshot,
): ReadonlyMap<GraphNodeId, TrackedItemState> {
  return version22EffectiveGraphStateByNodeId(version22Projection(snapshot));
}

/** 個人催促のEvidence参照が現行snapshot内で閉じていることを検証する。 */
export function assertPersonalReminderEvidenceClosure(snapshot: StateSnapshot): void {
  assertVersion22EvidenceClosure(version22Projection(snapshot));
}

/** 個人催促のEvidence recordを現行snapshot内で照合する。 */
export function assertPersonalReminderEvidenceRecordsClosure(
  snapshot: StateSnapshot,
  expectedEvidenceBySourceId: ReadonlyMap<SourceId, readonly Evidence[]>,
): void {
  assertVersion22EvidenceRecordsClosure(version22Projection(snapshot), expectedEvidenceBySourceId);
}
