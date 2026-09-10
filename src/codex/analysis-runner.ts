import {
  AI_ANALYSIS_ELEMENT_REVISIONS,
  type AiAnalysisElement,
  type AiAnalysisElementGeneration,
  type AiAnalysisElementResult,
} from "./analysis-elements.js";
import {
  createAiAnalysisTarget,
  selectAiAnalysisCandidates,
  selectAiAnalysisTarget,
  type AiAnalysisTarget,
  type AiAnalysisRunIdentity,
  type AiAnalysisSkipReason,
  type PreparedAiAnalysisCandidate,
} from "./analysis-selection.js";
import {
  planAiAnalysisBudget,
  planAiAnalysisBudgetWithPreflight,
  type AiAnalysisDeferReason,
  type AiPreflightBudget,
  type AiRunBudget,
} from "./budget.js";
import {
  createAiCacheEntry,
  createAiCacheKey,
  determineAiCacheReuse,
  type AiCacheEntry,
  type AiCacheIdentity,
  type AiCacheKey,
  type AiCacheStore,
} from "./cache.js";
import { hashCanonicalJson, parseSha256Hash, serializeCanonicalJson } from "./canonical-json.js";
import {
  CodexAttemptError,
  CodexOutputSchemaValidationError,
  CodexOutputSemanticValidationError,
  CodexOutputValidationError,
  CodexNonZeroExitError,
  CodexTransportAliasError,
  type CodexNonZeroExitDiagnostic,
  type CodexOutputValidationDiagnostic,
} from "./errors.js";
import { recordCodexDiagnostic, type CodexDiagnosticsContext } from "./diagnostics.js";
import type { DiagnosticsJsonValue } from "../diagnostics/error-serializer.js";
import {
  createCodexAnalysisInput,
  projectCodexLockedElementResult,
  type CodexAnalysisInput,
} from "./input.js";
import { type SchemaValidCodexElementOutput } from "./element-output.js";
import { CODEX_ELEMENT_OUTPUT_SCHEMA_VERSION } from "./element-output-schema.js";
import { aiAnalysisElementGenerationSchema } from "./analysis-elements.js";
import { classifyCodexUnavailableReason, type CodexUnavailableReason } from "./reducer.js";
import { validateCodexAnalysisSemantics } from "./semantic-validation.js";
import { createUtcIsoDateTime, type AnalysisMetadata } from "../domain/index.js";
import { assertNonNullable } from "../util/index.js";

const CODEX_OUTPUT_VALIDATION_ISSUE_DETAIL_LIMIT = 5;

/** 1 runのAI cache、予算、実行方針の設定。 */
export type AiAnalysisRunConfiguration = Readonly<{
  identity: AiAnalysisRunIdentity;
  budget: AiRunBudget;
  maxConcurrentCalls: number;
  target?: AiAnalysisTarget;
}>;

/** AI分析前に実行するCodex認証preflight。 */
export type AiAnalysisPreflight = Readonly<
  AiPreflightBudget & {
    execute: () => Promise<void>;
  }
>;

/** AI分析runへ注入する副作用境界。 */
export type AiAnalysisRunDependencies = Readonly<{
  cache: AiCacheStore;
  execute: (input: CodexAnalysisInput, context: AiAnalysisExecutionContext) => Promise<unknown>;
  executedAt: () => string;
  preflight?: AiAnalysisPreflight;
  diagnostics?: CodexDiagnosticsContext;
}>;

/** AI分析の実行候補を識別し、今回の選択要素を伝えるcontext。 */
export type AiAnalysisExecutionContext = Readonly<{
  candidateId: string;
  selectedElements: readonly AiAnalysisElement[];
}>;

/** cache再利用または新規実行で取得した要素別AI結果。 */
export type AiAnalysisRunElementResult = Readonly<{
  element: AiAnalysisElement;
  origin: "cache" | "executed";
  cacheKey: AiCacheKey;
  generation: AiAnalysisElementGeneration;
}>;

/** 一つのIssueまたはPull Requestについて取得したAI結果。 */
export type AiAnalysisRunItemResult = Readonly<{
  candidateId: string;
  origin: "cache" | "executed" | "mixed";
  elements: readonly AiAnalysisRunElementResult[];
}>;

