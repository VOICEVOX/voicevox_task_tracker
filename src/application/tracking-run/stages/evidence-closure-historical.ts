import { serializeCanonicalJson } from "../../../canonical-json/value.js";
import type { Evidence, GitHubNodeId, GitHubRepositoryId } from "../../../domain/types.js";
import type { OwnedHistoricalEvidence } from "../contracts/evidence-closure.js";

/** 前回snapshotの根拠と保存位置を読み取るための最小入力。 */
export type HistoricalEvidenceSnapshotInput = Readonly<{
  items: readonly Readonly<{
    nodeId: GitHubNodeId;
    repositoryId: GitHubRepositoryId;
    evidence: readonly Evidence[];
  }>[];
  relations: readonly Readonly<{
    id: string;
    fromNodeId: string;
    toNodeId: string;
    evidence: readonly Evidence[];
  }>[];
}>;

/** 前回項目と関係の根拠を元の所有位置付きで保持する。 */
export function collectOwnedHistoricalEvidence(
  previousItems: HistoricalEvidenceSnapshotInput["items"],
  previousRelations: HistoricalEvidenceSnapshotInput["relations"],
): readonly OwnedHistoricalEvidence[] {
  const records: OwnedHistoricalEvidence[] = [];
  for (const [itemIndex, item] of previousItems.entries()) {
    for (const [evidenceIndex, evidence] of item.evidence.entries()) {
      records.push(
        Object.freeze({
          record: Object.freeze({
            status: "historical",
            location: Object.freeze({
              container: "retained_value",
              path: Object.freeze(["items", itemIndex, "evidence", evidenceIndex]),
            }),
            evidence,
          }),
          owner: Object.freeze({
            kind: "item",
            itemNodeId: item.nodeId,
            repositoryId: item.repositoryId,
          }),
        }),
      );
    }
  }
  for (const [relationIndex, relation] of previousRelations.entries()) {
    for (const [evidenceIndex, evidence] of relation.evidence.entries()) {
      records.push(
        Object.freeze({
          record: Object.freeze({
            status: "historical",
            location: Object.freeze({
              container: "retained_value",
              path: Object.freeze(["relations", relationIndex, "evidence", evidenceIndex]),
            }),
            evidence,
          }),
          owner: Object.freeze({
            kind: "relation",
            relationId: relation.id,
            fromNodeId: relation.fromNodeId,
            toNodeId: relation.toNodeId,
          }),
        }),
      );
    }
  }
  return Object.freeze(
    records.sort((left, right) => {
      const leftIdentity = serializeCanonicalJson(left);
      const rightIdentity = serializeCanonicalJson(right);
      return leftIdentity < rightIdentity ? -1 : leftIdentity > rightIdentity ? 1 : 0;
    }),
  );
}
