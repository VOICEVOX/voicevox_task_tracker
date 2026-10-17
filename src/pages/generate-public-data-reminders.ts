import {
  currentPersonalReminderAssessment,
  PERSONAL_REMINDER_ASSESSMENT_RULES_VERSION,
  PERSONAL_REMINDER_CAUSE_PLANNING_VERSION,
  type CurrentPersonalReminderAssessment,
  type PersonalReminderCause,
} from "../domain/index.js";
import type { StateSnapshot } from "../persistence/index.js";
import { UnreachableError } from "../util/index.js";
import type { EvidenceSourceUrlMap } from "./evidence-source-url.js";
import {
  hasUnverifiedAiDependency,
  isUnverifiedAiDependency,
} from "./generate-public-data-ai-analysis.js";
import {
  createPersonalReminderResponseEvidence,
  type EvidenceSourceItem,
} from "./generate-public-data-evidence.js";
import {
  addResponsibleCurrentResponseSubjectChanges,
  createPublicCurrentResponseSubjectChangesAccumulator,
  finalizePublicCurrentResponseSubjectChanges,
} from "./generate-public-data-reminder-subjects.js";
import type {
  PublicCurrentResponseSubjectChangesDto,
  PublicItemSummaryDto,
  PublicPersonalReminderResponseDto,
  PublicPersonalReminderUnknownReason,
} from "./public-dto-contracts.js";
import { compareStrings } from "./public-dto-primitives.js";

type PublicPersonalReminderResponse = PublicPersonalReminderResponseDto;
type PublicPersonalReminderUnverifiedValue =
  PublicPersonalReminderResponse["unverifiedValues"][number];
export type PublicPersonalReminderResponses = Readonly<{
  responses: readonly PublicPersonalReminderResponse[];
  currentResponsesUnverified: boolean;
  currentResponseSubjectChanges: PublicCurrentResponseSubjectChangesDto;
}>;
type PublicPersonalReminderCausePlanningStatus =
  PublicItemSummaryDto["personalReminderCausePlanningStatus"];

function createPersonalReminderUnverifiedValues(
  cause: PersonalReminderCause,
  assessment: CurrentPersonalReminderAssessment,
  hasCurrentAssessmentEvidence: boolean,
): PublicPersonalReminderResponse["unverifiedValues"] {
  const values: PublicPersonalReminderUnverifiedValue[] = [];
  const statusDependencies = [cause.aiDependencies.presence];
  if (assessment.status === "available") {
    statusDependencies.push(cause.currentInput.aiDependency);
  }
  if (hasUnverifiedAiDependency(statusDependencies)) {
    values.push("status");
  }
  if (isUnverifiedAiDependency(cause.aiDependencies.responsible)) {
    values.push("responsible");
  }
  if (isUnverifiedAiDependency(cause.aiDependencies.action)) {
    values.push("action");
  }
  if (
    isUnverifiedAiDependency(cause.aiDependencies.evidence) ||
    (hasCurrentAssessmentEvidence && isUnverifiedAiDependency(cause.currentInput.aiDependency))
  ) {
    values.push("evidence");
  }
  if (
    assessment.status === "available" &&
    assessment.result.verdict === "waiting" &&
    isUnverifiedAiDependency(cause.currentInput.aiDependency)
  ) {
    values.push("waitingFor");
  }
  return values;
}

function personalReminderMembershipAssessmentUnverified(
  cause: PersonalReminderCause,
  assessment: CurrentPersonalReminderAssessment,
): boolean {
  switch (cause.responseMembershipAssessmentRequirement.status) {
    case "not_required":
      return false;
    case "required":
      return assessment.status !== "available";
    case "unknown":
      return true;
    default:
      throw new UnreachableError(cause.responseMembershipAssessmentRequirement);
  }
}

