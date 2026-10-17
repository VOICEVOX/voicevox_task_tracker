import { serializeCanonicalJson } from "../../../canonical-json/value.js";
import type {
  AiAnalysisDependency,
  AiAnalysisDependencyInput,
  AiAnalysisDependencyReconciliationContext,
} from "../../../domain/ai-analysis-dependencies.js";
import { combineReconciledAiAnalysisDependencies } from "../../../domain/ai-analysis-dependencies.js";
import type {
  PersonalReminderCauseSeed,
  PersonalReminderCauseSetSubjectChanges,
  PersonalReminderSubject,
} from "../../../domain/personal-reminder-causes.js";
import { personalReminderCauseSetSubjectChangesAreUnbounded } from "../../../domain/personal-reminder-causes.js";
import type {
  PersonalReminderCauseDraft,
  PersonalReminderLocalDecision,
  PreviousPersonalReminderCauses,
} from "../../../domain/personal-reminder-planning.js";
import type { SourceId } from "../../../domain/source-id.js";
import type { Evidence } from "../../../domain/types.js";
import { assertNonNullable } from "../../../util/index.js";
import type {
  PersonalReminderRuntimeCauseSetSubjectChangeInput,
  PersonalReminderRuntimeCollectedItem,
  PersonalReminderRuntimeCurrentSeed,
  PersonalReminderRuntimeItem,
  PersonalReminderRuntimeLocalDecision,
  PersonalReminderRuntimeState,
} from "./personal-reminder-runtime-contracts.js";