/** Codex実行または出力検証に失敗してfallbackする項目。 */
export type AiAnalysisRunFailure = Readonly<{
  candidateId: string;
  reason: CodexUnavailableReason;
  errorType: string;
  diagnostic?: CodexNonZeroExitDiagnostic;
  validationDiagnostic?: CodexOutputValidationDiagnostic;
}>;

/** 1 runのAI分析、抑止、延期と予算使用量。 */
export type AiAnalysisRunResult = Readonly<{
  results: readonly AiAnalysisRunItemResult[];
  failures: readonly AiAnalysisRunFailure[];
  skipped: readonly Readonly<{
    candidateId: string;
    reason: AiAnalysisSkipReason;
  }>[];
  deferred: readonly Readonly<{
    candidateId: string;
    reason: AiAnalysisDeferReason;
  }>[];
  usage: Readonly<{
    calls: number;
    inputCharacters: number;
    estimatedCostUsd: number;
  }>;
}>;

type CandidateCacheState = Readonly<{
  candidate: PreparedAiAnalysisCandidate;
  cached: readonly AiAnalysisRunElementResult[];
  misses: readonly PreparedAiAnalysisCandidate["selectedElements"][number][];
}>;

type CandidateExecutionOutcome =
  | Readonly<{
      status: "result";
      result: AiAnalysisRunItemResult;
    }>
  | Readonly<{
      status: "failure";
      failure: AiAnalysisRunFailure;
    }>;

function candidateDiagnosticsContext(
  context: CodexDiagnosticsContext | undefined,
  candidateId: string,
): CodexDiagnosticsContext | undefined {
  if (context == null) {
    return undefined;
  }
  return Object.freeze({
    ...context,
    candidateId,
  });
}

function validationFailureEvent(error: unknown): string {
  if (error instanceof CodexOutputSchemaValidationError) {
    return "codex.output.schema_validation_failed";
  }
  if (error instanceof CodexOutputSemanticValidationError) {
    return "codex.output.semantic_validation_failed";
  }
  if (error instanceof CodexAttemptError) {
    return "codex.fallback";
  }
  return "codex.analysis.failed";
}

