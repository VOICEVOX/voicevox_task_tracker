import type { PersonalReminderCause } from "../../../domain/personal-reminder-causes.js";
import {
  personalReminderDirectScopeNodeIds,
  personalReminderRelationConnectsDirectScope,
} from "../../../domain/personal-reminder-relation-scope.js";
import type { Relation } from "../../../domain/relation.js";
import type { GraphNodeId } from "../../../domain/types.js";
import type { CurrentSourceFact } from "../contracts/evidence-catalog.js";
import { nativeImplementationEvidenceOwnerNodeIds } from "./evidence-native-implementation-scope.js";
import { RunCompletenessError } from "./run-completeness-error.js";

type RelatedRelation = Readonly<{
  fromNodeId: GraphNodeId;
  toNodeId: GraphNodeId;
}>;

type CauseRelation = Pick<Relation, "active" | "fromNodeId" | "toNodeId" | "type">;

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

/** 個人催促の対象Issueを実装するPRだけを現行sourceの所有範囲へ加える。 */
export function personalReminderSourceOwnerNodeIds(
  itemNodeId: string,
  sourceId: string,
  scopeNodeIds: readonly string[],
  ownersByIssue: ReadonlyMap<string, readonly string[]>,
  currentById: ReadonlyMap<string, readonly CurrentSourceFact[]>,
): readonly string[] {
  return Object.freeze(
    [
      ...new Set([
        ...scopeNodeIds,
        ...nativeImplementationEvidenceOwnerNodeIds(
          sourceId,
          [itemNodeId],
          ownersByIssue,
          currentById,
        ),
      ]),
    ].sort(),
  );
}

/** 個人催促原因の責務と採用relationから利用できる対象範囲を返す。 */
export function personalReminderCauseScope(
  cause: PersonalReminderCause,
  relationsById: ReadonlyMap<string, CauseRelation>,
  path: readonly (string | number)[],
): Readonly<{ nodeIds: readonly string[]; relationIds: readonly string[] }> {
  const relationIds =
    cause.adoptedAssessment.status === "available"
      ? cause.adoptedAssessment.result.references.relationIds
      : [];
  return personalReminderCauseScopeForRelationIds(cause, relationIds, relationsById, path);
}

/** 個人催促原因と指定したrelation参照から利用できる対象範囲を返す。 */
export function personalReminderCauseScopeForRelationIds(
  cause: PersonalReminderCause,
  relationIds: readonly string[],
  relationsById: ReadonlyMap<string, CauseRelation>,
  path: readonly (string | number)[],
): Readonly<{ nodeIds: readonly string[]; relationIds: readonly string[] }> {
  const directScopeNodeIds = personalReminderDirectScopeNodeIds(cause);
  const nodes = new Set(directScopeNodeIds);
  for (const relationId of relationIds) {
    const relation = relationsById.get(relationId);
    if (
      relation == null ||
      !personalReminderRelationConnectsDirectScope(relation, directScopeNodeIds)
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
