import { serializeCanonicalJson } from "../../../canonical-json/value.js";
import { createLabelEffectsResolver } from "../../../domain/label-resolution.js";
import {
  PERSONAL_REMINDER_ASSESSMENT_RULES_VERSION,
  currentPersonalReminderAssessment,
  personalReminderCauseSchema,
  personalReminderCauseSeedSchema,
  type PersonalReminderCause,
  type PersonalReminderCauseId,
} from "../../../domain/personal-reminder-causes.js";
import {
  calculatePersonalReminderStaleness,
  updatePersonalReminderActionableClock,
  updatePersonalReminderLastConfirmedActionability,
} from "../../../domain/personal-reminder-staleness.js";
import type { Evidence, GitHubNodeId } from "../../../domain/types.js";
import { assertNonNullable } from "../../../util/index.js";
import { createPersonalReminderFinalizedStageProof } from "../contracts/proofs.js";
import type { StageState } from "../contracts/run-core.js";
import type {
  OwnedHistoricalAiResult,
  OwnedHistoricalEvidence,
} from "../contracts/evidence-closure.js";
import type { ContentDigestPort } from "../contracts/content-digest-port.js";
import type {
  PersonalReminderAssessmentAdoption,
  PersonalReminderFinalizedCause,
  PersonalReminderFinalizedItem,
} from "../contracts/personal-reminder-outcome.js";
import { adoptPersonalReminderAssessment } from "./personal-reminder-adoption.js";
import type {
  PersonalReminderExecutedRun,
  PersonalReminderExecutionOutcome,
} from "./personal-reminder-execution.js";
import {
  finalizePersonalReminderEvidence,
  personalReminderEvidenceIndexes,
} from "./personal-reminder-finalization-evidence.js";
import { indexCurrentClockEvidenceSources } from "./personal-reminder-clock-evidence.js";
import type {
  CanonicalPersonalReminderCausePlan,
  PersonalReminderCauseDecision,
} from "./personal-reminder-plan-contracts.js";
import { reconcileRetainedPersonalReminderCause } from "./personal-reminder-retained-cause.js";
import { normalizeLabelRules } from "./collection-label-rules.js";
import { collectOwnedHistoricalEvidence } from "./evidence-closure-historical.js";
import { collectOwnedHistoricalAiResults } from "./evidence-closure-historical-ai.js";

/** 個人催促の採用、時計、根拠、停滞を確定したrun。 */
export type PersonalReminderFinalizedRun = StageState<
  "personal_reminder_finalized",
  Omit<
    PersonalReminderExecutedRun["data"],
    "plan" | "outcomes" | "finalItems" | "candidateDependencyContexts"
  > &
    Readonly<{
      items: readonly PersonalReminderFinalizedItem[];
      historicalEvidence: readonly OwnedHistoricalEvidence[];
      historicalAiResults: readonly OwnedHistoricalAiResult[];
      personalReminderStatus: "success" | "fallback";
    }>
>;

type CanonicalEntry = CanonicalPersonalReminderCausePlan["entries"][number];

function uniqueIndex<Key, Value>(
  values: readonly Value[],
  keyOf: (value: Value) => Key,
  context: string,
): ReadonlyMap<Key, Value> {
  const indexed = new Map<Key, Value>();
  for (const value of values) {
    const key = keyOf(value);
    if (indexed.has(key)) throw new TypeError(`${context}が重複しています。対象: ${String(key)}`);
    indexed.set(key, value);
  }
  return indexed;
}

