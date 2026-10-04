import type {
  PersonalReminderAiSourceContext,
  PersonalReminderEvidenceRole,
} from "../../../codex/personal-reminder-input-contracts.js";
import type { PersonalReminderItem } from "../../../domain/personal-reminder-planning.js";
import type { SourceId } from "../../../domain/source-id.js";
import type { GitHubNodeId, NormalizedEvent, UtcIsoDateTime } from "../../../domain/types.js";
import type { GitHubDetailActor, GitHubItemDetail } from "../../../github/item-detail-types.js";
import { assertNonNullable } from "../../../util/index.js";
import { compareStrings, evidenceIdentity } from "./personal-reminder-runtime-common.js";
import type {
  PersonalReminderRuntimeCollectedItem,
  PersonalReminderRuntimeSource,
} from "./personal-reminder-runtime-contracts.js";

/** 収集項目と詳細の対応を検証する。 */
export function validateCollectedItem(item: PersonalReminderRuntimeCollectedItem): void {
  if (item.detail.nodeId !== item.item.nodeId || item.detail.type !== item.item.type) {
    throw new TypeError(`個人催促runtimeのitemとdetailが一致しません。対象: ${item.item.nodeId}`);
  }
  if (item.repositoryFullName.length === 0) {
    throw new TypeError("個人催促runtimeのrepository full nameは空にできません");
  }
  if (item.completeness.status === "incomplete" && item.completeness.missing.length === 0) {
    throw new TypeError("不完全な個人催促runtime入力には不足項目が必要です");
  }
}

/** 項目作成者のactor種別を取得する。 */
export function actorTypeForItem(item: PersonalReminderItem): "human" | "bot" | "system" {
  if (item.author.status === "unavailable") {
    return "system";
  }
  return item.author.actor.type;
}

/** 項目作成者の候補IDを取得する。 */
export function actorCandidateId(actor: PersonalReminderItem["author"]): string | undefined {
  if (actor.status === "unavailable") {
    return undefined;
  }
  return actor.actor.login;
}

/** event実行者のactor種別を取得する。 */
export function eventActorType(event: NormalizedEvent): "human" | "bot" | "system" {
  return event.actor.type;
}

/** event実行者の候補IDを取得する。 */
export function eventActorCandidateId(event: NormalizedEvent): string | undefined {
  return event.actor.type === "system" ? undefined : event.actor.login;
}

function sourceRolesForKind(
  kind: string,
): readonly [PersonalReminderEvidenceRole, ...PersonalReminderEvidenceRole[]] {
  if (kind === "item" || kind === "body" || kind === "comment") {
    return ["obligation_candidate", "actionability"];
  }
  if (kind === "push" || kind === "commit_added") {
    return ["resolution", "actionability"];
  }
  if (kind === "relation") {
    return ["relation", "resolution"];
  }
  if (kind === "review" || kind === "review_request") {
    return ["obligation_candidate", "actionability", "resolution"];
  }
  return ["actionability", "resolution"];
}

/** 根拠sourceの役割を重複なく並べる。 */
export function createRuntimeSourceRoles(
  roles: readonly PersonalReminderEvidenceRole[],
): readonly [PersonalReminderEvidenceRole, ...PersonalReminderEvidenceRole[]] {
  const sortedRoles = [...new Set(roles)].sort(compareStrings);
  const firstRole = sortedRoles[0];
  assertNonNullable(firstRole, "個人催促runtime sourceのroleがありません");
  return Object.freeze([firstRole, ...sortedRoles.slice(1)]);
}

/** eventからAI入力用の根拠概要を作る。 */
export function sourceSummaryForEvent(event: NormalizedEvent): string {
  switch (event.kind) {
    case "review":
      return `GitHub review ${event.state} ${event.commitStatus === "available" ? event.commitSha : "commit-unavailable"}`;
    case "review_request":
      return `GitHub review request ${event.action} ${event.target.type}:${event.target.nodeId}`;
    case "assignee":
      return `GitHub assignee ${event.action} ${event.assignee.login}`;
    case "label":
      return `GitHub label ${event.action} ${event.labelName}`;
    case "state":
      return `GitHub state ${event.state}${event.state === "closed" ? `:${event.stateReason}` : ""}`;
    case "relation":
      return `GitHub relation ${event.action} ${event.relationType} ${event.direction} ${
        event.target.type === "node" ? event.target.nodeId : event.target.url
      } ${event.provenance}`;
    case "push":
      return `GitHub push ${event.forcePush ? "force" : "normal"} ${event.headCommitSha}`;
    case "comment":
      return `GitHub comment ${event.bodyEmpty ? "empty" : "body"}`;
    case "ready_for_review":
    case "converted_to_draft":
    case "added_to_merge_queue":
    case "removed_from_merge_queue":
    case "auto_merge_enabled":
    case "auto_merge_disabled":
      return `GitHub ${event.kind} event`;
  }
}

