import { serializeCanonicalJson } from "../../canonical-json/index.js";
import { createPersonalReminderCauseInputFingerprint } from "../../codex/personal-reminder-input.js";
import type {
  PersonalReminderAiCauseRunOutcome,
  PersonalReminderAiRunResult,
} from "../../codex/personal-reminder-runner.js";
import {
  createPersonalReminderAiCacheKey,
  type PersonalReminderAiCacheKey,
} from "../../codex/personal-reminder-cache.js";
import {
  PERSONAL_REMINDER_AI_GENERATION_SCHEMA_VERSION,
  PERSONAL_REMINDER_AI_REVISION,
  PERSONAL_REMINDER_ASSESSMENT_RULES_VERSION,
  currentPersonalReminderAssessment,
  personalReminderCauseSchema,
  personalReminderCauseSeedSchema,
  type CurrentPersonalReminderAssessment,
  type PersonalReminderCause,
  type PersonalReminderCauseId,
} from "../../domain/personal-reminder-causes.js";
import {
  updatePersonalReminderActionableClock,
  updatePersonalReminderLastConfirmedActionability,
  type PreviousPersonalReminderClockState,
} from "../../domain/personal-reminder-staleness.js";
import type { Evidence, GitHubNodeId, UtcIsoDateTime } from "../../domain/types.js";
import type {
  PersonalReminderCauseRuntimePlan,
  PersonalReminderCauseRuntimePlanEntry,
} from "../personal-reminder-runtime.js";
import type {
  PersonalReminderAppliedItem,
  PersonalReminderOutcomeApplication,
} from "./analysis-result.js";

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function currentAssessmentFromCause(
  cause: PersonalReminderCause | undefined,
  fingerprint: string,
): CurrentPersonalReminderAssessment {
  if (
    cause?.currentInput.fingerprint !== fingerprint ||
    cause.currentInput.rulesVersion !== PERSONAL_REMINDER_ASSESSMENT_RULES_VERSION
  ) {
    return Object.freeze({ status: "not_available" });
  }
  return currentPersonalReminderAssessment(cause);
}

function originFromGeneration(
  generation: NonNullable<
    Extract<PersonalReminderAiCauseRunOutcome, { status: "accepted" }>["generation"]
  >,
  causeId: PersonalReminderCauseId,
): Readonly<{
  origin: Readonly<{
    kind: "ai";
    cacheEntryId: PersonalReminderAiCacheKey;
    metadata: typeof generation.metadata;
  }>;
  latestAttempt: Readonly<{
    status: "completed";
    inputFingerprint: typeof generation.metadata.inputFingerprint;
    completedAt: UtcIsoDateTime;
    origin: Readonly<{
      kind: "ai";
      cacheEntryId: PersonalReminderAiCacheKey;
      metadata: typeof generation.metadata;
    }>;
  }>;
}> {
  if (generation.metadata.rulesVersion !== PERSONAL_REMINDER_ASSESSMENT_RULES_VERSION) {
    throw new TypeError(`個人催促AI generationのrules versionが不一致です。対象: ${causeId}`);
  }
  const cacheKey = createPersonalReminderAiCacheKey({
    causeId,
    revision: PERSONAL_REMINDER_AI_REVISION,
    rulesVersion: PERSONAL_REMINDER_ASSESSMENT_RULES_VERSION,
    model: generation.metadata.model,
    reasoningEffort: generation.metadata.reasoningEffort,
    backendVersion: generation.metadata.backendVersion,
    schemaVersion: PERSONAL_REMINDER_AI_GENERATION_SCHEMA_VERSION,
    inputFingerprint: generation.metadata.inputFingerprint,
    executionFingerprint: generation.metadata.executionFingerprint,
  });
  const origin = Object.freeze({
    kind: "ai",
    cacheEntryId: cacheKey,
    metadata: generation.metadata,
  } satisfies Readonly<{
    kind: "ai";
    cacheEntryId: PersonalReminderAiCacheKey;
    metadata: typeof generation.metadata;
  }>);
  return Object.freeze({
    origin,
    latestAttempt: Object.freeze({
      status: "completed",
      inputFingerprint: generation.metadata.inputFingerprint,
      completedAt: generation.metadata.generatedAt,
      origin,
    } satisfies PersonalReminderCause["latestAttempt"]),
  });
}

function latestAttemptForOutcome(
  outcome: PersonalReminderAiCauseRunOutcome | undefined,
  fingerprint: string,
  attemptedAt: UtcIsoDateTime,
): PersonalReminderCause["latestAttempt"] | undefined {
  if (outcome?.status === "failed") {
    return Object.freeze({
      status: "failed",
      inputFingerprint: fingerprint,
      rulesVersion: PERSONAL_REMINDER_ASSESSMENT_RULES_VERSION,
      failedAt: attemptedAt,
      reason: outcome.reason,
    });
  }
  if (outcome?.status === "deferred") {
    return Object.freeze({
      status: "deferred",
      inputFingerprint: fingerprint,
      rulesVersion: PERSONAL_REMINDER_ASSESSMENT_RULES_VERSION,
      deferredAt: attemptedAt,
      reason: outcome.reason,
    });
  }
  return undefined;
}

