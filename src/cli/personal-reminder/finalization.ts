import { serializeCanonicalJson } from "../../canonical-json/index.js";
import {
  reconcileRetainedAiAnalysisDependency,
  type AiAnalysisDependencyReconciliationContext,
} from "../../domain/ai-analysis-dependencies.js";
import {
  PERSONAL_REMINDER_CAUSE_PLANNING_VERSION,
  personalReminderCauseSchema,
  type PersonalReminderCause,
  type PersonalReminderCauseId,
  type PersonalReminderCausePlanning,
} from "../../domain/personal-reminder-causes.js";
import { type LabelEffectsResolver } from "../../domain/label-resolution.js";
import { type SeverityThresholds } from "../../domain/severity.js";
import { type SourceId } from "../../domain/source-id.js";
import { calculatePersonalReminderStaleness } from "../../domain/personal-reminder-staleness.js";
import type { Evidence, GitHubNodeId, UtcIsoDateTime } from "../../domain/types.js";
import { assertNonNullable } from "../../util/index.js";
import type { PersonalReminderCauseRuntimePlan } from "../personal-reminder-runtime.js";
import type {
  PersonalReminderAnalysisResult,
  PersonalReminderAnalyzedItem,
  PersonalReminderFinalizationItem,
  PersonalReminderOutcomeApplication,
} from "./analysis-result.js";

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** 保持原因の値を変えずにAI依存を最終適用元へ照合する。 */
export function reconcileRetainedPersonalReminderCause(
  cause: PersonalReminderCause,
  context: AiAnalysisDependencyReconciliationContext,
): PersonalReminderCause {
  return personalReminderCauseSchema.parse({
    ...cause,
    aiDependencies: {
      presence: reconcileRetainedAiAnalysisDependency(cause.aiDependencies.presence, context),
      responseMembership: reconcileRetainedAiAnalysisDependency(
        cause.aiDependencies.responseMembership,
        context,
      ),
      responsible: reconcileRetainedAiAnalysisDependency(cause.aiDependencies.responsible, context),
      action: reconcileRetainedAiAnalysisDependency(cause.aiDependencies.action, context),
      evidence: reconcileRetainedAiAnalysisDependency(cause.aiDependencies.evidence, context),
    },
    currentInput: {
      ...cause.currentInput,
      aiDependency: reconcileRetainedAiAnalysisDependency(cause.currentInput.aiDependency, context),
    },
  });
}

/** 保持経路の個人催促cause計画をpendingへ戻し、terminalでcauseなしだけexcludedにする。 */
function reconcileRetainedPersonalReminderPlanning(
  itemState: "open" | "closed" | "merged",
  planning: PersonalReminderCausePlanning,
  causes: readonly PersonalReminderCause[],
): PersonalReminderCausePlanning {
  if (planning.status === "excluded" && (itemState === "open" || causes.length !== 0)) {
    throw new TypeError("個人催促cause planningのexcluded状態が項目と一致しません");
  }
  if (itemState !== "open" && causes.length === 0) {
    return Object.freeze({
      status: "excluded",
      planningVersion: PERSONAL_REMINDER_CAUSE_PLANNING_VERSION,
      reason: "terminal_without_cause",
    });
  }
  return Object.freeze({
    status: "pending",
    planningVersion: PERSONAL_REMINDER_CAUSE_PLANNING_VERSION,
  });
}

type FinalizationInput = Readonly<{
  plan: PersonalReminderCauseRuntimePlan;
  application: PersonalReminderOutcomeApplication;
  expectedItemNodeIds: readonly GitHubNodeId[];
  items: readonly PersonalReminderFinalizationItem[];
  evaluatedAt: UtcIsoDateTime;
  aiDependencyContext: AiAnalysisDependencyReconciliationContext;
  currentEvidenceBySourceId: ReadonlyMap<SourceId, readonly Evidence[]>;
  previousEvidenceBySourceId: ReadonlyMap<SourceId, readonly Evidence[]>;
  minimumAiConfidence: number;
  thresholdsHours: SeverityThresholds;
  resolveLabelEffects: LabelEffectsResolver;
}>;

type UnfinalizedItem = Readonly<{
  item: PersonalReminderFinalizationItem;
  causes: readonly PersonalReminderCause[];
  evidence: readonly Evidence[];
  planning: PersonalReminderCausePlanning;
}>;

function uniqueNodeIds(nodeIds: readonly GitHubNodeId[], label: string): ReadonlySet<GitHubNodeId> {
  const ids = new Set<GitHubNodeId>();
  for (const nodeId of nodeIds) {
    if (ids.has(nodeId)) {
      throw new TypeError(`個人催促${label}の項目IDが重複しています。対象: ${nodeId}`);
    }
    ids.add(nodeId);
  }
  return ids;
}

