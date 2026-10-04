import type {
  MaterializedEvidenceReference,
  MaterializedReferenceValues,
} from "./run-validation-reference-contracts.js";
import { RunCompletenessError } from "./run-completeness-error.js";

type Path = readonly (string | number)[];

/** 値が配列でないrecordかを判定する。 */
export function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value != null && !Array.isArray(value);
}

/** 保存値の指定pathにある値を取得する。 */
export function valueAtPath(value: unknown, path: Path): unknown {
  let current = value;
  for (const part of path) {
    if (Array.isArray(current)) {
      if (typeof part !== "number") return undefined;
      current = current[part];
    } else if (isRecord(current)) {
      current = current[String(part)];
    } else {
      return undefined;
    }
  }
  return current;
}

/** 関係で接続された項目だけをsource所有範囲へ加える。 */
export function relationScope(
  values: MaterializedReferenceValues,
  ownerNodeId: string,
  relationIds: readonly string[],
  path: Path,
): Readonly<{ nodeIds: readonly string[]; relationIds: readonly string[] }> {
  const nodes = new Set([ownerNodeId]);
  for (const relationId of relationIds) {
    const relation = values.snapshot.relations.find((entry) => entry.id === relationId);
    if (relation == null) {
      throw new RunCompletenessError("invalid_reference", relationId, path, undefined);
    }
    const from = valueAtPath(relation, ["fromNodeId"]);
    const to = valueAtPath(relation, ["toNodeId"]);
    if (
      typeof from !== "string" ||
      typeof to !== "string" ||
      (from !== ownerNodeId && to !== ownerNodeId)
    ) {
      throw new RunCompletenessError("wrong_owner", relationId, path, undefined);
    }
    nodes.add(from);
    nodes.add(to);
  }
  return { nodeIds: [...nodes].sort(), relationIds: [...new Set(relationIds)].sort() };
}

function causeExecutionSurfaceNodeIds(cause: unknown, path: Path): readonly string[] {
  const scope = valueAtPath(cause, ["responsibility", "scope"]);
  if (!isRecord(scope) || typeof scope["kind"] !== "string") {
    throw new RunCompletenessError("invalid_reference", "responsibility", path, undefined);
  }
  if (scope["kind"] === "item") return [];
  const surfaces = scope["surfaces"];
  if (
    (scope["kind"] !== "execution_surfaces" && scope["kind"] !== "item_and_execution_surfaces") ||
    !Array.isArray(surfaces)
  ) {
    throw new RunCompletenessError("invalid_reference", "responsibility", path, undefined);
  }
  return surfaces.map((surface: unknown) => {
    const nodeId = valueAtPath(surface, ["nodeId"]);
    if (typeof nodeId !== "string") {
      throw new RunCompletenessError("invalid_reference", "responsibility", path, undefined);
    }
    return nodeId;
  });
}

function causeClockReferencesSource(cause: unknown, sourceId: string): boolean {
  return [
    ["obligationSince"],
    ["actionableClock", "actionableSince"],
    ["actionableClock", "stallSince"],
  ].some((path) => {
    const basis = valueAtPath(cause, path);
    if (!isRecord(basis) || basis["source"] !== "event") return false;
    const sourceIds = basis["sourceIds"];
    return Array.isArray(sourceIds) && sourceIds.includes(sourceId);
  });
}

/** 項目Evidenceの原因と関係から許可される所有範囲を得る。 */
export function itemEvidenceScope(
  reference: MaterializedEvidenceReference,
  values: MaterializedReferenceValues,
): Readonly<{ nodeIds: readonly string[]; relationIds: readonly string[] }> {
  const ownerNodeId = reference.owner.id;
  const itemIndex = reference.path[2];
  const item = typeof itemIndex === "number" ? values.snapshot.items[itemIndex] : undefined;
  if (item == null) {
    throw new RunCompletenessError("missing_value", ownerNodeId, reference.path, undefined);
  }
  const relationIds = new Set<string>();
  const ownerNodeIds = new Set([ownerNodeId]);
  for (const cause of item.personalReminderCauses) {
    const sourceIds = valueAtPath(cause, ["evidenceSourceIds"]);
    const assessmentSourceIds = valueAtPath(cause, [
      "adoptedAssessment",
      "result",
      "references",
      "sourceIds",
    ]);
    if (
      (Array.isArray(sourceIds) && sourceIds.includes(reference.sourceId)) ||
      (Array.isArray(assessmentSourceIds) && assessmentSourceIds.includes(reference.sourceId)) ||
      causeClockReferencesSource(cause, reference.sourceId)
    ) {
      for (const nodeId of causeExecutionSurfaceNodeIds(cause, reference.path)) {
        ownerNodeIds.add(nodeId);
      }
      const related = valueAtPath(cause, [
        "adoptedAssessment",
        "result",
        "references",
        "relationIds",
      ]);
      if (Array.isArray(related)) {
        for (const id of related) {
          if (typeof id !== "string")
            throw new RunCompletenessError(
              "invalid_reference",
              reference.sourceId,
              reference.path,
              undefined,
            );
          relationIds.add(id);
        }
      }
    }
  }
  const waitingOn = valueAtPath(item, ["waitingOn"]);
  if (Array.isArray(waitingOn)) {
    for (const waiting of waitingOn) {
      if (!isRecord(waiting) || waiting["kind"] !== "item") continue;
      const sourceIds = waiting["sourceIds"];
      if (!Array.isArray(sourceIds) || !sourceIds.includes(reference.sourceId)) continue;
      for (const relation of values.snapshot.relations) {
        const from = valueAtPath(relation, ["fromNodeId"]);
        const to = valueAtPath(relation, ["toNodeId"]);
        if (
          (from === ownerNodeId && to === waiting["candidateId"]) ||
          (to === ownerNodeId && from === waiting["candidateId"])
        ) {
          relationIds.add(relation.id);
        }
      }
    }
  }
  for (const relation of values.snapshot.relations) {
    const from = valueAtPath(relation, ["fromNodeId"]);
    const to = valueAtPath(relation, ["toNodeId"]);
    if (from !== ownerNodeId && to !== ownerNodeId) continue;
    const evidence = valueAtPath(relation, ["evidence"]);
    if (
      Array.isArray(evidence) &&
      evidence.some((entry: unknown) => isRecord(entry) && entry["sourceId"] === reference.sourceId)
    ) {
      relationIds.add(relation.id);
    }
  }
  const related = relationScope(values, ownerNodeId, [...relationIds], reference.path);
  return {
    nodeIds: [...new Set([...related.nodeIds, ...ownerNodeIds])].sort(),
    relationIds: related.relationIds,
  };
}

