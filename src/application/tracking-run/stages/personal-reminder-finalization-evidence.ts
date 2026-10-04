import { serializeCanonicalJson } from "../../../canonical-json/value.js";
import type {
  PersonalReminderCause,
  PersonalReminderTimeBasis,
} from "../../../domain/personal-reminder-causes.js";
import type { SourceId } from "../../../domain/source-id.js";
import type { Evidence, UtcIsoDateTime } from "../../../domain/types.js";
import type { ReconciledGraphEdge } from "../../../graph/reconcile-graph-types.js";
import { indexPersonalReminderEvidence } from "./personal-reminder-evidence-index.js";
import { personalReminderCauseEvidenceSourceIds } from "./personal-reminder-cause-references.js";
import {
  verifiedCurrentClockEvidence,
  type CurrentClockEvidenceSources,
} from "./personal-reminder-clock-evidence.js";
import { personalReminderCauseScope } from "./personal-reminder-related-scope.js";
import { RunCompletenessError } from "./run-completeness-error.js";

function evidenceIdentity(evidence: Evidence): string {
  return serializeCanonicalJson(evidence);
}

function clockBasesForCause(cause: PersonalReminderCause): readonly PersonalReminderTimeBasis[] {
  return cause.actionableClock.status === "observed"
    ? [
        cause.obligationSince,
        cause.actionableClock.actionableSince,
        cause.actionableClock.stallSince,
      ]
    : [cause.obligationSince];
}

/** 原因が参照する検証済み根拠recordを所有項目へ保持する。 */
export function finalizePersonalReminderEvidence(
  itemNodeId: string,
  causes: readonly PersonalReminderCause[],
  localEvidence: readonly Evidence[],
  currentEvidenceBySourceId: ReadonlyMap<SourceId, readonly Evidence[]>,
  previousEvidenceBySourceId: ReadonlyMap<SourceId, readonly Evidence[]>,
  clockSources: CurrentClockEvidenceSources,
  relationsById: ReadonlyMap<string, ReconciledGraphEdge>,
  evaluatedAt: UtcIsoDateTime,
): readonly Evidence[] {
  const records = new Map(localEvidence.map((evidence) => [evidenceIdentity(evidence), evidence]));
  for (const cause of causes) {
    const scope = personalReminderCauseScope(cause, relationsById, [
      "personalReminderCauses",
      itemNodeId,
      cause.causeId,
      "adoptedAssessment",
      "references",
    ]);
    const allowedOwnerNodeIds = new Set(scope.nodeIds);
    for (const basis of clockBasesForCause(cause)) {
      if (basis.source !== "event") continue;
      for (const sourceId of basis.sourceIds) {
        const verified = verifiedCurrentClockEvidence(
          sourceId,
          basis,
          allowedOwnerNodeIds,
          evaluatedAt,
          clockSources,
        );
        if (
          verified != null &&
          (currentEvidenceBySourceId.get(sourceId)?.length ?? 0) === 0 &&
          (previousEvidenceBySourceId.get(sourceId)?.length ?? 0) === 0 &&
          ![...records.values()].some((evidence) => evidence.sourceId === sourceId)
        ) {
          records.set(evidenceIdentity(verified), verified);
        }
      }
    }
    for (const sourceId of personalReminderCauseEvidenceSourceIds(cause)) {
      const previous = previousEvidenceBySourceId.get(sourceId) ?? [];
      const current = currentEvidenceBySourceId.get(sourceId) ?? [];
      if (
        previous.length === 0 &&
        current.length === 0 &&
        ![...records.values()].some((evidence) => evidence.sourceId === sourceId)
      ) {
        throw new RunCompletenessError(
          "missing_source",
          sourceId,
          ["personalReminderCauses", itemNodeId, cause.causeId],
          undefined,
        );
      }
      for (const evidence of [...previous, ...current]) {
        records.set(evidenceIdentity(evidence), evidence);
      }
    }
  }
  return Object.freeze(
    [...records.values()].sort((left, right) =>
      evidenceIdentity(left).localeCompare(evidenceIdentity(right)),
    ),
  );
}

/** 現在と前回のsource record索引をそれぞれ作る。 */
export function personalReminderEvidenceIndexes(
  currentGroups: readonly (readonly Evidence[])[],
  previousGroups: readonly (readonly Evidence[])[],
): Readonly<{
  current: ReadonlyMap<SourceId, readonly Evidence[]>;
  previous: ReadonlyMap<SourceId, readonly Evidence[]>;
}> {
  return Object.freeze({
    current: indexPersonalReminderEvidence(currentGroups),
    previous: indexPersonalReminderEvidence(previousGroups),
  });
}
