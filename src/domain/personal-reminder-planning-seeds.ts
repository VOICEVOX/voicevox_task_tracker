import { type PersonalReminderCause } from "./personal-reminder-causes.js";
import { responsibleSignatures } from "./personal-reminder-planning-common.js";
import { type PersonalReminderCauseDraft } from "./personal-reminder-planning-contracts.js";

/** 原因候補の同一性keyを作る。 */
export function draftKey(draft: PersonalReminderCauseDraft): string {
  return JSON.stringify([
    draft.itemNodeId,
    draft.action.kind,
    responsibleSignatures(draft.responsible),
  ]);
}

/** 原因projectionの同一性keyを作る。 */
export function projectionKey(
  draft: PersonalReminderCauseDraft | undefined,
  previousCause: PersonalReminderCause | undefined,
): string {
  return JSON.stringify([draft == null ? undefined : draftKey(draft), previousCause?.causeId]);
}
