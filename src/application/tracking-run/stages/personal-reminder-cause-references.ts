import type { PersonalReminderCause } from "../../../domain/personal-reminder-causes.js";
import type { SourceId } from "../../../domain/source-id.js";

/** 個人催促原因が保持する全種類のsource参照を返す。 */
export function personalReminderCauseSourceIds(cause: PersonalReminderCause): readonly SourceId[] {
  const sourceIds = new Set(personalReminderCauseEvidenceSourceIds(cause));
  const bases = [
    cause.obligationSince,
    ...(cause.actionableClock.status === "observed"
      ? [cause.actionableClock.actionableSince, cause.actionableClock.stallSince]
      : []),
  ];
  for (const basis of bases) {
    if (basis.source !== "reconfirmed_observation") continue;
    for (const id of basis.sourceIds) sourceIds.add(id);
  }
  return Object.freeze([...sourceIds].sort());
}

/** 個人催促原因のうちEvidenceによる支持を要するsource参照を返す。 */
export function personalReminderCauseEvidenceSourceIds(
  cause: PersonalReminderCause,
): readonly SourceId[] {
  const sourceIds = new Set(cause.evidenceSourceIds);
  if (cause.adoptedAssessment.status === "available") {
    for (const id of cause.adoptedAssessment.result.references.sourceIds) sourceIds.add(id);
  }
  if (cause.obligationSince.source === "event") {
    for (const id of cause.obligationSince.sourceIds) sourceIds.add(id);
  }
  if (cause.actionableClock.status === "observed") {
    for (const basis of [cause.actionableClock.actionableSince, cause.actionableClock.stallSince]) {
      if (basis.source === "event") {
        for (const id of basis.sourceIds) sourceIds.add(id);
      }
    }
  }
  return Object.freeze([...sourceIds].sort());
}
