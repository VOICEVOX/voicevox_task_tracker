import type { PersonalReminderBatchCauseResult } from "../application/tracking-run/stages/personal-reminder-execution.js";
import type {
  PersonalReminderCauseDecision,
  PersonalReminderPlannedBatch,
} from "../application/tracking-run/stages/personal-reminder-plan-contracts.js";
import { hashCanonicalJson } from "../canonical-json/index.js";
import {
  PERSONAL_REMINDER_AI_GENERATION_SCHEMA_VERSION,
  PERSONAL_REMINDER_AI_PROMPT_VERSION,
  PERSONAL_REMINDER_AI_REVISION,
  PERSONAL_REMINDER_ASSESSMENT_RULES_VERSION,
  personalReminderAiGenerationSchema,
  type PersonalReminderAiGeneration,
  type PersonalReminderCauseId,
  type PersonalReminderDeferredReason,
} from "../domain/personal-reminder-causes.js";
import type { ReasoningEffort, UtcIsoDateTime } from "../domain/types.js";
import { assertNonNullable } from "../util/index.js";
import { CodexAttemptBudgetExceededError } from "./attempt-budget.js";
import type { AiBudgetUsage } from "./budget.js";
import { recordCodexDiagnostic, type CodexDiagnosticsContext } from "./diagnostics.js";
import {
  CodexAttemptError,
  CodexOutputSchemaValidationError,
  CodexOutputSemanticValidationError,
  CodexOutputValidationError,
} from "./errors.js";
import {
  createPersonalReminderAiCacheEntry,
  createPersonalReminderAiCacheKey,
  createPersonalReminderAiExecutionFingerprint,
  type PersonalReminderAiCacheStore,
} from "./personal-reminder-cache.js";
import type { PreparedPersonalReminderAiBatch } from "./personal-reminder-input-contracts.js";
import type { SchemaValidPersonalReminderAiOutput } from "./personal-reminder-output.js";
import {
  validatePersonalReminderCauseSemantics,
  type PersonalReminderCauseSemanticIssue,
  type PersonalReminderCauseSemanticValidation,
} from "./personal-reminder-semantic-validation.js";

const CODEX_OUTPUT_VALIDATION_ISSUE_DETAIL_LIMIT = 5;

/** 個人催促AIのcause単位実行結果。 */
export type PersonalReminderAiCauseRunOutcome =
  | Readonly<{
      status: "accepted";
      origin: "cache" | "executed";
      generation: PersonalReminderAiGeneration;
    }>
  | Readonly<{ status: "failed"; reason: string }>
  | Readonly<{ status: "deferred"; reason: PersonalReminderDeferredReason }>;

/** 未移行の採用処理へ渡す原因別実行結果。 */
export type PersonalReminderAiRunResult = Readonly<{
  outcomesByCauseId: ReadonlyMap<PersonalReminderCauseId, PersonalReminderAiCauseRunOutcome>;
  usage: AiBudgetUsage;
  executedBatchCount: number;
  cacheHitCauseCount: number;
  authenticationPreflightExecuted: boolean;
}>;

/** 確定済みbatchからgenerationを作るための実行条件。 */
export type PersonalReminderBatchExecutionConfiguration = Readonly<{
  model: string;
  reasoningEffort: ReasoningEffort;
  backendVersion: string;
  minimumConfidence: number;
  generatedAt: UtcIsoDateTime;
}>;

/** 確定済みbatchの副作用境界。 */
export type PersonalReminderBatchExecutionDependencies = Readonly<{
  execute: () => Promise<SchemaValidPersonalReminderAiOutput>;
  cache: PersonalReminderAiCacheStore;
  diagnostics?: CodexDiagnosticsContext;
}>;

