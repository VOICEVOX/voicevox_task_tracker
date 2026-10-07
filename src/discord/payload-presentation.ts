import {
  notificationReasonText,
  type PersonalReminderActionKind,
  type TrackedItem,
  type WaitingOnRole,
} from "../domain/index.js";
import { assertNonNullable } from "../util/index.js";
import { DiscordPayloadError } from "./errors.js";
import type {
  DiscordNotificationCandidate,
  SelectedDiscordNotificationReason,
} from "./notification-selection-contracts.js";
import type { DigestFieldDraft, PersonalReminderSelectedReason } from "./payload-contracts.js";
import {
  DISCORD_SAFE_LIMITS,
  isPersonalReminderSelectedReason,
  TITLE_MAX_CHARACTERS,
} from "./payload-contracts.js";
import {
  categoryForReason,
  characterCount,
  createPublicItemUrl,
  formatElapsedTime,
  formatJst,
  formatPersonalReminderResponsible,
  formatWaitingOn,
  normalizeInlineText,
  parseTimestamp,
  truncateText,
  validateGitHubUrl,
} from "./payload-text.js";

function createFieldName(item: TrackedItem): string {
  const reference = normalizeInlineText(item.displayReference, "表示用参照");
  if (characterCount(reference) > DISCORD_SAFE_LIMITS.fieldNameCharacters) {
    throw new DiscordPayloadError("owner/repo#numberがfield名の安全上限を超えています");
  }
  return reference;
}

function createReasonLines(candidate: DiscordNotificationCandidate): readonly string[] {
  return Object.freeze(
    candidate.reasons.map((reason) => `理由: ${notificationReasonText(reason)}`),
  );
}

function createSystemReasonLines(
  reasons: readonly SelectedDiscordNotificationReason[],
): readonly string[] {
  return Object.freeze(
    reasons
      .filter((reason) => reason.source.kind === "system")
      .map((reason) => `理由: ${notificationReasonText(reason)}`),
  );
}

function personalReminderWaitingFor(actionKind: PersonalReminderActionKind): string {
  switch (actionKind) {
    case "assessment":
      return "内容確認";
    case "owner":
      return "作業担当の決定";
    case "decision":
      return "方針判断";
    case "review":
      return "依頼されたレビューへの対応";
    case "revision":
      return "指摘や失敗内容への対応";
    case "reply":
      return "返答";
    case "work":
      return "作業着手または再開";
    case "merge":
      return "マージ条件確認";
  }
}

function createPersonalReminderReasonLine(
  reason: PersonalReminderSelectedReason,
  generatedTimestamp: number,
  mentionLookup: ReadonlyMap<string, string>,
  mentionsEnabled: boolean,
): Readonly<{
  text: string;
  mentionedUserIds: readonly string[];
}> {
  const context = reason.source.context;
  if (reason.threshold.status !== "recorded") {
    throw new DiscordPayloadError("個人催促理由のseverity閾値が記録されていません");
  }
  const stallTimestamp = parseTimestamp(context.stallSince.at, "個人催促のstallSince");
  const responsible = formatPersonalReminderResponsible(
    context.responsible,
    mentionLookup,
    mentionsEnabled,
  );
  const actionSummary = normalizeInlineText(context.action.summary, "個人催促の行動");
  return Object.freeze({
    text: [
      `待ち相手: ${responsible.text}`,
      `待っていること: ${personalReminderWaitingFor(context.action.kind)}`,
      `次の行動: ${actionSummary}`,
      `停滞時間: ${formatElapsedTime(stallTimestamp, generatedTimestamp)}、${formatJst(stallTimestamp)}から`,
      `理由: ${notificationReasonText(reason)}、基準時間: ${reason.threshold.hours.toString()}時間`,
    ].join("\n"),
    mentionedUserIds: responsible.mentionedUserIds,
  });
}

type NotificationGuidance = Readonly<{
  waitingFor: string;
  nextAction: string;
}>;

function hasWaitingOnRole(item: TrackedItem, role: WaitingOnRole): boolean {
  return item.waitingOn.some((waitingOn) => waitingOn.role === role);
}

function revisionWaitingFor(checkState: TrackedItem["checkState"]): string {
  switch (checkState) {
    case "failing":
      return "指摘や必須チェック失敗への対応";
    case "conflict":
      return "競合への対応";
    case "pending":
      return "指摘やチェック結果への対応";
    case "not_applicable":
    case "not_required":
    case "passing":
    case "unknown":
      return "指摘への対応";
  }
}

function mergeWaitingFor(checkState: TrackedItem["checkState"]): string {
  switch (checkState) {
    case "pending":
      return "必須チェック完了とマージ条件確認";
    case "failing":
      return "必須チェック失敗やマージ条件の確認";
    case "conflict":
      return "競合の解消とマージ条件確認";
    case "not_applicable":
    case "not_required":
    case "passing":
    case "unknown":
      return "マージ条件確認";
  }
}

