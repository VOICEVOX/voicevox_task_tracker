import type {
  PublicItemSummaryDto,
  PublicSummaryDto,
} from "../../src/pages/public-dto-contracts.js";
import { assertNonNullable, UnreachableError } from "../../src/util/index.js";
import type {
  CurrentRoleResolution,
  NotificationWaitingOnReference,
  WaitingOnCandidate,
  WaitingOnDisplayPart,
  WaitingOnReference,
  WaitingOnRole,
} from "./model-contracts.js";
import { ROLE_LABELS } from "./model-labels.js";

function waitingOnRoleName(role: WaitingOnRole): string {
  return ROLE_LABELS[role];
}

function waitingOnItemLabel(candidateId: string, summary: PublicSummaryDto): string {
  const relatedItem = summary.items.find((item) => item.nodeId === candidateId);
  if (relatedItem != null) {
    return relatedItem.displayReference;
  }
  const graphNode = summary.graph.nodes.find((node) => node.nodeId === candidateId);
  assertNonNullable(graphNode, `waitingOn項目 ${candidateId} がありません`);
  if (graphNode.kind !== "external_reference") {
    throw new TypeError(`waitingOn項目 ${candidateId} の表示名がありません`);
  }
  return graphNode.displayReference;
}

function textWaitingOnPart(text: string): WaitingOnDisplayPart {
  return { kind: "text", text };
}

function loginWaitingOnPart(login: string): WaitingOnDisplayPart {
  return { kind: "login", login };
}

function joinWaitingOnParts(
  groups: readonly (readonly WaitingOnDisplayPart[])[],
  separator: string,
): readonly WaitingOnDisplayPart[] {
  const parts: WaitingOnDisplayPart[] = [];
  for (const [index, group] of groups.entries()) {
    if (index > 0) {
      parts.push(textWaitingOnPart(separator));
    }
    parts.push(...group);
  }
  return parts;
}

function waitingOnPartsText(parts: readonly WaitingOnDisplayPart[]): string {
  return parts
    .map((part) => {
      switch (part.kind) {
        case "text":
          return part.text;
        case "login":
          return `@${part.login}`;
        default:
          throw new UnreachableError(part);
      }
    })
    .join("");
}

function waitingOnKindParts(
  waitingOn: WaitingOnReference,
  summary: PublicSummaryDto,
  roleParts: (role: WaitingOnRole) => readonly WaitingOnDisplayPart[],
): readonly WaitingOnDisplayPart[] {
  switch (waitingOn.kind) {
    case "user":
      return [
        textWaitingOnPart(`${waitingOnRoleName(waitingOn.role)} `),
        loginWaitingOnPart(waitingOn.candidateId),
      ];
    case "team":
      return [
        textWaitingOnPart(`${waitingOnRoleName(waitingOn.role)} チーム ${waitingOn.candidateId}`),
      ];
    case "role":
      return roleParts(waitingOn.role);
    case "item":
      return [textWaitingOnPart(waitingOnItemLabel(waitingOn.candidateId, summary))];
    case "automation":
      return [textWaitingOnPart(`自動処理 ${waitingOn.candidateId}`)];
    case "unknown":
      return [textWaitingOnPart("不明")];
    default:
      throw new UnreachableError(waitingOn.kind);
  }
}

export function resolveCurrentRole(
  role: WaitingOnRole,
  item: PublicItemSummaryDto,
): CurrentRoleResolution {
  switch (role) {
    case "author":
      switch (item.author.status) {
        case "identified":
          return { kind: "accounts", logins: [item.author.actor.login] };
        case "unavailable":
          return { kind: "deleted_account" };
        default:
          throw new UnreachableError(item.author);
      }
    case "assignee":
      if (item.assignees.length === 0) {
        return { kind: "unassigned" };
      }
      return { kind: "accounts", logins: item.assignees.map((assignee) => assignee.login) };
    case "maintainer":
    case "reviewer":
    case "merge_decider":
    case "ci":
    case "dependency":
    case "respondent":
    case "unknown":
      return { kind: "unresolved" };
    default:
      throw new UnreachableError(role);
  }
}

