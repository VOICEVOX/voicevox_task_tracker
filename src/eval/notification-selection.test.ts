import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildSourceId,
  createGitHubNodeId,
  createUtcIsoDateTime,
  type NotificationLedgerEntry,
  type Severity,
  type Status,
  type StalenessNotificationSeverityReason,
  type UtcIsoDateTime,
  type WaitClass,
  type WaitingOn,
} from "../domain/index.js";
import {
  createAcknowledgedNotificationLedgerEntries,
  selectDiscordNotifications,
  type DiscordNotificationItem,
  type DiscordNotificationSelection,
  type DiscordNotificationSelectionSettings,
} from "../discord/notification-selection.js";
import { type DependencyCycleId } from "../graph/index.js";
import { assertNonNullable } from "../util/index.js";

const MILLISECONDS_PER_HOUR = 60 * 60 * 1000;
const EVALUATED_AT = createUtcIsoDateTime("2026-01-10T00:00:00.000Z");
const NEXT_DAY = createUtcIsoDateTime("2026-01-11T00:00:00.000Z");
const THREE_DAYS_LATER = createUtcIsoDateTime("2026-01-13T00:00:00.000Z");
const SOURCE_ID = buildSourceId("test", "notification-selection");
const SETTINGS: DiscordNotificationSelectionSettings = Object.freeze({
  maxItemsPerDigest: 10,
  recentProgressGraceHours: 24,
  minimumAiConfidence: 0.8,
});

type ItemOverrides = Readonly<{
  nodeId?: string;
  createdAt?: UtcIsoDateTime;
  draftState?: DiscordNotificationItem["draftState"];
  status?: Status;
  waitClass?: WaitClass;
  severity?: Severity;
  statusSince?: UtcIsoDateTime;
  ownerSince?: UtcIsoDateTime;
  stallSince?: UtcIsoDateTime;
  lastProgressAt?: UtcIsoDateTime;
  currentWaitingOnRole?: WaitingOn["role"];
  currentWaitingOnCandidateId?: string;
  previousSeverity?: Severity;
  previousStallSince?: UtcIsoDateTime;
  previousObservedAt?: UtcIsoDateTime;
  currentDependencyCycleIds?: readonly DependencyCycleId[];
  previousDependencyCycleIds?: readonly DependencyCycleId[];
}>;

type DigestSelection = Extract<DiscordNotificationSelection, { action: "create_digest" }>;

function hoursBefore(value: UtcIsoDateTime, hours: number): UtcIsoDateTime {
  return createUtcIsoDateTime(
    new Date(Date.parse(value) - hours * MILLISECONDS_PER_HOUR).toISOString(),
  );
}

function waitingOn(role: WaitingOn["role"], candidateId: string): WaitingOn {
  return {
    kind: "user",
    candidateId,
    role,
    reasonSummary: "テスト用の待ち相手です",
    sourceIds: [SOURCE_ID],
    confidence: 1,
  };
}

function severityThresholdHours(waitClass: WaitClass, severity: Exclude<Severity, "none">): number {
  if (waitClass === "work") {
    switch (severity) {
      case "watch":
        return 168;
      case "urgent":
        return 336;
      case "critical":
        return 720;
    }
  }
  switch (severity) {
    case "watch":
      return 24;
    case "urgent":
      return 48;
    case "critical":
      return 72;
  }
}

function severityReason(
  waitClass: WaitClass,
  severity: Severity,
  stallSince: UtcIsoDateTime,
  evaluatedAt: UtcIsoDateTime,
): StalenessNotificationSeverityReason {
  const elapsedHours = (Date.parse(evaluatedAt) - Date.parse(stallSince)) / MILLISECONDS_PER_HOUR;
  if (severity === "none") {
    return {
      kind: "elapsed_threshold",
      waitClass,
      elapsedHours,
      crossedThreshold: {
        status: "not_reached",
        nextSeverity: "watch",
        nextThresholdHours: 24,
      },
    };
  }
  const thresholdHours = severityThresholdHours(waitClass, severity);
  return {
    kind: "elapsed_threshold",
    waitClass,
    elapsedHours,
    crossedThreshold: {
      status: "reached",
      severity,
      thresholdHours,
    },
  };
}