function unavailableAdoptedAssessment(): PersonalReminderCause["adoptedAssessment"] {
  return Object.freeze({ status: "not_available" });
}

function notEvaluatedAttempt(): PersonalReminderCause["latestAttempt"] {
  return Object.freeze({ status: "not_evaluated" });
}

function assessmentForEntry(
  entry: PersonalReminderCauseRuntimePlanEntry,
  outcome: PersonalReminderAiCauseRunOutcome | undefined,
  fingerprint: string,
  attemptedAt: UtcIsoDateTime,
): Readonly<{
  assessment: CurrentPersonalReminderAssessment;
  adoptedAssessment: PersonalReminderCause["adoptedAssessment"];
  latestAttempt: PersonalReminderCause["latestAttempt"];
}> {
  const deterministic = entry.deterministicAssessment;
  if (deterministic != null) {
    const origin = Object.freeze({
      kind: "deterministic",
      rulesVersion: PERSONAL_REMINDER_ASSESSMENT_RULES_VERSION,
    } satisfies Readonly<{
      kind: "deterministic";
      rulesVersion: typeof PERSONAL_REMINDER_ASSESSMENT_RULES_VERSION;
    }>);
    const adoptedAssessment = Object.freeze({
      status: "available",
      inputFingerprint: fingerprint,
      rulesVersion: PERSONAL_REMINDER_ASSESSMENT_RULES_VERSION,
      result: deterministic,
      origin,
    } satisfies PersonalReminderCause["adoptedAssessment"]);
    return Object.freeze({
      assessment: Object.freeze({ status: "available", result: deterministic }),
      adoptedAssessment,
      latestAttempt:
        latestAttemptForOutcome(outcome, fingerprint, attemptedAt) ??
        Object.freeze({
          status: "completed",
          inputFingerprint: fingerprint,
          completedAt: attemptedAt,
          origin,
        } satisfies PersonalReminderCause["latestAttempt"]),
    });
  }
  if (outcome?.status === "accepted") {
    const generated = originFromGeneration(outcome.generation, entry.seed.causeId);
    const adoptedAssessment = Object.freeze({
      status: "available",
      inputFingerprint: fingerprint,
      rulesVersion: PERSONAL_REMINDER_ASSESSMENT_RULES_VERSION,
      result: outcome.generation.result,
      origin: generated.origin,
    } satisfies PersonalReminderCause["adoptedAssessment"]);
    return Object.freeze({
      assessment: Object.freeze({ status: "available", result: outcome.generation.result }),
      adoptedAssessment,
      latestAttempt: generated.latestAttempt,
    });
  }
  const previousAssessment = currentAssessmentFromCause(entry.previousCause, fingerprint);
  const latestAttempt = latestAttemptForOutcome(outcome, fingerprint, attemptedAt);
  const adoptedAssessment =
    entry.previousCause?.adoptedAssessment ?? unavailableAdoptedAssessment();
  if (latestAttempt != null) {
    return Object.freeze({
      assessment: previousAssessment,
      adoptedAssessment,
      latestAttempt,
    });
  }
  if (entry.previousCause != null) {
    return Object.freeze({
      assessment: previousAssessment,
      adoptedAssessment,
      latestAttempt: entry.previousCause.latestAttempt,
    });
  }
  return Object.freeze({
    assessment: Object.freeze({ status: "not_available" }),
    adoptedAssessment,
    latestAttempt: notEvaluatedAttempt(),
  });
}

function createCauseEvidence(
  entry: PersonalReminderCauseRuntimePlanEntry,
  assessment: CurrentPersonalReminderAssessment,
): readonly Evidence[] {
  const evidenceByIdentity = new Map<string, Evidence>();
  for (const evidence of entry.sourceEvidence) {
    evidenceByIdentity.set(evidenceIdentity(evidence), evidence);
  }
  if (assessment.status === "available") {
    for (const sourceId of assessment.result.references.sourceIds) {
      if (!entry.semanticInput.sources.some((source) => source.sourceId === sourceId)) {
        throw new TypeError(`assessmentがallowlist外sourceを参照しています。対象: ${sourceId}`);
      }
      const evidence: Evidence = Object.freeze({
        sourceId,
        supports: "notification",
        summary: assessment.result.references.reasonSummary,
      });
      evidenceByIdentity.set(evidenceIdentity(evidence), evidence);
    }
  }
  return Object.freeze(
    [...evidenceByIdentity.values()].sort((left, right) =>
      compareStrings(evidenceIdentity(left), evidenceIdentity(right)),
    ),
  );
}

function evidenceIdentity(evidence: Evidence): string {
  return serializeCanonicalJson(evidence);
}

