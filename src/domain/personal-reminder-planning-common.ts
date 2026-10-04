export type { PersonalReminderResponsibilityBasis } from "./personal-reminder-planning-contracts.js";
import { UnreachableError, assertNonNullable } from "../util/index.js";
import {
  aiAnalysisDependencyForApplication,
  type AiAnalysisDependency,
} from "./ai-analysis-dependencies.js";
import { type AiAnalysisElement } from "./ai-analysis-elements.js";
import {
  personalReminderResponsibilitySchema,
  type PersonalReminderCauseSeed,
  type PersonalReminderExecutionSurface,
  type PersonalReminderReasonCode,
  type PersonalReminderResponsibility,
  type PersonalReminderResponsible,
} from "./personal-reminder-causes.js";
import {
  type PersonalReminderCauseDraftUnavailable,
  type PersonalReminderCauseDraftUnavailableReason,
  type PersonalReminderItem,
  type PersonalReminderLocalDecision,
} from "./personal-reminder-planning-contracts.js";
import { type SourceId } from "./source-id.js";
import { type StalenessWaitClass } from "./staleness.js";
import { type GitHubNodeId, type UtcIsoDateTime } from "./types.js";
import { type TrackedItemAiAnalysisApplications } from "./tracked-item-ai-analysis.js";

export const PERSONAL_REMINDER_ID_VERSION = "personal-reminder-v1";

const PERSONAL_REMINDER_SOURCE_ID_LIMIT = 30;

const reasonByWaitClass: Readonly<
  Partial<
    Record<
      Exclude<StalenessWaitClass, "blockedParent" | "notApplicable">,
      PersonalReminderReasonCode
    >
  >
> = Object.freeze({
  assessment: "assessment_overdue",
  owner: "owner_overdue",
  decision: "decision_overdue",
  review: "review_overdue",
  revision: "revision_overdue",
  reply: "reply_overdue",
  work: "work_overdue",
  merge: "merge_overdue",
});

/** 文字列を辞書順で比較する。 */
export function compareStrings(left: string, right: string): -1 | 0 | 1 {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

/** source IDを安定した順で比較する。 */
export function compareSourceIds(left: SourceId, right: SourceId): -1 | 0 | 1 {
  return compareStrings(left, right);
}

/** 個人催促で使う時刻を検証して数値化する。 */
export function parseTimestamp(value: UtcIsoDateTime, context: string): number {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new TypeError(`${context}は有効な日時ではありません`);
  }
  return timestamp;
}

/** source ID列を重複なく安定した順へそろえる。 */
export function createSourceIds(
  sourceIds: readonly SourceId[],
): readonly [SourceId, ...SourceId[]] {
  const uniqueSourceIds = [...new Set(sourceIds)].sort(compareSourceIds);
  if (uniqueSourceIds.length > PERSONAL_REMINDER_SOURCE_ID_LIMIT) {
    throw new RangeError("個人催促原因のsource IDは30件以内にしてください");
  }
  const [firstSourceId, ...remainingSourceIds] = uniqueSourceIds;
  assertNonNullable(firstSourceId, "個人催促原因のsource IDが1件もありません");
  return Object.freeze([firstSourceId, ...remainingSourceIds]);
}

function createBoundedSourceIds(
  requiredSourceIds: readonly SourceId[],
  optionalSourceIds: readonly SourceId[],
): readonly [SourceId, ...SourceId[]] {
  const required = [...new Set(requiredSourceIds)].sort(compareSourceIds);
  if (required.length > PERSONAL_REMINDER_SOURCE_ID_LIMIT) {
    throw new RangeError("個人催促原因の必須source IDは30件以内にしてください");
  }
  const requiredSet = new Set(required);
  const optional = [...new Set(optionalSourceIds)]
    .filter((sourceId) => !requiredSet.has(sourceId))
    .sort(compareSourceIds)
    .slice(0, PERSONAL_REMINDER_SOURCE_ID_LIMIT - required.length);
  return createSourceIds([...required, ...optional]);
}

function responsibleSignature(value: PersonalReminderResponsible): string {
  return JSON.stringify([value.kind, value.candidateId.toLowerCase(), value.role]);
}

function sortResponsible(
  values: readonly PersonalReminderResponsible[],
): readonly [PersonalReminderResponsible, ...PersonalReminderResponsible[]] {
  const unique = new Map<string, PersonalReminderResponsible>();
  for (const value of values) {
    if (value.candidateId.length === 0) {
      throw new TypeError("個人催促原因の責任主体candidate IDは空にできません");
    }
    const key = responsibleSignature(value);
    if (!unique.has(key)) {
      unique.set(key, Object.freeze({ ...value }));
    }
  }
  const sorted = [...unique.values()].sort((left, right) =>
    compareStrings(responsibleSignature(left), responsibleSignature(right)),
  );
  const [first, ...remaining] = sorted;
  assertNonNullable(first, "個人催促原因の責任主体が1件もありません");
  return Object.freeze([first, ...remaining]);
}

/** 責任主体の同一性を表す文字列を作る。 */
export function responsibleSignatures(
  values: readonly PersonalReminderResponsible[],
): readonly string[] {
  return Object.freeze(values.map(responsibleSignature).sort(compareStrings));
}

/** 二つの責任主体が同じか判定する。 */
export function sameResponsible(
  left: readonly PersonalReminderResponsible[],
  right: readonly PersonalReminderResponsible[],
): boolean {
  const leftSignatures = responsibleSignatures(left);
  const rightSignatures = responsibleSignatures(right);
  return (
    leftSignatures.length === rightSignatures.length &&
    leftSignatures.every((value, index) => value === rightSignatures[index])
  );
}