function preparedBatch(
  batch: PersonalReminderPlannedBatch,
  causes: readonly PersonalReminderCauseDecision[],
): PreparedPersonalReminderAiBatch {
  const causeInputs = new Map<
    PersonalReminderCauseId,
    PreparedPersonalReminderAiBatch["causeInputs"] extends ReadonlyMap<
      PersonalReminderCauseId,
      infer Value
    >
      ? Value
      : never
  >();
  for (const causeId of batch.causeIds) {
    const cause = causes.find((value) => value.causeId === causeId);
    assertNonNullable(cause, `個人催促AIの計画原因がありません。対象: ${causeId}`);
    causeInputs.set(
      causeId,
      Object.freeze({ input: cause.exactInput, inputFingerprint: cause.fingerprint }),
    );
  }
  return Object.freeze({
    id: batch.id,
    itemNodeId: batch.itemNodeId,
    input: batch.input,
    normalizedInput: batch.normalizedInput,
    inputCharacters: batch.inputCharacters,
    batchInputFingerprint: batch.batchInputFingerprint,
    refs: Object.freeze({
      items: new Map(batch.refs.items),
      relations: new Map(batch.refs.relations),
      sources: new Map(batch.refs.sources),
    }),
    causeInputs,
  });
}

async function recordFailure(
  batch: PersonalReminderPlannedBatch,
  diagnostics: CodexDiagnosticsContext | undefined,
  error: CodexAttemptError | CodexOutputValidationError,
): Promise<void> {
  const event =
    error instanceof CodexOutputSchemaValidationError
      ? "codex.output.schema_validation_failed"
      : error instanceof CodexOutputSemanticValidationError
        ? "codex.output.semantic_validation_failed"
        : "codex.fallback";
  for (const causeId of batch.causeIds) {
    await recordCodexDiagnostic(
      diagnostics == null ? undefined : Object.freeze({ ...diagnostics, candidateId: causeId }),
      event,
      {
        phase: "execution",
        batchId: batch.id,
        itemNodeId: batch.itemNodeId,
        errorType: error.name,
        ...(error instanceof CodexAttemptError ? { attempt: error.attempts } : {}),
        ...(error instanceof CodexOutputValidationError
          ? {
              issueCount: error.issues.length,
              issues: Object.freeze(
                error.issues
                  .slice(0, CODEX_OUTPUT_VALIDATION_ISSUE_DETAIL_LIMIT)
                  .map((issue) => Object.freeze({ path: issue.path, code: issue.code })),
              ),
            }
          : {}),
      },
      error,
    );
  }
}

async function recordSemanticFailure(
  batch: PersonalReminderPlannedBatch,
  causeId: PersonalReminderCauseId,
  issues: readonly PersonalReminderCauseSemanticIssue[],
  diagnostics: CodexDiagnosticsContext | undefined,
): Promise<void> {
  await recordCodexDiagnostic(diagnostics, "codex.personal_reminder.semantic_failed", {
    batchId: batch.id,
    itemNodeId: batch.itemNodeId,
    causeId,
    status: "failed",
    reason: "semantic_validation_failed",
    issueCount: issues.length,
    issues: Object.freeze(
      issues
        .slice(0, CODEX_OUTPUT_VALIDATION_ISSUE_DETAIL_LIMIT)
        .map((issue) => Object.freeze({ path: issue.path, code: issue.code })),
    ),
  });
}

function generationForCause(
  batch: PersonalReminderPlannedBatch,
  accepted: PersonalReminderCauseSemanticValidation["accepted"][number],
  configuration: PersonalReminderBatchExecutionConfiguration,
): PersonalReminderAiGeneration {
  const executionFingerprint = createPersonalReminderAiExecutionFingerprint({
    model: configuration.model,
    reasoningEffort: configuration.reasoningEffort,
    backendVersion: configuration.backendVersion,
    promptVersion: PERSONAL_REMINDER_AI_PROMPT_VERSION,
  });
  return personalReminderAiGenerationSchema.parse({
    metadata: {
      model: configuration.model,
      reasoningEffort: configuration.reasoningEffort,
      backendVersion: configuration.backendVersion,
      schemaVersion: PERSONAL_REMINDER_AI_GENERATION_SCHEMA_VERSION,
      revision: PERSONAL_REMINDER_AI_REVISION,
      inputFingerprint: accepted.inputFingerprint,
      executionFingerprint,
      promptFingerprint: hashCanonicalJson({
        batchInputFingerprint: batch.batchInputFingerprint,
        promptVersion: PERSONAL_REMINDER_AI_PROMPT_VERSION,
      }),
      outputHash: hashCanonicalJson(accepted.assessment),
      generatedAt: configuration.generatedAt,
      rulesVersion: PERSONAL_REMINDER_ASSESSMENT_RULES_VERSION,
      batchInputFingerprint: batch.batchInputFingerprint,
    },
    result: accepted.assessment,
  });
}

