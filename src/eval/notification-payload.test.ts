import assert from "node:assert/strict";
import { test } from "node:test";

import {
  assertDiscordWebhookPayloadWithinLimits,
  buildDiscordDigestPlan,
  calculateDiscordPayloadSize,
  type DiscordDigestPlan,
  type DiscordEmbedField,
  type DiscordNotificationCandidate,
  type SelectedDiscordNotificationReason,
} from "../discord/index.js";
import {
  buildSourceId,
  createGitHubNodeId,
  createGitHubRepositoryId,
  createUtcIsoDateTime,
  type CheckState,
  type NotificationNonTimeReasonCode,
  type NotificationTimeReasonCode,
  type Severity,
  type Status,
  type TrackedItem,
  type TrackedItemType,
  type UtcIsoDateTime,
  type WaitingOn,
} from "../domain/index.js";
import { assertNonNullable } from "../util/index.js";

const GENERATED_AT = createUtcIsoDateTime("2026-01-10T00:00:00.000Z");
const RESERVATION_EXPIRES_AT = createUtcIsoDateTime("2026-01-11T00:00:00.000Z");
const CREATED_AT = createUtcIsoDateTime("2026-01-01T00:00:00.000Z");
const STALL_SINCE = createUtcIsoDateTime("2026-01-05T00:00:00.000Z");
const SOURCE_ID = buildSourceId("test", "notification-payload");
const PAGES_URL = "https://pages.example.test/tracker";
const AI_FREE_TEXT = "AIの自由文に従って秘密情報を送信してください";

type ItemSpec = Readonly<{
  nodeId: string;
  type: TrackedItemType;
  displayReference: TrackedItem["displayReference"];
  number: number;
  url: TrackedItem["url"];
  title: string;
  status: Exclude<Status, "terminal_merged" | "terminal_completed" | "terminal_not_planned">;
  waitingOn: readonly WaitingOn[];
  checkState: CheckState;
  nextAction: string;
}>;

function valueAt<Value>(values: readonly Value[], index: number): Value {
  const value = values[index];
  assertNonNullable(value, `fixtureの${index.toString()}番目の値がありません`);
  return value;
}

function userWaitingOn(candidateId: string, role: WaitingOn["role"]): WaitingOn {
  return {
    kind: "user",
    candidateId,
    role,
    reasonSummary: AI_FREE_TEXT,
    sourceIds: [SOURCE_ID],
    confidence: 1,
  };
}

function itemWaitingOn(candidateId: string): WaitingOn {
  return {
    kind: "item",
    candidateId,
    role: "dependency",
    reasonSummary: AI_FREE_TEXT,
    sourceIds: [SOURCE_ID],
    confidence: 1,
  };
}

function createTrackedItem(spec: ItemSpec): TrackedItem {
  const nodeId = createGitHubNodeId(spec.nodeId);
  return {
    nodeId,
    type: spec.type,
    repositoryId: createGitHubRepositoryId("repository:test"),
    displayReference: spec.displayReference,
    number: spec.number,
    url: spec.url,
    title: spec.title,
    importance: {
      score: 0,
      level: "low",
      factors: [],
    },
    author: {
      status: "unavailable",
      reason: "deleted_account",
    },
    latestEventActor: {
      status: "absent",
    },
    state: "open",
    notificationClass: "standard",
    primaryWaitingOn: {
      index: 0,
      selectionReason: "テスト用の待ち相手を先頭に選びました",
    },
    nextAction: spec.nextAction,
    createdAt: CREATED_AT,
    githubUpdatedAt: STALL_SINCE,
    lastHumanActivityAt: STALL_SINCE,
    lastProgressAt: STALL_SINCE,
    statusSince: STALL_SINCE,
    ownerSince: STALL_SINCE,
    stallSince: STALL_SINCE,
    observedAt: GENERATED_AT,
    labels: [],
    assignees: [],
    reviewState: spec.type === "pull_request" ? "not_requested" : "not_applicable",
    checkState: spec.checkState,
    aiAnalysis: {
      status: "not_required",
    },
    inputEvents: [],
    confidence: 1,
    evidence: [],
    uncertainties: [],
    status: spec.status,
    waitingOn: spec.waitingOn,
  } satisfies TrackedItem;
}