function automationWaitingFor(checkState: TrackedItem["checkState"]): string {
  switch (checkState) {
    case "pending":
      return "自動処理の完了確認";
    case "failing":
    case "conflict":
      return "自動処理の結果確認";
    case "not_applicable":
    case "not_required":
    case "passing":
    case "unknown":
      return "処理状況確認";
  }
}

function pullRequestOwnerGuidance(item: TrackedItem): NotificationGuidance {
  if (hasWaitingOnRole(item, "maintainer")) {
    return {
      waitingFor: "レビューを進めるためのメンテナー確認",
      nextAction: "PRを確認し、自分でレビューするか、依頼先を決めてください。",
    };
  }
  if (hasWaitingOnRole(item, "reviewer")) {
    return {
      waitingFor: "レビュー担当の決定",
      nextAction: "PRを確認し、レビュー担当を決めてください。",
    };
  }
  if (hasWaitingOnRole(item, "unknown")) {
    return {
      waitingFor: "次の対応と担当確認",
      nextAction: "PRを確認し、次の対応と担当を決めてください。",
    };
  }
  return {
    waitingFor: "レビューを進めるための担当確認",
    nextAction: "PRを確認し、レビュー担当を決めてください。",
  };
}

function createStatusGuidance(item: TrackedItem): NotificationGuidance {
  switch (item.status) {
    case "waiting_for_assessment":
      return {
        waitingFor: "内容確認",
        nextAction: "内容を確認し、進め方を判断してください。",
      };
    case "waiting_for_owner":
      if (item.type === "pull_request") {
        return pullRequestOwnerGuidance(item);
      }
      return {
        waitingFor: "作業担当の決定",
        nextAction: "作業の進め方と担当を決めてください。",
      };
    case "waiting_for_decision":
      return {
        waitingFor: "方針判断",
        nextAction: "方針を確認し、進め方を決めてください。",
      };
    case "waiting_for_review":
      return {
        waitingFor: "依頼されたレビューへの対応",
        nextAction: "依頼されたレビューを確認し、対応してください。",
      };
    case "waiting_for_revision":
      return {
        waitingFor: revisionWaitingFor(item.checkState),
        nextAction: "指摘や失敗内容を確認し、回答や修正を行ってください。",
      };
    case "waiting_for_reply":
      return {
        waitingFor: "返答",
        nextAction: "質問や依頼を確認し、返答してください。",
      };
    case "waiting_for_work":
      return {
        waitingFor: "作業着手または再開",
        nextAction: "作業に着手するか、作業を再開してください。",
      };
    case "waiting_for_unblock":
      return {
        waitingFor: "依存先の状態確認",
        nextAction: "依存先の状態を確認し、依存が解消されるか判断してください。",
      };
    case "waiting_for_automation":
      return {
        waitingFor: automationWaitingFor(item.checkState),
        nextAction: "自動処理の状況を確認し、必要なら対応してください。",
      };
    case "waiting_for_merge":
      return {
        waitingFor: mergeWaitingFor(item.checkState),
        nextAction: "マージ条件を確認し、マージ可否を判断してください。",
      };
    case "in_progress":
      return {
        waitingFor: "作業の継続",
        nextAction: "作業状況を確認し、必要な対応を進めてください。",
      };
    case "unknown":
      return {
        waitingFor: "次の対応と担当確認",
        nextAction: "次の対応と担当を確認し、決めてください。",
      };
    case "terminal_merged":
    case "terminal_completed":
    case "terminal_not_planned":
      throw new DiscordPayloadError(
        `${item.displayReference}のterminal状態には通知文の次の行動を設定できません`,
      );
  }
}

function createReasonGuidance(
  reasons: readonly SelectedDiscordNotificationReason[],
): NotificationGuidance | undefined {
  for (const reason of reasons) {
    switch (reason.reasonCode) {
      case "dependency_cycle":
        return {
          waitingFor: "依存関係の循環の解消",
          nextAction: "循環している依存関係を確認し、対応順を決めてください。",
        };
      case "blocker_overdue":
        return {
          waitingFor: "下流を止めている項目への対応",
          nextAction: "下流を止めている原因を確認し、対応してください。",
        };
      case "newly_unblocked":
        return {
          waitingFor: "依存解消後の再開",
          nextAction: "依存が解消した項目を確認し、作業を再開してください。",
        };
      case "assessment_overdue":
      case "owner_overdue":
      case "decision_overdue":
      case "review_overdue":
      case "revision_overdue":
      case "reply_overdue":
      case "owner_unknown":
      case "merge_overdue":
      case "automation_stuck":
      case "work_overdue":
      case "responsibility_changed":
        continue;
    }
  }
  return undefined;
}

function createNotificationGuidance(
  reasons: readonly SelectedDiscordNotificationReason[],
  item: TrackedItem,
): NotificationGuidance {
  const statusGuidance = createStatusGuidance(item);
  return createReasonGuidance(reasons) ?? statusGuidance;
}

