import { serializeCanonicalJson } from "../../../canonical-json/value.js";
import { CODEX_BACKEND_VERSION } from "../../../codex/backend-version.js";
import {
  estimateAiInputCost,
  planAiAnalysisBudget,
  planAiAnalysisBudgetWithPreflight,
} from "../../../codex/budget.js";
import type { AiAnalysisPriority } from "../../../codex/analysis-selection.js";
import type { ContentDigestPort } from "../contracts/content-digest-port.js";
import type { PreviousPersonalReminderAiCacheEntry } from "../contracts/previous-state.js";
import { createPersonalReminderCauseInputFingerprint } from "../../../codex/personal-reminder-input-assessment.js";
import { preparePersonalReminderAiBatch } from "../../../codex/personal-reminder-input-transport.js";
import { createPersonalReminderCauseSemanticInput } from "../../../codex/personal-reminder-input-core.js";
import type {
  PersonalReminderCauseSemanticInput,
  PreparedPersonalReminderAiBatch,
} from "../../../codex/personal-reminder-input-contracts.js";
import {
  CODEX_AUTHENTICATION_PREFLIGHT_INPUT_CHARACTERS,
  CODEX_AUTHENTICATION_PREFLIGHT_PROMPT,
} from "../../../codex/preflight.js";
import {
  PERSONAL_REMINDER_AI_GENERATION_SCHEMA_VERSION,
  PERSONAL_REMINDER_AI_INPUT_SCHEMA_VERSION,
  PERSONAL_REMINDER_AI_OUTPUT_SCHEMA_VERSION,
  PERSONAL_REMINDER_AI_PROMPT_VERSION,
  PERSONAL_REMINDER_AI_REVISION,
  PERSONAL_REMINDER_ASSESSMENT_RULES_VERSION,
  currentPersonalReminderAssessment,
  type PersonalReminderCauseId,
  type PersonalReminderDeferredReason,
} from "../../../domain/personal-reminder-causes.js";
import type { GitHubNodeId } from "../../../domain/types.js";
import { assertNonNullable } from "../../../util/index.js";
import {
  releaseAiBudgetAttempt,
  reserveAiBudgetAttempt,
  summarizeAiBudgetLedger,
  type AiBudgetCharge,
  type AiBudgetLedgerSnapshot,
  type AiBudgetReservation,
} from "../contracts/ai-budget-ledger.js";
import type { GraphReconciledRun } from "./graph-reconciliation.js";
import type {
  PersonalReminderCauseDecision,
  PersonalReminderPlannedBatch,
} from "./personal-reminder-plan-contracts.js";
import type { PersonalReminderCauseRuntimePlanEntry } from "./personal-reminder-runtime-contracts.js";

type Miss = Readonly<{
  entry: PersonalReminderCauseRuntimePlanEntry;
  exactInput: PersonalReminderCauseSemanticInput;
  fingerprint: ReturnType<typeof createPersonalReminderCauseInputFingerprint>;
  priority: AiAnalysisPriority;
}>;

type BudgetBatch = Readonly<{
  id: string;
  itemNodeId: GitHubNodeId;
  misses: readonly Miss[];
  batch: PreparedPersonalReminderAiBatch;
  inputCharacters: number;
  priority: AiAnalysisPriority;
  estimatedCostUsd: number;
}>;

/** 原因別の評価判断と実行枠を確定した結果。 */
export type PersonalReminderAiPlanning = Readonly<{
  causes: readonly PersonalReminderCauseDecision[];
  batches: readonly PersonalReminderPlannedBatch[];
  preflightReservation?: AiBudgetReservation;
  ledger: AiBudgetLedgerSnapshot;
}>;

function priorityForEntry(
  entry: PersonalReminderCauseRuntimePlanEntry,
  run: GraphReconciledRun,
): AiAnalysisPriority {
  const downstreamImpact = run.data.graph.analysis.downstreamImpacts.find(
    (impact) => impact.nodeId === entry.seed.itemNodeId,
  );
  return Object.freeze({
    previouslyDeferred: entry.previousCause?.latestAttempt.status === "deferred",
    severityCandidate: true,
    ownerUnknown: entry.seed.responsible.some((responsible) => responsible.kind === "role"),
    changedBlocker:
      entry.semanticInput.relations.length !== 0 ||
      entry.semanticInput.pendingRelations.length !== 0,
    downstreamImpact: Object.freeze({
      openNodeCount: downstreamImpact?.openNodeCount ?? 0,
      repositoryCount: downstreamImpact?.repositoryCount ?? 0,
    }),
  });
}