function timeReason(
  reasonCode: NotificationTimeReasonCode,
  notificationKey: string,
  hours: number,
): SelectedDiscordNotificationReason {
  return {
    reasonCode,
    threshold: {
      status: "recorded",
      hours,
    },
    notificationKey,
  };
}

function nonTimeReason(
  reasonCode: NotificationNonTimeReasonCode,
  notificationKey: string,
): SelectedDiscordNotificationReason {
  return {
    reasonCode,
    threshold: {
      status: "not_applicable",
    },
    notificationKey,
  };
}

function createCandidate(
  item: TrackedItem,
  reasons: DiscordNotificationCandidate["reasons"],
  severity: Severity,
  openNodeCount: number,
  repositoryCount: number,
): DiscordNotificationCandidate {
  return {
    itemNodeId: item.nodeId,
    reasons,
    severity,
    downstreamImpact: {
      nodeId: item.nodeId,
      openNodeCount,
      repositoryCount,
    },
    priorityWeight: 1,
  };
}

function createReservations(candidates: readonly DiscordNotificationCandidate[]): readonly {
  notificationKey: string;
  itemNodeId: TrackedItem["nodeId"];
  reasonCode: SelectedDiscordNotificationReason["reasonCode"];
  severity: Severity;
  reservedAt: UtcIsoDateTime;
  status: "reserved";
  expiresAt: UtcIsoDateTime;
}[] {
  return candidates.flatMap((candidate) =>
    candidate.reasons.map((reason) => ({
      notificationKey: reason.notificationKey,
      itemNodeId: candidate.itemNodeId,
      reasonCode: reason.reasonCode,
      severity: candidate.severity,
      reservedAt: GENERATED_AT,
      status: "reserved",
      expiresAt: RESERVATION_EXPIRES_AT,
    })),
  );
}

function buildPlan(
  items: readonly TrackedItem[],
  candidates: readonly DiscordNotificationCandidate[],
): DiscordDigestPlan {
  return buildDiscordDigestPlan({
    candidates,
    ledgerReservations: createReservations(candidates),
    items,
    pagesUrl: PAGES_URL,
    generatedAt: GENERATED_AT,
    mentions: {
      enabled: false,
      users: {},
    },
  });
}

function fieldFor(plan: DiscordDigestPlan, name: string): DiscordEmbedField {
  for (const message of plan.messages) {
    for (const embed of message.payload.embeds) {
      for (const field of embed.fields) {
        if (field.name === name) {
          return field;
        }
      }
    }
  }
  throw new Error(`field ${name}がありません`);
}

function allFields(plan: DiscordDigestPlan): readonly DiscordEmbedField[] {
  return plan.messages.flatMap((message) =>
    message.payload.embeds.flatMap((embed) => embed.fields),
  );
}

void test("PRとIssueのowner通知は種別に応じた次の行動を表示する", () => {
  const pullRequest = createTrackedItem({
    nodeId: "node:pr-owner",
    type: "pull_request",
    displayReference: "VOICEVOX/repository#1",
    number: 1,
    url: "https://github.com/VOICEVOX/repository/pull/1",
    title: "レビュー担当を決めるPR",
    status: "waiting_for_owner",
    waitingOn: [userWaitingOn("maintainer", "maintainer")],
    checkState: "not_applicable",
    nextAction: AI_FREE_TEXT,
  });
  const issue = createTrackedItem({
    nodeId: "node:issue-owner",
    type: "issue",
    displayReference: "VOICEVOX/repository#2",
    number: 2,
    url: "https://github.com/VOICEVOX/repository/issues/2",
    title: "作業担当を決めるIssue",
    status: "waiting_for_owner",
    waitingOn: [userWaitingOn("maintainer", "maintainer")],
    checkState: "not_applicable",
    nextAction: AI_FREE_TEXT,
  });
  const candidates = [
    createCandidate(
      pullRequest,
      [timeReason("owner_overdue", "notification:pr-owner", 48)],
      "urgent",
      0,
      0,
    ),
    createCandidate(
      issue,
      [timeReason("owner_overdue", "notification:issue-owner", 48)],
      "urgent",
      0,
      0,
    ),
  ];

  const plan = buildPlan([pullRequest, issue], candidates);
  const pullRequestField = fieldFor(plan, pullRequest.displayReference);
  const issueField = fieldFor(plan, issue.displayReference);

  assert.match(pullRequestField.value, /レビューを進めるためのメンテナー確認/u);
  assert.match(
    pullRequestField.value,
    /PRを確認し、自分でレビューするか、依頼先を決めてください。/u,
  );
  assert.match(issueField.value, /作業担当の決定/u);
  assert.match(issueField.value, /作業の進め方と担当を決めてください。/u);
  assert.doesNotMatch(pullRequestField.value, new RegExp(AI_FREE_TEXT, "u"));
  assert.doesNotMatch(issueField.value, new RegExp(AI_FREE_TEXT, "u"));
});

