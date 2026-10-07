import { Ajv2020 } from "ajv/dist/2020.js";
import { z } from "zod";

import currentSnapshotSchema from "../../schemas/snapshot-v23.schema.json" with { type: "json" };
import snapshotSchema from "../../schemas/snapshot-v22.schema.json" with { type: "json" };
import { serializeCanonicalJsonLine } from "../canonical-json/index.js";
import type {
  PersonalReminderCause,
  PersonalReminderTimeBasis,
} from "../domain/personal-reminder-causes.js";
import { parseSourceId, type SourceId } from "../domain/source-id.js";
import type { Evidence, GraphNodeId, TrackedItemState } from "../domain/types.js";
import {
  StateFormatError,
  StateSnapshotSchemaError,
  StateSnapshotSemanticError,
} from "./errors.js";
import { normalizePersonalReminderCause } from "./snapshot-normalization.js";
import {
  assertPersonalReminderEvidenceClosure as assertVersion21EvidenceClosure,
  assertPersonalReminderEvidenceRecordsClosure as assertVersion21EvidenceRecordsClosure,
  createStateSnapshot as createVersion21Snapshot,
  createLegacyStateSnapshot as createLegacyVersion21Snapshot,
  snapshotEffectiveGraphStateByNodeId as version21EffectiveGraphStateByNodeId,
  version19SnapshotFields as version21ToVersion19Fields,
  type StateSnapshot as StateSnapshotVersion21,
} from "./snapshot-v21.js";

/** tracker-stateへ保存するschema version 22のcurrent snapshot。 */
export type StateSnapshot = Omit<StateSnapshotVersion21, "schemaVersion"> &
  Readonly<{ schemaVersion: "22" }>;

const snapshotVersionSchema = z.object({ schemaVersion: z.literal("22") });
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
const validateLegacySnapshotSchema = ajv.compile<StateSnapshot>(snapshotSchema);
const validateSnapshotSchema = ajv.compile<StateSnapshot>({
  ...snapshotSchema,
  $id: `${snapshotSchema.$id}/current-ai`,
  $defs: {
    ...snapshotSchema.$defs,
    trackedItemAiAnalysis: currentSnapshotSchema.$defs.trackedItemAiAnalysis,
  },
});

function version21Basis(basis: PersonalReminderTimeBasis): PersonalReminderTimeBasis {
  if (basis.source === "reconfirmation_pending" || basis.source === "reconfirmed_observation") {
    return Object.freeze({ source: "first_observation", at: basis.at });
  }
  return basis;
}

function version21Cause(cause: PersonalReminderCause): PersonalReminderCause {
  return Object.freeze({
    ...cause,
    obligationSince: version21Basis(cause.obligationSince),
    actionableClock:
      cause.actionableClock.status === "not_observed"
        ? cause.actionableClock
        : Object.freeze({
            ...cause.actionableClock,
            actionableSince: version21Basis(cause.actionableClock.actionableSince),
            stallSince: version21Basis(cause.actionableClock.stallSince),
            basis:
              cause.actionableClock.basis === "reconfirmed_observation"
                ? "first_observation"
                : cause.actionableClock.basis,
          }),
  });
}

function version21Projection(snapshot: StateSnapshot): StateSnapshotVersion21 {
  return Object.freeze({
    ...snapshot,
    schemaVersion: "21",
    items: Object.freeze(
      snapshot.items.map((item) =>
        Object.freeze({
          ...item,
          personalReminderCauses: Object.freeze(item.personalReminderCauses.map(version21Cause)),
        }),
      ),
    ),
  });
}

/** 保存する個人催促時計に未確定の再確認がないことを確認する。 */
export function assertNoPendingPersonalReminderClock(snapshot: Pick<StateSnapshot, "items">): void {
  for (const item of snapshot.items) {
    for (const cause of item.personalReminderCauses) {
      const bases = [
        cause.obligationSince,
        ...(cause.actionableClock.status === "observed"
          ? [cause.actionableClock.actionableSince, cause.actionableClock.stallSince]
          : []),
      ];
      if (bases.some((basis) => basis.source === "reconfirmation_pending")) {
        throw new StateSnapshotSemanticError(
          `個人催促時計の再確認が完了していません。item: ${item.nodeId} cause: ${cause.causeId}`,
        );
      }
    }
  }
}