function unresolvedCurrentWaitingOnRoleParts(
  role: Exclude<WaitingOnRole, "author" | "assignee">,
): readonly WaitingOnDisplayPart[] {
  switch (role) {
    case "maintainer":
    case "reviewer":
    case "merge_decider":
      return [textWaitingOnPart(`${waitingOnRoleName(role)}の誰か`)];
    case "ci":
    case "dependency":
    case "respondent":
    case "unknown":
      return [textWaitingOnPart(waitingOnRoleName(role))];
    default:
      throw new UnreachableError(role);
  }
}

function currentWaitingOnRoleParts(
  role: WaitingOnRole,
  item: PublicItemSummaryDto,
): readonly WaitingOnDisplayPart[] {
  const resolution = resolveCurrentRole(role, item);
  switch (resolution.kind) {
    case "accounts":
      return [
        textWaitingOnPart(`${waitingOnRoleName(role)} `),
        ...joinWaitingOnParts(
          resolution.logins.map((login) => [loginWaitingOnPart(login)]),
          "、",
        ),
      ];
    case "deleted_account":
      return [textWaitingOnPart(`${waitingOnRoleName(role)} アカウント削除済み`)];
    case "unassigned":
      return [textWaitingOnPart(`${waitingOnRoleName(role)} 未割り当て`)];
    case "unresolved":
      if (role === "author" || role === "assignee") {
        throw new TypeError(`waitingOnの未解決roleが不正です: ${role}`);
      }
      return unresolvedCurrentWaitingOnRoleParts(role);
    default:
      throw new UnreachableError(resolution);
  }
}

function historyWaitingOnRoleParts(
  role: WaitingOnRole,
  item: PublicItemSummaryDto,
): readonly WaitingOnDisplayPart[] {
  if (role === "assignee") {
    return [textWaitingOnPart(`当時の${waitingOnRoleName(role)}`)];
  }
  return currentWaitingOnRoleParts(role, item);
}

/** 現在のwaitingOn候補を役割と対象がわかる表示断片へ変換する。 */
export function waitingOnLabelParts(
  waitingOn: WaitingOnCandidate,
  item: PublicItemSummaryDto,
  summary: PublicSummaryDto,
): readonly WaitingOnDisplayPart[] {
  return waitingOnKindParts(waitingOn, summary, (role) => currentWaitingOnRoleParts(role, item));
}

/** 現在のwaitingOn候補を役割と対象がわかる表示文字列へ変換する。 */
export function waitingOnLabel(
  waitingOn: WaitingOnCandidate,
  item: PublicItemSummaryDto,
  summary: PublicSummaryDto,
): string {
  return waitingOnPartsText(waitingOnLabelParts(waitingOn, item, summary));
}

/** 過去のwaitingOn候補を対象がわかる表示文字列へ変換する。 */
export function waitingOnHistoryLabel(
  waitingOn: WaitingOnReference,
  item: PublicItemSummaryDto,
  summary: PublicSummaryDto,
): string {
  return waitingOnPartsText(
    waitingOnKindParts(waitingOn, summary, (role) => historyWaitingOnRoleParts(role, item)),
  );
}

function notificationWaitingOnCandidateLabelParts(
  waitingOn: NotificationWaitingOnReference,
): readonly WaitingOnDisplayPart[] {
  switch (waitingOn.kind) {
    case "user":
      return [
        textWaitingOnPart(`${waitingOnRoleName(waitingOn.role)} `),
        loginWaitingOnPart(waitingOn.candidateId),
      ];
    case "team":
      return [
        textWaitingOnPart(`${waitingOnRoleName(waitingOn.role)} チーム ${waitingOn.candidateId}`),
      ];
    case "role":
      return [textWaitingOnPart(waitingOnRoleName(waitingOn.role))];
    case "item":
      return [textWaitingOnPart(waitingOn.displayReference)];
    case "automation":
      return [textWaitingOnPart(`自動処理 ${waitingOn.candidateId}`)];
    case "unknown":
      return [textWaitingOnPart("不明")];
    default:
      throw new UnreachableError(waitingOn);
  }
}

/** 通知履歴の保存済みwaitingOnを表示用の断片へ変換する。 */
export function notificationWaitingOnLabelParts(
  waitingOn: readonly NotificationWaitingOnReference[],
): readonly WaitingOnDisplayPart[] {
  if (waitingOn.length === 0) {
    throw new TypeError("通知履歴のwaitingOnが空です");
  }
  return joinWaitingOnParts(waitingOn.map(notificationWaitingOnCandidateLabelParts), "、");
}