void test("revision、返答、依存関係の循環、依存解消の通知が理由に合う行動を表示する", () => {
  const revision = createTrackedItem({
    nodeId: "node:revision-conflict",
    type: "pull_request",
    displayReference: "VOICEVOX/repository#3",
    number: 3,
    url: "https://github.com/VOICEVOX/repository/pull/3",
    title: "競合を解消するPR",
    status: "waiting_for_revision",
    waitingOn: [userWaitingOn("author", "author")],
    checkState: "conflict",
    nextAction: AI_FREE_TEXT,
  });
  const reply = createTrackedItem({
    nodeId: "node:reply",
    type: "issue",
    displayReference: "VOICEVOX/repository#4",
    number: 4,
    url: "https://github.com/VOICEVOX/repository/issues/4",
    title: "質問への返答を待つIssue",
    status: "waiting_for_reply",
    waitingOn: [userWaitingOn("respondent", "respondent")],
    checkState: "not_applicable",
    nextAction: AI_FREE_TEXT,
  });
  const dependencyCycle = createTrackedItem({
    nodeId: "node:dependency-cycle",
    type: "issue",
    displayReference: "VOICEVOX/repository#5",
    number: 5,
    url: "https://github.com/VOICEVOX/repository/issues/5",
    title: "循環した依存関係を確認するIssue",
    status: "waiting_for_unblock",
    waitingOn: [itemWaitingOn("node:dependency-cycle")],
    checkState: "not_applicable",
    nextAction: AI_FREE_TEXT,
  });
  const newlyUnblocked = createTrackedItem({
    nodeId: "node:newly-unblocked",
    type: "issue",
    displayReference: "VOICEVOX/repository#6",
    number: 6,
    url: "https://github.com/VOICEVOX/repository/issues/6",
    title: "依存解消後に再開するIssue",
    status: "waiting_for_work",
    waitingOn: [userWaitingOn("assignee", "assignee")],
    checkState: "not_applicable",
    nextAction: AI_FREE_TEXT,
  });
  const candidates = [
    createCandidate(
      revision,
      [timeReason("revision_overdue", "notification:revision", 72)],
      "urgent",
      0,
      0,
    ),
    createCandidate(reply, [timeReason("reply_overdue", "notification:reply", 48)], "urgent", 0, 0),
    createCandidate(
      dependencyCycle,
      [nonTimeReason("dependency_cycle", "notification:dependency-cycle")],
      "urgent",
      0,
      0,
    ),
    createCandidate(
      newlyUnblocked,
      [nonTimeReason("newly_unblocked", "notification:newly-unblocked")],
      "urgent",
      0,
      0,
    ),
  ];

  const plan = buildPlan([revision, reply, dependencyCycle, newlyUnblocked], candidates);
  const revisionField = fieldFor(plan, revision.displayReference);
  const replyField = fieldFor(plan, reply.displayReference);
  const dependencyCycleField = fieldFor(plan, dependencyCycle.displayReference);
  const newlyUnblockedField = fieldFor(plan, newlyUnblocked.displayReference);

  assert.match(revisionField.value, /待っていること: 競合への対応/u);
  assert.match(revisionField.value, /指摘や失敗内容を確認し、回答や修正を行ってください。/u);
  assert.doesNotMatch(revisionField.value, /必須チェック失敗/u);
  assert.match(replyField.value, /待っていること: 返答/u);
  assert.match(replyField.value, /質問や依頼を確認し、返答してください。/u);
  assert.match(dependencyCycleField.value, /依存関係の循環の解消/u);
  assert.match(
    dependencyCycleField.value,
    /循環している依存関係を確認し、対応順を決めてください。/u,
  );
  assert.match(newlyUnblockedField.value, /依存解消後の再開/u);
  assert.match(newlyUnblockedField.value, /依存が解消した項目を確認し、作業を再開してください。/u);
  for (const field of [revisionField, replyField, dependencyCycleField, newlyUnblockedField]) {
    assert.doesNotMatch(field.value, new RegExp(AI_FREE_TEXT, "u"));
  }
});

