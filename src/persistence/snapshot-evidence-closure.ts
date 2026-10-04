import { serializeCanonicalJson } from "../canonical-json/index.js";
import { type Evidence, type SourceId } from "../domain/index.js";
import { StateSnapshotSemanticError } from "./errors.js";
import type { StateSnapshot } from "./snapshot-contracts.js";

/** personal reminderのEvidence recordをsource IDごとに完全一致で索引化する。 */
export function createPersonalReminderEvidenceSourceIndex(
  evidenceGroups: readonly (readonly Evidence[])[],
): ReadonlyMap<SourceId, readonly Evidence[]> {
  const evidenceBySourceId = new Map<SourceId, Map<string, Evidence>>();
  for (const group of evidenceGroups) {
    for (const evidence of group) {
      const identity = serializeCanonicalJson(evidence);
      const evidenceByIdentity = evidenceBySourceId.get(evidence.sourceId);
      if (evidenceByIdentity == null) {
        evidenceBySourceId.set(evidence.sourceId, new Map([[identity, evidence]]));
      } else {
        evidenceByIdentity.set(identity, evidence);
      }
    }
  }
  const index = new Map<SourceId, readonly Evidence[]>();
  for (const sourceId of [...evidenceBySourceId.keys()].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  )) {
    const evidenceByIdentity = evidenceBySourceId.get(sourceId);
    if (evidenceByIdentity == null) {
      throw new TypeError(`Evidence source索引がありません。対象: ${sourceId}`);
    }
    index.set(
      sourceId,
      Object.freeze(
        [...evidenceByIdentity.values()].sort((left, right) => {
          const leftIdentity = serializeCanonicalJson(left);
          const rightIdentity = serializeCanonicalJson(right);
          return leftIdentity < rightIdentity ? -1 : leftIdentity > rightIdentity ? 1 : 0;
        }),
      ),
    );
  }
  return index;
}

/** personal reminderが参照するEvidence recordを所有itemへ閉じていることを検証する。 */
export function assertPersonalReminderEvidenceRecordsClosure(
  snapshot: StateSnapshot,
  expectedEvidenceBySourceId: ReadonlyMap<SourceId, readonly Evidence[]>,
): void {
  for (const item of snapshot.items) {
    for (const cause of item.personalReminderCauses) {
      const causeSourceIds = new Set(cause.evidenceSourceIds);
      const requiredSourceIds = new Set(cause.evidenceSourceIds);
      if (cause.adoptedAssessment.status === "available") {
        for (const sourceId of cause.adoptedAssessment.result.references.sourceIds) {
          requiredSourceIds.add(sourceId);
        }
      }
      const itemEvidenceByIdentity = new Map(
        item.evidence.map((evidence) => [serializeCanonicalJson(evidence), evidence]),
      );
      for (const sourceId of requiredSourceIds) {
        const expectedEvidence = expectedEvidenceBySourceId.get(sourceId);
        const referenceKind = causeSourceIds.has(sourceId) ? "cause" : "assessment";
        if (expectedEvidence == null || expectedEvidence.length === 0) {
          throw new StateSnapshotSemanticError(
            `personal reminder ${referenceKind}のevidence sourceをsnapshotのevidenceへ解決できません。item: ${item.nodeId} cause: ${cause.causeId} source: ${sourceId}`,
          );
        }
        for (const evidence of expectedEvidence) {
          if (!itemEvidenceByIdentity.has(serializeCanonicalJson(evidence))) {
            throw new StateSnapshotSemanticError(
              `personal reminder ${referenceKind}のevidence recordがowner itemで閉じていません。item: ${item.nodeId} cause: ${cause.causeId} source: ${sourceId}`,
            );
          }
        }
      }
    }
  }
}

/** personal reminderの根拠参照がsnapshot内で閉じていることを検証する。 */
export function assertPersonalReminderEvidenceClosure(snapshot: StateSnapshot): void {
  const evidenceBySourceId = createPersonalReminderEvidenceSourceIndex([
    ...snapshot.items.map((item) => item.evidence),
    ...snapshot.relations.map((relation) => relation.evidence),
  ]);
  assertPersonalReminderEvidenceRecordsClosure(snapshot, evidenceBySourceId);
}
