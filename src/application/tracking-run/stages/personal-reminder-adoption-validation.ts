import { serializeCanonicalJson } from "../../../canonical-json/value.js";
import { CODEX_BACKEND_VERSION } from "../../../codex/backend-version.js";
import type {
  PersonalReminderCauseSemanticInput,
  PersonalReminderEvidenceRole,
} from "../../../codex/personal-reminder-input-contracts.js";
import type { SourceId } from "../../../domain/source-id.js";
import type { GraphNodeId, ReasoningEffort } from "../../../domain/types.js";
import {
  PERSONAL_REMINDER_AI_GENERATION_SCHEMA_VERSION,
  PERSONAL_REMINDER_AI_INPUT_SCHEMA_VERSION,
  PERSONAL_REMINDER_AI_OUTPUT_SCHEMA_VERSION,
  PERSONAL_REMINDER_AI_PROMPT_VERSION,
  PERSONAL_REMINDER_AI_REVISION,
  PERSONAL_REMINDER_ASSESSMENT_RULES_VERSION,
  personalReminderAiGenerationSchema,
  personalReminderCauseAssessmentSchema,
  type PersonalReminderAiGeneration,
  type PersonalReminderCauseAssessment,
  type PersonalReminderResponsible,
} from "../../../domain/personal-reminder-causes.js";
import type { ContentDigestPort } from "../contracts/content-digest-port.js";
import type { PersonalReminderCauseDecision } from "./personal-reminder-plan-contracts.js";

/** 個人催促候補を採用できない意味検証エラー。 */
export class PersonalReminderAssessmentRejectedError extends TypeError {}

function assertUniqueAllowed(
  values: readonly string[],
  allowed: ReadonlySet<string>,
  causeId: string,
  kind: string,
): void {
  if (new Set(values).size !== values.length || values.some((value) => !allowed.has(value))) {
    throw new PersonalReminderAssessmentRejectedError(
      `個人催促assessmentの${kind}参照が現入力と一致しません。対象: ${causeId}`,
    );
  }
}

function optionReferencesPresent(
  references: PersonalReminderCauseAssessment["references"],
  option: Readonly<{
    itemNodeId: GraphNodeId;
    relationIds: readonly string[];
    evidenceSourceIds: readonly SourceId[];
  }>,
): boolean {
  return (
    references.nodeIds.includes(option.itemNodeId) &&
    option.relationIds.every((id) => references.relationIds.includes(id)) &&
    option.evidenceSourceIds.every((id) => references.sourceIds.includes(id))
  );
}

function assertOptionReferences(
  references: PersonalReminderCauseAssessment["references"],
  option: Parameters<typeof optionReferencesPresent>[1],
  causeId: string,
): void {
  if (!optionReferencesPresent(references, option)) {
    throw new PersonalReminderAssessmentRejectedError(
      `個人催促assessmentのoption根拠が不足しています。対象: ${causeId}`,
    );
  }
}

