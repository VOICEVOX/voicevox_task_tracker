import { serializeCanonicalJson } from "../../../canonical-json/value.js";
import type { Evidence } from "../../../domain/types.js";
import type { EvidenceClosureResult } from "../contracts/evidence-closure.js";
import { assertEvidenceClosureMatches } from "./evidence-closure.js";
import type { MaterializedReferenceValues } from "./run-validation-reference-contracts.js";
import { RunCompletenessError } from "./run-completeness-error.js";
import { assertRunValueMatches, runValuesById } from "./run-validation-compare.js";

function canonicalValues<Value>(values: readonly Value[]): readonly Value[] {
  return Object.freeze(
    [...values].sort((left, right) => {
      const a = serializeCanonicalJson(left);
      const b = serializeCanonicalJson(right);
      return a < b ? -1 : a > b ? 1 : 0;
    }),
  );
}

function canonicalEvidence(values: readonly Evidence[]): readonly Evidence[] {
  const unique = new Map(values.map((evidence) => [serializeCanonicalJson(evidence), evidence]));
  return canonicalValues([...unique.values()]);
}

function field(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value == null || Array.isArray(value)) return undefined;
  return Object.getOwnPropertyDescriptor(value, key)?.value;
}

/** stageの全保存対象source値を最終snapshotと追加値へ照合する。 */
export function assertStageSourceValuesMatch(
  closure: EvidenceClosureResult,
  values: MaterializedReferenceValues,
): void {
  assertEvidenceClosureMatches(closure, closure.outward);
  const stageItems = runValuesById(closure.outward.items, (entry) => entry.item.nodeId, ["items"]);
  const savedItems = runValuesById(values.snapshot.items, (item) => item.nodeId, [
    "snapshot",
    "items",
  ]);
  if (stageItems.size !== savedItems.size) {
    throw new RunCompletenessError("missing_value", "items", ["snapshot", "items"], undefined);
  }
  for (const [itemNodeId, entry] of stageItems) {
    const saved = savedItems.get(itemNodeId);
    if (saved == null)
      throw new RunCompletenessError("missing_value", itemNodeId, ["snapshot", "items"], undefined);
    const sourceFields: readonly ("waitingOn" | "inputEvents" | "aiAnalysis")[] = [
      "waitingOn",
      "inputEvents",
      "aiAnalysis",
    ];
    for (const key of sourceFields) {
      assertRunValueMatches(
        entry.item[key],
        field(saved, key),
        ["snapshot", "items", itemNodeId, key],
        itemNodeId,
      );
    }
    assertRunValueMatches(
      canonicalEvidence([...entry.item.evidence, ...entry.evidence]),
      field(saved, "evidence"),
      ["snapshot", "items", itemNodeId, "evidence"],
      itemNodeId,
    );
    assertRunValueMatches(
      entry.causeResults.map(({ cause }) => cause),
      saved.personalReminderCauses,
      ["snapshot", "items", itemNodeId, "personalReminderCauses"],
      itemNodeId,
    );
  }
  const stageRelations = runValuesById(closure.outward.relations, (relation) => relation.id, [
    "relations",
  ]);
  const savedRelations = runValuesById(values.snapshot.relations, (relation) => relation.id, [
    "snapshot",
    "relations",
  ]);
  if (stageRelations.size !== savedRelations.size)
    throw new RunCompletenessError(
      "missing_value",
      "relations",
      ["snapshot", "relations"],
      undefined,
    );
  for (const [relationId, relation] of stageRelations) {
    const saved = savedRelations.get(relationId);
    if (saved == null)
      throw new RunCompletenessError(
        "missing_value",
        relationId,
        ["snapshot", "relations"],
        undefined,
      );
    assertRunValueMatches(
      relation.evidence,
      field(saved, "evidence"),
      ["snapshot", "relations", relationId, "evidence"],
      relationId,
    );
  }
  assertRunValueMatches(
    canonicalValues(closure.outward.historyInputEvents),
    canonicalValues(values.historyInputEvents),
    ["historyInputEvents"],
    "history",
  );
  assertRunValueMatches(
    canonicalValues(closure.outward.pendingNotifications),
    canonicalValues(values.notificationLedger.pendingNotifications),
    ["notificationLedger", "pendingNotifications"],
    "notification",
  );
  assertRunValueMatches(
    values.notificationLedger.pendingNotifications,
    values.notificationSelection.pendingNotifications,
    ["notificationSelection", "pendingNotifications"],
    "notification",
  );
  assertRunValueMatches(
    canonicalValues(
      closure.outward.aiCacheAdditions.map((addition) => ({
        element: addition.element,
        result: addition.result,
      })),
    ),
    canonicalValues(
      values.aiCacheAdditions.map((addition) => ({
        element: addition.element,
        result: addition.generation.result,
      })),
    ),
    ["aiCacheAdditions"],
    "aiCache",
  );
  assertRunValueMatches(
    canonicalValues(closure.outward.personalReminderAiCacheAdditions.map(({ result }) => result)),
    canonicalValues(
      values.personalReminderAiCacheAdditions.map(({ generation }) => generation.result),
    ),
    ["personalReminderAiCacheAdditions"],
    "personalReminderAiCache",
  );
}
