import { assertNonNullable } from "../util/index.js";
import { PublicDtoSemanticError } from "./errors.js";
type PublicNotificationHistoryEntryInput = Readonly<{
  sentAt: string;
  item: Readonly<{
    displayReference: string;
    url: string;
    number: number;
    type: "issue" | "pull_request";
    nodeId: string;
  }>;
  waitingOn: readonly (
    | Readonly<{ kind: "item"; displayReference: string }>
    | Readonly<{ kind: "user" | "team" | "role" | "automation" | "unknown" }>
  )[];
  reasons: readonly Readonly<{ reasonCode: string; threshold: unknown }>[];
}>;

/** 通知履歴entryを送信時刻降順と表示情報で比較する。 */
export function comparePublicNotificationHistoryEntries(
  left: PublicNotificationHistoryEntryInput,
  right: PublicNotificationHistoryEntryInput,
): number {
  if (left.sentAt > right.sentAt) {
    return -1;
  }
  if (left.sentAt < right.sentAt) {
    return 1;
  }
  if (left.item.displayReference < right.item.displayReference) {
    return -1;
  }
  if (left.item.displayReference > right.item.displayReference) {
    return 1;
  }
  if (left.item.url < right.item.url) {
    return -1;
  }
  if (left.item.url > right.item.url) {
    return 1;
  }
  const reasonCount = Math.min(left.reasons.length, right.reasons.length);
  for (let index = 0; index < reasonCount; index += 1) {
    const leftReason = left.reasons[index];
    const rightReason = right.reasons[index];
    if (leftReason == null || rightReason == null) {
      throw new TypeError("通知履歴の理由を取得できません");
    }
    if (leftReason.reasonCode < rightReason.reasonCode) {
      return -1;
    }
    if (leftReason.reasonCode > rightReason.reasonCode) {
      return 1;
    }
    const leftThreshold = JSON.stringify(leftReason.threshold);
    const rightThreshold = JSON.stringify(rightReason.threshold);
    if (leftThreshold < rightThreshold) {
      return -1;
    }
    if (leftThreshold > rightThreshold) {
      return 1;
    }
  }
  if (left.reasons.length < right.reasons.length) {
    return -1;
  }
  if (left.reasons.length > right.reasons.length) {
    return 1;
  }
  return 0;
}

type PublicItemDisplayIdentity = Readonly<{
  number: number;
  owner: string;
  repository: string;
}>;

type PublicItemUrlIdentity = Readonly<{
  number: number;
  owner: string;
  repository: string;
  type: "issue" | "pull_request";
}>;

export function parsePublicItemDisplayReference(
  displayReference: string,
): PublicItemDisplayIdentity {
  const match = /^([^/\s#?%]+)\/([^/\s#?%]+)#([1-9]\d*)$/u.exec(displayReference);
  if (match == null) {
    throw new PublicDtoSemanticError(
      "公開項目の表示参照がowner/repository#number形式ではありません",
    );
  }
  const owner = match[1];
  const repository = match[2];
  const numberText = match[3];
  assertNonNullable(owner, "公開項目の表示参照ownerを取得できません");
  assertNonNullable(repository, "公開項目の表示参照repositoryを取得できません");
  assertNonNullable(numberText, "公開項目の表示参照numberを取得できません");
  const number = Number.parseInt(numberText, 10);
  if (!Number.isSafeInteger(number)) {
    throw new PublicDtoSemanticError("公開項目の表示参照numberが安全な整数ではありません");
  }
  return {
    owner,
    repository,
    number,
  };
}

export function parsePublicItemUrl(urlValue: string): PublicItemUrlIdentity {
  if (urlValue.includes("?") || urlValue.includes("#") || urlValue.includes("\\")) {
    throw new PublicDtoSemanticError(
      "公開項目のURLにquery、hash、または不正な区切り文字があります",
    );
  }
  const url = new URL(urlValue);
  if (
    url.protocol !== "https:" ||
    url.hostname !== "github.com" ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== ""
  ) {
    throw new PublicDtoSemanticError("公開項目のURLがGitHubのHTTPS URLではありません");
  }
  const match = /^\/([^/\s?#%]+)\/([^/\s?#%]+)\/(issues|pull)\/([1-9]\d*)$/u.exec(url.pathname);
  if (match == null) {
    throw new PublicDtoSemanticError(
      "公開項目のURL pathがIssueまたはPull Requestの形式ではありません",
    );
  }
  const owner = match[1];
  const repository = match[2];
  const kind = match[3];
  const numberText = match[4];
  assertNonNullable(owner, "公開項目のURL ownerを取得できません");
  assertNonNullable(repository, "公開項目のURL repositoryを取得できません");
  assertNonNullable(kind, "公開項目のURL種別を取得できません");
  assertNonNullable(numberText, "公開項目のURL numberを取得できません");
  const number = Number.parseInt(numberText, 10);
  if (!Number.isSafeInteger(number)) {
    throw new PublicDtoSemanticError("公開項目のURL numberが安全な整数ではありません");
  }
  return {
    owner,
    repository,
    number,
    type: kind === "issues" ? "issue" : "pull_request",
  };
}

export function assertPublicNotificationHistoryEntryItem(
  entry: PublicNotificationHistoryEntryInput,
): void {
  const displayIdentity = parsePublicItemDisplayReference(entry.item.displayReference);
  const urlIdentity = parsePublicItemUrl(entry.item.url);
  if (
    displayIdentity.owner !== urlIdentity.owner ||
    displayIdentity.repository !== urlIdentity.repository ||
    displayIdentity.number !== urlIdentity.number ||
    entry.item.number !== displayIdentity.number ||
    entry.item.type !== urlIdentity.type
  ) {
    throw new PublicDtoSemanticError(
      `通知履歴の表示参照とURLのitem identityが一致しません。対象: ${entry.item.nodeId}`,
    );
  }
  for (const waitingOn of entry.waitingOn) {
    if (waitingOn.kind === "item") {
      parsePublicItemDisplayReference(waitingOn.displayReference);
    }
  }
}