function currentCause(
  entry: CanonicalEntry,
  decision: PersonalReminderCauseDecision,
  outcome: PersonalReminderExecutionOutcome,
  run: PersonalReminderExecutedRun,
  digest: ContentDigestPort,
): Readonly<{ cause: PersonalReminderCause; adoption: PersonalReminderAssessmentAdoption }> {
  const batch =
    decision.choice === "execute"
      ? run.data.plan.batches.find((value) => value.id === decision.batchId)
      : undefined;
  if (decision.choice === "execute") {
    assertNonNullable(batch, `個人催促AIの計画batchがありません。対象: ${decision.causeId}`);
  }
  const adoption = adoptPersonalReminderAssessment(
    entry,
    outcome,
    run.data.sourceRecords.evaluatedAt,
    run.core.personalReminderInput.config.ai.confidence.high,
    Object.freeze({
      model: run.core.personalReminderInput.config.ai.model,
      reasoningEffort: run.core.personalReminderInput.config.ai.execution.reasoningEffort,
    }),
    batch?.batchInputFingerprint,
    digest,
  );
  if (adoption.inputFingerprint !== decision.fingerprint) {
    throw new TypeError(`個人催促採用値のfingerprintが一致しません。対象: ${decision.causeId}`);
  }
  const actionabilityStart = entry.activity.actionabilityStartByAction.find(
    ([kind]) => kind === entry.seed.action.kind,
  )?.[1];
  const clock = updatePersonalReminderActionableClock({
    cause: personalReminderCauseSeedSchema.parse(entry.seed),
    assessment: adoption.currentAssessment,
    previous:
      entry.previousCause == null
        ? Object.freeze({ availability: "not_available" })
        : Object.freeze({ availability: "available", value: entry.previousCause.actionableClock }),
    actionabilityStart,
    relevantProgress: entry.activity.relevantProgress,
    responsibleActivity: entry.activity.responsibleActivity,
    humanReviewActivity: entry.activity.humanReviewActivity,
    currentObservedAt: run.data.sourceRecords.evaluatedAt,
  });
  const cause = personalReminderCauseSchema.parse({
    ...entry.seed,
    responseMembershipAssessmentRequirement: entry.responseMembershipAssessmentRequirement,
    lastConfirmedActionability: updatePersonalReminderLastConfirmedActionability(
      adoption.currentAssessment,
      entry.seed.lastConfirmedActionability,
    ),
    currentInput: {
      fingerprint: decision.fingerprint,
      rulesVersion: PERSONAL_REMINDER_ASSESSMENT_RULES_VERSION,
      completeness: decision.exactInput.completeness,
      aiDependency: entry.currentInputAiDependency,
    },
    latestAttempt: adoption.latestAttempt,
    adoptedAssessment: adoption.adoptedAssessment,
    actionableClock: clock,
  });
  if (currentPersonalReminderAssessment(cause).status !== adoption.currentAssessment.status) {
    throw new TypeError(`個人催促原因と採用結果の現在性が一致しません。対象: ${decision.causeId}`);
  }
  return Object.freeze({ cause, adoption });
}

function finalAiDependencyContext(
  run: PersonalReminderExecutedRun,
): Parameters<typeof reconcileRetainedPersonalReminderCause>[1] {
  return Object.freeze({
    applicationsByNodeId: new Map(
      run.data.finalItems.map((item) => [item.nodeId, item.aiAnalysis.applications]),
    ),
    relationsById: new Map(run.data.graph.edges.map((edge) => [edge.id, edge])),
    candidatesById: new Map(
      run.data.candidateDependencyContexts.map((candidate) => [
        candidate.candidateId,
        Object.freeze({
          endpointNodeIds: candidate.endpointNodeIds,
          ownerNodeId: candidate.ownerNodeId,
          aiDependency: candidate.aiDependency,
        }),
      ]),
    ),
  });
}

function currentCauseEvidence(
  entry: CanonicalEntry,
  adoption: PersonalReminderAssessmentAdoption,
): readonly Evidence[] {
  const records = new Map(
    entry.sourceEvidence.map((evidence) => [serializeCanonicalJson(evidence), evidence]),
  );
  if (adoption.currentAssessment.status === "available") {
    for (const sourceId of adoption.currentAssessment.result.references.sourceIds) {
      const evidence = Object.freeze({
        sourceId,
        supports: "notification",
        summary: adoption.currentAssessment.result.references.reasonSummary,
      } satisfies Evidence);
      records.set(serializeCanonicalJson(evidence), evidence);
    }
  }
  return Object.freeze([...records.values()]);
}