function assertReconfirmedProvenance(snapshot: StateSnapshot): void {
  const relationsById = new Map(snapshot.relations.map((relation) => [relation.id, relation]));
  for (const item of snapshot.items) {
    for (const cause of item.personalReminderCauses) {
      const bases = [
        cause.obligationSince,
        ...(cause.actionableClock.status === "observed"
          ? [cause.actionableClock.actionableSince, cause.actionableClock.stallSince]
          : []),
      ];
      for (const basis of bases) {
        if (basis.source !== "reconfirmed_observation") continue;
        const previousAt = Date.parse(basis.previousAt);
        if (
          previousAt < Date.parse(item.createdAt) ||
          previousAt > Date.parse(basis.at) ||
          new Set(basis.sourceIds).size !== basis.sourceIds.length
        ) {
          throw new StateSnapshotSemanticError(
            `再確認した個人催促時計の監査値が不正です。item: ${item.nodeId} cause: ${cause.causeId}`,
          );
        }
        const ownerNodeIds = new Set<string>([
          item.nodeId,
          ...(cause.responsibility.scope.kind === "item"
            ? []
            : cause.responsibility.scope.surfaces.map((surface) => surface.nodeId)),
        ]);
        const relationIds =
          cause.adoptedAssessment.status === "available"
            ? cause.adoptedAssessment.result.references.relationIds
            : [];
        for (const relationId of relationIds) {
          const relation = relationsById.get(relationId);
          if (
            relation == null ||
            (relation.fromNodeId !== item.nodeId && relation.toNodeId !== item.nodeId)
          ) {
            throw new StateSnapshotSemanticError(
              `再確認した個人催促時計の関連項目が不正です。item: ${item.nodeId} cause: ${cause.causeId} relation: ${relationId}`,
            );
          }
          ownerNodeIds.add(relation.fromNodeId);
          ownerNodeIds.add(relation.toNodeId);
        }
        for (const sourceId of basis.sourceIds) {
          const source = parseSourceId(sourceId);
          if (
            source.kind === "github_pull_request_commit" &&
            ![...ownerNodeIds].some((nodeId) => source.originalId.startsWith(`${nodeId}:`))
          ) {
            throw new StateSnapshotSemanticError(
              `再確認した個人催促時計の所有項目が不正です。item: ${item.nodeId} cause: ${cause.causeId} source: ${sourceId}`,
            );
          }
        }
      }
    }
  }
}

/** 未検証の値をschema検証済みの現行snapshotへ変換する。 */
export function createStateSnapshot(value: unknown): StateSnapshot {
  return createSnapshot(value, "current");
}

function createLegacyStateSnapshot(value: unknown): StateSnapshot {
  return createSnapshot(value, "legacy");
}

function createSnapshot(value: unknown, proofVersion: "current" | "legacy"): StateSnapshot {
  snapshotVersionSchema.parse(value);
  const validate =
    proofVersion === "current" ? validateSnapshotSchema : validateLegacySnapshotSchema;
  if (!validate(value)) {
    throw new StateSnapshotSchemaError(validate.errors?.length ?? 1);
  }
  const createVersion21 =
    proofVersion === "current" ? createVersion21Snapshot : createLegacyVersion21Snapshot;
  const legacy = createVersion21(version21Projection(value));
  const causesByNodeId = new Map(
    value.items.map((item) => [
      item.nodeId,
      new Map(
        item.personalReminderCauses.map((cause) => [
          cause.causeId,
          normalizePersonalReminderCause(cause),
        ]),
      ),
    ]),
  );
  const snapshot = Object.freeze({
    ...legacy,
    schemaVersion: "22",
    items: Object.freeze(
      legacy.items.map((item) => {
        const causes = causesByNodeId.get(item.nodeId);
        if (causes == null) throw new StateSnapshotSchemaError(1);
        return Object.freeze({
          ...item,
          personalReminderCauses: Object.freeze(
            item.personalReminderCauses.map((cause) => {
              const normalized = causes.get(cause.causeId);
              if (normalized == null) throw new StateSnapshotSchemaError(1);
              return normalized;
            }),
          ),
        });
      }),
    ),
  } satisfies StateSnapshot);
  assertReconfirmedProvenance(snapshot);
  return snapshot;
}

/** 現行snapshotを末尾改行付きcanonical JSONへ変換する。 */
export function serializeStateSnapshot(snapshot: StateSnapshot): string {
  const validated = createLegacyStateSnapshot(snapshot);
  assertNoPendingPersonalReminderClock(validated);
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
  const snapshot = createLegacyStateSnapshot(value);
  assertNoPendingPersonalReminderClock(snapshot);
  return snapshot;
}

/** 旧schemaで検証する境界だけへ個人催促時計を射影する。 */
export function version19SnapshotFields(
  snapshot: StateSnapshot,
): ReturnType<typeof version21ToVersion19Fields> {
  return version21ToVersion19Fields(version21Projection(snapshot));
}

/** 保存済み公開投影に含まれるeffective graph状態を返す。 */
export function snapshotEffectiveGraphStateByNodeId(
  snapshot: StateSnapshot,
): ReadonlyMap<GraphNodeId, TrackedItemState> {
  return version21EffectiveGraphStateByNodeId(version21Projection(snapshot));
}

/** personal reminderのEvidence参照が現行snapshot内で閉じていることを検証する。 */
export function assertPersonalReminderEvidenceClosure(snapshot: StateSnapshot): void {
  assertNoPendingPersonalReminderClock(snapshot);
  assertVersion21EvidenceClosure(createVersion21Snapshot(version21Projection(snapshot)));
  assertReconfirmedProvenance(snapshot);
}

/** personal reminderのEvidence recordを現行snapshot内で照合する。 */
export function assertPersonalReminderEvidenceRecordsClosure(
  snapshot: StateSnapshot,
  expectedEvidenceBySourceId: ReadonlyMap<SourceId, readonly Evidence[]>,
): void {
  assertNoPendingPersonalReminderClock(snapshot);
  assertVersion21EvidenceRecordsClosure(
    createVersion21Snapshot(version21Projection(snapshot)),
    expectedEvidenceBySourceId,
  );
  assertReconfirmedProvenance(snapshot);
}