function previousClock(
  cause: PersonalReminderCause | undefined,
): PreviousPersonalReminderClockState {
  if (cause == null) {
    return Object.freeze({ availability: "not_available" });
  }
  return Object.freeze({ availability: "available", value: cause.actionableClock });
}

/** causeの評価結果を時計と項目単位のevidenceへ適用する。 */
export function applyPersonalReminderCauseOutcomes(
  input: Readonly<{
    plan: PersonalReminderCauseRuntimePlan;
    outcomes: PersonalReminderAiRunResult | undefined;
    evaluatedAt: UtcIsoDateTime;
  }>,
): PersonalReminderOutcomeApplication {
  const itemsByNodeId = new Map<
    GitHubNodeId,
    { itemNodeId: GitHubNodeId; causes: PersonalReminderCause[]; evidence: Evidence[] }
  >();
  for (const itemNodeId of input.plan.applicableItemNodeIds) {
    if (itemsByNodeId.has(itemNodeId)) {
      throw new TypeError(`個人催促planの適用項目IDが重複しています。対象: ${itemNodeId}`);
    }
    itemsByNodeId.set(itemNodeId, { itemNodeId, causes: [], evidence: [] });
  }
  for (const cause of input.plan.preservedCauses) {
    const item = itemsByNodeId.get(cause.itemNodeId);
    if (item == null) {
      throw new TypeError(`個人催促の保持causeが適用対象外です。対象: ${cause.itemNodeId}`);
    }
    item.causes.push(cause);
  }
  for (const [itemNodeId, evidence] of input.plan.preservedEvidenceByNodeId) {
    const item = itemsByNodeId.get(itemNodeId);
    if (item == null) {
      throw new TypeError(`個人催促の保持evidenceが適用対象外です。対象: ${itemNodeId}`);
    }
    item.evidence.push(...evidence);
  }
  for (const entry of input.plan.entries) {
    const item = itemsByNodeId.get(entry.seed.itemNodeId);
    if (item == null) {
      throw new TypeError(`個人催促のplan entryが適用対象外です。対象: ${entry.seed.itemNodeId}`);
    }
    const fingerprint = createPersonalReminderCauseInputFingerprint(entry.semanticInput);
    const outcome = input.outcomes?.outcomesByCauseId.get(entry.seed.causeId);
    const evaluation = assessmentForEntry(entry, outcome, fingerprint, input.evaluatedAt);
    const clock = updatePersonalReminderActionableClock({
      cause: personalReminderCauseSeedSchema.parse({
        ...entry.seed,
        lastConfirmedActionability: entry.seed.lastConfirmedActionability,
      }),
      assessment: evaluation.assessment,
      previous: previousClock(entry.previousCause),
      actionabilityStart: entry.activity.actionabilityStartByAction.get(entry.seed.action.kind),
      relevantProgress: entry.activity.relevantProgress,
      responsibleActivity: entry.activity.responsibleActivity,
      humanReviewActivity: entry.activity.humanReviewActivity,
      currentObservedAt: input.evaluatedAt,
    });
    const lastConfirmedActionability = updatePersonalReminderLastConfirmedActionability(
      evaluation.assessment,
      entry.seed.lastConfirmedActionability,
    );
    const cause = personalReminderCauseSchema.parse({
      ...entry.seed,
      responseMembershipAssessmentRequirement: entry.responseMembershipAssessmentRequirement,
      lastConfirmedActionability,
      currentInput: {
        fingerprint,
        rulesVersion: PERSONAL_REMINDER_ASSESSMENT_RULES_VERSION,
        completeness: entry.semanticInput.completeness,
        aiDependency: entry.currentInputAiDependency,
      },
      latestAttempt: evaluation.latestAttempt,
      adoptedAssessment: evaluation.adoptedAssessment,
      actionableClock: clock,
    });
    item.causes.push(cause);
    const evidence = createCauseEvidence(entry, evaluation.assessment);
    const evidenceByIdentity = new Map(
      item.evidence.map((value) => [evidenceIdentity(value), value]),
    );
    for (const value of evidence) {
      evidenceByIdentity.set(evidenceIdentity(value), value);
    }
    item.evidence = [...evidenceByIdentity.values()];
  }
  const appliedItemsByNodeId = new Map<GitHubNodeId, PersonalReminderAppliedItem>();
  for (const [itemNodeId, item] of itemsByNodeId) {
    appliedItemsByNodeId.set(
      itemNodeId,
      Object.freeze({
        itemNodeId,
        causes: Object.freeze(
          item.causes.sort((left, right) => compareStrings(left.causeId, right.causeId)),
        ),
        evidence: Object.freeze(
          item.evidence.sort((left, right) =>
            compareStrings(evidenceIdentity(left), evidenceIdentity(right)),
          ),
        ),
      }),
    );
  }
  return Object.freeze({ itemsByNodeId: appliedItemsByNodeId });
}
