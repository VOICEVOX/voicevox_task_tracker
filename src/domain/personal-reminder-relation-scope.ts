import type { PersonalReminderCause } from "./personal-reminder-causes.js";
import type { Relation } from "./relation.js";
import type { GraphNodeId } from "./types.js";

/** 個人催促原因の主項目とその原因自身の実行対象を関係参照の起点にする。 */
export function personalReminderDirectScopeNodeIds(
  cause: Pick<PersonalReminderCause, "itemNodeId" | "responsibility">,
): ReadonlySet<GraphNodeId> {
  return new Set([
    cause.itemNodeId,
    ...(cause.responsibility.scope.kind === "item"
      ? []
      : cause.responsibility.scope.surfaces.map((surface) => surface.nodeId)),
  ]);
}

/** 有効な関係が原因自身の起点へ直接接続するか判定する。 */
export function personalReminderRelationConnectsDirectScope(
  relation: Pick<Relation, "active" | "fromNodeId" | "toNodeId" | "type">,
  directScopeNodeIds: ReadonlySet<string>,
): boolean {
  return (
    relation.active &&
    relation.type !== "related_to" &&
    (directScopeNodeIds.has(relation.fromNodeId) || directScopeNodeIds.has(relation.toNodeId))
  );
}