function createItem(
  evaluatedAt: UtcIsoDateTime,
  overrides: ItemOverrides,
): DiscordNotificationItem {
  const status = overrides.status ?? "waiting_for_review";
  const waitClass = overrides.waitClass ?? "review";
  const severity = overrides.severity ?? "urgent";
  const statusSince = overrides.statusSince ?? hoursBefore(evaluatedAt, 72);
  const ownerSince = overrides.ownerSince ?? hoursBefore(evaluatedAt, 72);
  const stallSince = overrides.stallSince ?? hoursBefore(evaluatedAt, 72);
  const lastProgressAt = overrides.lastProgressAt ?? hoursBefore(evaluatedAt, 72);
  const currentWaitingOn = waitingOn(
    overrides.currentWaitingOnRole ?? "reviewer",
    overrides.currentWaitingOnCandidateId ?? "user:reviewer-1",
  );
  const previousStallSince = overrides.previousStallSince ?? stallSince;
  const previousObservedAt = overrides.previousObservedAt ?? hoursBefore(evaluatedAt, 1);
  const previousDependencyCycles:
    | Readonly<{
        availability: "not_available";
      }>
    | Readonly<{
        availability: "available";
        cycleIds: readonly DependencyCycleId[];
      }> =
    overrides.previousDependencyCycleIds == null
      ? { availability: "not_available" }
      : {
          availability: "available",
          cycleIds: overrides.previousDependencyCycleIds,
        };
  return {
    nodeId: createGitHubNodeId(overrides.nodeId ?? "node:test"),
    createdAt: overrides.createdAt ?? createUtcIsoDateTime("2026-01-01T00:00:00.000Z"),
    draftState: overrides.draftState ?? "not_applicable",
    repositoryFreshness: "fresh",
    notificationClass: "standard",
    notificationsSuppressedByLabel: false,
    latestChange: "none",
    decisionBasis: { source: "deterministic" },
    notificationRecommendation: { availability: "not_available" },
    priorityWeight: 1,
    current: {
      status,
      waitingOn: [currentWaitingOn],
      severity,
      severityReason: severityReason(waitClass, severity, stallSince, evaluatedAt),
      waitClass,
      statusSince,
      ownerSince,
      stallSince,
      lastProgressAt,
    },
    previous: {
      availability: "available",
      value: {
        status,
        waitingOn: [currentWaitingOn],
        severity: overrides.previousSeverity ?? severity,
        stallSince: previousStallSince,
        observedAt: previousObservedAt,
      },
    },
    graph: {
      downstreamImpact: {
        nodeId: createGitHubNodeId(overrides.nodeId ?? "node:test"),
        openNodeCount: 0,
        repositoryCount: 0,
      },
      newlyUnblocked: false,
      currentDependencyCycleIds: overrides.currentDependencyCycleIds ?? [],
      previousDependencyCycles,
    },
  } satisfies DiscordNotificationItem;
}

function select(
  evaluatedAt: UtcIsoDateTime,
  item: DiscordNotificationItem,
  ledger: readonly NotificationLedgerEntry[],
): DiscordNotificationSelection {
  return selectDiscordNotifications({
    evaluatedAt,
    items: [item],
    ledger,
    settings: SETTINGS,
  });
}

function digest(selection: DiscordNotificationSelection): DigestSelection {
  if (selection.action !== "create_digest") {
    throw new Error("通知候補が作成されませんでした");
  }
  return selection;
}

function first<Value>(values: readonly Value[]): Value {
  const value = values[0];
  assertNonNullable(value, "配列が空です");
  return value;
}

function reasonCodes(selection: DigestSelection): readonly string[] {
  return first(selection.candidates).reasons.map((reason) => reason.reasonCode);
}

function createSentLedgerEntry(
  selection: DigestSelection,
  reservedAt: UtcIsoDateTime,
  sentAt: UtcIsoDateTime,
): NotificationLedgerEntry {
  const candidate = first(selection.candidates);
  const reason = first(candidate.reasons);
  return {
    notificationKey: reason.notificationKey,
    itemNodeId: candidate.itemNodeId,
    reasonCode: reason.reasonCode,
    severity: candidate.severity,
    reservedAt,
    status: "sent",
    sentAt,
    discordMessageId: "message:test",
  };
}

function createAcknowledgedLedgerEntry(
  selection: DigestSelection,
  reservedAt: UtcIsoDateTime,
  acknowledgedAt: UtcIsoDateTime,
): NotificationLedgerEntry {
  const candidate = first(selection.candidates);
  const reason = first(candidate.reasons);
  return {
    notificationKey: reason.notificationKey,
    itemNodeId: candidate.itemNodeId,
    reasonCode: reason.reasonCode,
    severity: candidate.severity,
    reservedAt,
    status: "acknowledged",
    acknowledgedAt,
  };
}