function stripPreviousPersonalReminder(
  item: PersonalReminderExecutedRun["data"]["finalItems"][number],
): PersonalReminderFinalizedItem["item"] {
  const { personalReminderCauses, personalReminderCausePlanning, ...current } = item;
  void personalReminderCauses;
  void personalReminderCausePlanning;
  return Object.freeze(current);
}

/** 全項目の原因、現在性、時計、根拠、planningを一度だけ確定する。 */
export function finalizePersonalReminders(
  run: PersonalReminderExecutedRun,
  digest: ContentDigestPort,
): PersonalReminderFinalizedRun {
  const plan = run.data.plan;
  const entries = uniqueIndex(
    plan.causePlan.entries,
    (entry) => entry.seed.causeId,
    "個人催促plan原因ID",
  );
  const decisions = uniqueIndex(plan.causes, (decision) => decision.causeId, "個人催促判断ID");
  const outcomes = uniqueIndex(
    run.data.outcomes,
    (outcome) => outcome.cause.causeId,
    "個人催促実行結果ID",
  );
  if (entries.size !== decisions.size || decisions.size !== outcomes.size) {
    throw new TypeError("個人催促計画と実行結果の原因集合が一致しません");
  }
  const plannedItems = uniqueIndex(plan.items, (item) => item.itemNodeId, "個人催促項目計画ID");
  const finalItems = uniqueIndex(run.data.finalItems, (item) => item.nodeId, "個人催促最終項目ID");
  const previousItems = uniqueIndex(
    run.core.personalReminderInput.previousItems,
    (item) => item.nodeId,
    "前回個人催促項目ID",
  );
  const repositories = uniqueIndex(
    run.data.approvedRepositories,
    (repository): string => repository.id,
    "公開repository ID",
  );
  const preservedByNodeId = new Map<GitHubNodeId, PersonalReminderCause[]>();
  for (const cause of plan.causePlan.preservedCauses) {
    const values = preservedByNodeId.get(cause.itemNodeId) ?? [];
    values.push(cause);
    preservedByNodeId.set(cause.itemNodeId, values);
  }
  const preservedEvidence = new Map(plan.causePlan.preservedEvidenceByNodeId);
  if (preservedEvidence.size !== plan.causePlan.preservedEvidenceByNodeId.length) {
    throw new TypeError("個人催促保持根拠の項目IDが重複しています");
  }
  const entriesByNodeId = new Map<GitHubNodeId, CanonicalEntry[]>();
  for (const entry of plan.causePlan.entries) {
    const values = entriesByNodeId.get(entry.seed.itemNodeId) ?? [];
    values.push(entry);
    entriesByNodeId.set(entry.seed.itemNodeId, values);
  }
  const evidenceIndexes = personalReminderEvidenceIndexes(
    [
      ...run.data.finalItems.map((item) => item.evidence),
      ...run.data.graph.edges.map((edge) => edge.evidence),
      ...plan.causePlan.entries.map((entry) => entry.sourceEvidence),
    ],
    [
      ...run.core.personalReminderInput.previousItems.map((item) => item.evidence),
      ...run.core.personalReminderInput.previousRelations.map((relation) => relation.evidence),
    ],
  );
  const clockSources = indexCurrentClockEvidenceSources(
    run.data.sourceRecords,
    run.data.sourceRecords.evaluatedAt,
  );
  const relationsById = new Map(run.data.graph.edges.map((edge) => [edge.id, edge]));
  const aiContext = finalAiDependencyContext(run);
  const resolveLabelEffects = createLabelEffectsResolver(
    normalizeLabelRules(run.core.personalReminderInput.config),
  );
  const applicable = new Set(plan.causePlan.applicableItemNodeIds);
  if (
    applicable.size !== plan.causePlan.applicableItemNodeIds.length ||
    [...applicable].some((nodeId) => !finalItems.has(nodeId)) ||
    [...entries.values()].some((entry) => !applicable.has(entry.seed.itemNodeId)) ||
    [...preservedByNodeId.keys()].some((nodeId) => !applicable.has(nodeId)) ||
    [...preservedEvidence.keys()].some((nodeId) => !applicable.has(nodeId)) ||
    plan.causePlan.continuityConflicts.some((conflict) => applicable.has(conflict.itemNodeId))
  ) {
    throw new TypeError("個人催促計画の適用項目集合が一致しません");
  }
  const causeIds = new Set<PersonalReminderCauseId>();
  let processedEntryCount = 0;
  const items: PersonalReminderFinalizedItem[] = [];
  for (const graphItem of run.data.finalItems) {
    const planned = plannedItems.get(graphItem.nodeId);
    assertNonNullable(planned, `個人催促項目計画がありません。対象: ${graphItem.nodeId}`);
    const previous = previousItems.get(graphItem.nodeId);
    const currentEntries = entriesByNodeId.get(graphItem.nodeId) ?? [];
    const current = applicable.has(graphItem.nodeId);
    const causeResults: Readonly<{
      cause: PersonalReminderCause;
      assessment: PersonalReminderFinalizedCause["assessment"];
    }>[] = [];
    const evidence: Evidence[] = current
      ? [...(preservedEvidence.get(graphItem.nodeId) ?? [])]
      : [];
    if (current) {
      for (const cause of preservedByNodeId.get(graphItem.nodeId) ?? []) {
        const retained = reconcileRetainedPersonalReminderCause(cause, aiContext);
        causeResults.push(
          Object.freeze({
            cause: retained,
            assessment: Object.freeze({
              applicationSource: "retained",
              currentness:
                currentPersonalReminderAssessment(retained).status === "available"
                  ? "available"
                  : "unverified",
              reason: "retained_without_evaluation",
            }),
          }),
        );
      }
      for (const entry of currentEntries) {
        processedEntryCount += 1;
        const decision = decisions.get(entry.seed.causeId);
        const outcome = outcomes.get(entry.seed.causeId);
        assertNonNullable(decision, `個人催促判断がありません。対象: ${entry.seed.causeId}`);
        assertNonNullable(outcome, `個人催促実行結果がありません。対象: ${entry.seed.causeId}`);
        const result = currentCause(entry, decision, outcome, run, digest);
        causeResults.push(
          Object.freeze({
            cause: result.cause,
            assessment: Object.freeze({
              applicationSource: result.adoption.applicationSource,
              currentness: result.adoption.currentness,
              reason: decision.reason,
            }),
          }),
        );
        evidence.push(...currentCauseEvidence(entry, result.adoption));
      }
    } else {
      assertNonNullable(
        previous,
        `個人催促保持項目が前回stateにありません。対象: ${graphItem.nodeId}`,
      );
      evidence.push(...previous.evidence);
      for (const previousCause of previous.personalReminderCauses) {
        const cause = reconcileRetainedPersonalReminderCause(previousCause, aiContext);
        causeResults.push(
          Object.freeze({
            cause,
            assessment: Object.freeze({
              applicationSource: "retained",
              currentness:
                currentPersonalReminderAssessment(cause).status === "available"
                  ? "available"
                  : "unverified",
              reason: "retained_without_evaluation",
            }),
          }),
        );
      }
    }
    if (planned.status === "excluded" && causeResults.length !== 0) {
      throw new TypeError(`個人催促excluded項目に原因があります。対象: ${graphItem.nodeId}`);
    }
    if (!current && planned.status === "completed") {
      throw new TypeError(`個人催促保持項目の計画がcompletedです。対象: ${graphItem.nodeId}`);
    }
    const repository = repositories.get(graphItem.repositoryId);
    assertNonNullable(
      repository,
      `個人催促項目の公開repositoryがありません。対象: ${graphItem.nodeId}`,
    );
    const finalizedCauses = Object.freeze(
      causeResults
        .map(({ cause, assessment }): PersonalReminderFinalizedCause => {
          if (cause.itemNodeId !== graphItem.nodeId || causeIds.has(cause.causeId)) {
            throw new TypeError(
              `個人催促原因IDまたは所有項目が競合しています。対象: ${cause.causeId}`,
            );
          }
          causeIds.add(cause.causeId);
          return Object.freeze({
            cause,
            assessment,
            staleness: calculatePersonalReminderStaleness({
              cause,
              evaluatedAt: run.data.sourceRecords.evaluatedAt,
              minimumAiConfidence: run.core.personalReminderInput.config.ai.confidence.medium,
              repositoryFullName: `${repository.owner}/${repository.name}`,
              currentLabels: graphItem.labels,
              resolveLabelEffects,
              thresholdsHours: run.core.personalReminderInput.config.staleness.thresholdsHours,
            }),
          });
        })
        .sort((left, right) => left.cause.causeId.localeCompare(right.cause.causeId)),
    );
    const completeEvidence = finalizePersonalReminderEvidence(
      graphItem.nodeId,
      finalizedCauses.map((result) => result.cause),
      evidence,
      evidenceIndexes.current,
      evidenceIndexes.previous,
      clockSources,
      relationsById,
      run.data.sourceRecords.evaluatedAt,
    );
    items.push(
      Object.freeze({
        item: stripPreviousPersonalReminder(graphItem),
        causeResults: finalizedCauses,
        evidence: completeEvidence,
        planning: planned.planning,
      }),
    );
  }
  if (
    items.length !== plannedItems.size ||
    items.length !== finalItems.size ||
    processedEntryCount !== entries.size
  ) {
    throw new TypeError("個人催促最終項目と計画項目の集合が一致しません");
  }
  const personalReminderStatus =
    run.data.snapshotProjection.unavailablePersonalReminderConsumer ||
    run.data.plan.causePlan.continuityConflicts.length > 0 ||
    run.data.plan.causePlan.incompleteInputNodeIds.length > 0 ||
    run.data.plan.causePlan.deferredStructuralEndNodeIds.length > 0 ||
    items.some((item) => item.planning.status === "pending") ||
    items.some((item) =>
      item.causeResults.some(({ assessment }) => assessment.currentness === "unverified"),
    )
      ? "fallback"
      : "success";
  return Object.freeze({
    stage: "personal_reminder_finalized",
    core: Object.freeze({
      identity: run.core.identity,
      executionPolicy: run.core.executionPolicy,
      configDigest: run.core.configDigest,
      baseRevision: run.core.baseRevision,
      aiBudget: run.core.aiBudget,
    }),
    data: Object.freeze({
      approvedRepositories: run.data.approvedRepositories,
      allowlistDigest: run.data.allowlistDigest,
      sourceCatalog: run.data.sourceCatalog,
      sourceRecords: run.data.sourceRecords,
      aiItems: run.data.aiItems,
      graph: run.data.graph,
      finalGraphProjection: run.data.finalGraphProjection,
      items: Object.freeze(items),
      snapshotProjection: run.data.snapshotProjection,
      personalReminderStatus,
      historicalEvidence: collectOwnedHistoricalEvidence(
        run.core.personalReminderInput.previousBaseSnapshot.items,
        run.core.personalReminderInput.previousBaseSnapshot.relations,
      ),
      historicalAiResults: collectOwnedHistoricalAiResults(
        run.core.personalReminderInput.previousAiSnapshot,
      ),
    }),
    proof: createPersonalReminderFinalizedStageProof(),
  });
}