async function recordCandidateFailure(
  context: CodexDiagnosticsContext | undefined,
  candidateId: string,
  error: unknown,
  phase: "execution" | "cache",
): Promise<void> {
  const candidateContext = candidateDiagnosticsContext(context, candidateId);
  const details: Record<string, DiagnosticsJsonValue> = {
    phase,
    errorType: error instanceof Error ? error.name : typeof error,
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
  await recordCodexDiagnostic(candidateContext, validationFailureEvent(error), details, error);
}

function createCacheIdentity(
  identity: AiAnalysisRunIdentity,
  elementCandidate: PreparedAiAnalysisCandidate["selectedElements"][number],
): AiCacheIdentity {
  return Object.freeze({
    ...identity,
    element: elementCandidate.element,
    revision: AI_ANALYSIS_ELEMENT_REVISIONS[elementCandidate.element],
    inputFingerprint: parseSha256Hash(elementCandidate.inputFingerprint),
    executionFingerprint: parseSha256Hash(elementCandidate.executionFingerprint),
  });
}

function resultForElement(
  output: SchemaValidCodexElementOutput,
  element: AiAnalysisElement,
): AiAnalysisElementResult {
  function requiredResult<T>(value: T | undefined, message: string): T {
    assertNonNullable(value, message);
    return value;
  }

  switch (element) {
    case "status":
      return requiredResult(output.status, "検証済みCodex出力のstatusがありません");
    case "waitingOn":
      return requiredResult(output.waitingOn, "検証済みCodex出力のwaitingOnがありません");
    case "nextAction":
      return requiredResult(output.nextAction, "検証済みCodex出力のnextActionがありません");
    case "relations":
      return requiredResult(output.relations, "検証済みCodex出力のrelationsがありません");
    case "progress":
      return requiredResult(output.progress, "検証済みCodex出力のprogressがありません");
    case "importance":
      return requiredResult(output.importance, "検証済みCodex出力のimportanceがありません");
    case "deadline":
      return requiredResult(output.deadline, "検証済みCodex出力のdeadlineがありません");
    case "notification":
      return requiredResult(output.notification, "検証済みCodex出力のnotificationがありません");
    case "selfCommitment":
      return requiredResult(output.selfCommitment, "検証済みCodex出力のselfCommitmentがありません");
    default:
      throw new TypeError(`未知のAI判定要素です。対象: ${String(element)}`);
  }
}

function assertOutputItemMatchesInput(
  output: SchemaValidCodexElementOutput,
  input: CodexAnalysisInput,
): void {
  if (output.item.nodeId === input.item.nodeId && output.item.url === input.item.url) {
    return;
  }
  throw new CodexOutputSemanticValidationError([
    Object.freeze({
      path: "/item",
      code: "item_mismatch",
      message: "Codex出力のitemが入力対象と一致しません",
    }),
  ]);
}

function validateComposedOutput(
  input: CodexAnalysisInput,
  elements: readonly AiAnalysisRunElementResult[],
): SchemaValidCodexElementOutput {
  const value: Record<string, unknown> = {
    schemaVersion: CODEX_ELEMENT_OUTPUT_SCHEMA_VERSION,
    item: {
      nodeId: input.item.nodeId,
      url: input.item.url,
    },
  };
  for (const element of elements) {
    value[element.element] = element.generation.result;
  }
  const selectedElements = elements.map((element) => element.element);
  const selectedSet = new Set<string>(selectedElements);
  const lockedElements: Record<string, unknown> = {};
  for (const [element, result] of Object.entries(input.lockedElements)) {
    if (!selectedSet.has(element)) {
      lockedElements[element] = result;
    }
  }
  const composedInput = createCodexAnalysisInput({
    ...input,
    selectedElements,
    lockedElements,
  });
  return validateCodexAnalysisSemantics(value, composedInput);
}

function createExecutionInput(state: CandidateCacheState): PreparedAiAnalysisCandidate {
  const lockedElements: Record<string, unknown> = {
    ...state.candidate.input.lockedElements,
  };
  for (const result of state.cached) {
    lockedElements[result.element] = projectCodexLockedElementResult(
      result.element,
      result.generation.result,
    );
  }
  const input = createCodexAnalysisInput({
    ...state.candidate.input,
    selectedElements: state.misses.map((value) => value.element),
    lockedElements,
  });
  const normalizedInput = `${serializeCanonicalJson(input)}\n`;
  const cachedSkipped = state.cached.map((result) => {
    const elementCandidate = state.candidate.selectedElements.find(
      (value) => value.element === result.element,
    );
    assertNonNullable(elementCandidate, `cache結果の要素候補がありません。対象: ${result.element}`);
    return Object.freeze({
      candidate: elementCandidate,
      reason: "up_to_date" as const,
    });
  });
  return Object.freeze({
    ...state.candidate,
    input,
    elementSelection: Object.freeze({
      selected: Object.freeze([...state.misses]),
      skipped: Object.freeze([...state.candidate.elementSelection.skipped, ...cachedSkipped]),
      shouldCallAi: state.misses.length !== 0,
    }),
    selectedElements: Object.freeze([...state.misses]),
    normalizedInput,
    inputCharacters: countUnicodeCharacters(normalizedInput),
  });
}

function countUnicodeCharacters(value: string): number {
  let count = 0;
  for (const character of value) {
    if (character.length === 0) {
      throw new TypeError("空のUnicode文字を検出しました");
    }
    count += 1;
  }
  return count;
}

function createElementGeneration(
  candidate: PreparedAiAnalysisCandidate,
  elementCandidate: PreparedAiAnalysisCandidate["selectedElements"][number],
  result: AiAnalysisElementResult,
  identity: AiAnalysisRunIdentity,
  generatedAt: string,
): AiAnalysisElementGeneration {
  const metadata = Object.freeze({
    ...identity,
    revision: AI_ANALYSIS_ELEMENT_REVISIONS[elementCandidate.element],
    inputFingerprint: parseSha256Hash(elementCandidate.inputFingerprint),
    executionFingerprint: parseSha256Hash(elementCandidate.executionFingerprint),
    promptFingerprint: parseSha256Hash(candidate.promptFingerprint),
    outputHash: hashCanonicalJson(result),
    generatedAt: createUtcIsoDateTime(generatedAt),
  }) satisfies AnalysisMetadata;
  return aiAnalysisElementGenerationSchema.parse({
    metadata,
    result,
  });
}

function createRunElementResult(
  element: AiAnalysisElement,
  origin: "cache" | "executed",
  cacheKey: AiCacheKey,
  generation: AiAnalysisElementGeneration,
): AiAnalysisRunElementResult {
  return Object.freeze({
    element,
    origin,
    cacheKey,
    generation,
  });
}

function createRunItemResult(
  candidateId: string,
  elements: readonly AiAnalysisRunElementResult[],
): AiAnalysisRunItemResult {
  if (elements.length === 0) {
    throw new TypeError(`AI分析結果の要素がありません。対象: ${candidateId}`);
  }
  const hasCache = elements.some((value) => value.origin === "cache");
  const hasExecuted = elements.some((value) => value.origin === "executed");
  const origin = hasCache && hasExecuted ? "mixed" : hasCache ? "cache" : "executed";
  return Object.freeze({
    candidateId,
    origin,
    elements: Object.freeze([...elements]),
  });
}

function createFailure(error: unknown, candidateId: string): AiAnalysisRunFailure {
  const diagnostic =
    error instanceof CodexNonZeroExitError
      ? Object.freeze({
          exitCode: error.exitCode,
          apiError: error.apiError,
        })
      : undefined;
  const validationDiagnostic =
    error instanceof CodexOutputValidationError
      ? Object.freeze({
          issueCount: error.issues.length,
          issues: Object.freeze(
            error.issues.slice(0, CODEX_OUTPUT_VALIDATION_ISSUE_DETAIL_LIMIT).map((issue) =>
              Object.freeze({
                path: issue.path,
                code: issue.code,
              }),
            ),
          ),
        })
      : undefined;
  return Object.freeze({
    candidateId,
    reason: classifyCodexUnavailableReason(error),
    errorType: error instanceof Error ? error.name : typeof error,
    ...(diagnostic == null ? {} : { diagnostic }),
    ...(validationDiagnostic == null ? {} : { validationDiagnostic }),
  });
}

async function resolveCacheEntries(
  candidates: readonly PreparedAiAnalysisCandidate[],
  configuration: AiAnalysisRunConfiguration,
  cache: AiCacheStore,
  target: AiAnalysisTarget | undefined,
): Promise<
  Readonly<{
    states: readonly CandidateCacheState[];
  }>
> {
  const states: CandidateCacheState[] = [];
  for (const candidate of candidates) {
    const cached: AiAnalysisRunElementResult[] = [];
    const misses: PreparedAiAnalysisCandidate["selectedElements"][number][] = [];
    for (const elementCandidate of candidate.selectedElements) {
      if (target?.nodeId === candidate.id && target.elements.includes(elementCandidate.element)) {
        misses.push(elementCandidate);
        continue;
      }
      const identity = createCacheIdentity(configuration.identity, elementCandidate);
      const cacheKey = createAiCacheKey(identity);
      const cachedValue = await cache.read(cacheKey);
      if (cachedValue.status === "hit") {
        const reuse = determineAiCacheReuse(cachedValue.entry, identity);
        if (reuse.status === "reusable") {
          const result = createRunElementResult(
            elementCandidate.element,
            "cache",
            reuse.entry.cacheKey,
            reuse.entry.generation,
          );
          cached.push(result);
          continue;
        }
      }
      misses.push(elementCandidate);
    }
    states.push(
      Object.freeze({
        candidate,
        cached: Object.freeze(cached),
        misses: Object.freeze(misses),
      }),
    );
  }
  return Object.freeze({
    states: Object.freeze(states),
  });
}

function sameSelectedElements(
  candidate: PreparedAiAnalysisCandidate,
  targetSelection: ReturnType<typeof selectAiAnalysisTarget>,
): boolean {
  if (candidate.selectedElements.length !== targetSelection.selectedElements.length) {
    return false;
  }
  const selectedElementsMatch = candidate.selectedElements.every((candidateElement, index) => {
    return candidateElement.element === targetSelection.selectedElements[index]?.element;
  });
  if (!selectedElementsMatch) {
    return false;
  }
  if (candidate.input.selectedElements.length !== targetSelection.selectedElements.length) {
    return false;
  }
  return candidate.input.selectedElements.every((element, index) => {
    return element === targetSelection.selectedElements[index]?.element;
  });
}

function selectCandidatesForRun(
  candidates: readonly PreparedAiAnalysisCandidate[],
  target: AiAnalysisTarget | undefined,
): Readonly<{
  selected: readonly PreparedAiAnalysisCandidate[];
  skipped: readonly Readonly<{
    candidate: PreparedAiAnalysisCandidate;
    reason: AiAnalysisSkipReason;
  }>[];
}> {
  if (target == null) {
    return selectAiAnalysisCandidates(candidates);
  }
  const targetSelection = selectAiAnalysisTarget(candidates, target);
  if (!sameSelectedElements(targetSelection.candidate, targetSelection)) {
    throw new TypeError("指定したAI分析対象のselectedElementsが一致しません");
  }
  return Object.freeze({
    selected: Object.freeze([targetSelection.candidate]),
    skipped: Object.freeze([]),
  });
}

function assertTargetWasExecuted(run: AiAnalysisRunResult, target: AiAnalysisTarget): void {
  const result = run.results.find((candidate) => candidate.candidateId === target.nodeId);
  if (result == null) {
    const failure = run.failures.find((candidate) => candidate.candidateId === target.nodeId);
    throw new TypeError(
      `指定したAI分析対象の実推論結果がありません。対象: ${target.nodeId}`,
      failure == null ? {} : { cause: failure },
    );
  }
  for (const element of target.elements) {
    const elementResult = result.elements.find((candidate) => candidate.element === element);
    if (elementResult?.origin !== "executed") {
      throw new TypeError(
        `指定したAI分析対象の要素が実推論されていません。対象: ${target.nodeId} 要素: ${element}`,
      );
    }
  }
}

async function executeCandidate(
  state: CandidateCacheState,
  identity: AiAnalysisRunIdentity,
  dependencies: AiAnalysisRunDependencies,
): Promise<CandidateExecutionOutcome> {
  const candidate = createExecutionInput(state);
  try {
    const output = validateCodexAnalysisSemantics(
      await dependencies.execute(candidate.input, {
        candidateId: candidate.id,
        selectedElements: Object.freeze(candidate.selectedElements.map((value) => value.element)),
      }),
      candidate.input,
    );
    assertOutputItemMatchesInput(output, candidate.input);
    const generatedAt = dependencies.executedAt();
    const executedResults: AiAnalysisRunElementResult[] = [];
    const entries: AiCacheEntry[] = [];
    for (const elementCandidate of candidate.selectedElements) {
      const result = resultForElement(output, elementCandidate.element);
      const generation = createElementGeneration(
        candidate,
        elementCandidate,
        result,
        identity,
        generatedAt,
      );
      const cacheKey = createAiCacheKey(createCacheIdentity(identity, elementCandidate));
      const entry = createAiCacheEntry({
        cacheKey,
        element: elementCandidate.element,
        generation,
      });
      entries.push(entry);
      executedResults.push(
        createRunElementResult(
          elementCandidate.element,
          "executed",
          entry.cacheKey,
          entry.generation,
        ),
      );
    }
    validateComposedOutput(candidate.input, [...state.cached, ...executedResults]);
    for (const entry of entries) {
      await dependencies.cache.write(entry);
    }
    return Object.freeze({
      status: "result",
      result: createRunItemResult(candidate.id, [...state.cached, ...executedResults]),
    });
  } catch (error: unknown) {
    if (error instanceof CodexTransportAliasError) {
      throw error;
    }
    await recordCandidateFailure(dependencies.diagnostics, candidate.id, error, "execution");
    return Object.freeze({
      status: "failure",
      failure: createFailure(error, candidate.id),
    });
  }
}

async function executeSelectedCandidates(
  states: readonly CandidateCacheState[],
  selected: readonly PreparedAiAnalysisCandidate[],
  maxConcurrentCalls: number,
  configuration: AiAnalysisRunConfiguration,
  dependencies: AiAnalysisRunDependencies,
): Promise<
  Readonly<{
    results: readonly AiAnalysisRunItemResult[];
    failures: readonly AiAnalysisRunFailure[];
  }>
> {
  if (!Number.isSafeInteger(maxConcurrentCalls) || maxConcurrentCalls <= 0) {
    throw new RangeError("Codexの最大同時呼び出し数は正の安全な整数にしてください");
  }
  const outcomes = new Map<number, CandidateExecutionOutcome>();
  let nextCandidateIndex = 0;
  let stopped = false;
  const workers = Array.from(
    { length: Math.min(maxConcurrentCalls, selected.length) },
    async () => {
      while (!stopped) {
        const candidateIndex = nextCandidateIndex;
        if (candidateIndex >= selected.length) {
          return;
        }
        nextCandidateIndex += 1;
        const candidate = selected.at(candidateIndex);
        assertNonNullable(candidate, "Codex分析候補を予算計画順に取得できませんでした");
        const state = states.find((value) => value.candidate.id === candidate.id);
        assertNonNullable(state, `Codex分析候補のcache stateがありません。対象: ${candidate.id}`);
        try {
          outcomes.set(
            candidateIndex,
            await executeCandidate(state, configuration.identity, dependencies),
          );
        } catch (error: unknown) {
          stopped = true;
          throw error;
        }
      }
    },
  );
  const settledWorkers = await Promise.allSettled(workers);
  for (const settledWorker of settledWorkers) {
    if (settledWorker.status === "rejected") {
      throw settledWorker.reason;
    }
  }
  const results: AiAnalysisRunItemResult[] = [];
  const failures: AiAnalysisRunFailure[] = [];
  for (const candidateIndex of selected.keys()) {
    const outcome = outcomes.get(candidateIndex);
    assertNonNullable(outcome, "Codex分析候補の実行結果がありません");
    if (outcome.status === "result") {
      results.push(outcome.result);
    } else {
      failures.push(outcome.failure);
    }
  }
  return Object.freeze({
    results: Object.freeze(results),
    failures: Object.freeze(failures),
  });
}

/** 選別済みの要素だけを項目ごとに一回のCodex呼び出しで分析する。 */
export async function runAiAnalyses(
  candidates: readonly PreparedAiAnalysisCandidate[],
  configuration: AiAnalysisRunConfiguration,
  dependencies: AiAnalysisRunDependencies,
): Promise<AiAnalysisRunResult> {
  const target =
    configuration.target == null ? undefined : createAiAnalysisTarget(configuration.target);
  const selection = selectCandidatesForRun(candidates, target);
  const resolved = await resolveCacheEntries(
    selection.selected,
    configuration,
    dependencies.cache,
    target,
  );
  const cachedOnlyResults = resolved.states
    .filter((state) => state.misses.length === 0)
    .map((state) => {
      validateComposedOutput(state.candidate.input, state.cached);
      return createRunItemResult(state.candidate.id, state.cached);
    });
  const executionCandidates = resolved.states
    .filter((state) => state.misses.length !== 0)
    .map((state) => createExecutionInput(state));
  const budgetPlan =
    dependencies.preflight == null
      ? planAiAnalysisBudget(executionCandidates, configuration.budget)
      : planAiAnalysisBudgetWithPreflight(
          executionCandidates,
          configuration.budget,
          dependencies.preflight,
        );
  if (dependencies.preflight != null && budgetPlan.selected.length > 0) {
    await dependencies.preflight.execute();
  }
  const executed = await executeSelectedCandidates(
    resolved.states,
    budgetPlan.selected,
    configuration.maxConcurrentCalls,
    configuration,
    dependencies,
  );
  const result = Object.freeze({
    results: Object.freeze([...cachedOnlyResults, ...executed.results]),
    failures: executed.failures,
    skipped: Object.freeze(
      selection.skipped.map((value) =>
        Object.freeze({
          candidateId: value.candidate.id,
          reason: value.reason,
        }),
      ),
    ),
    deferred: Object.freeze(
      budgetPlan.deferred.map((value) =>
        Object.freeze({
          candidateId: value.candidate.id,
          reason: value.reason,
        }),
      ),
    ),
    usage: budgetPlan.usage,
  });
  if (target != null) {
    assertTargetWasExecuted(result, target);
  }
  return result;
}