function personalReminderResponseMembershipUnverified(
  cause: PersonalReminderCause,
  assessment: CurrentPersonalReminderAssessment,
): boolean {
  return (
    personalReminderMembershipAssessmentUnverified(cause, assessment) ||
    hasUnverifiedAiDependency([
      cause.aiDependencies.presence,
      cause.aiDependencies.responseMembership,
      cause.aiDependencies.responsible,
    ])
  );
}

function createPersonalReminderSubjectMembershipUnverified(
  cause: PersonalReminderCause,
  assessment: CurrentPersonalReminderAssessment,
): boolean {
  return (
    cause.responsible.some((responsible) => responsible.kind !== "role") &&
    personalReminderResponseMembershipUnverified(cause, assessment)
  );
}

/** 項目のAI利用状態を公開値へ写す。 */
function personalReminderUnknownReason(
  cause: PersonalReminderCause,
): PublicPersonalReminderUnknownReason {
  switch (cause.latestAttempt.status) {
    case "not_evaluated":
      return "not_evaluated";
    case "failed":
      return cause.currentInput.rulesVersion === PERSONAL_REMINDER_ASSESSMENT_RULES_VERSION &&
        cause.latestAttempt.inputFingerprint === cause.currentInput.fingerprint &&
        cause.latestAttempt.rulesVersion === cause.currentInput.rulesVersion
        ? "failed"
        : "input_mismatch";
    case "deferred":
      return cause.currentInput.rulesVersion === PERSONAL_REMINDER_ASSESSMENT_RULES_VERSION &&
        cause.latestAttempt.inputFingerprint === cause.currentInput.fingerprint &&
        cause.latestAttempt.rulesVersion === cause.currentInput.rulesVersion
        ? "deferred"
        : "input_mismatch";
    case "completed":
      return "input_mismatch";
  }
}

function createPersonalReminderResponseBase(
  cause: PersonalReminderCause,
  evidence: PublicPersonalReminderResponse["evidence"],
): Omit<
  PublicPersonalReminderResponse,
  "status" | "waitingFor" | "reason" | "unverifiedValues" | "subjectMembershipUnverified"
> {
  return {
    causeId: cause.causeId,
    responsible: cause.responsible.map((responsible) => ({
      kind: responsible.kind,
      candidateId: responsible.candidateId,
      role: responsible.role,
    })),
    action: {
      kind: cause.action.kind,
      summary: cause.action.summary,
    },
    evidence,
  };
}

function createPersonalReminderResponse(
  cause: PersonalReminderCause,
  assessment: CurrentPersonalReminderAssessment,
  currentSourceItem: StateSnapshot["items"][number],
  allSourceItems: readonly EvidenceSourceItem[],
  sourceOwnersById: EvidenceSourceUrlMap,
): PublicPersonalReminderResponse | undefined {
  if (assessment.status === "available") {
    if (assessment.result.verdict === "duplicate" || assessment.result.verdict === "not_required") {
      return undefined;
    }
  }
  const assessmentReferences =
    assessment.status === "available" &&
    assessment.result.verdict !== "duplicate" &&
    assessment.result.verdict !== "not_required"
      ? assessment.result.references
      : undefined;
  const evidence = createPersonalReminderResponseEvidence(
    [...cause.evidenceSourceIds, ...(assessmentReferences?.sourceIds ?? [])],
    currentSourceItem,
    allSourceItems,
    sourceOwnersById,
  );
  const hasCurrentAssessmentEvidence =
    assessmentReferences != null && assessmentReferences.sourceIds.length > 0;
  const unverifiedValues = createPersonalReminderUnverifiedValues(
    cause,
    assessment,
    hasCurrentAssessmentEvidence,
  );
  const subjectMembershipUnverified = createPersonalReminderSubjectMembershipUnverified(
    cause,
    assessment,
  );
  const base = createPersonalReminderResponseBase(cause, evidence);
  if (assessment.status !== "available") {
    return {
      ...base,
      status: "unknown",
      reason: personalReminderUnknownReason(cause),
      unverifiedValues,
      subjectMembershipUnverified,
    };
  }
  switch (assessment.result.verdict) {
    case "actionable":
      return {
        ...base,
        status: "actionable",
        unverifiedValues,
        subjectMembershipUnverified,
      };
    case "waiting":
      return {
        ...base,
        status: "waiting",
        waitingFor: {
          itemNodeId: assessment.result.waitingFor.itemNodeId,
          action: assessment.result.waitingFor.action,
        },
        unverifiedValues,
        subjectMembershipUnverified,
      };
    case "unknown":
      return {
        ...base,
        status: "unknown",
        reason: assessment.result.reason,
        unverifiedValues,
        subjectMembershipUnverified,
      };
    case "duplicate":
    case "not_required":
      return undefined;
  }
}

