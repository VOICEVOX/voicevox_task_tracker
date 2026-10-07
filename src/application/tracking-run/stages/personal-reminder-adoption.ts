import { serializeCanonicalJson } from "../../../canonical-json/value.js";
import { ZodError } from "zod";
import { createPersonalReminderCauseInputFingerprint } from "../../../codex/personal-reminder-input-assessment.js";
import {
  PERSONAL_REMINDER_AI_REVISION,
  PERSONAL_REMINDER_ASSESSMENT_RULES_VERSION,
  currentPersonalReminderAssessment,
  type CurrentPersonalReminderAssessment,
  type PersonalReminderAdoptedAssessment,
  type PersonalReminderEvaluationAttempt,
} from "../../../domain/personal-reminder-causes.js";
import type { UtcIsoDateTime } from "../../../domain/types.js";
import type { ReasoningEffort } from "../../../domain/types.js";
import { assertNonNullable } from "../../../util/index.js";
import type { ContentDigestPort } from "../contracts/content-digest-port.js";
import type { PersonalReminderAssessmentAdoption } from "../contracts/personal-reminder-outcome.js";
import {
  assertPersonalReminderAssessment,
  assertPersonalReminderGeneration,
  PersonalReminderAssessmentRejectedError,
} from "./personal-reminder-adoption-validation.js";
import type { PersonalReminderExecutionOutcome } from "./personal-reminder-execution.js";
import type { PersonalReminderCauseDecision } from "./personal-reminder-plan-contracts.js";
import type { CanonicalPersonalReminderCausePlan } from "./personal-reminder-plan-contracts.js";

type CanonicalEntry = CanonicalPersonalReminderCausePlan["entries"][number];

function hash(
  value: unknown,
  digest: ContentDigestPort,
): ReturnType<ContentDigestPort["sha256Utf8"]> {
  return digest.sha256Utf8(serializeCanonicalJson(value));
}

function aiOrigin(
  outcome: Extract<PersonalReminderExecutionOutcome, { status: "completed" | "cache_hit" }>,
  digest: ContentDigestPort,
): Extract<PersonalReminderAdoptedAssessment, { status: "available" }>["origin"] {
  const metadata = outcome.generation.metadata;
  const cacheEntryId = hash(
    {
      backendVersion: metadata.backendVersion,
      causeId: outcome.cause.causeId,
      executionFingerprint: metadata.executionFingerprint,
      inputFingerprint: metadata.inputFingerprint,
      model: metadata.model,
      reasoningEffort: metadata.reasoningEffort,
      revision: metadata.revision,
      rulesVersion: metadata.rulesVersion,
      schemaVersion: metadata.schemaVersion,
    },
    digest,
  );
  if (
    outcome.status === "cache_hit" &&
    outcome.cause.choice === "cache_hit" &&
    outcome.cause.entry.cacheKey !== cacheEntryId
  ) {
    throw new TypeError(`個人催促cacheの採用元が一致しません。対象: ${outcome.cause.causeId}`);
  }
  return Object.freeze({ kind: "ai", cacheEntryId, metadata });
}

function previousCurrentAssessment(
  entry: CanonicalEntry,
  decision: PersonalReminderCauseDecision,
  digest: ContentDigestPort,
): CurrentPersonalReminderAssessment {
  const previous = entry.previousCause;
  if (previous?.currentInput.fingerprint !== decision.fingerprint) {
    return Object.freeze({ status: "not_available" });
  }
  if (previous.currentInput.rulesVersion !== PERSONAL_REMINDER_ASSESSMENT_RULES_VERSION) {
    return Object.freeze({ status: "not_available" });
  }
  const current = currentPersonalReminderAssessment({
    currentInput: Object.freeze({
      fingerprint: decision.fingerprint,
      rulesVersion: PERSONAL_REMINDER_ASSESSMENT_RULES_VERSION,
      aiDependency: entry.currentInputAiDependency,
    }),
    adoptedAssessment: previous.adoptedAssessment,
  });
  if (current.status === "available") {
    const adopted = previous.adoptedAssessment;
    if (adopted.status !== "available") {
      throw new TypeError(`個人催促旧assessmentの採用値がありません。対象: ${decision.causeId}`);
    }
    assertPersonalReminderAssessment(
      current.result,
      decision,
      0,
      adopted.origin.kind === "deterministic",
    );
    if (adopted.origin.kind === "deterministic") {
      if (adopted.origin.rulesVersion !== PERSONAL_REMINDER_ASSESSMENT_RULES_VERSION) {
        throw new TypeError(`個人催促旧fixed producerの規則が不正です。対象: ${decision.causeId}`);
      }
    } else {
      const metadata = adopted.origin.metadata;
      if (
        metadata.inputFingerprint !== decision.fingerprint ||
        metadata.rulesVersion !== PERSONAL_REMINDER_ASSESSMENT_RULES_VERSION ||
        metadata.revision !== PERSONAL_REMINDER_AI_REVISION ||
        hash(current.result, digest) !== metadata.outputHash ||
        hash(
          {
            backendVersion: metadata.backendVersion,
            causeId: decision.causeId,
            executionFingerprint: metadata.executionFingerprint,
            inputFingerprint: metadata.inputFingerprint,
            model: metadata.model,
            reasoningEffort: metadata.reasoningEffort,
            revision: metadata.revision,
            rulesVersion: metadata.rulesVersion,
            schemaVersion: metadata.schemaVersion,
          },
          digest,
        ) !== adopted.origin.cacheEntryId
      ) {
        throw new TypeError(`個人催促旧AI producerの由来が不正です。対象: ${decision.causeId}`);
      }
    }
  }
  return current;
}