/** 文字列を安定した順序で比較する。 */
export function compareStrings(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

/** 根拠記録の同一性を比較するための値を作る。 */
export function evidenceIdentity(evidence: Evidence): string {
  return serializeCanonicalJson(evidence);
}

/** source IDを安定した順序で比較する。 */
export function compareSourceIds(left: SourceId, right: SourceId): number {
  return compareStrings(left, right);
}

/** 原因候補の責務同一性を表す値を作る。 */
export function personalReminderDraftIdentity(draft: PersonalReminderCauseDraft): string {
  return serializeCanonicalJson([draft.itemNodeId, draft.action.kind, draft.responsible]);
}

/** 原因seedが今回の候補と同じ責務か判定する。 */
export function seedMatchesDraft(
  seed: PersonalReminderCauseSeed,
  draft: PersonalReminderCauseDraft,
): boolean {
  return (
    seed.itemNodeId === draft.itemNodeId &&
    seed.reasonCode === draft.reasonCode &&
    seed.action.kind === draft.action.kind &&
    seed.action.summary === draft.action.summary &&
    serializeCanonicalJson(seed.responsible) === serializeCanonicalJson(draft.responsible) &&
    serializeCanonicalJson(seed.responsibility) === serializeCanonicalJson(draft.responsibility)
  );
}

/** AI依存が未検証の値を含むか判定する。 */
export function aiAnalysisDependencyIsUnverified(dependency: AiAnalysisDependency): boolean {
  return dependency.status === "unverified" || dependency.status === "unknown";
}

/** 今回のAI依存を統合入力へ変換する。 */
export function currentAiDependencyInput(
  dependency: AiAnalysisDependency,
): AiAnalysisDependencyInput {
  return Object.freeze({ origin: "current", dependency, relationCandidateAssessment: "graph" });
}

/** 前回のAI依存を統合入力へ変換する。 */
export function retainedAiDependencyInput(
  dependency: AiAnalysisDependency,
): AiAnalysisDependencyInput {
  return Object.freeze({ origin: "retained", dependency });
}

/** 原因seedの由来に応じてAI依存を統合入力へ変換する。 */
export function seedAiDependencyInput(
  dependency: AiAnalysisDependency,
  origin: PersonalReminderRuntimeCurrentSeed["origin"],
): AiAnalysisDependencyInput {
  return origin === "current_draft"
    ? currentAiDependencyInput(dependency)
    : retainedAiDependencyInput(dependency);
}

/** 原因集合の存在と候補からAI依存を合成する。 */
export function combineCauseSetAiDependency(
  inputs: readonly AiAnalysisDependencyInput[],
  presenceInputs: readonly AiAnalysisDependencyInput[],
  context: AiAnalysisDependencyReconciliationContext,
): AiAnalysisDependency {
  const dependency = combineReconciledAiAnalysisDependencies(inputs, context);
  if (
    dependency.status === "unknown" &&
    dependency.reasons.includes("not_recorded") &&
    dependency.producers == null
  ) {
    return combineReconciledAiAnalysisDependencies(
      [retainedAiDependencyInput(dependency), ...presenceInputs],
      context,
    );
  }
  return dependency;
}

function personalReminderSubjectKey(subject: PersonalReminderSubject): string {
  return `${subject.kind}\u0000${subject.candidateId.toLowerCase()}`;
}

function normalizePersonalReminderSubjects(
  subjects: readonly PersonalReminderSubject[],
): PersonalReminderSubject[] {
  const subjectsByKey = new Map<string, PersonalReminderSubject>();
  for (const subject of subjects) {
    const key = personalReminderSubjectKey(subject);
    const existing = subjectsByKey.get(key);
    if (existing == null || compareStrings(subject.candidateId, existing.candidateId) < 0) {
      subjectsByKey.set(key, subject);
    }
  }
  return [...subjectsByKey.values()].sort((left, right) =>
    compareStrings(personalReminderSubjectKey(left), personalReminderSubjectKey(right)),
  );
}

/** 原因集合が変わり得る主体を確定する。 */
export function createCauseSetSubjectChanges(
  dependency: AiAnalysisDependency,
  input: PersonalReminderRuntimeCauseSetSubjectChangeInput,
  context: AiAnalysisDependencyReconciliationContext,
): PersonalReminderCauseSetSubjectChanges {
  if (
    personalReminderCauseSetSubjectChangesAreUnbounded({
      causeSetDependency: dependency,
      presenceDependency: combineReconciledAiAnalysisDependencies(input.presenceInputs, context),
      negativeCandidateSubjectCount: input.negativeCandidateSubjectCount,
      inputUnbounded: input.unbounded,
    })
  ) {
    return Object.freeze({ scope: "unbounded" });
  }
  if (!aiAnalysisDependencyIsUnverified(dependency)) {
    return Object.freeze({
      scope: "bounded",
      addableSubjects: [],
      removableSubjects: [],
    });
  }
  const addableSubjects = normalizePersonalReminderSubjects(input.addableSubjects);
  const removableSubjects = normalizePersonalReminderSubjects(input.removableSubjects);
  return Object.freeze({
    scope: "bounded",
    addableSubjects,
    removableSubjects,
  });
}

/** source IDを重複なく並べて非空配列にする。 */
export function createNonEmptySourceIds(
  sourceIds: readonly SourceId[],
  context: string,
): readonly [SourceId, ...SourceId[]] {
  const uniqueSourceIds = [...new Set(sourceIds)].sort(compareSourceIds);
  const first = uniqueSourceIds[0];
  assertNonNullable(first, `${context}のsource IDがありません`);
  return Object.freeze([first, ...uniqueSourceIds.slice(1)]);
}

/** 対象項目に対応する前回原因を取得する。 */
export function createPreviousCauses(
  state: PersonalReminderRuntimeState,
  item: PersonalReminderRuntimeCollectedItem,
): PreviousPersonalReminderCauses {
  const previous = state.previousCausesByNodeId.get(item.item.nodeId);
  if (previous != null) {
    return previous;
  }
  return Object.freeze({ observedAt: item.item.createdAt, causes: Object.freeze([]) });
}

/** 項目種別付きのlocal decisionを取り出す。 */
export function determineLocalDecision(
  input: PersonalReminderRuntimeLocalDecision,
): PersonalReminderLocalDecision {
  if (input.itemType === "issue") {
    return input.value;
  }
  return input.value;
}

/** 関連項目のlocal decision種別を検証する。 */
export function validateLocalDecision(
  itemType: PersonalReminderRuntimeItem["type"],
  localDecision: PersonalReminderRuntimeLocalDecision | undefined,
  context: string,
): boolean {
  if (localDecision == null) {
    return false;
  }
  if (localDecision.itemType !== itemType) {
    throw new TypeError(`${context}のlocal decision種別が一致しません`);
  }
  return true;
}
