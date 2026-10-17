import { serializeCanonicalJson } from "../../../canonical-json/value.js";
import type {
  EvidenceClosureResult,
  EvidenceClosureOutward,
} from "../contracts/evidence-closure.js";
import type { FinalSnapshotCandidate } from "../contracts/final-snapshot.js";
import { assertEvidenceClosureMatches, type EvidenceClosureAdditions } from "./evidence-closure.js";
import type { PersonalReminderFinalizedRun } from "./personal-reminder-finalization.js";
import { RunCompletenessError } from "./run-completeness-error.js";
import { assertRunValueMatches, runValuesById } from "./run-validation-compare.js";

function matchingEvidence<Actual extends { sourceId: string; supports: string; summary: string }>(
  expected: readonly Actual[],
  saved: readonly Actual[],
  path: readonly (string | number)[],
  id: string,
): readonly Actual[] {
  assertRunValueMatches(canonicalValues(expected), canonicalValues(saved), path, id);
  return expected;
}

function canonicalValues(values: readonly unknown[]): readonly unknown[] {
  return Object.freeze(
    [...values].sort((left, right) => {
      const a = serializeCanonicalJson(left);
      const b = serializeCanonicalJson(right);
      return a < b ? -1 : a > b ? 1 : 0;
    }),
  );
}

function assertActualAdditionsMatch(
  closure: EvidenceClosureResult,
  actual: EvidenceClosureAdditions,
): void {
  const fields: readonly (keyof EvidenceClosureAdditions)[] = [
    "historyInputEvents",
    "aiCacheAdditions",
    "personalReminderAiCacheAdditions",
    "notificationCauses",
    "pendingNotifications",
  ];
  for (const field of fields) {
    assertRunValueMatches(
      canonicalValues(closure.outward[field]),
      canonicalValues(actual[field]),
      [field],
      field,
    );
  }
}

/** 実際の保存・通知値の参照からT16閉包を再照合する。 */
export function assertActualOutwardMatches(
  run: PersonalReminderFinalizedRun,
  closure: EvidenceClosureResult,
  snapshot: FinalSnapshotCandidate,
  actual: EvidenceClosureAdditions,
): void {
  assertActualAdditionsMatch(closure, actual);
  const finalized = runValuesById(run.data.items, (entry) => entry.item.nodeId, ["items"]);
  const closed = runValuesById(closure.outward.items, (entry) => entry.item.nodeId, ["items"]);
  const saved = runValuesById(snapshot.items, (item) => item.nodeId, ["items"]);
  const items: EvidenceClosureOutward["items"][number][] = [];
  for (const [nodeId, savedItem] of saved) {
    const finalizedEntry = finalized.get(nodeId);
    const closedEntry = closed.get(nodeId);
    if (finalizedEntry == null || closedEntry == null) {
      throw new RunCompletenessError("missing_value", nodeId, ["items", nodeId], undefined);
    }
    const itemEvidence = closedEntry.item.evidence;
    const additionalEvidence = closedEntry.evidence;
    const completeEvidence = new Map(
      [...itemEvidence, ...additionalEvidence].map((record) => [
        serializeCanonicalJson(record),
        record,
      ]),
    );
    matchingEvidence(
      [...completeEvidence.values()],
      savedItem.evidence,
      ["items", nodeId, "evidence"],
      nodeId,
    );
    const causes = runValuesById(savedItem.personalReminderCauses, (cause) => cause.causeId, [
      "items",
      nodeId,
      "personalReminderCauses",
    ]);
    const causeResults = closedEntry.causeResults.map((result) => {
      const cause = causes.get(result.cause.causeId);
      if (cause == null) {
        throw new RunCompletenessError(
          "missing_value",
          result.cause.causeId,
          ["items", nodeId, "personalReminderCauses"],
          undefined,
        );
      }
      return Object.freeze({ ...result, cause });
    });
    if (causes.size !== causeResults.length) {
      throw new RunCompletenessError(
        "missing_value",
        nodeId,
        ["items", nodeId, "personalReminderCauses"],
        undefined,
      );
    }
    items.push(
      Object.freeze({
        item: Object.freeze({
          ...finalizedEntry.item,
          ...savedItem,
          deadlineLevel: finalizedEntry.item.deadlineLevel,
          evidence: itemEvidence,
        }),
        causeResults: Object.freeze(causeResults),
        evidence: additionalEvidence,
        planning: savedItem.personalReminderCausePlanning,
      }),
    );
  }
  if (saved.size !== closed.size) {
    throw new RunCompletenessError("missing_value", "items", ["items"], undefined);
  }
  const edges = runValuesById(closure.outward.relations, (edge) => edge.id, ["relations"]);
  const relations: EvidenceClosureOutward["relations"][number][] = [];
  for (const relation of snapshot.relations) {
    const edge = edges.get(relation.id);
    if (edge == null) {
      throw new RunCompletenessError("missing_value", relation.id, ["relations"], undefined);
    }
    relations.push(
      Object.freeze({
        ...edge,
        evidence: matchingEvidence(
          edge.evidence,
          relation.evidence,
          ["relations", relation.id, "evidence"],
          relation.id,
        ),
      }),
    );
  }
  if (relations.length !== edges.size) {
    throw new RunCompletenessError("missing_value", "relations", ["relations"], undefined);
  }
  assertEvidenceClosureMatches(
    closure,
    Object.freeze({
      items: Object.freeze(items),
      collectionAiItems: Object.freeze(
        snapshot.collection.repositories.flatMap((repository) => repository.items),
      ),
      relations: Object.freeze(relations),
      aiItems: run.data.aiItems,
      ...actual,
    }),
  );
}