function sameResponsible(
  left: readonly PersonalReminderResponsible[],
  right: readonly PersonalReminderResponsible[],
): boolean {
  const signature = (value: PersonalReminderResponsible): string =>
    `${value.kind}\u0000${value.candidateId.toLowerCase()}\u0000${value.role}`;
  const a = left.map(signature).sort();
  const b = right.map(signature).sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/** 採用候補の意味、根拠、選択肢を計画時の厳密入力へ照合する。 */
export function assertPersonalReminderAssessment(
  assessment: PersonalReminderCauseAssessment,
  decision: PersonalReminderCauseDecision,
  minimumConfidence: number,
  fixed: boolean,
): void {
  const result = personalReminderCauseAssessmentSchema.parse(assessment);
  const input: PersonalReminderCauseSemanticInput = decision.exactInput;
  const references = result.references;
  const causeId = decision.causeId;
  assertUniqueAllowed(
    references.nodeIds,
    new Set(input.items.map((item) => item.nodeId)),
    causeId,
    "item",
  );
  assertUniqueAllowed(
    references.relationIds,
    new Set(
      input.relations
        .filter((relation) => relation.type !== "related_to")
        .map((relation) => relation.id),
    ),
    causeId,
    "relation",
  );
  assertUniqueAllowed(
    references.sourceIds,
    new Set(input.sources.map((source) => source.sourceId)),
    causeId,
    "source",
  );
  if (result.verdict !== "unknown" && result.confidence < minimumConfidence) {
    throw new PersonalReminderAssessmentRejectedError(
      `個人催促assessmentのconfidenceが最低値を下回っています。対象: ${causeId}`,
    );
  }
  if (
    (input.completeness.status === "incomplete" &&
      (result.verdict !== "unknown" || result.reason !== "incomplete_input")) ||
    (input.completeness.status === "complete" &&
      result.verdict === "unknown" &&
      result.reason === "incomplete_input")
  ) {
    throw new PersonalReminderAssessmentRejectedError(
      `個人催促assessmentと入力完全性が一致しません。対象: ${causeId}`,
    );
  }
  const hasRole = (role: PersonalReminderEvidenceRole): boolean =>
    references.sourceIds.some((id) =>
      input.evidenceScopes.some((scope) => scope.sourceId === id && scope.roles.includes(role)),
    );
  if (
    !fixed &&
    result.verdict === "actionable" &&
    (!hasRole("obligation_candidate") || !hasRole("actionability"))
  ) {
    throw new PersonalReminderAssessmentRejectedError(
      `個人催促actionableの根拠役割が不足しています。対象: ${causeId}`,
    );
  }
  if (
    result.verdict === "not_required" &&
    (input.cause.responsibility.authority === "fixed" ||
      (!hasRole("resolution") && !hasRole("obligation_candidate")))
  ) {
    throw new PersonalReminderAssessmentRejectedError(
      `個人催促not_requiredの根拠が不正です。対象: ${causeId}`,
    );
  }
  if (
    result.verdict === "unknown" &&
    result.reason !== "incomplete_input" &&
    references.nodeIds.length + references.relationIds.length + references.sourceIds.length === 0
  ) {
    throw new PersonalReminderAssessmentRejectedError(
      `個人催促unknownの不確実性根拠がありません。対象: ${causeId}`,
    );
  }
  if (result.verdict === "waiting") {
    const matching = input.waitingOptions.some(
      (option) =>
        option.itemNodeId === result.waitingFor.itemNodeId &&
        option.action.summary === result.waitingFor.action &&
        (option.itemNodeId === input.cause.itemNodeId || option.relationIds.length !== 0) &&
        optionReferencesPresent(references, option),
    );
    if (!matching) {
      throw new PersonalReminderAssessmentRejectedError(
        `個人催促waitingのoptionが現入力にありません。対象: ${causeId}`,
      );
    }
  }
  if (result.verdict === "duplicate") {
    const option = input.duplicateOptions.find(
      (value) => value.canonicalCauseId === result.canonicalCauseId,
    );
    if (
      option == null ||
      !sameResponsible(option.responsible, input.cause.responsible) ||
      option.action.kind !== input.cause.action.kind
    ) {
      throw new PersonalReminderAssessmentRejectedError(
        `個人催促duplicateのoptionが現入力にありません。対象: ${causeId}`,
      );
    }
    assertOptionReferences(references, option, causeId);
  }
}

/** AI生成値のproducerとhashを計画済み入力へ照合する。 */
export function assertPersonalReminderGeneration(
  generation: PersonalReminderAiGeneration,
  decision: PersonalReminderCauseDecision,
  execution: Readonly<{ model: string; reasoningEffort: ReasoningEffort }>,
  digest: ContentDigestPort,
): void {
  const parsed = personalReminderAiGenerationSchema.parse(generation);
  const metadata = parsed.metadata;
  if (
    metadata.revision !== PERSONAL_REMINDER_AI_REVISION ||
    metadata.rulesVersion !== PERSONAL_REMINDER_ASSESSMENT_RULES_VERSION ||
    metadata.inputFingerprint !== decision.fingerprint ||
    metadata.backendVersion !== CODEX_BACKEND_VERSION ||
    metadata.model !== execution.model ||
    metadata.reasoningEffort !== execution.reasoningEffort ||
    digest.sha256Utf8(
      serializeCanonicalJson({
        backendVersion: CODEX_BACKEND_VERSION,
        inputSchemaVersion: PERSONAL_REMINDER_AI_INPUT_SCHEMA_VERSION,
        model: execution.model,
        outputSchemaVersion: PERSONAL_REMINDER_AI_OUTPUT_SCHEMA_VERSION,
        promptVersion: PERSONAL_REMINDER_AI_PROMPT_VERSION,
        reasoningEffort: execution.reasoningEffort,
        revision: PERSONAL_REMINDER_AI_REVISION,
        schemaVersion: PERSONAL_REMINDER_AI_GENERATION_SCHEMA_VERSION,
      }),
    ) !== metadata.executionFingerprint ||
    digest.sha256Utf8(serializeCanonicalJson(parsed.result)) !== metadata.outputHash ||
    digest.sha256Utf8(
      serializeCanonicalJson({
        batchInputFingerprint: metadata.batchInputFingerprint,
        promptVersion: PERSONAL_REMINDER_AI_PROMPT_VERSION,
      }),
    ) !== metadata.promptFingerprint
  ) {
    throw new TypeError(
      `個人催促AI generationの由来が現入力と一致しません。対象: ${decision.causeId}`,
    );
  }
}