function mergedPriority(misses: readonly Miss[]): AiAnalysisPriority {
  return Object.freeze({
    previouslyDeferred: misses.some((miss) => miss.priority.previouslyDeferred),
    severityCandidate: misses.some((miss) => miss.priority.severityCandidate),
    ownerUnknown: misses.some((miss) => miss.priority.ownerUnknown),
    changedBlocker: misses.some((miss) => miss.priority.changedBlocker),
    downstreamImpact: Object.freeze({
      openNodeCount: Math.max(
        ...misses.map((miss) => miss.priority.downstreamImpact.openNodeCount),
      ),
      repositoryCount: Math.max(
        ...misses.map((miss) => miss.priority.downstreamImpact.repositoryCount),
      ),
    }),
  });
}

function hashCanonical(value: unknown, digest: ContentDigestPort): string {
  return digest.sha256Utf8(serializeCanonicalJson(value));
}

function assertCacheIntegrity(
  entry: PreviousPersonalReminderAiCacheEntry,
  digest: ContentDigestPort,
): void {
  const metadata = entry.generation.metadata;
  const expectedKey = hashCanonical(
    {
      backendVersion: metadata.backendVersion,
      causeId: entry.causeId,
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
  if (expectedKey !== entry.cacheKey) {
    throw new TypeError(`個人催促AI cacheのkeyとmetadataが一致しません。対象: ${entry.causeId}`);
  }
  if (hashCanonical(entry.generation.result, digest) !== metadata.outputHash) {
    throw new TypeError(`個人催促AI cacheの出力hashが一致しません。対象: ${entry.causeId}`);
  }
  if (
    hashCanonical(
      {
        batchInputFingerprint: metadata.batchInputFingerprint,
        promptVersion: PERSONAL_REMINDER_AI_PROMPT_VERSION,
      },
      digest,
    ) !== metadata.promptFingerprint
  ) {
    throw new TypeError(
      `個人催促AI cacheのprompt fingerprintが一致しません。対象: ${entry.causeId}`,
    );
  }
}

function cacheIndex(
  run: GraphReconciledRun,
  digest: ContentDigestPort,
): ReadonlyMap<string, PreviousPersonalReminderAiCacheEntry> {
  const entries = new Map<string, PreviousPersonalReminderAiCacheEntry>();
  for (const previous of run.core.personalReminderInput.aiCache) {
    const entry = previous;
    assertCacheIntegrity(entry, digest);
    const existing = entries.get(entry.cacheKey);
    if (existing != null && serializeCanonicalJson(existing) !== serializeCanonicalJson(entry)) {
      throw new TypeError(`個人催促AI cache keyの記録が競合しています。対象: ${entry.cacheKey}`);
    }
    entries.set(entry.cacheKey, entry);
  }
  return entries;
}

function cacheKey(
  run: GraphReconciledRun,
  causeId: PersonalReminderCauseId,
  fingerprint: ReturnType<typeof createPersonalReminderCauseInputFingerprint>,
  digest: ContentDigestPort,
): string {
  const ai = run.core.personalReminderInput.config.ai;
  const executionFingerprint = hashCanonical(
    {
      backendVersion: CODEX_BACKEND_VERSION,
      inputSchemaVersion: PERSONAL_REMINDER_AI_INPUT_SCHEMA_VERSION,
      model: ai.model,
      outputSchemaVersion: PERSONAL_REMINDER_AI_OUTPUT_SCHEMA_VERSION,
      promptVersion: PERSONAL_REMINDER_AI_PROMPT_VERSION,
      reasoningEffort: ai.execution.reasoningEffort,
      revision: PERSONAL_REMINDER_AI_REVISION,
      schemaVersion: PERSONAL_REMINDER_AI_GENERATION_SCHEMA_VERSION,
    },
    digest,
  );
  return hashCanonical(
    {
      causeId,
      revision: PERSONAL_REMINDER_AI_REVISION,
      rulesVersion: PERSONAL_REMINDER_ASSESSMENT_RULES_VERSION,
      model: ai.model,
      reasoningEffort: ai.execution.reasoningEffort,
      backendVersion: CODEX_BACKEND_VERSION,
      schemaVersion: PERSONAL_REMINDER_AI_GENERATION_SCHEMA_VERSION,
      inputFingerprint: fingerprint,
      executionFingerprint,
    },
    digest,
  );
}

function deferred(
  miss: Miss,
  reason: PersonalReminderDeferredReason | "ai_disabled" | "forced_generic_target",
): PersonalReminderCauseDecision {
  return Object.freeze({
    causeId: miss.entry.seed.causeId,
    itemNodeId: miss.entry.seed.itemNodeId,
    exactInput: miss.exactInput,
    fingerprint: miss.fingerprint,
    choice: "deferred",
    reason,
  });
}

function initialDecision(
  entry: PersonalReminderCauseRuntimePlanEntry,
  run: GraphReconciledRun,
  cache: ReadonlyMap<string, PreviousPersonalReminderAiCacheEntry>,
  forcedGenericTarget: boolean,
  digest: ContentDigestPort,
): Readonly<{ decision: PersonalReminderCauseDecision }> | Readonly<{ miss: Miss }> {
  const exactInput = createPersonalReminderCauseSemanticInput(entry.semanticInput);
  const fingerprint = createPersonalReminderCauseInputFingerprint(exactInput, digest);
  const base = Object.freeze({
    causeId: entry.seed.causeId,
    itemNodeId: entry.seed.itemNodeId,
    exactInput,
    fingerprint,
  });
  if (exactInput.completeness.status === "incomplete") {
    return Object.freeze({
      decision: Object.freeze({
        ...base,
        choice: "deferred",
        reason: exactInput.pendingRelations.length !== 0 ? "upstream_relation" : "input_incomplete",
      }),
    });
  }
  if (entry.deterministicAssessment != null) {
    return Object.freeze({
      decision: Object.freeze({ ...base, choice: "deterministic", reason: "fixed_assessment" }),
    });
  }
  if (
    entry.previousCause?.currentInput.fingerprint === fingerprint &&
    entry.previousCause.currentInput.rulesVersion === PERSONAL_REMINDER_ASSESSMENT_RULES_VERSION &&
    currentPersonalReminderAssessment({
      currentInput: {
        fingerprint,
        rulesVersion: PERSONAL_REMINDER_ASSESSMENT_RULES_VERSION,
        aiDependency: entry.currentInputAiDependency,
      },
      adoptedAssessment: entry.previousCause.adoptedAssessment,
    }).status === "available"
  ) {
    return Object.freeze({
      decision: Object.freeze({
        ...base,
        choice: "snapshot_reuse",
        reason: "current_completed_assessment",
      }),
    });
  }
  const miss = Object.freeze({
    entry,
    exactInput,
    fingerprint,
    priority: priorityForEntry(entry, run),
  });
  if (!run.core.personalReminderInput.config.ai.enabled) {
    return Object.freeze({ decision: deferred(miss, "ai_disabled") });
  }
  if (forcedGenericTarget) {
    return Object.freeze({ decision: deferred(miss, "forced_generic_target") });
  }
  const key = cacheKey(run, entry.seed.causeId, fingerprint, digest);
  const cached = cache.get(key);
  if (
    cached?.causeId === entry.seed.causeId &&
    cached.generation.metadata.inputFingerprint === fingerprint &&
    cached.generation.metadata.rulesVersion === PERSONAL_REMINDER_ASSESSMENT_RULES_VERSION
  ) {
    return Object.freeze({
      decision: Object.freeze({
        ...base,
        choice: "cache_hit",
        reason: "current_input_cached",
        entry: cached,
      }),
    });
  }
  return Object.freeze({ miss });
}

function preparedBatches(
  misses: readonly Miss[],
  run: GraphReconciledRun,
  decisions: Map<PersonalReminderCauseId, PersonalReminderCauseDecision>,
  digest: ContentDigestPort,
): readonly BudgetBatch[] {
  const byItem = new Map<GitHubNodeId, Miss[]>();
  for (const miss of misses) {
    const itemMisses = byItem.get(miss.entry.seed.itemNodeId) ?? [];
    itemMisses.push(miss);
    byItem.set(miss.entry.seed.itemNodeId, itemMisses);
  }
  const batches: BudgetBatch[] = [];
  for (const [itemNodeId, itemMisses] of [...byItem.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const ordered = [...itemMisses].sort((left, right) =>
      left.entry.seed.causeId.localeCompare(right.entry.seed.causeId),
    );
    const first = ordered[0];
    assertNonNullable(first, `個人催促AI batchの原因がありません。対象: ${itemNodeId}`);
    const inputs: [PersonalReminderCauseSemanticInput, ...PersonalReminderCauseSemanticInput[]] = [
      first.exactInput,
      ...ordered.slice(1).map((miss) => miss.exactInput),
    ];
    const prepared = preparePersonalReminderAiBatch(inputs, digest);
    if (prepared.status === "over_capacity") {
      for (const miss of ordered)
        decisions.set(miss.entry.seed.causeId, deferred(miss, "input_cardinality_limit"));
      continue;
    }
    for (const miss of ordered) {
      const causeInput = prepared.batch.causeInputs.get(miss.entry.seed.causeId);
      assertNonNullable(
        causeInput,
        `個人催促AI batchの原因入力がありません。対象: ${miss.entry.seed.causeId}`,
      );
      if (causeInput.inputFingerprint !== miss.fingerprint) {
        throw new TypeError(
          `個人催促AI batchのfingerprintが一致しません。対象: ${miss.entry.seed.causeId}`,
        );
      }
    }
    batches.push(
      Object.freeze({
        id: prepared.batch.id,
        itemNodeId,
        misses: Object.freeze(ordered),
        batch: prepared.batch,
        inputCharacters: prepared.batch.inputCharacters,
        priority: mergedPriority(ordered),
        estimatedCostUsd: estimateAiInputCost(
          prepared.batch.normalizedInput,
          run.core.personalReminderInput.config.ai.budget.estimatedInputCostUsdPerMillionTokens,
        ).estimatedCostUsd,
      }),
    );
  }
  return Object.freeze(batches);
}

function chargeForBatch(batch: BudgetBatch, run: GraphReconciledRun): AiBudgetCharge {
  const estimate = estimateAiInputCost(
    batch.batch.normalizedInput,
    run.core.personalReminderInput.config.ai.budget.estimatedInputCostUsdPerMillionTokens,
  );
  return Object.freeze({
    inputCharacters: batch.inputCharacters,
    estimatedInputTokens: estimate.estimatedInputTokens,
    estimatedCostUsd: estimate.estimatedCostUsd,
  });
}

function preflightCharge(run: GraphReconciledRun): AiBudgetCharge | undefined {
  const ai = run.core.personalReminderInput.config.ai;
  if (
    ai.authentication !== "auth-json" ||
    run.core.aiBudget.events.some(
      (event) =>
        event.action === "consumed" && event.reservation.kind === "authentication_preflight",
    )
  ) {
    return undefined;
  }
  const estimate = estimateAiInputCost(
    CODEX_AUTHENTICATION_PREFLIGHT_PROMPT,
    ai.budget.estimatedInputCostUsdPerMillionTokens,
  );
  return Object.freeze({
    inputCharacters: CODEX_AUTHENTICATION_PREFLIGHT_INPUT_CHARACTERS,
    estimatedInputTokens: estimate.estimatedInputTokens,
    estimatedCostUsd: estimate.estimatedCostUsd,
  });
}

function plannedBatch(
  batch: BudgetBatch,
  reservation: AiBudgetReservation,
): PersonalReminderPlannedBatch {
  const sortedEntries = <Key extends string, Value>(
    values: ReadonlyMap<Key, Value>,
  ): readonly (readonly [Key, Value])[] =>
    Object.freeze([...values.entries()].sort(([left], [right]) => left.localeCompare(right)));
  return Object.freeze({
    id: batch.id,
    itemNodeId: batch.itemNodeId,
    causeIds: Object.freeze(batch.misses.map((miss) => miss.entry.seed.causeId)),
    input: batch.batch.input,
    normalizedInput: batch.batch.normalizedInput,
    inputCharacters: batch.batch.inputCharacters,
    batchInputFingerprint: batch.batch.batchInputFingerprint,
    refs: Object.freeze({
      items: sortedEntries(batch.batch.refs.items),
      relations: sortedEntries(batch.batch.refs.relations),
      sources: sortedEntries(batch.batch.refs.sources),
    }),
    reservation,
  });
}

/** 前回assessmentとcacheを照合し、残予算へcause単位の実行を予約する。 */
export function planPersonalReminderAi(
  entries: readonly PersonalReminderCauseRuntimePlanEntry[],
  run: GraphReconciledRun,
  forcedGenericTarget: boolean,
  digest: ContentDigestPort,
): PersonalReminderAiPlanning {
  const cache = cacheIndex(run, digest);
  const decisions = new Map<PersonalReminderCauseId, PersonalReminderCauseDecision>();
  const misses: Miss[] = [];
  for (const entry of entries) {
    if (
      decisions.has(entry.seed.causeId) ||
      misses.some((miss) => miss.entry.seed.causeId === entry.seed.causeId)
    ) {
      throw new TypeError(`個人催促原因IDが重複しています。対象: ${entry.seed.causeId}`);
    }
    const result = initialDecision(entry, run, cache, forcedGenericTarget, digest);
    if ("decision" in result) decisions.set(entry.seed.causeId, result.decision);
    else misses.push(result.miss);
  }
  const batches = preparedBatches(misses, run, decisions, digest);
  const summary = summarizeAiBudgetLedger(run.core.aiBudget);
  const initialUsage = Object.freeze({
    calls: summary.logicalCandidateCount + summary.authenticationPreflightAttemptCount,
    inputCharacters: summary.inputCharacters,
    estimatedCostUsd: summary.estimatedCostUsd,
  });
  const preflight = batches.length === 0 ? undefined : preflightCharge(run);
  const budget = run.core.personalReminderInput.config.ai.budget;
  const budgetPlan =
    preflight == null
      ? planAiAnalysisBudget(batches, budget, initialUsage)
      : planAiAnalysisBudgetWithPreflight(batches, budget, initialUsage, preflight);
  for (const deferredBatch of budgetPlan.deferred) {
    for (const miss of deferredBatch.candidate.misses) {
      decisions.set(miss.entry.seed.causeId, deferred(miss, deferredBatch.reason));
    }
  }
  let ledger = run.core.aiBudget;
  const selected: PersonalReminderPlannedBatch[] = [];
  let preflightReservation: AiBudgetReservation | undefined;
  if (budgetPlan.selected.length !== 0 && preflight != null) {
    const reserved = reserveAiBudgetAttempt(
      ledger,
      "authentication_preflight",
      "authentication",
      preflight,
    );
    if (reserved != null) {
      ledger = reserved.snapshot;
      preflightReservation = reserved.reservation;
    }
  }
  for (const batch of budgetPlan.selected) {
    const reserved =
      preflight != null && preflightReservation == null
        ? undefined
        : reserveAiBudgetAttempt(ledger, "personal_initial", batch.id, chargeForBatch(batch, run));
    if (reserved == null) {
      for (const miss of batch.misses)
        decisions.set(miss.entry.seed.causeId, deferred(miss, "call_limit"));
      continue;
    }
    ledger = reserved.snapshot;
    selected.push(plannedBatch(batch, reserved.reservation));
    for (const miss of batch.misses) {
      decisions.set(
        miss.entry.seed.causeId,
        Object.freeze({
          causeId: miss.entry.seed.causeId,
          itemNodeId: miss.entry.seed.itemNodeId,
          exactInput: miss.exactInput,
          fingerprint: miss.fingerprint,
          choice: "execute",
          reason: "cache_miss",
          batchId: batch.id,
          priority: miss.priority,
        }),
      );
    }
  }
  if (selected.length === 0 && preflightReservation != null) {
    ledger = releaseAiBudgetAttempt(ledger, preflightReservation.id);
    preflightReservation = undefined;
  }
  if (decisions.size !== entries.length)
    throw new TypeError("個人催促原因のAI計画件数が一致しません");
  return Object.freeze({
    causes: Object.freeze(
      [...decisions.values()].sort((left, right) => left.causeId.localeCompare(right.causeId)),
    ),
    batches: Object.freeze(selected),
    ...(preflightReservation == null ? {} : { preflightReservation }),
    ledger,
  });
}