/** 判定結果から根拠source IDを取り出す。 */
export function sourceIdsFromDecision(
  item: PersonalReminderItem,
  decision: PersonalReminderLocalDecision,
): readonly [SourceId, ...SourceId[]] {
  const requiredSourceIds = [
    item.sourceId,
    ...decision.statusBasis.sourceIds,
    ...decision.responsibilityBasis.sourceIds,
  ];
  const currentEvidenceSourceIds = decision.evidence
    .filter((evidence) => evidence.supports === "status" || evidence.supports === "waiting_on")
    .map((evidence) => evidence.sourceId);
  return createBoundedSourceIds(requiredSourceIds, currentEvidenceSourceIds);
}

/** 評価traceのAI依存を取り出す。 */
export function assessmentTraceDependency(
  itemNodeId: GitHubNodeId,
  element: AiAnalysisElement,
  decision: PersonalReminderLocalDecision,
  applications: TrackedItemAiAnalysisApplications,
): AiAnalysisDependency {
  const usesElement = decision.assessmentTrace.some((trace) => {
    if (trace.kind === "explicit_request") {
      return element === "waitingOn";
    }
    return element === "status" || element === "waitingOn";
  });
  if (!usesElement) {
    return Object.freeze({ status: "not_dependent" });
  }
  return aiAnalysisDependencyForApplication(itemNodeId, element, applications[element]);
}

/** 原因候補を作れない結果を表す。 */
export function createUnavailable(
  itemNodeId: GitHubNodeId,
  reason: PersonalReminderCauseDraftUnavailableReason,
): PersonalReminderCauseDraftUnavailable {
  return Object.freeze({ status: "unavailable", itemNodeId, reason });
}

/** 待機状態に対応する原因理由を選ぶ。 */
export function reasonForWaitClass(
  waitClass: StalenessWaitClass,
): PersonalReminderReasonCode | undefined {
  if (
    waitClass === "blockedParent" ||
    waitClass === "notApplicable" ||
    waitClass === "automation"
  ) {
    return undefined;
  }
  return reasonByWaitClass[waitClass];
}

/** 判定結果から責任主体を得る。 */
export function responsibleFromDecision(
  decision: PersonalReminderLocalDecision,
): readonly [PersonalReminderResponsible, ...PersonalReminderResponsible[]] | undefined {
  const responsible: PersonalReminderResponsible[] = [];
  for (const waitingOn of decision.waitingOn) {
    if (waitingOn.kind !== "user" && waitingOn.kind !== "team" && waitingOn.kind !== "role") {
      continue;
    }
    if (waitingOn.role === "dependency" || waitingOn.role === "ci") {
      continue;
    }
    responsible.push(
      Object.freeze({
        kind: waitingOn.kind,
        candidateId: waitingOn.candidateId,
        role: waitingOn.role,
      }),
    );
  }
  if (responsible.length === 0) {
    return undefined;
  }
  return sortResponsible(responsible);
}

/** 原因理由に対応する行動を得る。 */
export function actionKindForReason(
  reasonCode: PersonalReminderReasonCode,
): PersonalReminderCauseSeed["action"]["kind"] {
  switch (reasonCode) {
    case "assessment_overdue":
      return "assessment";
    case "owner_overdue":
      return "owner";
    case "decision_overdue":
      return "decision";
    case "review_overdue":
      return "review";
    case "revision_overdue":
      return "revision";
    case "reply_overdue":
      return "reply";
    case "work_overdue":
      return "work";
    case "merge_overdue":
      return "merge";
    default:
      throw new UnreachableError(reasonCode);
  }
}

/** 実行面の同一性を表す文字列を作る。 */
export function surfaceSignature(surface: PersonalReminderExecutionSurface): string {
  return JSON.stringify([surface.kind, surface.nodeId]);
}

/** 実行面を重複なく安定した順へそろえる。 */
export function sortedExecutionSurfaces(
  surfaces: readonly PersonalReminderExecutionSurface[],
): readonly [PersonalReminderExecutionSurface, ...PersonalReminderExecutionSurface[]] {
  const unique = new Map<string, PersonalReminderExecutionSurface>();
  for (const surface of surfaces) {
    if (!unique.has(surfaceSignature(surface))) {
      unique.set(surfaceSignature(surface), Object.freeze({ ...surface }));
    }
  }
  const sorted = [...unique.values()].sort((left, right) =>
    compareStrings(surfaceSignature(left), surfaceSignature(right)),
  );
  const [first, ...remaining] = sorted;
  assertNonNullable(first, "個人催促原因の実行面が1件もありません");
  return Object.freeze([first, ...remaining]);
}

/** 責務をcanonicalな構造へそろえる。 */
export function normalizeResponsibility(
  value: PersonalReminderResponsibility,
): PersonalReminderResponsibility {
  const parsed = personalReminderResponsibilitySchema.parse(value);
  if (parsed.scope.kind === "item") {
    return Object.freeze({
      authority: parsed.authority,
      scope: Object.freeze({ kind: "item" }),
    });
  }
  if (parsed.scope.kind === "execution_surfaces") {
    return Object.freeze({
      authority: parsed.authority,
      scope: Object.freeze({
        kind: "execution_surfaces",
        surfaces: sortedExecutionSurfaces(parsed.scope.surfaces),
      }),
    });
  }
  return Object.freeze({
    authority: parsed.authority,
    scope: Object.freeze({
      kind: "item_and_execution_surfaces",
      surfaces: sortedExecutionSurfaces(parsed.scope.surfaces),
    }),
  });
}