function causeValueScope(
  cause: unknown,
  reference: MaterializedEvidenceReference,
  values: MaterializedReferenceValues,
): Readonly<{ nodeIds: readonly string[]; relationIds: readonly string[] }> {
  const related = valueAtPath(cause, ["adoptedAssessment", "result", "references", "relationIds"]);
  if (related != null && !Array.isArray(related)) {
    throw new RunCompletenessError(
      "invalid_reference",
      reference.sourceId,
      reference.path,
      undefined,
    );
  }
  const ids: string[] = [];
  if (Array.isArray(related)) {
    for (const id of related) {
      if (typeof id !== "string")
        throw new RunCompletenessError(
          "invalid_reference",
          reference.sourceId,
          reference.path,
          undefined,
        );
      ids.push(id);
    }
  }
  const relatedScopeValue = relationScope(values, reference.owner.id, ids, reference.path);
  return {
    nodeIds: [
      ...new Set([
        ...relatedScopeValue.nodeIds,
        ...causeExecutionSurfaceNodeIds(cause, reference.path),
      ]),
    ].sort(),
    relationIds: relatedScopeValue.relationIds,
  };
}

/** 個人催促原因が参照する関係の所有範囲を得る。 */
export function causeScope(
  reference: MaterializedEvidenceReference,
  values: MaterializedReferenceValues,
): Readonly<{ nodeIds: readonly string[]; relationIds: readonly string[] }> {
  const itemIndex = reference.path[2];
  const causeIndex = reference.path[4];
  const cause =
    typeof itemIndex === "number" && typeof causeIndex === "number"
      ? values.snapshot.items[itemIndex]?.personalReminderCauses[causeIndex]
      : undefined;
  if (cause == null) {
    throw new RunCompletenessError("missing_value", reference.sourceId, reference.path, undefined);
  }
  return causeValueScope(cause, reference, values);
}

function causeForItem(
  values: MaterializedReferenceValues,
  itemNodeId: string,
  causeId: string,
): unknown {
  const item = values.snapshot.items.find((value) => value.nodeId === itemNodeId);
  return item?.personalReminderCauses.find((value) => value.causeId === causeId);
}

/** 保存済み通知に対応する原因の関係と実行面をsource所有範囲へ加える。 */
export function pendingNotificationScope(
  reference: MaterializedEvidenceReference,
  values: MaterializedReferenceValues,
): Readonly<{ nodeIds: readonly string[]; relationIds: readonly string[] }> {
  const pending = valueAtPath(values, reference.path.slice(0, 3));
  const causeId = valueAtPath(pending, ["target", "causeId"]);
  if (typeof causeId !== "string") return { nodeIds: [reference.owner.id], relationIds: [] };
  const cause = causeForItem(values, reference.owner.id, causeId);
  return cause == null
    ? { nodeIds: [reference.owner.id], relationIds: [] }
    : causeValueScope(cause, reference, values);
}

/** 個人催促通知理由に対応する原因の所有範囲を得る。 */
export function notificationReasonScope(
  reference: MaterializedEvidenceReference,
  values: MaterializedReferenceValues,
): Readonly<{ nodeIds: readonly string[]; relationIds: readonly string[] }> {
  const context = valueAtPath(values, reference.path.slice(0, 7));
  const causeId = valueAtPath(context, ["causeId"]);
  if (typeof causeId !== "string") {
    throw new RunCompletenessError(
      "invalid_reference",
      reference.sourceId,
      reference.path,
      undefined,
    );
  }
  const cause = causeForItem(values, reference.owner.id, causeId);
  if (cause == null) {
    throw new RunCompletenessError("missing_value", reference.sourceId, reference.path, undefined);
  }
  return causeValueScope(cause, reference, values);
}
