import {
  PERSONAL_REMINDER_AI_GENERATION_SCHEMA_VERSION,
  PERSONAL_REMINDER_AI_PROMPT_VERSION,
  PERSONAL_REMINDER_AI_REVISION,
  PERSONAL_REMINDER_ASSESSMENT_RULES_VERSION,
  personalReminderAiGenerationSchema,
  type PersonalReminderDeferredReason,
  type PersonalReminderAiGeneration,
  type PersonalReminderCause,
  type PersonalReminderCauseId,
} from "../domain/personal-reminder-causes.js";
import { type AiAnalysisElementInputFingerprint } from "../domain/ai-analysis-elements.js";
import type { DiagnosticsJsonValue } from "../diagnostics/error-serializer.js";
import { type GitHubNodeId, type ReasoningEffort } from "../domain/types.js";
import { assertNonNullable } from "../util/index.js";
import { type AiAnalysisPreflight } from "./analysis-runner.js";
import { type AiAnalysisPriority } from "./analysis-selection.js";
import {
  estimateAiInputCost,
  planAiAnalysisBudget,
  planAiAnalysisBudgetWithPreflight,
  type AiBudgetUsage,
  type AiRunBudget,
} from "./budget.js";
import { hashCanonicalJson } from "./canonical-json.js";
import {
  createPersonalReminderAiCacheEntry,
  createPersonalReminderAiCacheKey,
  createPersonalReminderAiExecutionFingerprint,
  determinePersonalReminderAiCacheReuse,
  type PersonalReminderAiCacheEntry,
  type PersonalReminderAiCacheIdentity,
  type PersonalReminderAiCacheStore,
} from "./personal-reminder-cache.js";
import {
  createPersonalReminderCauseInputFingerprint,
  preparePersonalReminderAiBatch,
  type PersonalReminderAiInput,
  type PersonalReminderCauseSemanticInput,
  type PreparedPersonalReminderAiBatch,
} from "./personal-reminder-input.js";
import {
  validatePersonalReminderCauseSemantics,
  type PersonalReminderCauseSemanticIssue,
  type PersonalReminderCauseSemanticValidation,
} from "./personal-reminder-semantic-validation.js";
import { type SchemaValidPersonalReminderAiOutput } from "./personal-reminder-output.js";
import { recordCodexDiagnostic, type CodexDiagnosticsContext } from "./diagnostics.js";
import {
  CodexAttemptError,
  CodexOutputSchemaValidationError,
  CodexOutputSemanticValidationError,
  CodexOutputValidationError,
} from "./errors.js";

const CODEX_OUTPUT_VALIDATION_ISSUE_DETAIL_LIMIT = 5;

/** 個人催促AIへ送る意味判定候補。 */
export type PersonalReminderAiEvaluationCandidate = Readonly<{
  cause: PersonalReminderCause;
  input: PersonalReminderCauseSemanticInput;
  inputFingerprint: AiAnalysisElementInputFingerprint;
  priority: AiAnalysisPriority;
}>;

/** 個人催促AIの予算配分候補。 */
export type PreparedPersonalReminderAiBudgetCandidate = Readonly<{
  id: string;
  batch: PreparedPersonalReminderAiBatch;
  inputCharacters: number;
  priority: AiAnalysisPriority;
  estimatedCostUsd: number;
}>;

/** 個人催促AIのrun設定。 */
export type PersonalReminderAiRunConfiguration = Readonly<{
  model: string;
  reasoningEffort: ReasoningEffort;
  backendVersion: string;
  budget: AiRunBudget;
  initialUsage: AiBudgetUsage;
  maxConcurrentCalls: number;
  minimumConfidence: number;
  inputCostUsdPerMillionTokens: number;
}>;

/** 個人催促AIの副作用境界。 */
export type PersonalReminderAiRunDependencies = Readonly<{
  cache: PersonalReminderAiCacheStore;
  execute: (input: PersonalReminderAiInput) => Promise<SchemaValidPersonalReminderAiOutput>;
  executedAt: () => string;
  preflight?: AiAnalysisPreflight;
  diagnostics?: CodexDiagnosticsContext;
}>;

/** 個人催促AIのcause単位実行結果。 */
export type PersonalReminderAiCauseRunOutcome =
  | Readonly<{
      status: "accepted";
      origin: "cache" | "executed";
      generation: PersonalReminderAiGeneration;
    }>
  | Readonly<{
      status: "failed";
      reason: string;
    }>
  | Readonly<{
      status: "deferred";
      reason: PersonalReminderDeferredReason;
    }>;