function assertSameNodeIds(
  expected: ReadonlySet<GitHubNodeId>,
  actual: ReadonlySet<GitHubNodeId>,
  label: string,
): void {
  for (const nodeId of expected) {
    if (!actual.has(nodeId)) {
      throw new TypeError(`個人催促${label}に項目がありません。対象: ${nodeId}`);
    }
  }
  for (const nodeId of actual) {
    if (!expected.has(nodeId)) {
      throw new TypeError(`個人催促${label}に対象外の項目があります。対象: ${nodeId}`);
    }
  }
}

function planningForEvaluatedItem(
  item: Extract<PersonalReminderFinalizationItem, { kind: "evaluated" }>,
  causes: readonly PersonalReminderCause[],
  input: FinalizationInput,
): PersonalReminderCausePlanning {
  if (
    causes.length !== 0 &&
    (item.collectionCompleteness === "incomplete" ||
      input.plan.incompleteInputNodeIds.has(item.itemNodeId) ||
      input.plan.deferredStructuralEndNodeIds.has(item.itemNodeId) ||
      input.plan.unrecordedDependencyNodeIds.has(item.itemNodeId))
  ) {
    return Object.freeze({
      status: "pending",
      planningVersion: PERSONAL_REMINDER_CAUSE_PLANNING_VERSION,
    });
  }
  if (causes.length === 0 && item.itemState !== "open") {
    return Object.freeze({
      status: "excluded",
      planningVersion: PERSONAL_REMINDER_CAUSE_PLANNING_VERSION,
      reason: "terminal_without_cause",
    });
  }
  const causeSetAiDependency = input.plan.causeSetAiDependencyByNodeId.get(item.itemNodeId);
  assertNonNullable(
    causeSetAiDependency,
    `個人催促cause集合のAI依存がありません。対象: ${item.itemNodeId}`,
  );
  const causeSetSubjectChanges = input.plan.causeSetSubjectChangesByNodeId.get(item.itemNodeId);
  assertNonNullable(
    causeSetSubjectChanges,
    `個人催促cause集合の主体変化範囲がありません。対象: ${item.itemNodeId}`,
  );
  return Object.freeze({
    status: "completed",
    planningVersion: PERSONAL_REMINDER_CAUSE_PLANNING_VERSION,
    observedAt: input.evaluatedAt,
    causeSetAiDependency,
    causeSetSubjectChanges,
  });
}

function evidenceSourceIndex(
  evidenceGroups: readonly (readonly Evidence[])[],
): ReadonlyMap<SourceId, readonly Evidence[]> {
  const evidenceBySourceId = new Map<SourceId, Map<string, Evidence>>();
  for (const group of evidenceGroups) {
    for (const evidence of group) {
      const identity = serializeCanonicalJson(evidence);
      const byIdentity = evidenceBySourceId.get(evidence.sourceId);
      if (byIdentity == null) {
        evidenceBySourceId.set(evidence.sourceId, new Map([[identity, evidence]]));
      } else {
        byIdentity.set(identity, evidence);
      }
    }
  }
  const index = new Map<SourceId, readonly Evidence[]>();
  for (const sourceId of [...evidenceBySourceId.keys()].sort(compareStrings)) {
    const byIdentity = evidenceBySourceId.get(sourceId);
    assertNonNullable(byIdentity, `個人催促evidence source索引がありません。対象: ${sourceId}`);
    index.set(
      sourceId,
      Object.freeze(
        [...byIdentity.values()].sort((left, right) =>
          compareStrings(serializeCanonicalJson(left), serializeCanonicalJson(right)),
        ),
      ),
    );
  }
  return index;
}

function completePersonalReminderEvidenceClosure(
  itemNodeId: GitHubNodeId,
  causes: readonly PersonalReminderCause[],
  existingEvidence: readonly Evidence[],
  currentEvidenceBySourceId: ReadonlyMap<SourceId, readonly Evidence[]>,
  previousEvidenceBySourceId: ReadonlyMap<SourceId, readonly Evidence[]>,
): readonly Evidence[] {
  const evidenceByIdentity = new Map(
    existingEvidence.map((evidence) => [serializeCanonicalJson(evidence), evidence]),
  );
  for (const cause of causes) {
    const requiredSourceIds = new Set(cause.evidenceSourceIds);
    if (cause.adoptedAssessment.status === "available") {
      for (const sourceId of cause.adoptedAssessment.result.references.sourceIds) {
        requiredSourceIds.add(sourceId);
      }
    }
    for (const sourceId of requiredSourceIds) {
      const currentEvidence = currentEvidenceBySourceId.get(sourceId) ?? [];
      const previousEvidence = previousEvidenceBySourceId.get(sourceId) ?? [];
      if (currentEvidence.length === 0 && previousEvidence.length === 0) {
        throw new TypeError(
          `個人催促causeの保存evidenceに必要なsourceがありません。item: ${itemNodeId} cause: ${cause.causeId} source: ${sourceId}`,
        );
      }
      for (const evidence of [...currentEvidence, ...previousEvidence]) {
        evidenceByIdentity.set(serializeCanonicalJson(evidence), evidence);
      }
    }
  }
  return Object.freeze(
    [...evidenceByIdentity.values()].sort((left, right) =>
      compareStrings(serializeCanonicalJson(left), serializeCanonicalJson(right)),
    ),
  );
}

