import type {
  CurrentPersonalReminderAssessment,
  PersonalReminderAdoptedAssessment,
  PersonalReminderCause,
  PersonalReminderCausePlanning,
  PersonalReminderEvaluationAttempt,
} from "../../../domain/personal-reminder-causes.js";
import type { PersonalReminderStaleness } from "../../../domain/personal-reminder-staleness.js";
import type { Evidence } from "../../../domain/types.js";
import type { PersonalReminderCauseDecision } from "../stages/personal-reminder-plan-contracts.js";
import type { GraphFinalItem } from "./graph-final-item.js";

/** 個人催促評価の採用元と現入力での利用可否。 */
export type PersonalReminderAssessmentAdoption = Readonly<{
  causeId: PersonalReminderCause["causeId"];
  inputFingerprint: PersonalReminderCause["currentInput"]["fingerprint"];
  applicationSource: "fixed" | "new" | "cache" | "snapshot" | "retained" | "none";
  currentness: "available" | "unverified";
  latestAttempt: PersonalReminderEvaluationAttempt;
  adoptedAssessment: PersonalReminderAdoptedAssessment;
  currentAssessment: CurrentPersonalReminderAssessment;
}>;

/** 確定済み原因と通知適格性の唯一の結果。 */
export type PersonalReminderFinalizedCause = Readonly<{
  cause: PersonalReminderCause;
  staleness: PersonalReminderStaleness;
  assessment: Readonly<{
    applicationSource: PersonalReminderAssessmentAdoption["applicationSource"];
    currentness: PersonalReminderAssessmentAdoption["currentness"];
    reason: PersonalReminderCauseDecision["reason"] | "retained_without_evaluation";
  }>;
}>;

/** 最終graphの項目と個人催促の確定値。 */
export type PersonalReminderFinalizedItem = Readonly<{
  item: Omit<GraphFinalItem, "personalReminderCauses" | "personalReminderCausePlanning">;
  causeResults: readonly PersonalReminderFinalizedCause[];
  evidence: readonly Evidence[];
  planning: PersonalReminderCausePlanning;
}>;