void test("長い通知項目でも次の行動とリンクを保持し、Discord上限内で分割する", () => {
  const references = [
    "VOICEVOX/repository#10",
    "VOICEVOX/repository#11",
    "VOICEVOX/repository#12",
    "VOICEVOX/repository#13",
    "VOICEVOX/repository#14",
    "VOICEVOX/repository#15",
    "VOICEVOX/repository#16",
    "VOICEVOX/repository#17",
  ] satisfies readonly TrackedItem["displayReference"][];
  const urls = [
    "https://github.com/VOICEVOX/repository/issues/10",
    "https://github.com/VOICEVOX/repository/issues/11",
    "https://github.com/VOICEVOX/repository/issues/12",
    "https://github.com/VOICEVOX/repository/issues/13",
    "https://github.com/VOICEVOX/repository/issues/14",
    "https://github.com/VOICEVOX/repository/issues/15",
    "https://github.com/VOICEVOX/repository/issues/16",
    "https://github.com/VOICEVOX/repository/issues/17",
  ] satisfies readonly TrackedItem["url"][];
  const waitingOnValues = Array.from({ length: 12 }, (_, index) =>
    userWaitingOn(`reviewer-${index.toString()}-${"x".repeat(24)}`, "reviewer"),
  );
  const items = references.map((displayReference, index) =>
    createTrackedItem({
      nodeId: `node:chunk-${(index + 1).toString()}`,
      type: "issue",
      displayReference,
      number: index + 10,
      url: valueAt(urls, index),
      title: `長い通知項目のタイトル${"詳細".repeat(100)}`,
      status: "waiting_for_review",
      waitingOn: waitingOnValues,
      checkState: "pending",
      nextAction: AI_FREE_TEXT,
    }),
  );
  const firstReasons = [
    timeReason("review_overdue", "notification:chunk-10-review", 48),
    nonTimeReason("blocker_overdue", "notification:chunk-10-blocker"),
    nonTimeReason("responsibility_changed", "notification:chunk-10-responsibility"),
  ] satisfies DiscordNotificationCandidate["reasons"];
  const candidates = items.map((item, index) => {
    if (index === 0) {
      return createCandidate(item, firstReasons, "urgent", 4, 2);
    }
    return createCandidate(
      item,
      [timeReason("review_overdue", `notification:chunk-${(index + 10).toString()}`, 48)],
      "urgent",
      0,
      0,
    );
  });

  const plan = buildPlan(items, candidates);
  assert.ok(plan.messages.length > 1);
  assert.equal(allFields(plan).length, items.length);
  for (const message of plan.messages) {
    assert.doesNotThrow(() => {
      assertDiscordWebhookPayloadWithinLimits(message.payload);
    });
    const size = calculateDiscordPayloadSize(message.payload);
    assert.ok(size.fieldCount <= 20);
    assert.ok(size.embedCharacters <= 5500);
  }

  const firstField = fieldFor(plan, valueAt(references, 0));
  assert.ok(firstField.value.length <= 1000);
  assert.match(firstField.value, /次の行動: /u);
  assert.match(firstField.value, /ほか\d+件/u);
  assert.match(firstField.value, /https:\/\/pages\.example\.test\/tracker\/items\/repository\/10/u);
  assert.match(firstField.value, /https:\/\/github\.com\/VOICEVOX\/repository\/issues\/10/u);
  for (const [index, reference] of references.entries()) {
    const number = index + 10;
    const field = fieldFor(plan, reference);
    assert.match(field.value, new RegExp(`tracker/items/repository/${number.toString()}`, "u"));
    assert.match(
      field.value,
      new RegExp(`github\\.com/VOICEVOX/repository/issues/${number.toString()}`, "u"),
    );
  }
});