/** 個人催促の計画状態を公開値へ写す。 */
export function personalReminderCausePlanningStatus(
  item: StateSnapshot["items"][number],
): PublicPersonalReminderCausePlanningStatus {
  if (
    item.personalReminderCausePlanning.planningVersion !== PERSONAL_REMINDER_CAUSE_PLANNING_VERSION
  ) {
    return "pending";
  }
  return item.personalReminderCausePlanning.status;
}

/** 個人催促の現在応答を公開値へ写す。 */
export function createPersonalReminderResponses(
  item: StateSnapshot["items"][number],
  allSourceItems: readonly EvidenceSourceItem[],
  sourceOwnersById: EvidenceSourceUrlMap,
): PublicPersonalReminderResponses {
  const planning = item.personalReminderCausePlanning;
  if (
    planning.status !== "completed" ||
    planning.planningVersion !== PERSONAL_REMINDER_CAUSE_PLANNING_VERSION
  ) {
    const currentResponseSubjectChanges: PublicCurrentResponseSubjectChangesDto = {
      scope: "bounded",
      addableSubjects: [],
      removableSubjects: [],
    };
    return Object.freeze({
      responses: Object.freeze([]),
      currentResponsesUnverified: false,
      currentResponseSubjectChanges,
    });
  }
  const responses: PublicPersonalReminderResponse[] = [];
  let currentResponsesUnverified = isUnverifiedAiDependency(planning.causeSetAiDependency);
  const subjectChanges = createPublicCurrentResponseSubjectChangesAccumulator(
    planning.causeSetSubjectChanges,
  );
  for (const cause of item.personalReminderCauses) {
    const assessment = currentPersonalReminderAssessment(cause);
    const responseMembershipUnverified = personalReminderResponseMembershipUnverified(
      cause,
      assessment,
    );
    if (responseMembershipUnverified) {
      currentResponsesUnverified = true;
    }
    const response = createPersonalReminderResponse(
      cause,
      assessment,
      item,
      allSourceItems,
      sourceOwnersById,
    );
    if (response != null) {
      responses.push(response);
      if (response.subjectMembershipUnverified) {
        addResponsibleCurrentResponseSubjectChanges(subjectChanges, "removable", cause.responsible);
      }
      if (isUnverifiedAiDependency(cause.aiDependencies.responsible)) {
        subjectChanges.unbounded = true;
      }
      continue;
    }
    if (responseMembershipUnverified) {
      addResponsibleCurrentResponseSubjectChanges(subjectChanges, "addable", cause.responsible);
      if (isUnverifiedAiDependency(cause.aiDependencies.responsible)) {
        subjectChanges.unbounded = true;
      }
    }
  }
  const sortedResponses = responses.sort((left, right) =>
    compareStrings(left.causeId, right.causeId),
  );
  return Object.freeze({
    responses: Object.freeze(sortedResponses),
    currentResponsesUnverified,
    currentResponseSubjectChanges: finalizePublicCurrentResponseSubjectChanges(
      subjectChanges,
      sortedResponses,
    ),
  });
}