/** 項目ごとのcause、evidence、planning、stalenessを確定する。 */
export function finalizePersonalReminderAnalysis(
  input: FinalizationInput,
): PersonalReminderAnalysisResult {
  const expectedNodeIds = uniqueNodeIds(input.expectedItemNodeIds, "期待");
  const finalizationNodeIds = uniqueNodeIds(
    input.items.map((item) => item.itemNodeId),
    "finalization",
  );
  assertSameNodeIds(expectedNodeIds, finalizationNodeIds, "finalization");

  const applicableNodeIds = uniqueNodeIds(input.plan.applicableItemNodeIds, "plan適用");
  const evaluatedNodeIds = uniqueNodeIds(
    input.items.filter((item) => item.kind === "evaluated").map((item) => item.itemNodeId),
    "評価",
  );
  assertSameNodeIds(applicableNodeIds, evaluatedNodeIds, "評価");
  const applicationNodeIds = uniqueNodeIds(
    [...input.application.itemsByNodeId.keys()],
    "outcome適用",
  );
  assertSameNodeIds(applicableNodeIds, applicationNodeIds, "outcome適用");

  const unfinalizedItems: UnfinalizedItem[] = [];
  for (const item of input.items) {
    if (item.kind === "evaluated") {
      const applied = input.application.itemsByNodeId.get(item.itemNodeId);
      assertNonNullable(applied, `個人催促outcome適用結果がありません。対象: ${item.itemNodeId}`);
      if (applied.itemNodeId !== item.itemNodeId) {
        throw new TypeError(
          `個人催促outcome適用結果の項目IDが一致しません。対象: ${item.itemNodeId}`,
        );
      }
      unfinalizedItems.push(
        Object.freeze({
          item,
          causes: applied.causes,
          evidence: applied.evidence,
          planning: planningForEvaluatedItem(item, applied.causes, input),
        }),
      );
      continue;
    }
    const causes = Object.freeze(
      item.previous.causes.map((cause) =>
        reconcileRetainedPersonalReminderCause(cause, input.aiDependencyContext),
      ),
    );
    const planning: PersonalReminderCausePlanning =
      item.planningHandling.kind === "force_pending"
        ? Object.freeze({
            status: "pending",
            planningVersion: PERSONAL_REMINDER_CAUSE_PLANNING_VERSION,
          })
        : reconcileRetainedPersonalReminderPlanning(item.itemState, item.previous.planning, causes);
    unfinalizedItems.push(
      Object.freeze({
        item,
        causes,
        evidence: item.previous.evidence,
        planning,
      }),
    );
  }

  const causeIds = new Set<PersonalReminderCauseId>();
  for (const { item, causes } of unfinalizedItems) {
    for (const cause of causes) {
      if (cause.itemNodeId !== item.itemNodeId) {
        throw new TypeError(
          `個人催促causeの所有項目IDが一致しません。item: ${item.itemNodeId} cause: ${cause.causeId} owner: ${cause.itemNodeId}`,
        );
      }
      if (causeIds.has(cause.causeId)) {
        throw new TypeError(`個人催促cause IDが項目間で重複しています。対象: ${cause.causeId}`);
      }
      causeIds.add(cause.causeId);
    }
  }

  const currentPersonalEvidenceBySourceId = evidenceSourceIndex(
    unfinalizedItems.map((value) => value.evidence),
  );
  const currentEvidenceBySourceId = evidenceSourceIndex([
    ...input.currentEvidenceBySourceId.values(),
    ...currentPersonalEvidenceBySourceId.values(),
  ]);
  const itemsByNodeId = new Map<GitHubNodeId, PersonalReminderAnalyzedItem>();
  for (const { item, causes, evidence, planning } of unfinalizedItems) {
    const completeEvidence = completePersonalReminderEvidenceClosure(
      item.itemNodeId,
      causes,
      evidence,
      currentEvidenceBySourceId,
      input.previousEvidenceBySourceId,
    );
    const causeResults = Object.freeze(
      [...causes]
        .sort((left, right) => compareStrings(left.causeId, right.causeId))
        .map((cause) =>
          Object.freeze({
            cause,
            staleness: calculatePersonalReminderStaleness({
              cause,
              evaluatedAt: input.evaluatedAt,
              minimumAiConfidence: input.minimumAiConfidence,
              repositoryFullName: item.repositoryFullName,
              currentLabels: item.currentLabels,
              resolveLabelEffects: input.resolveLabelEffects,
              thresholdsHours: input.thresholdsHours,
            }),
          }),
        ),
    );
    itemsByNodeId.set(
      item.itemNodeId,
      Object.freeze({
        itemNodeId: item.itemNodeId,
        causeResults,
        evidence: completeEvidence,
        planning,
      }),
    );
  }
  return Object.freeze({ itemsByNodeId });
}