type PersonalReminderRuntimeReviewRequest = Extract<
  GitHubItemDetail,
  { type: "pull_request" }
>["reviewRequests"]["current"][number];

/** review requestからAI入力用の根拠概要を作る。 */
export function sourceSummaryForReviewRequest(
  request: PersonalReminderRuntimeReviewRequest,
): string {
  if ("status" in request.target) {
    return "GitHub review request target unavailable";
  }
  if (request.target.type === "user") {
    return `GitHub review request user:${request.target.login}`;
  }
  return `GitHub review request team:${request.target.organizationLogin}/${request.target.slug}`;
}

/** 同じsource IDの根拠を整合性を確認して追加する。 */
export function addRuntimeSource(
  sources: Map<SourceId, PersonalReminderRuntimeSource>,
  source: PersonalReminderRuntimeSource,
): void {
  const previous = sources.get(source.source.sourceId);
  if (previous == null) {
    sources.set(source.source.sourceId, source);
    return;
  }
  if (
    previous.source.itemNodeId !== source.source.itemNodeId ||
    previous.source.kind !== source.source.kind ||
    previous.source.actorType !== source.source.actorType ||
    previous.source.actorCandidateId !== source.source.actorCandidateId ||
    previous.source.occurredAt !== source.source.occurredAt ||
    previous.source.summary !== source.source.summary
  ) {
    throw new TypeError(
      `個人催促runtime sourceの実体が重複しています。対象: ${source.source.sourceId}`,
    );
  }
  const roles = [...new Set([...previous.roles, ...source.roles])].sort(compareStrings);
  if (roles.length === 0) {
    throw new TypeError(
      `個人催促runtime sourceのroleがありません。対象: ${source.source.sourceId}`,
    );
  }
  const firstRole = roles[0];
  assertNonNullable(
    firstRole,
    `個人催促runtime sourceのroleがありません。対象: ${source.source.sourceId}`,
  );
  const roleTuple: readonly [PersonalReminderEvidenceRole, ...PersonalReminderEvidenceRole[]] = [
    firstRole,
    ...roles.slice(1),
  ];
  sources.set(
    source.source.sourceId,
    Object.freeze({
      source: previous.source,
      roles: Object.freeze(roleTuple),
      evidence: Object.freeze(
        [
          ...new Map(
            [...previous.evidence, ...source.evidence].map((value) => [
              evidenceIdentity(value),
              value,
            ]),
          ).values(),
        ].sort((left, right) => compareStrings(evidenceIdentity(left), evidenceIdentity(right))),
      ),
      causalPush: previous.causalPush || source.causalPush,
    }),
  );
}

/** GitHub sourceを原因計画用の根拠に投影する。 */
export function sourceContext(
  itemNodeId: GitHubNodeId,
  sourceId: SourceId,
  kind: string,
  actorType: "human" | "bot" | "system",
  actorCandidate: string | undefined,
  occurredAt: UtcIsoDateTime,
  summary: string,
  causalPush: boolean,
): PersonalReminderRuntimeSource {
  const roles = sourceRolesForKind(kind);
  const source: PersonalReminderAiSourceContext = {
    sourceId,
    itemNodeId,
    kind,
    actorType,
    ...(actorCandidate == null ? {} : { actorCandidateId: actorCandidate }),
    occurredAt,
    summary,
  };
  return Object.freeze({
    source: Object.freeze(source),
    roles: Object.freeze(roles),
    evidence: Object.freeze([]),
    causalPush,
  });
}

/** 詳細記録の実行者のactor種別を取得する。 */
export function detailActorType(actor: GitHubDetailActor): "human" | "bot" | "system" {
  if (actor.status === "unavailable") {
    return "system";
  }
  return actor.account.apiType === "Bot" ? "bot" : "human";
}

/** 詳細記録の実行者の候補IDを取得する。 */
export function detailActorCandidateId(actor: GitHubDetailActor): string | undefined {
  return actor.status === "identified" ? actor.account.login : undefined;
}