export function createFieldDraft(
  candidate: DiscordNotificationCandidate,
  item: TrackedItem,
  pagesUrl: URL,
  generatedTimestamp: number,
  itemReferences: ReadonlyMap<string, string>,
  mentionLookup: ReadonlyMap<string, string>,
  mentionsEnabled: boolean,
): DigestFieldDraft {
  if (candidate.itemNodeId !== item.nodeId) {
    throw new DiscordPayloadError("通知候補と追跡項目のnode IDが一致しません");
  }
  if (candidate.downstreamImpact.nodeId !== candidate.itemNodeId) {
    throw new DiscordPayloadError("通知候補のdownstream impactが別の項目を参照しています");
  }
  validateGitHubUrl(item.url);
  const publicItemUrl = createPublicItemUrl(pagesUrl, item);
  const firstReason = candidate.reasons[0];
  assertNonNullable(firstReason, `${candidate.itemNodeId}の通知理由を取得できませんでした`);
  const personalReasons = candidate.reasons.filter(isPersonalReminderSelectedReason);
  let fixedLines: readonly string[];
  let mentionedUserIds: readonly string[];
  if (personalReasons.length > 0) {
    const personalReasonLines = personalReasons.map((reason) =>
      createPersonalReminderReasonLine(reason, generatedTimestamp, mentionLookup, mentionsEnabled),
    );
    const lines = personalReasonLines.map((line) => line.text);
    const personalMentionedUserIds = personalReasonLines.flatMap((line) => line.mentionedUserIds);
    const systemReasons = candidate.reasons.filter((reason) => reason.source.kind === "system");
    const allMentionedUserIds = [...personalMentionedUserIds];
    if (systemReasons.length > 0) {
      const systemWaitingOn = formatWaitingOn(
        item.waitingOn,
        itemReferences,
        mentionLookup,
        mentionsEnabled,
      );
      const systemStallTimestamp = parseTimestamp(
        item.stallSince,
        `${item.displayReference}のstallSince`,
      );
      const guidance = createNotificationGuidance(systemReasons, item);
      lines.push(
        `項目全体の待ち相手: ${systemWaitingOn.text}`,
        `待っていること: ${guidance.waitingFor}`,
        `次の行動: ${guidance.nextAction}`,
        `停滞時間: ${formatElapsedTime(systemStallTimestamp, generatedTimestamp)}、${formatJst(systemStallTimestamp)}から`,
        ...createSystemReasonLines(systemReasons),
      );
      allMentionedUserIds.push(...systemWaitingOn.mentionedUserIds);
    }
    fixedLines = Object.freeze([...lines, `公開ページ: ${publicItemUrl}`, `GitHub: ${item.url}`]);
    mentionedUserIds = Object.freeze([...new Set(allMentionedUserIds)].sort());
  } else {
    const stallTimestamp = parseTimestamp(item.stallSince, `${item.displayReference}のstallSince`);
    const waitingOn = formatWaitingOn(
      item.waitingOn,
      itemReferences,
      mentionLookup,
      mentionsEnabled,
    );
    const reasonLines = createReasonLines(candidate);
    const guidance = createNotificationGuidance(candidate.reasons, item);
    fixedLines = Object.freeze([
      `待ち相手: ${waitingOn.text}`,
      `待っていること: ${guidance.waitingFor}`,
      `次の行動: ${guidance.nextAction}`,
      `停滞時間: ${formatElapsedTime(stallTimestamp, generatedTimestamp)}、${formatJst(stallTimestamp)}から`,
      ...reasonLines,
      `公開ページ: ${publicItemUrl}`,
      `GitHub: ${item.url}`,
    ]);
    mentionedUserIds = waitingOn.mentionedUserIds;
  }
  const titlePrefix = "タイトル: ";
  const maximumTitleCharacters =
    DISCORD_SAFE_LIMITS.fieldValueCharacters -
    characterCount(fixedLines.join("\n")) -
    1 -
    characterCount(titlePrefix);
  if (maximumTitleCharacters < 1) {
    throw new DiscordPayloadError(`${item.displayReference}のfield値にタイトルを収められません`);
  }
  const title = truncateText(
    normalizeInlineText(item.title, "タイトル"),
    Math.min(TITLE_MAX_CHARACTERS, maximumTitleCharacters),
  );
  const value = [`${titlePrefix}${title}`, ...fixedLines].join("\n");
  if (characterCount(value) > DISCORD_SAFE_LIMITS.fieldValueCharacters) {
    throw new DiscordPayloadError(`${item.displayReference}のfield値が安全上限を超えています`);
  }
  return Object.freeze({
    category: categoryForReason(firstReason.reasonCode),
    field: Object.freeze({
      name: createFieldName(item),
      value,
      inline: false,
    }),
    itemNodeId: item.nodeId,
    notificationKeys: Object.freeze(candidate.reasons.map((reason) => reason.notificationKey)),
    mentionedUserIds,
  });
}