/** 原因の全実行経路を現入力と照合して一つの採用結果へ確定する。 */
export function adoptPersonalReminderAssessment(
  entry: CanonicalEntry,
  outcome: PersonalReminderExecutionOutcome,
  evaluatedAt: UtcIsoDateTime,
  minimumConfidence: number,
  execution: Readonly<{ model: string; reasoningEffort: ReasoningEffort }>,
  batchInputFingerprint: string | undefined,
  digest: ContentDigestPort,
): PersonalReminderAssessmentAdoption {
  const decision = outcome.cause;
  if (
    decision.causeId !== entry.seed.causeId ||
    decision.itemNodeId !== entry.seed.itemNodeId ||
    decision.exactInput.cause.causeId !== entry.seed.causeId ||
    decision.exactInput.cause.itemNodeId !== entry.seed.itemNodeId ||
    serializeCanonicalJson(decision.exactInput.cause) !==
      serializeCanonicalJson({
        causeId: entry.seed.causeId,
        itemNodeId: entry.seed.itemNodeId,
        reasonCode: entry.seed.reasonCode,
        responsible: entry.seed.responsible,
        responsibility: entry.seed.responsibility,
        action: entry.seed.action,
      }) ||
    createPersonalReminderCauseInputFingerprint(decision.exactInput, digest) !==
      decision.fingerprint ||
    serializeCanonicalJson(decision.exactInput) !== serializeCanonicalJson(entry.semanticInput)
  ) {
    throw new TypeError(`個人催促assessmentの計画入力が一致しません。対象: ${entry.seed.causeId}`);
  }
  let latestAttempt: PersonalReminderEvaluationAttempt;
  let adoptedAssessment: PersonalReminderAdoptedAssessment;
  let applicationSource: PersonalReminderAssessmentAdoption["applicationSource"];
  if (outcome.status === "deterministic") {
    if (decision.choice !== "deterministic" || entry.deterministicAssessment == null) {
      throw new TypeError(
        `個人催促fixed assessmentの計画が一致しません。対象: ${decision.causeId}`,
      );
    }
    assertPersonalReminderAssessment(
      entry.deterministicAssessment,
      decision,
      minimumConfidence,
      true,
    );
    const origin = Object.freeze({
      kind: "deterministic",
      rulesVersion: PERSONAL_REMINDER_ASSESSMENT_RULES_VERSION,
    } satisfies Extract<PersonalReminderAdoptedAssessment, { status: "available" }>["origin"]);
    adoptedAssessment = Object.freeze({
      status: "available",
      inputFingerprint: decision.fingerprint,
      rulesVersion: PERSONAL_REMINDER_ASSESSMENT_RULES_VERSION,
      result: entry.deterministicAssessment,
      origin,
    });
    latestAttempt = Object.freeze({
      status: "completed",
      inputFingerprint: decision.fingerprint,
      completedAt: evaluatedAt,
      origin,
    });
    applicationSource = "fixed";
  } else if (outcome.status === "completed" || outcome.status === "cache_hit") {
    if (
      (outcome.status === "completed" && decision.choice !== "execute") ||
      (outcome.status === "cache_hit" && decision.choice !== "cache_hit") ||
      entry.deterministicAssessment != null
    ) {
      throw new TypeError(
        `個人催促AI assessmentの実行元が計画と一致しません。対象: ${decision.causeId}`,
      );
    }
    assertPersonalReminderGeneration(outcome.generation, decision, execution, digest);
    try {
      assertPersonalReminderAssessment(
        outcome.generation.result,
        decision,
        minimumConfidence,
        false,
      );
      if (
        (outcome.generation.result.verdict === "duplicate" ||
          outcome.generation.result.verdict === "not_required") &&
        entry.responseMembershipAssessmentRequirement.status !== "required"
      ) {
        throw new PersonalReminderAssessmentRejectedError(
          `個人催促のresponse除外には人物所属の意味判定が必要です。対象: ${decision.causeId}`,
        );
      }
    } catch (error: unknown) {
      if (!(
        error instanceof PersonalReminderAssessmentRejectedError || error instanceof ZodError
      )) {
        throw error;
      }
      return adoptPersonalReminderAssessment(
        entry,
        Object.freeze({ cause: decision, status: "failed", reason: "semantic_validation_failed" }),
        evaluatedAt,
        minimumConfidence,
        execution,
        batchInputFingerprint,
        digest,
      );
    }
    if (
      outcome.status === "completed" &&
      (batchInputFingerprint == null ||
        outcome.generation.metadata.batchInputFingerprint !== batchInputFingerprint)
    ) {
      throw new TypeError(`個人催促AIのbatch由来が不正です。対象: ${decision.causeId}`);
    }
    const origin = aiOrigin(outcome, digest);
    adoptedAssessment = Object.freeze({
      status: "available",
      inputFingerprint: decision.fingerprint,
      rulesVersion: PERSONAL_REMINDER_ASSESSMENT_RULES_VERSION,
      result: outcome.generation.result,
      origin,
    });
    latestAttempt = Object.freeze({
      status: "completed",
      inputFingerprint: decision.fingerprint,
      completedAt: outcome.generation.metadata.generatedAt,
      origin,
    });
    applicationSource = outcome.status === "completed" ? "new" : "cache";
  } else if (outcome.status === "snapshot_reuse") {
    if (decision.choice !== "snapshot_reuse") {
      throw new TypeError(`個人催促旧assessmentの計画が一致しません。対象: ${decision.causeId}`);
    }
    const previous = entry.previousCause;
    assertNonNullable(previous, `個人催促旧assessmentがありません。対象: ${decision.causeId}`);
    const previousCurrent = previousCurrentAssessment(entry, decision, digest);
    adoptedAssessment = previous.adoptedAssessment;
    latestAttempt = previous.latestAttempt;
    applicationSource = previousCurrent.status === "available" ? "snapshot" : "retained";
  } else {
    if (!("reason" in outcome)) {
      throw new TypeError(`個人催促評価状態が不正です。対象: ${decision.causeId}`);
    }
    if (
      (outcome.status === "failed" &&
        decision.choice !== "execute" &&
        decision.choice !== "cache_hit") ||
      (outcome.status === "deferred" &&
        decision.choice !== "deferred" &&
        decision.choice !== "execute")
    ) {
      throw new TypeError(`個人催促評価失敗の計画が一致しません。対象: ${decision.causeId}`);
    }
    const previous = entry.previousCause;
    adoptedAssessment = previous?.adoptedAssessment ?? Object.freeze({ status: "not_available" });
    if (outcome.status === "failed") {
      latestAttempt = Object.freeze({
        status: "failed",
        inputFingerprint: decision.fingerprint,
        rulesVersion: PERSONAL_REMINDER_ASSESSMENT_RULES_VERSION,
        failedAt: evaluatedAt,
        reason: outcome.reason,
      });
    } else if (outcome.reason === "ai_disabled" || outcome.reason === "forced_generic_target") {
      latestAttempt = previous?.latestAttempt ?? Object.freeze({ status: "not_evaluated" });
    } else {
      latestAttempt = Object.freeze({
        status: "deferred",
        inputFingerprint: decision.fingerprint,
        rulesVersion: PERSONAL_REMINDER_ASSESSMENT_RULES_VERSION,
        deferredAt: evaluatedAt,
        reason: outcome.reason,
      });
    }
    previousCurrentAssessment(entry, decision, digest);
    applicationSource = previous == null ? "none" : "retained";
  }
  const currentAssessment = currentPersonalReminderAssessment({
    currentInput: Object.freeze({
      fingerprint: decision.fingerprint,
      rulesVersion: PERSONAL_REMINDER_ASSESSMENT_RULES_VERSION,
      aiDependency: entry.currentInputAiDependency,
    }),
    adoptedAssessment,
  });
  if (
    currentAssessment.status === "available" &&
    adoptedAssessment.status === "available" &&
    adoptedAssessment.origin.kind === "ai" &&
    adoptedAssessment.origin.metadata.revision !== PERSONAL_REMINDER_AI_REVISION
  ) {
    throw new TypeError(`個人催促assessmentのAI revisionが不正です。対象: ${decision.causeId}`);
  }
  return Object.freeze({
    causeId: decision.causeId,
    inputFingerprint: decision.fingerprint,
    applicationSource,
    currentness: currentAssessment.status === "available" ? "available" : "unverified",
    latestAttempt,
    adoptedAssessment,
    currentAssessment,
  });
}
