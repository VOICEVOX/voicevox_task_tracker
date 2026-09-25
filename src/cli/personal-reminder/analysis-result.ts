import type {
  PersonalReminderCause,
  PersonalReminderCauseId,
  PersonalReminderCausePlanning,
} from "../../domain/personal-reminder-causes.js";
import type { PersonalReminderStaleness } from "../../domain/personal-reminder-staleness.js";
import type { Evidence, GitHubNodeId } from "../../domain/types.js";
import { assertNonNullable } from "../../util/index.js";

export type PersonalReminderAnalyzedCause = Readonly<{
  cause: PersonalReminderCause;
  staleness: PersonalReminderStaleness;
}>;

export type PersonalReminderAnalyzedItem = Readonly<{
  itemNodeId: GitHubNodeId;
  causeResults: readonly PersonalReminderAnalyzedCause[];
  evidence: readonly Evidence[];
  planning: PersonalReminderCausePlanning;
}>;

export type PersonalReminderAnalysisResult = Readonly<{
  itemsByNodeId: ReadonlyMap<GitHubNodeId, PersonalReminderAnalyzedItem>;
}>;

export type PersonalReminderAppliedItem = Readonly<{
  itemNodeId: GitHubNodeId;
  causes: readonly PersonalReminderCause[];
  evidence: readonly Evidence[];
}>;

export type PersonalReminderOutcomeApplication = Readonly<{
  itemsByNodeId: ReadonlyMap<GitHubNodeId, PersonalReminderAppliedItem>;
}>;

export type PersonalReminderEvaluatedFinalizationItem = Readonly<{
  kind: "evaluated";
  itemNodeId: GitHubNodeId;
  itemState: "open" | "closed" | "merged";
  collectionCompleteness: "complete" | "incomplete";
  repositoryFullName: string;
  currentLabels: readonly string[];
}>;

export type PersonalReminderRetainedFinalizationItem = Readonly<{
  kind: "retained";
  itemNodeId: GitHubNodeId;
  itemState: "open" | "closed" | "merged";
  planningHandling:
    | Readonly<{ kind: "reconcile" }>
    | Readonly<{ kind: "force_pending"; reason: "continuity_conflict" }>;
  previous: Readonly<{
    causes: readonly PersonalReminderCause[];
    evidence: readonly Evidence[];
    planning: PersonalReminderCausePlanning;
  }>;
  repositoryFullName: string;
  currentLabels: readonly string[];
}>;

export type PersonalReminderFinalizationItem =
  PersonalReminderEvaluatedFinalizationItem | PersonalReminderRetainedFinalizationItem;

/** 項目IDに対応する個人催促解析結果を取得する。 */
export function requirePersonalReminderAnalyzedItem(
  result: PersonalReminderAnalysisResult,
  itemNodeId: GitHubNodeId,
): PersonalReminderAnalyzedItem {
  const item = result.itemsByNodeId.get(itemNodeId);
  if (item == null) {
    throw new TypeError(`個人催促解析結果の項目がありません。対象: ${itemNodeId}`);
  }
  return item;
}

/** 原因IDに対応する個人催促解析結果を取得する。 */
export function requirePersonalReminderAnalyzedCause(
  item: PersonalReminderAnalyzedItem,
  causeId: PersonalReminderCauseId,
): PersonalReminderAnalyzedCause {
  const matches = item.causeResults.filter((result) => result.cause.causeId === causeId);
  if (matches.length !== 1) {
    throw new TypeError(
      `個人催促解析結果のcauseが一意に定まりません。項目: ${item.itemNodeId} cause: ${causeId}`,
    );
  }
  const match = matches[0];
  assertNonNullable(match, `個人催促解析結果のcauseがありません。対象: ${causeId}`);
  return match;
}
