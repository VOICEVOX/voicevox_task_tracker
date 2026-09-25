import { createPersonalReminderCauseInputFingerprint } from "../../codex/personal-reminder-input.js";
import type { PersonalReminderAiEvaluationCandidate } from "../../codex/personal-reminder-runner.js";
import {
  PERSONAL_REMINDER_ASSESSMENT_RULES_VERSION,
  currentPersonalReminderAssessment,
  personalReminderCauseSchema,
  type PersonalReminderCause,
} from "../../domain/personal-reminder-causes.js";
import type {
  PersonalReminderCauseRuntimePlan,
  PersonalReminderCauseRuntimePlanEntry,
} from "../personal-reminder-runtime.js";

type PersonalReminderDownstreamImpact = Readonly<{
  openNodeCount: number;
  repositoryCount: number;
}>;

function personalReminderPlaceholderCause(
  entry: PersonalReminderCauseRuntimePlanEntry,
): PersonalReminderCause {
  const inputFingerprint = createPersonalReminderCauseInputFingerprint(entry.semanticInput);
  return personalReminderCauseSchema.parse({
    ...entry.seed,
    responseMembershipAssessmentRequirement: entry.responseMembershipAssessmentRequirement,
    currentInput: {
      fingerprint: inputFingerprint,
      rulesVersion: PERSONAL_REMINDER_ASSESSMENT_RULES_VERSION,
      completeness: entry.semanticInput.completeness,
      aiDependency: entry.currentInputAiDependency,
    },
    latestAttempt: { status: "not_evaluated" },
    adoptedAssessment: { status: "not_available" },
    actionableClock: { status: "not_observed" },
  });
}

function hasCurrentPersonalReminderAssessment(
  cause: PersonalReminderCause | undefined,
  inputFingerprint: string,
): boolean {
  if (cause == null) {
    return false;
  }
  return (
    cause.currentInput.fingerprint === inputFingerprint &&
    cause.currentInput.rulesVersion === PERSONAL_REMINDER_ASSESSMENT_RULES_VERSION &&
    currentPersonalReminderAssessment(cause).status === "available"
  );
}

/** 個人催促causeのAI評価候補を作る。 */
export function personalReminderAiCandidate(
  entry: PersonalReminderCauseRuntimePlanEntry,
  downstreamImpact: PersonalReminderDownstreamImpact | undefined,
): PersonalReminderAiEvaluationCandidate | undefined {
  const inputFingerprint = createPersonalReminderCauseInputFingerprint(entry.semanticInput);
  if (entry.semanticInput.completeness.status === "complete") {
    if (entry.deterministicAssessment != null) {
      return undefined;
    }
    if (hasCurrentPersonalReminderAssessment(entry.previousCause, inputFingerprint)) {
      return undefined;
    }
  }
  const previousAttempt = entry.previousCause?.latestAttempt.status;
  return Object.freeze({
    cause: entry.previousCause ?? personalReminderPlaceholderCause(entry),
    input: entry.semanticInput,
    inputFingerprint,
    priority: Object.freeze({
      previouslyDeferred: previousAttempt === "deferred",
      severityCandidate: true,
      ownerUnknown: entry.seed.responsible.some((responsible) => responsible.kind === "role"),
      changedBlocker:
        entry.semanticInput.relations.length !== 0 ||
        entry.semanticInput.pendingRelations.length !== 0,
      downstreamImpact:
        downstreamImpact == null
          ? Object.freeze({ openNodeCount: 0, repositoryCount: 0 })
          : Object.freeze({
              openNodeCount: downstreamImpact.openNodeCount,
              repositoryCount: downstreamImpact.repositoryCount,
            }),
    }),
  });
}

/** 前回評価を再利用する個人催促causeを数える。 */
export function personalReminderAssessmentReuseCount(
  plan: PersonalReminderCauseRuntimePlan,
): number {
  return plan.entries.filter((entry) => {
    if (entry.previousCause == null || entry.deterministicAssessment != null) {
      return false;
    }
    const inputFingerprint = createPersonalReminderCauseInputFingerprint(entry.semanticInput);
    return hasCurrentPersonalReminderAssessment(entry.previousCause, inputFingerprint);
  }).length;
}