function createReservedLedgerEntry(
  selection: DigestSelection,
  reservedAt: UtcIsoDateTime,
  expiresAt: UtcIsoDateTime,
): NotificationLedgerEntry {
  const candidate = first(selection.candidates);
  const reason = first(candidate.reasons);
  return {
    notificationKey: reason.notificationKey,
    itemNodeId: candidate.itemNodeId,
    reasonCode: reason.reasonCode,
    severity: candidate.severity,
    reservedAt,
    status: "reserved",
    expiresAt,
  };
}

void test("同じ待ち期間とseverityのsent、acknowledgedはstallSince更新後も抑制する", () => {
  const firstItem = createItem(EVALUATED_AT, {
    nodeId: "node:stall-refresh",
  });
  const firstSelection = digest(select(EVALUATED_AT, firstItem, []));
  const nextItem = createItem(NEXT_DAY, {
    nodeId: "node:stall-refresh",
    statusSince: firstItem.current.statusSince,
    ownerSince: firstItem.current.ownerSince,
    stallSince: hoursBefore(NEXT_DAY, 48),
  });

  const sent = createSentLedgerEntry(firstSelection, EVALUATED_AT, EVALUATED_AT);
  assert.equal(select(NEXT_DAY, nextItem, [sent]).action, "skip_digest");

  const acknowledged = createAcknowledgedLedgerEntry(firstSelection, EVALUATED_AT, EVALUATED_AT);
  assert.equal(select(NEXT_DAY, nextItem, [acknowledged]).action, "skip_digest");
});

void test("新しい待ち期間では旧期間のreserved後送信を抑制しない", () => {
  const firstItem = createItem(EVALUATED_AT, { nodeId: "node:new-period" });
  const firstSelection = digest(select(EVALUATED_AT, firstItem, []));
  const oldReservationSentLater = createSentLedgerEntry(
    firstSelection,
    EVALUATED_AT,
    THREE_DAYS_LATER,
  );
  const nextItem = createItem(THREE_DAYS_LATER, {
    nodeId: "node:new-period",
    statusSince: NEXT_DAY,
    ownerSince: hoursBefore(THREE_DAYS_LATER, 72),
    stallSince: hoursBefore(THREE_DAYS_LATER, 48),
  });

  assert.equal(
    select(THREE_DAYS_LATER, nextItem, [oldReservationSentLater]).action,
    "create_digest",
  );
});

void test("同じreviewerの新しい依頼とseverity上昇は再候補にする", () => {
  const firstItem = createItem(EVALUATED_AT, {
    nodeId: "node:review-cycle",
    currentWaitingOnCandidateId: "user:reviewer-1",
  });
  const firstSelection = digest(select(EVALUATED_AT, firstItem, []));
  const previousNotification = createSentLedgerEntry(firstSelection, EVALUATED_AT, EVALUATED_AT);

  const newRequest = createItem(THREE_DAYS_LATER, {
    nodeId: "node:review-cycle",
    currentWaitingOnCandidateId: "user:reviewer-1",
    statusSince: firstItem.current.statusSince,
    ownerSince: NEXT_DAY,
    stallSince: hoursBefore(THREE_DAYS_LATER, 48),
  });
  assert.equal(
    select(THREE_DAYS_LATER, newRequest, [previousNotification]).action,
    "create_digest",
  );

  const severityRise = createItem(THREE_DAYS_LATER, {
    nodeId: "node:review-cycle",
    severity: "critical",
    statusSince: firstItem.current.statusSince,
    ownerSince: firstItem.current.ownerSince,
    stallSince: hoursBefore(THREE_DAYS_LATER, 96),
  });
  assert.equal(
    select(THREE_DAYS_LATER, severityRise, [previousNotification]).action,
    "create_digest",
  );
});

void test("reservedは期限内だけ抑制し期限到達後に再候補にする", () => {
  const item = createItem(EVALUATED_AT, { nodeId: "node:reservation" });
  const initialSelection = digest(select(EVALUATED_AT, item, []));
  const reservation = createReservedLedgerEntry(initialSelection, EVALUATED_AT, NEXT_DAY);

  assert.equal(select(EVALUATED_AT, item, [reservation]).action, "skip_digest");
  const afterExpiryItem = createItem(NEXT_DAY, {
    nodeId: "node:reservation",
    statusSince: item.current.statusSince,
    ownerSince: item.current.ownerSince,
    stallSince: item.current.stallSince,
  });
  assert.equal(select(NEXT_DAY, afterExpiryItem, [reservation]).action, "create_digest");
});

