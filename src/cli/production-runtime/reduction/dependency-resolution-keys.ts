import type { GraphNodeId, Relation } from "../../../domain/index.js";

/** 関係進捗を識別するキーを作る。 */
export function relationProgressKey(
  relationType: Relation["type"],
  provenance: Relation["provenance"],
  fromNodeId: GraphNodeId,
  toNodeId: GraphNodeId,
): string {
  return JSON.stringify([relationType, provenance, fromNodeId, toNodeId]);
}

/** 関係の意味を識別するキーを作る。 */
export function relationMeaningKey(
  relationType: Relation["type"],
  fromNodeId: GraphNodeId,
  toNodeId: GraphNodeId,
): string {
  return JSON.stringify([relationType, fromNodeId, toNodeId]);
}