/** 個人催促AIのrun結果。 */
export type PersonalReminderAiRunResult = Readonly<{
  outcomesByCauseId: ReadonlyMap<PersonalReminderCauseId, PersonalReminderAiCauseRunOutcome>;
  usage: AiBudgetUsage;
  executedBatchCount: number;
  cacheHitCauseCount: number;
  authenticationPreflightExecuted: boolean;
}>;

type MissCandidate = Readonly<{
  candidate: PersonalReminderAiEvaluationCandidate;
  cacheIdentity: PersonalReminderAiCacheIdentity;
}>;

type PreparedBatchState = Readonly<{
  budgetCandidate: PreparedPersonalReminderAiBudgetCandidate;
  misses: readonly MissCandidate[];
}>;

type BatchExecutionOutcome = Readonly<{
  outcomes: ReadonlyMap<PersonalReminderCauseId, PersonalReminderAiCauseRunOutcome>;
}>;

function compareStrings(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function validateConfiguration(configuration: PersonalReminderAiRunConfiguration): void {
  if (configuration.model.length === 0) {
    throw new TypeError("個人催促AIのmodelは空にできません");
  }
  if (configuration.backendVersion.length === 0) {
    throw new TypeError("個人催促AIのbackendVersionは空にできません");
  }
  if (
    !Number.isSafeInteger(configuration.maxConcurrentCalls) ||
    configuration.maxConcurrentCalls <= 0
  ) {
    throw new RangeError("個人催促AIの最大同時呼び出し数は正の安全な整数にしてください");
  }
  if (
    !Number.isFinite(configuration.minimumConfidence) ||
    configuration.minimumConfidence < 0 ||
    configuration.minimumConfidence > 1
  ) {
    throw new RangeError("個人催促AIのminimumConfidenceは0以上1以下にしてください");
  }
  if (
    !Number.isFinite(configuration.inputCostUsdPerMillionTokens) ||
    configuration.inputCostUsdPerMillionTokens <= 0
  ) {
    throw new RangeError("個人催促AIの入力単価は正の有限値にしてください");
  }
}

function validateCandidates(candidates: readonly PersonalReminderAiEvaluationCandidate[]): void {
  const causeIds = new Set<PersonalReminderCauseId>();
  for (const candidate of candidates) {
    if (causeIds.has(candidate.cause.causeId)) {
      throw new TypeError(
        `個人催促AI候補のcause IDが重複しています。対象: ${candidate.cause.causeId}`,
      );
    }
    causeIds.add(candidate.cause.causeId);
    if (candidate.input.cause.causeId !== candidate.cause.causeId) {
      throw new TypeError(
        `個人催促AI候補のcause IDが入力と一致しません。対象: ${candidate.cause.causeId}`,
      );
    }
    if (candidate.input.cause.itemNodeId !== candidate.cause.itemNodeId) {
      throw new TypeError(
        `個人催促AI候補のitem IDが入力と一致しません。対象: ${candidate.cause.causeId}`,
      );
    }
    const inputFingerprint = createPersonalReminderCauseInputFingerprint(candidate.input);
    if (inputFingerprint !== candidate.inputFingerprint) {
      throw new TypeError(
        `個人催促AI候補のinput fingerprintが一致しません。対象: ${candidate.cause.causeId}`,
      );
    }
  }
}

function createCacheIdentity(
  candidate: PersonalReminderAiEvaluationCandidate,
  configuration: PersonalReminderAiRunConfiguration,
): PersonalReminderAiCacheIdentity {
  const executionFingerprint = createPersonalReminderAiExecutionFingerprint({
    model: configuration.model,
    reasoningEffort: configuration.reasoningEffort,
    backendVersion: configuration.backendVersion,
    promptVersion: PERSONAL_REMINDER_AI_PROMPT_VERSION,
  });
  return Object.freeze({
    causeId: candidate.cause.causeId,
    revision: PERSONAL_REMINDER_AI_REVISION,
    rulesVersion: PERSONAL_REMINDER_ASSESSMENT_RULES_VERSION,
    model: configuration.model,
    reasoningEffort: configuration.reasoningEffort,
    backendVersion: configuration.backendVersion,
    schemaVersion: PERSONAL_REMINDER_AI_GENERATION_SCHEMA_VERSION,
    inputFingerprint: candidate.inputFingerprint,
    executionFingerprint,
  });
}

async function resolveCache(
  candidates: readonly PersonalReminderAiEvaluationCandidate[],
  configuration: PersonalReminderAiRunConfiguration,
  cache: PersonalReminderAiCacheStore,
): Promise<
  Readonly<{
    outcomes: ReadonlyMap<PersonalReminderCauseId, PersonalReminderAiCauseRunOutcome>;
    misses: readonly MissCandidate[];
  }>
> {
  const outcomes = new Map<PersonalReminderCauseId, PersonalReminderAiCauseRunOutcome>();
  const misses: MissCandidate[] = [];
  for (const candidate of candidates) {
    if (candidate.input.completeness.status === "incomplete") {
      outcomes.set(
        candidate.cause.causeId,
        Object.freeze({
          status: "deferred",
          reason:
            candidate.input.pendingRelations.length !== 0
              ? "upstream_relation"
              : "input_incomplete",
        }),
      );
      continue;
    }
    const cacheIdentity = createCacheIdentity(candidate, configuration);
    const cacheKey = createPersonalReminderAiCacheKey(cacheIdentity);
    const readResult = await cache.read(cacheKey);
    if (readResult.status === "hit") {
      const reuse = determinePersonalReminderAiCacheReuse(readResult.entry, cacheIdentity);
      if (reuse.status === "reusable") {
        outcomes.set(
          candidate.cause.causeId,
          Object.freeze({
            status: "accepted",
            origin: "cache",
            generation: reuse.entry.generation,
          }),
        );
        continue;
      }
    }
    misses.push(Object.freeze({ candidate, cacheIdentity }));
  }
  return Object.freeze({
    outcomes,
    misses: Object.freeze(misses),
  });
}

function mergePriority(priorities: readonly AiAnalysisPriority[]): AiAnalysisPriority {
  const first = priorities[0];
  assertNonNullable(first, "個人催促AI batchのpriorityがありません");
  return Object.freeze({
    previouslyDeferred: priorities.some((priority) => priority.previouslyDeferred),
    severityCandidate: priorities.some((priority) => priority.severityCandidate),
    ownerUnknown: priorities.some((priority) => priority.ownerUnknown),
    changedBlocker: priorities.some((priority) => priority.changedBlocker),
    downstreamImpact: Object.freeze({
      openNodeCount: Math.max(
        ...priorities.map((priority) => priority.downstreamImpact.openNodeCount),
      ),
      repositoryCount: Math.max(
        ...priorities.map((priority) => priority.downstreamImpact.repositoryCount),
      ),
    }),
  });
}

function createPreparedBatchStates(
  misses: readonly MissCandidate[],
  configuration: PersonalReminderAiRunConfiguration,
): readonly PreparedBatchState[] {
  const grouped = new Map<GitHubNodeId, MissCandidate[]>();
  for (const miss of misses) {
    const itemNodeId = miss.candidate.cause.itemNodeId;
    const group = grouped.get(itemNodeId) ?? [];
    group.push(miss);
    grouped.set(itemNodeId, group);
  }
  const states: PreparedBatchState[] = [];
  for (const [itemNodeId, group] of [...grouped.entries()].sort((left, right) =>
    compareStrings(left[0], right[0]),
  )) {
    const sortedGroup = [...group].sort((left, right) =>
      compareStrings(left.candidate.cause.causeId, right.candidate.cause.causeId),
    );
    const first = sortedGroup[0];
    assertNonNullable(first, `個人催促AIのbatch候補がありません。対象: ${itemNodeId}`);
    const firstInput = first.candidate.input;
    const restInputs: PersonalReminderCauseSemanticInput[] = sortedGroup
      .slice(1)
      .map((value) => value.candidate.input);
    const batchInputs: [
      PersonalReminderCauseSemanticInput,
      ...PersonalReminderCauseSemanticInput[],
    ] = [firstInput, ...restInputs];
    const batch = preparePersonalReminderAiBatch(batchInputs);
    const priorities = sortedGroup.map((value) => value.candidate.priority);
    const estimatedCost = estimateAiInputCost(
      batch.normalizedInput,
      configuration.inputCostUsdPerMillionTokens,
    );
    for (const miss of sortedGroup) {
      const causeInput = batch.causeInputs.get(miss.candidate.cause.causeId);
      assertNonNullable(
        causeInput,
        `個人催促AI batchのcause inputがありません。対象: ${miss.candidate.cause.causeId}`,
      );
      if (causeInput.inputFingerprint !== miss.candidate.inputFingerprint) {
        throw new TypeError(
          `個人催促AI batchのinput fingerprintが一致しません。対象: ${miss.candidate.cause.causeId}`,
        );
      }
    }
    states.push(
      Object.freeze({
        budgetCandidate: Object.freeze({
          id: batch.id,
          batch,
          inputCharacters: batch.inputCharacters,
          priority: mergePriority(priorities),
          estimatedCostUsd: estimatedCost.estimatedCostUsd,
        }),
        misses: Object.freeze(sortedGroup),
      }),
    );
  }
  return Object.freeze(states);
}

function causeFailureOutcomes(
  misses: readonly MissCandidate[],
  reason: string,
): ReadonlyMap<PersonalReminderCauseId, PersonalReminderAiCauseRunOutcome> {
  return new Map(
    misses.map((miss) => [
      miss.candidate.cause.causeId,
      Object.freeze({ status: "failed", reason }),
    ]),
  );
}

function isCodexExecutionFailure(
  error: unknown,
): error is CodexAttemptError | CodexOutputValidationError {
  return error instanceof CodexAttemptError || error instanceof CodexOutputValidationError;
}

function validationFailureEvent(error: CodexAttemptError | CodexOutputValidationError): string {
  if (error instanceof CodexOutputSchemaValidationError) {
    return "codex.output.schema_validation_failed";
  }
  if (error instanceof CodexOutputSemanticValidationError) {
    return "codex.output.semantic_validation_failed";
  }
  return "codex.fallback";
}

async function recordBatchFailure(
  diagnostics: CodexDiagnosticsContext | undefined,
  batch: PreparedPersonalReminderAiBatch,
  causeIds: readonly PersonalReminderCauseId[],
  error: CodexAttemptError | CodexOutputValidationError,
): Promise<void> {
  const details: Record<string, DiagnosticsJsonValue> = {
    phase: "execution",
    batchId: batch.id,
    itemNodeId: batch.itemNodeId,
    errorType: error.name,
  };
  if (error instanceof CodexAttemptError) {
    details["attempt"] = error.attempts;
  }
  if (error instanceof CodexOutputValidationError) {
    details["issueCount"] = error.issues.length;
    details["issues"] = Object.freeze(
      error.issues.slice(0, CODEX_OUTPUT_VALIDATION_ISSUE_DETAIL_LIMIT).map((issue) =>
        Object.freeze({
          path: issue.path,
          code: issue.code,
        }),
      ),
    );
  }
  for (const causeId of causeIds) {
    const causeDiagnostics =
      diagnostics == null
        ? undefined
        : Object.freeze({
            ...diagnostics,
            candidateId: causeId,
          });
    await recordCodexDiagnostic(causeDiagnostics, validationFailureEvent(error), details, error);
  }
}

async function recordSemanticFailure(
  diagnostics: CodexDiagnosticsContext | undefined,
  batch: PreparedPersonalReminderAiBatch,
  causeId: PersonalReminderCauseId,
  reason: string,
  issues: readonly PersonalReminderCauseSemanticIssue[],
): Promise<void> {
  await recordCodexDiagnostic(diagnostics, "codex.personal_reminder.semantic_failed", {
    batchId: batch.id,
    itemNodeId: batch.itemNodeId,
    causeId,
    status: "failed",
    reason,
    issueCount: issues.length,
    issues: Object.freeze(
      issues.slice(0, CODEX_OUTPUT_VALIDATION_ISSUE_DETAIL_LIMIT).map((issue) =>
        Object.freeze({
          path: issue.path,
          code: issue.code,
        }),
      ),
    ),
  });
}

function createGeneration(
  miss: MissCandidate,
  batch: PreparedPersonalReminderAiBatch,
  assessment: PersonalReminderCauseSemanticValidation["accepted"][number],
  generatedAt: string,
): PersonalReminderAiGeneration {
  const promptFingerprint = hashCanonicalJson({
    batchInputFingerprint: batch.batchInputFingerprint,
    promptVersion: PERSONAL_REMINDER_AI_PROMPT_VERSION,
  });
  return personalReminderAiGenerationSchema.parse({
    metadata: {
      model: miss.cacheIdentity.model,
      reasoningEffort: miss.cacheIdentity.reasoningEffort,
      backendVersion: miss.cacheIdentity.backendVersion,
      schemaVersion: PERSONAL_REMINDER_AI_GENERATION_SCHEMA_VERSION,
      revision: PERSONAL_REMINDER_AI_REVISION,
      inputFingerprint: assessment.inputFingerprint,
      executionFingerprint: miss.cacheIdentity.executionFingerprint,
      promptFingerprint,
      outputHash: hashCanonicalJson(assessment.assessment),
      generatedAt,
      rulesVersion: PERSONAL_REMINDER_ASSESSMENT_RULES_VERSION,
      batchInputFingerprint: batch.batchInputFingerprint,
    },
    result: assessment.assessment,
  });
}

async function executeBatch(
  state: PreparedBatchState,
  configuration: PersonalReminderAiRunConfiguration,
  dependencies: PersonalReminderAiRunDependencies,
): Promise<BatchExecutionOutcome> {
  let semanticValidation: PersonalReminderCauseSemanticValidation;
  try {
    const output = await dependencies.execute(state.budgetCandidate.batch.input);
    semanticValidation = validatePersonalReminderCauseSemantics({
      batch: state.budgetCandidate.batch,
      output,
      minimumConfidence: configuration.minimumConfidence,
    });
  } catch (error: unknown) {
    if (!isCodexExecutionFailure(error)) {
      throw error;
    }
    await recordBatchFailure(
      dependencies.diagnostics,
      state.budgetCandidate.batch,
      state.misses.map((miss) => miss.candidate.cause.causeId),
      error,
    );
    return Object.freeze({
      outcomes: causeFailureOutcomes(state.misses, "execution_failed"),
    });
  }
  const outcomes = new Map<PersonalReminderCauseId, PersonalReminderAiCauseRunOutcome>();
  for (const rejected of semanticValidation.rejected) {
    await recordSemanticFailure(
      dependencies.diagnostics,
      state.budgetCandidate.batch,
      rejected.causeId,
      "semantic_validation_failed",
      rejected.issues,
    );
    outcomes.set(
      rejected.causeId,
      Object.freeze({ status: "failed", reason: "semantic_validation_failed" }),
    );
  }
  if (semanticValidation.unexpected.length !== 0) {
    await recordCodexDiagnostic(dependencies.diagnostics, "codex.personal_reminder.unexpected", {
      batchId: state.budgetCandidate.batch.id,
      itemNodeId: state.budgetCandidate.batch.itemNodeId,
      reason: "unexpected_cause_row",
    });
  }
  if (semanticValidation.accepted.length === 0) {
    return Object.freeze({ outcomes });
  }
  const generatedAt = dependencies.executedAt();
  const entries: PersonalReminderAiCacheEntry[] = [];
  for (const accepted of semanticValidation.accepted) {
    const miss = state.misses.find((value) => value.candidate.cause.causeId === accepted.causeId);
    assertNonNullable(miss, `個人催促AIのmiss候補がありません。対象: ${accepted.causeId}`);
    const generation = createGeneration(miss, state.budgetCandidate.batch, accepted, generatedAt);
    const cacheKey = createPersonalReminderAiCacheKey(miss.cacheIdentity);
    entries.push(
      createPersonalReminderAiCacheEntry({
        cacheKey,
        causeId: accepted.causeId,
        generation,
      }),
    );
  }
  for (const entry of entries) {
    await dependencies.cache.write(entry);
  }
  for (const entry of entries) {
    outcomes.set(
      entry.causeId,
      Object.freeze({
        status: "accepted",
        origin: "executed",
        generation: entry.generation,
      }),
    );
  }
  return Object.freeze({ outcomes });
}

async function executeSelectedBatches(
  states: readonly PreparedBatchState[],
  selected: readonly PreparedPersonalReminderAiBudgetCandidate[],
  configuration: PersonalReminderAiRunConfiguration,
  dependencies: PersonalReminderAiRunDependencies,
): Promise<ReadonlyMap<PersonalReminderCauseId, PersonalReminderAiCauseRunOutcome>> {
  const statesByBatchId = new Map(states.map((state) => [state.budgetCandidate.id, state]));
  const outcomesByIndex = new Map<number, BatchExecutionOutcome>();
  let nextIndex = 0;
  let stopped = false;
  const workers = Array.from(
    { length: Math.min(configuration.maxConcurrentCalls, selected.length) },
    async () => {
      while (!stopped) {
        const index = nextIndex;
        if (index >= selected.length) {
          return;
        }
        nextIndex += 1;
        const budgetCandidate = selected.at(index);
        assertNonNullable(budgetCandidate, "個人催促AIの予算候補がありません");
        const state = statesByBatchId.get(budgetCandidate.id);
        assertNonNullable(
          state,
          `個人催促AIのbatch stateがありません。対象: ${budgetCandidate.id}`,
        );
        try {
          outcomesByIndex.set(index, await executeBatch(state, configuration, dependencies));
        } catch (error: unknown) {
          stopped = true;
          throw error;
        }
      }
    },
  );
  const settledWorkers = await Promise.allSettled(workers);
  for (const worker of settledWorkers) {
    if (worker.status === "rejected") {
      throw worker.reason;
    }
  }
  const outcomes = new Map<PersonalReminderCauseId, PersonalReminderAiCauseRunOutcome>();
  for (const index of selected.keys()) {
    const outcome = outcomesByIndex.get(index);
    assertNonNullable(outcome, "個人催促AIのbatch実行結果がありません");
    for (const [causeId, causeOutcome] of outcome.outcomes) {
      if (outcomes.has(causeId)) {
        throw new TypeError(`個人催促AIのcause結果が重複しています。対象: ${causeId}`);
      }
      outcomes.set(causeId, causeOutcome);
    }
  }
  return outcomes;
}

function addOutcome(
  outcomes: Map<PersonalReminderCauseId, PersonalReminderAiCauseRunOutcome>,
  causeId: PersonalReminderCauseId,
  outcome: PersonalReminderAiCauseRunOutcome,
): void {
  if (outcomes.has(causeId)) {
    throw new TypeError(`個人催促AIのcause結果が重複しています。対象: ${causeId}`);
  }
  outcomes.set(causeId, outcome);
}

/** 個人催促AIをcache、予算、batch、部分semantic採用の順で実行する。 */
export async function runPersonalReminderAiAnalyses(
  candidates: readonly PersonalReminderAiEvaluationCandidate[],
  configuration: PersonalReminderAiRunConfiguration,
  dependencies: PersonalReminderAiRunDependencies,
): Promise<PersonalReminderAiRunResult> {
  validateConfiguration(configuration);
  validateCandidates(candidates);
  const resolved = await resolveCache(candidates, configuration, dependencies.cache);
  const batchStates = createPreparedBatchStates(resolved.misses, configuration);
  const budgetCandidates = batchStates.map((state) => state.budgetCandidate);
  const budgetPlan =
    dependencies.preflight == null
      ? planAiAnalysisBudget(budgetCandidates, configuration.budget, configuration.initialUsage)
      : planAiAnalysisBudgetWithPreflight(
          budgetCandidates,
          configuration.budget,
          configuration.initialUsage,
          dependencies.preflight,
        );
  const authenticationPreflightExecuted =
    dependencies.preflight != null && budgetPlan.selected.length > 0;
  if (authenticationPreflightExecuted) {
    assertNonNullable(dependencies.preflight, "個人催促AIの認証preflightがありません");
    await dependencies.preflight.execute();
  }
  const outcomes = new Map<PersonalReminderCauseId, PersonalReminderAiCauseRunOutcome>();
  for (const [causeId, outcome] of resolved.outcomes) {
    addOutcome(outcomes, causeId, outcome);
  }
  for (const deferred of budgetPlan.deferred) {
    const state = batchStates.find((value) => value.budgetCandidate.id === deferred.candidate.id);
    assertNonNullable(
      state,
      `個人催促AIの延期batch stateがありません。対象: ${deferred.candidate.id}`,
    );
    for (const miss of state.misses) {
      addOutcome(
        outcomes,
        miss.candidate.cause.causeId,
        Object.freeze({ status: "deferred", reason: deferred.reason }),
      );
    }
  }
  const executedOutcomes = await executeSelectedBatches(
    batchStates,
    budgetPlan.selected,
    configuration,
    dependencies,
  );
  for (const [causeId, outcome] of executedOutcomes) {
    addOutcome(outcomes, causeId, outcome);
  }
  for (const candidate of candidates) {
    if (!outcomes.has(candidate.cause.causeId)) {
      throw new TypeError(`個人催促AI候補の結果がありません。対象: ${candidate.cause.causeId}`);
    }
  }
  return Object.freeze({
    outcomesByCauseId: outcomes,
    usage: budgetPlan.usage,
    executedBatchCount: budgetPlan.selected.length,
    cacheHitCauseCount: [...resolved.outcomes.values()].filter(
      (outcome) => outcome.status === "accepted" && outcome.origin === "cache",
    ).length,
    authenticationPreflightExecuted,
  });
}
