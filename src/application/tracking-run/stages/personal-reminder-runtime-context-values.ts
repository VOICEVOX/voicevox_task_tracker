import type {
  PersonalReminderActionKind,
  PersonalReminderTimeBasis,
} from "../../../domain/personal-reminder-causes.js";
import type { PersonalReminderLocalDecision } from "../../../domain/personal-reminder-planning.js";
import type { GraphNodeId, NormalizedEvent, UtcIsoDateTime } from "../../../domain/types.js";
import type { GitHubCheckContext } from "../../../github/item-detail-types.js";
import { assertNonNullable } from "../../../util/index.js";
import type {
  PersonalReminderDecisionWaitingOn,
  PersonalReminderResponsibleWaitingOn,
} from "./personal-reminder-runtime-contracts.js";
import type {
  PersonalReminderRuntimeCandidateEndpointItem,
  PersonalReminderRuntimeContext,
  PersonalReminderRuntimeContextItem,
} from "./personal-reminder-runtime-contracts.js";

/** check contextの発生時刻を取得する。 */
export function checkContextOccurredAt(
  headOccurredAt: UtcIsoDateTime,
  context: GitHubCheckContext,
): UtcIsoDateTime {
  if (context.type === "commit_status") {
    return context.createdAt;
  }
  return context.completedAt ?? headOccurredAt;
}

/** 日時の集合から最も新しい値を取得する。 */
export function latestUtcIsoDateTime(
  values: readonly UtcIsoDateTime[],
  context: string,
): UtcIsoDateTime {
  const firstValue = values[0];
  assertNonNullable(firstValue, `${context}の時刻がありません`);
  return values.slice(1).reduce((latest, value) => (latest < value ? value : latest), firstValue);
}

/** eventを時刻根拠へ変換する。 */
export function basisFromEvent(event: NormalizedEvent): PersonalReminderTimeBasis {
  return Object.freeze({ source: "event", at: event.occurredAt, sourceIds: [event.sourceId] });
}

/** local decisionから催促する行動種別を取得する。 */
export function actionKindForDecision(
  decision: PersonalReminderLocalDecision,
): PersonalReminderActionKind | undefined {
  switch (decision.status) {
    case "waiting_for_assessment":
      return "assessment";
    case "waiting_for_owner":
      return "owner";
    case "waiting_for_decision":
      return "decision";
    case "waiting_for_review":
      return "review";
    case "waiting_for_revision":
      return "revision";
    case "waiting_for_reply":
      return "reply";
    case "waiting_for_work":
    case "in_progress":
      return "work";
    case "waiting_for_merge":
      return "merge";
    case "waiting_for_unblock":
    case "waiting_for_automation":
    case "unknown":
    case "terminal_merged":
    case "terminal_completed":
    case "terminal_not_planned":
      return undefined;
  }
}

/** 待機先が催促対象の責任主体か判定する。 */
export function isPersonalReminderResponsibleWaitingOn(
  waitingOn: PersonalReminderDecisionWaitingOn,
): waitingOn is PersonalReminderResponsibleWaitingOn {
  return (
    (waitingOn.kind === "user" || waitingOn.kind === "team" || waitingOn.kind === "role") &&
    waitingOn.role !== "dependency" &&
    waitingOn.role !== "ci"
  );
}

/** 計画context内の項目をnode IDで取得する。 */
export function contextItemByNodeId(
  context: PersonalReminderRuntimeContext,
  nodeId: GraphNodeId,
): PersonalReminderRuntimeContextItem | undefined {
  return context.items.find((value) => value.item.nodeId === nodeId);
}

/** relation候補の端点項目をnode IDで取得する。 */
export function candidateEndpointItemByNodeId(
  context: PersonalReminderRuntimeContext,
  nodeId: GraphNodeId,
): PersonalReminderRuntimeCandidateEndpointItem | undefined {
  return context.graph.candidateEndpointItemsByNodeId.get(nodeId);
}