/** 計画済みbatchを輸送し、原因ごとにcanonicalな生成結果を返す。 */
export async function executePlannedPersonalReminderBatch(
  batch: PersonalReminderPlannedBatch,
  causes: readonly PersonalReminderCauseDecision[],
  configuration: PersonalReminderBatchExecutionConfiguration,
  dependencies: PersonalReminderBatchExecutionDependencies,
): Promise<readonly PersonalReminderBatchCauseResult[]> {
  let validation: PersonalReminderCauseSemanticValidation;
  try {
    const output = await dependencies.execute();
    validation = validatePersonalReminderCauseSemantics({
      batch: preparedBatch(batch, causes),
      output,
      minimumConfidence: configuration.minimumConfidence,
    });
  } catch (error: unknown) {
    if (error instanceof CodexAttemptBudgetExceededError) {
      return Object.freeze(
        batch.causeIds.map((causeId) =>
          Object.freeze({ causeId, status: "deferred", reason: "call_limit" }),
        ),
      );
    }
    if (!(error instanceof CodexAttemptError || error instanceof CodexOutputValidationError)) {
      throw error;
    }
    await recordFailure(batch, dependencies.diagnostics, error);
    return Object.freeze(
      batch.causeIds.map((causeId) =>
        Object.freeze({ causeId, status: "failed", reason: "execution_failed" }),
      ),
    );
  }
  if (validation.unexpected.length !== 0) {
    throw new TypeError(`個人催促AIの出力に計画外の原因があります。対象: ${batch.id}`);
  }
  const results = new Map<PersonalReminderCauseId, PersonalReminderBatchCauseResult>();
  for (const rejected of validation.rejected) {
    await recordSemanticFailure(batch, rejected.causeId, rejected.issues, dependencies.diagnostics);
    results.set(
      rejected.causeId,
      Object.freeze({
        causeId: rejected.causeId,
        status: "failed",
        reason: "semantic_validation_failed",
      }),
    );
  }
  for (const accepted of validation.accepted) {
    const generation = generationForCause(batch, accepted, configuration);
    const cacheKey = createPersonalReminderAiCacheKey({
      causeId: accepted.causeId,
      revision: PERSONAL_REMINDER_AI_REVISION,
      rulesVersion: PERSONAL_REMINDER_ASSESSMENT_RULES_VERSION,
      model: configuration.model,
      reasoningEffort: configuration.reasoningEffort,
      backendVersion: configuration.backendVersion,
      schemaVersion: PERSONAL_REMINDER_AI_GENERATION_SCHEMA_VERSION,
      inputFingerprint: accepted.inputFingerprint,
      executionFingerprint: generation.metadata.executionFingerprint,
    });
    await dependencies.cache.write(
      createPersonalReminderAiCacheEntry({ cacheKey, causeId: accepted.causeId, generation }),
    );
    results.set(
      accepted.causeId,
      Object.freeze({ causeId: accepted.causeId, status: "completed", generation }),
    );
  }
  return Object.freeze(
    batch.causeIds.map((causeId) => {
      const result = results.get(causeId);
      assertNonNullable(result, `個人催促AIの原因別結果がありません。対象: ${causeId}`);
      return result;
    }),
  );
}
