import type { PersonalReminderCause } from "../../../domain/personal-reminder-causes.js";
import type { GraphNodeId } from "../../../domain/types.js";
import { RunCompletenessError } from "./run-completeness-error.js";

type RelatedRelation = Readonly<{
  fromNodeId: GraphNodeId;
  toNodeId: GraphNodeId;
}>;

/** 項目に接続したrelation参照から利用できる対象範囲を返す。 */
export function relatedScope(
  itemNodeId: string,
  relationIds: readonly string[],
  relationsById: ReadonlyMap<string, RelatedRelation>,
  path: readonly (string | number)[],
): Readonly<{ nodeIds: readonly string[]; relationIds: readonly string[] }> {
  const nodes = new Set([itemNodeId]);
  for (const relationId of relationIds) {
    const relation = relationsById.get(relationId);
    if (
      relation == null ||
      (relation.fromNodeId !== itemNodeId && relation.toNodeId !== itemNodeId)
    ) {
      throw new RunCompletenessError("invalid_reference", relationId, path, undefined);
    }
    nodes.add(relation.fromNodeId);
    nodes.add(relation.toNodeId);
  }
  return Object.freeze({
    nodeIds: Object.freeze([...nodes].sort()),
    relationIds: Object.freeze([...new Set(relationIds)].sort()),
  });
}

/** 個人催促原因の責務と採用relationから利用できる対象範囲を返す。 */
export function personalReminderCauseScope(
  cause: PersonalReminderCause,
  relationsById: ReadonlyMap<string, RelatedRelation>,
  path: readonly (string | number)[],
): Readonly<{ nodeIds: readonly string[]; relationIds: readonly string[] }> {
  const references =
    cause.adoptedAssessment.status === "available"
      ? cause.adoptedAssessment.result.references
      : undefined;
  const related = relatedScope(
    cause.itemNodeId,
    references?.relationIds ?? [],
    relationsById,
    path,
  );
  const nodes = new Set([
    ...related.nodeIds,
    ...(cause.responsibility.scope.kind === "item"
      ? []
      : cause.responsibility.scope.surfaces.map((surface) => surface.nodeId)),
  ]);
  return Object.freeze({
    nodeIds: Object.freeze([...nodes].sort()),
    relationIds: related.relationIds,
  });
}
