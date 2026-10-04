import { type AiAnalysisElementApplications } from "../domain/ai-analysis-elements.js";
import {
  isTerminalStatus,
  migratedAiAnalysisDependency,
  migratedPersonalReminderCauseAiDependencies,
  PERSONAL_REMINDER_ASSESSMENT_MIGRATION_RULES_VERSION,
  personalReminderCausePlanningSchema,
  personalReminderCauseSchema,
  personalReminderEvaluationAttemptSchema,
  type PersonalReminderCause,
  type PersonalReminderCausePlanning,
} from "../domain/index.js";
import { UnreachableError } from "../util/index.js";
import { StateSnapshotSemanticError } from "./errors.js";
import type {
  LegacyPersonalReminderCause,
  LegacyPersonalReminderCausePlanning,
} from "./snapshot-contracts.js";
import { migratedAiAnalysisElementApplications } from "./snapshot-migration-relations.js";
import type { LegacyRelation, LegacyTrackedItem } from "./snapshot-migration-schema.js";

function migratePersonalReminderCause(cause: LegacyPersonalReminderCause): PersonalReminderCause {
  return personalReminderCauseSchema.parse({
    ...cause,
    responseMembershipAssessmentRequirement:
      cause.responsibility.authority === "semantic"
        ? { status: "required" }
        : { status: "unknown", reason: "migration" },
    aiDependencies: migratedPersonalReminderCauseAiDependencies(),
    currentInput: {
      ...cause.currentInput,
      aiDependency: migratedAiAnalysisDependency(),
    },
    latestAttempt: migratePersonalReminderEvaluationAttempt(cause.latestAttempt),
  });
}

function migratePersonalReminderEvaluationAttempt(
  attempt: LegacyPersonalReminderCause["latestAttempt"],
): PersonalReminderCause["latestAttempt"] {
  switch (attempt.status) {
    case "not_evaluated":
    case "completed":
      return attempt;
    case "failed":
      return personalReminderEvaluationAttemptSchema.parse({
        ...attempt,
        rulesVersion: PERSONAL_REMINDER_ASSESSMENT_MIGRATION_RULES_VERSION,
      });
    case "deferred":
      return personalReminderEvaluationAttemptSchema.parse({
        ...attempt,
        rulesVersion: PERSONAL_REMINDER_ASSESSMENT_MIGRATION_RULES_VERSION,
      });
    default:
      throw new UnreachableError(attempt);
  }
}

export function migratePersonalReminderCauses(
  causes: readonly LegacyPersonalReminderCause[],
): readonly PersonalReminderCause[] {
  return causes.map(migratePersonalReminderCause);
}

export function migratePersonalReminderCausePlanning(
  planning: LegacyPersonalReminderCausePlanning,
): PersonalReminderCausePlanning {
  if (planning.status !== "completed") {
    return planning;
  }
  return personalReminderCausePlanningSchema.parse({
    ...planning,
    causeSetAiDependency: migratedAiAnalysisDependency(),
    causeSetSubjectChanges: {
      scope: "unbounded",
    },
  });
}

const LEGACY_PERSONAL_REMINDER_CAUSE_PLANNING_VERSION = "personal-reminder-planning-v1";

export function migratedPersonalReminderCausePlanning(
  status: LegacyTrackedItem["status"],
): PersonalReminderCausePlanning {
  if (isTerminalStatus(status)) {
    return {
      status: "excluded",
      planningVersion: LEGACY_PERSONAL_REMINDER_CAUSE_PLANNING_VERSION,
      reason: "terminal_without_cause",
    };
  }
  return {
    status: "pending",
    planningVersion: LEGACY_PERSONAL_REMINDER_CAUSE_PLANNING_VERSION,
  };
}

export function migrationCollectionAiAnalysis(): Readonly<{
  origin: "migration";
  status: "not_recorded";
  elements: Readonly<Record<string, never>>;
  adoptedElements: Readonly<Record<string, never>>;
  applications: AiAnalysisElementApplications;
}> {
  return {
    origin: "migration",
    status: "not_recorded",
    elements: {},
    adoptedElements: {},
    applications: migratedAiAnalysisElementApplications(),
  };
}

export function createLegacyRelationsById(
  relations: readonly LegacyRelation[],
): ReadonlyMap<string, LegacyRelation> {
  const relationsById = new Map<string, LegacyRelation>();
  for (const relation of relations) {
    if (relationsById.has(relation.id)) {
      throw new StateSnapshotSemanticError(`relation IDが重複しています。対象: ${relation.id}`);
    }
    relationsById.set(relation.id, relation);
  }
  return relationsById;
}