void test("非時間系の新しいdependency cycleは同じ期間でも抑制しない", () => {
  const firstItem = createItem(EVALUATED_AT, {
    nodeId: "node:cycle",
    currentDependencyCycleIds: ["dependency-cycle:first"],
    previousDependencyCycleIds: [],
  });
  const firstSelection = digest(select(EVALUATED_AT, firstItem, []));
  const previousNotification = createSentLedgerEntry(firstSelection, EVALUATED_AT, EVALUATED_AT);
  const nextItem = createItem(NEXT_DAY, {
    nodeId: "node:cycle",
    currentDependencyCycleIds: ["dependency-cycle:second"],
    previousDependencyCycleIds: [],
    statusSince: firstItem.current.statusSince,
    ownerSince: firstItem.current.ownerSince,
    stallSince: firstItem.current.stallSince,
  });

  const nextSelection = digest(select(NEXT_DAY, nextItem, [previousNotification]));
  assert.ok(reasonCodes(nextSelection).includes("dependency_cycle"));
});

void test("waiting_for_workの既存watchがwork閾値到達後に候補になる", () => {
  const item = createItem(EVALUATED_AT, {
    nodeId: "node:work",
    status: "waiting_for_work",
    waitClass: "work",
    severity: "watch",
    previousSeverity: "watch",
    stallSince: hoursBefore(EVALUATED_AT, 168),
  });

  const selection = digest(select(EVALUATED_AT, item, []));
  assert.deepEqual(reasonCodes(selection), ["work_overdue"]);
});

void test("Draftとrevision、in_progressのwork待ちにはwork_overdueを付けない", () => {
  const revision = createItem(EVALUATED_AT, {
    nodeId: "node:revision-work",
    draftState: "ready_for_review",
    status: "waiting_for_revision",
    waitClass: "work",
    severity: "watch",
    stallSince: hoursBefore(EVALUATED_AT, 168),
  });
  const inProgress = createItem(EVALUATED_AT, {
    nodeId: "node:in-progress-work",
    draftState: "draft",
    status: "in_progress",
    waitClass: "work",
    severity: "watch",
    stallSince: hoursBefore(EVALUATED_AT, 168),
  });

  assert.equal(select(EVALUATED_AT, revision, []).action, "skip_digest");
  assert.equal(select(EVALUATED_AT, inProgress, []).action, "skip_digest");
});

void test("PRのowner、review待ちはauthor活動が24時間以内でも通知する", () => {
  const recentAuthorActivity = hoursBefore(EVALUATED_AT, 1);
  const owner = createItem(EVALUATED_AT, {
    nodeId: "node:pr-owner",
    draftState: "ready_for_review",
    status: "waiting_for_owner",
    waitClass: "owner",
    lastProgressAt: recentAuthorActivity,
  });
  const review = createItem(EVALUATED_AT, {
    nodeId: "node:pr-review",
    draftState: "ready_for_review",
    status: "waiting_for_review",
    waitClass: "review",
    lastProgressAt: recentAuthorActivity,
  });

  assert.deepEqual(reasonCodes(digest(select(EVALUATED_AT, owner, []))), ["owner_overdue"]);
  assert.deepEqual(reasonCodes(digest(select(EVALUATED_AT, review, []))), ["review_overdue"]);
});

void test("owner、review以外の状態ではlastProgressAtの猶予を維持する", () => {
  const reply = createItem(EVALUATED_AT, {
    nodeId: "node:reply-grace",
    draftState: "ready_for_review",
    status: "waiting_for_reply",
    waitClass: "reply",
    lastProgressAt: hoursBefore(EVALUATED_AT, 1),
  });

  assert.equal(select(EVALUATED_AT, reply, []).action, "skip_digest");
});

void test("確認済みledgerは現在候補だけを対象にし将来候補を確認済みにしない", () => {
  const notYetEligible = createItem(EVALUATED_AT, {
    nodeId: "node:future-ack",
    severity: "none",
    stallSince: hoursBefore(EVALUATED_AT, 12),
    lastProgressAt: hoursBefore(EVALUATED_AT, 72),
  });

  assert.deepEqual(
    createAcknowledgedNotificationLedgerEntries({
      evaluatedAt: EVALUATED_AT,
      items: [notYetEligible],
      ledger: [],
      settings: SETTINGS,
    }),
    [],
  );

  const laterEligible = createItem(NEXT_DAY, {
    nodeId: "node:future-ack",
    severity: "watch",
    previousSeverity: "none",
    stallSince: hoursBefore(NEXT_DAY, 48),
    lastProgressAt: hoursBefore(NEXT_DAY, 48),
  });
  assert.deepEqual(reasonCodes(digest(select(NEXT_DAY, laterEligible, []))), ["review_overdue"]);
});
