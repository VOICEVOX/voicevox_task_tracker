import { describe, expect, it } from "vitest";

import {
  buildSourceId,
  createGitHubNodeId,
  createGitHubRepositoryId,
  createUtcIsoDateTime,
  type GitHubNodeId,
  type NotificationLedgerEntry,
  type Severity,
  type StalenessWaitClass,
  type Status,
  type UtcIsoDateTime,
  type WaitingOn,
  type WaitingOnKind,
  type WaitingOnRole,
} from "../src/domain/index.js";
import {
  selectDiscordNotifications,
  type DiscordNotificationItem,
  type DiscordNotificationPrevious,
  type DiscordNotificationRecommendation,
  type DiscordNotificationReasonCode,
  type DiscordNotificationSelection,
  type DiscordNotificationSelectionSettings,
  type SelectDiscordNotificationsInput,
} from "../src/discord/index.js";
import {
  analyzeGraph,
  type DependencyCycleId,
  type TrackedGraphAnalysisNode,
} from "../src/graph/index.js";

const NOW = createUtcIsoDateTime("2026-08-10T00:00:00Z");
const CREATED_AT = createUtcIsoDateTime("2026-08-01T00:00:00Z");
const PREVIOUS_STALL_SINCE = createUtcIsoDateTime("2026-08-05T00:00:00Z");
const PREVIOUS_OBSERVED_AT = createUtcIsoDateTime("2026-08-09T00:00:00Z");
const settings = Object.freeze({
  maxItemsPerDigest: 10,
  cooldownDays: Object.freeze({
    urgent: 3,
    critical: 2,
  }),
  recentProgressGraceHours: 24,
  minimumAiConfidence: 0.65,
} satisfies DiscordNotificationSelectionSettings);

type ItemOverrides = Readonly<{
  status?: Status;
  waitingOn?: readonly WaitingOn[];
  severity?: Severity;
  waitClass?: StalenessWaitClass;
  statusSince?: UtcIsoDateTime;
  ownerSince?: UtcIsoDateTime;
  stallSince?: UtcIsoDateTime;
  lastProgressAt?: UtcIsoDateTime;
  createdAt?: UtcIsoDateTime;
  draftState?: DiscordNotificationItem["draftState"];
  repositoryFreshness?: DiscordNotificationItem["repositoryFreshness"];
  notificationClass?: DiscordNotificationItem["notificationClass"];
  notificationsSuppressedByLabel?: boolean;
  latestChange?: DiscordNotificationItem["latestChange"];
  decisionBasis?: DiscordNotificationItem["decisionBasis"];
  notificationRecommendation?: DiscordNotificationRecommendation;
  priorityWeight?: number;
  previous?: DiscordNotificationPrevious;
  downstreamOpenNodeCount?: number;
  downstreamRepositoryCount?: number;
  newlyUnblocked?: boolean;
  currentDependencyCycleIds?: readonly DependencyCycleId[];
  previousDependencyCycles?: DiscordNotificationItem["graph"]["previousDependencyCycles"];
}>;

function addHours(value: UtcIsoDateTime, hours: number): UtcIsoDateTime {
  return createUtcIsoDateTime(new Date(Date.parse(value) + hours * 60 * 60 * 1000).toISOString());
}

function markReservationsSent(
  entries: readonly NotificationLedgerEntry[],
  sentAt: UtcIsoDateTime,
): readonly NotificationLedgerEntry[] {
  return Object.freeze(
    entries.map((entry) => {
      if (entry.status !== "reserved") {
        throw new TypeError("送信済みへ変換するledger entryが予約ではありません");
      }
      return Object.freeze({
        notificationKey: entry.notificationKey,
        itemNodeId: entry.itemNodeId,
        reasonCode: entry.reasonCode,
        severity: entry.severity,
        reservedAt: entry.reservedAt,
        cooldownUntil: entry.cooldownUntil,
        status: "sent",
        sentAt,
        discordMessageId: `discord-message:${entry.notificationKey}`,
      } satisfies NotificationLedgerEntry);
    }),
  );
}

function createWaitingOn(kind: WaitingOnKind, candidateId: string, role: WaitingOnRole): WaitingOn {
  return Object.freeze({
    kind,
    candidateId,
    role,
    reasonSummary: "通知選別fixtureの待機根拠です",
    sourceIds: [buildSourceId("notification_fixture", candidateId)],
    confidence: 1,
  } satisfies WaitingOn);
}

function createPrevious(
  status: Status,
  waitingOn: readonly WaitingOn[],
  severity: Severity,
  stallSince: UtcIsoDateTime,
  observedAt: UtcIsoDateTime,
): DiscordNotificationPrevious {
  return Object.freeze({
    availability: "available",
    value: Object.freeze({
      status,
      waitingOn: Object.freeze([...waitingOn]),
      severity,
      stallSince,
      observedAt,
    }),
  });
}

function createItem(nodeIdValue: string, overrides: ItemOverrides): DiscordNotificationItem {
  const nodeId = createGitHubNodeId(nodeIdValue);
  const waitingOn = overrides.waitingOn ?? [createWaitingOn("role", "assignee", "assignee")];
  return Object.freeze({
    nodeId,
    createdAt: overrides.createdAt ?? CREATED_AT,
    draftState: overrides.draftState ?? "not_applicable",
    repositoryFreshness: overrides.repositoryFreshness ?? "fresh",
    notificationClass: overrides.notificationClass ?? "standard",
    notificationsSuppressedByLabel: overrides.notificationsSuppressedByLabel ?? false,
    latestChange: overrides.latestChange ?? "none",
    decisionBasis: overrides.decisionBasis ?? Object.freeze({ source: "deterministic" }),
    notificationRecommendation:
      overrides.notificationRecommendation ?? Object.freeze({ availability: "not_available" }),
    priorityWeight: overrides.priorityWeight ?? 0,
    current: Object.freeze({
      status: overrides.status ?? "in_progress",
      waitingOn: Object.freeze([...waitingOn]),
      severity: overrides.severity ?? "none",
      waitClass: overrides.waitClass ?? "work",
      statusSince: overrides.statusSince ?? CREATED_AT,
      ownerSince: overrides.ownerSince ?? CREATED_AT,
      stallSince: overrides.stallSince ?? CREATED_AT,
      lastProgressAt: overrides.lastProgressAt ?? CREATED_AT,
    }),
    previous: overrides.previous ?? Object.freeze({ availability: "not_available" }),
    graph: Object.freeze({
      downstreamImpact: Object.freeze({
        nodeId,
        openNodeCount: overrides.downstreamOpenNodeCount ?? 0,
        repositoryCount: overrides.downstreamRepositoryCount ?? 0,
      }),
      newlyUnblocked: overrides.newlyUnblocked ?? false,
      currentDependencyCycleIds: Object.freeze([...(overrides.currentDependencyCycleIds ?? [])]),
      previousDependencyCycles:
        overrides.previousDependencyCycles ??
        Object.freeze({
          availability: "available",
          cycleIds: Object.freeze([]),
        }),
    }),
  } satisfies DiscordNotificationItem);
}

function createInput(
  evaluatedAt: UtcIsoDateTime,
  items: readonly DiscordNotificationItem[],
  ledger: readonly NotificationLedgerEntry[],
  selectionSettings: DiscordNotificationSelectionSettings,
): SelectDiscordNotificationsInput {
  return Object.freeze({
    evaluatedAt,
    items: Object.freeze([...items]),
    ledger: Object.freeze([...ledger]),
    settings: selectionSettings,
  });
}

function candidateReasonCodes(
  selection: DiscordNotificationSelection,
): DiscordNotificationReasonCode[] {
  return selection.candidates.map((candidate) => candidate.reasonCode);
}

function selectedNodeIds(selection: DiscordNotificationSelection): GitHubNodeId[] {
  return selection.candidates.map((candidate) => candidate.itemNodeId);
}

function selectOne(item: DiscordNotificationItem): DiscordNotificationSelection {
  return selectDiscordNotifications(createInput(NOW, [item], [], settings));
}

const maintainer = createWaitingOn("role", "maintainer", "maintainer");
const unknownOwner = createWaitingOn("unknown", "unknown", "unknown");
const reviewer = createWaitingOn("role", "reviewer", "reviewer");
const author = createWaitingOn("role", "author", "author");
const respondent = createWaitingOn("user", "respondent", "respondent");
const mergeDecider = createWaitingOn("role", "merge_decider", "merge_decider");
const automation = createWaitingOn("automation", "required_checks", "ci");

describe("通知理由の抽出", () => {
  const cycleId = "dependency-cycle:cycle-a" satisfies DependencyCycleId;
  const responsibilityBefore = createWaitingOn("user", "previous-owner", "assignee");
  const responsibilityAfter = createWaitingOn("user", "current-owner", "assignee");
  const fixtures = [
    {
      reasonCode: "assessment_overdue",
      item: createItem("I_assessment", {
        status: "waiting_for_assessment",
        waitingOn: [maintainer],
        severity: "watch",
        waitClass: "assessment",
      }),
    },
    {
      reasonCode: "owner_overdue",
      item: createItem("I_owner", {
        status: "waiting_for_owner",
        waitingOn: [maintainer],
        severity: "watch",
        waitClass: "owner",
      }),
    },
    {
      reasonCode: "decision_overdue",
      item: createItem("I_decision", {
        status: "waiting_for_decision",
        waitingOn: [maintainer],
        severity: "watch",
        waitClass: "decision",
      }),
    },
    {
      reasonCode: "review_overdue",
      item: createItem("I_review", {
        status: "waiting_for_review",
        waitingOn: [reviewer],
        severity: "watch",
        waitClass: "review",
      }),
    },
    {
      reasonCode: "revision_overdue",
      item: createItem("I_revision", {
        status: "waiting_for_revision",
        waitingOn: [author],
        severity: "watch",
        waitClass: "revision",
      }),
    },
    {
      reasonCode: "reply_overdue",
      item: createItem("I_reply", {
        status: "waiting_for_reply",
        waitingOn: [respondent],
        severity: "watch",
        waitClass: "reply",
      }),
    },
    {
      reasonCode: "owner_unknown",
      item: createItem("I_owner_unknown", {
        status: "unknown",
        waitingOn: [unknownOwner],
        severity: "watch",
        waitClass: "owner",
      }),
    },
    {
      reasonCode: "blocker_overdue",
      item: createItem("I_blocker", {
        severity: "urgent",
        downstreamOpenNodeCount: 5,
        downstreamRepositoryCount: 3,
      }),
    },
    {
      reasonCode: "newly_unblocked",
      item: createItem("I_unblocked", {
        newlyUnblocked: true,
        priorityWeight: 25,
      }),
    },
    {
      reasonCode: "dependency_cycle",
      item: createItem("I_cycle", {
        currentDependencyCycleIds: [cycleId],
      }),
    },
    {
      reasonCode: "responsibility_changed",
      item: createItem("I_responsibility", {
        waitingOn: [responsibilityAfter],
        ownerSince: NOW,
        lastProgressAt: NOW,
        previous: createPrevious(
          "in_progress",
          [responsibilityBefore],
          "none",
          PREVIOUS_STALL_SINCE,
          PREVIOUS_OBSERVED_AT,
        ),
      }),
    },
    {
      reasonCode: "merge_overdue",
      item: createItem("I_merge", {
        status: "waiting_for_merge",
        waitingOn: [mergeDecider],
        severity: "watch",
        waitClass: "merge",
      }),
    },
    {
      reasonCode: "automation_stuck",
      item: createItem("I_automation_stuck", {
        status: "waiting_for_automation",
        waitingOn: [automation],
        severity: "watch",
        waitClass: "automation",
      }),
    },
  ] satisfies readonly {
    reasonCode: DiscordNotificationReasonCode;
    item: DiscordNotificationItem;
  }[];

  it.each(fixtures)("$reasonCodeを候補にする", ({ reasonCode, item }) => {
    const selection = selectOne(item);

    expect(selection.action).toBe("create_digest");
    expect(candidateReasonCodes(selection)).toEqual([reasonCode]);
    expect(selection.candidates[0]?.reasons.map((reason) => reason.reasonCode)).toContain(
      reasonCode,
    );
  });

  it.each([
    ["watch", "none"],
    ["urgent", "watch"],
    ["critical", "urgent"],
  ] satisfies readonly [Severity, Severity][])(
    "severityが%sへ初めて上がると候補にする",
    (severity, previousSeverity) => {
      const item = createItem(`I_threshold_${severity}`, {
        status: "waiting_for_assessment",
        waitingOn: [maintainer],
        severity,
        waitClass: "assessment",
        previous: createPrevious(
          "waiting_for_assessment",
          [maintainer],
          previousSeverity,
          CREATED_AT,
          PREVIOUS_OBSERVED_AT,
        ),
      });

      expect(candidateReasonCodes(selectOne(item))).toEqual(["assessment_overdue"]);
    },
  );

  it("低confidenceのAI-only判定でもowner unknown警告は残す", () => {
    const item = createItem("I_low_confidence_owner", {
      status: "unknown",
      waitingOn: [unknownOwner],
      severity: "watch",
      waitClass: "owner",
      decisionBasis: {
        source: "ai_only",
        confidence: 0.4,
      },
    });

    expect(candidateReasonCodes(selectOne(item))).toEqual(["owner_unknown"]);
  });

  it("同じ項目の複数理由を1候補にまとめて理由ごとにledger予約する", () => {
    const item = createItem("I_multiple_reasons", {
      status: "unknown",
      waitingOn: [unknownOwner],
      severity: "urgent",
      waitClass: "owner",
      downstreamOpenNodeCount: 4,
      downstreamRepositoryCount: 2,
    });
    const selection = selectOne(item);

    expect(selection.candidates).toHaveLength(1);
    expect(selection.candidates[0]?.reasons.map((reason) => reason.reasonCode)).toEqual([
      "blocker_overdue",
      "owner_unknown",
    ]);
    expect(selection.ledgerReservations).toHaveLength(2);
  });
});

describe("Codex通知提案の統合", () => {
  function createAvailableRecommendation(
    reasonCode: DiscordNotificationReasonCode,
    policy: "eligible" | "normal_priority_only",
  ): DiscordNotificationRecommendation {
    return Object.freeze({
      availability: "available",
      value: Object.freeze({
        recommended: true,
        reasonCode,
        reasonSummary: "検証済みCodex出力による通知提案です",
        policy,
        highPriorityEligible: policy === "eligible",
      }),
    });
  }

  it("高信頼recommendationがある場合だけ定式理由のない項目を候補にする", () => {
    const withoutRecommendation = createItem("I_without_recommendation", {});
    const withRecommendation = createItem("I_with_recommendation", {
      decisionBasis: {
        source: "ai_only",
        confidence: 0.95,
      },
      notificationRecommendation: createAvailableRecommendation("review_overdue", "eligible"),
    });

    expect(selectOne(withoutRecommendation).candidates).toEqual([]);
    expect(candidateReasonCodes(selectOne(withRecommendation))).toEqual(["review_overdue"]);
  });

  it("通知しないrecommendationでも定式ルールの候補を残す", () => {
    const item = createItem("I_deterministic_with_suppressed_recommendation", {
      status: "waiting_for_review",
      waitingOn: [reviewer],
      severity: "watch",
      waitClass: "review",
      notificationRecommendation: Object.freeze({
        availability: "available",
        value: Object.freeze({
          recommended: false,
          reasonCode: "none",
          reasonSummary: "Codexは通知を提案していません",
          policy: "suppressed",
          highPriorityEligible: false,
        }),
      }),
    });

    expect(candidateReasonCodes(selectOne(item))).toEqual(["review_overdue"]);
  });

  it("中信頼recommendationだけの候補を通常優先度に制限する", () => {
    const deterministicWatch = createItem("I_deterministic_watch", {
      status: "waiting_for_review",
      waitingOn: [reviewer],
      severity: "watch",
      waitClass: "review",
    });
    const mediumRecommendation = createItem("I_medium_recommendation", {
      severity: "critical",
      decisionBasis: {
        source: "ai_only",
        confidence: 0.7,
      },
      notificationRecommendation: createAvailableRecommendation(
        "assessment_overdue",
        "normal_priority_only",
      ),
    });
    const limitedSettings = Object.freeze({
      ...settings,
      maxItemsPerDigest: 1,
    });

    const selection = selectDiscordNotifications(
      createInput(NOW, [mediumRecommendation, deterministicWatch], [], limitedSettings),
    );

    expect(selectedNodeIds(selection)).toEqual([deterministicWatch.nodeId]);
  });

  it("低信頼で抑制されたrecommendationだけでは候補にしない", () => {
    const item = createItem("I_low_recommendation", {
      decisionBasis: {
        source: "ai_only",
        confidence: 0.649_999,
      },
      notificationRecommendation: Object.freeze({
        availability: "available",
        value: Object.freeze({
          recommended: false,
          reasonCode: "none",
          reasonSummary: "Codex判定のconfidenceが低いため抑制されました",
          policy: "suppressed",
          highPriorityEligible: false,
        }),
      }),
    });

    expect(selectOne(item).candidates).toEqual([]);
  });
});

describe("noise抑制", () => {
  const previousWatch = createPrevious(
    "waiting_for_review",
    [reviewer],
    "watch",
    CREATED_AT,
    PREVIOUS_OBSERVED_AT,
  );
  const recentDraftAt = addHours(NOW, -12);
  const noiseFixtures = [
    createItem("I_recent_progress", {
      status: "waiting_for_review",
      waitingOn: [reviewer],
      severity: "watch",
      waitClass: "review",
      lastProgressAt: NOW,
    }),
    createItem("I_bot_only", {
      status: "waiting_for_review",
      waitingOn: [reviewer],
      severity: "watch",
      waitClass: "review",
      latestChange: "bot_only",
    }),
    createItem("I_preview", {
      status: "waiting_for_review",
      waitingOn: [reviewer],
      severity: "watch",
      waitClass: "review",
      latestChange: "preview_update",
    }),
    createItem("I_renovate_update", {
      status: "waiting_for_review",
      waitingOn: [reviewer],
      severity: "watch",
      waitClass: "review",
      latestChange: "renovate_dashboard_update",
    }),
    createItem("I_unchanged_watch", {
      status: "waiting_for_review",
      waitingOn: [reviewer],
      severity: "watch",
      waitClass: "review",
      previous: previousWatch,
    }),
    createItem("I_recent_draft", {
      status: "waiting_for_review",
      waitingOn: [reviewer],
      severity: "watch",
      waitClass: "review",
      createdAt: recentDraftAt,
      statusSince: recentDraftAt,
      ownerSince: recentDraftAt,
      stallSince: recentDraftAt,
      lastProgressAt: recentDraftAt,
      draftState: "draft",
    }),
    createItem("I_low_confidence_ai", {
      status: "waiting_for_review",
      waitingOn: [reviewer],
      severity: "watch",
      waitClass: "review",
      decisionBasis: {
        source: "ai_only",
        confidence: 0.649_999,
      },
    }),
    createItem("I_suppression_label", {
      status: "waiting_for_review",
      waitingOn: [reviewer],
      severity: "watch",
      waitClass: "review",
      notificationsSuppressedByLabel: true,
    }),
    createItem("I_stale_repository", {
      status: "waiting_for_review",
      waitingOn: [reviewer],
      severity: "watch",
      waitClass: "review",
      repositoryFreshness: "stale",
    }),
    createItem("I_automation_dashboard", {
      status: "waiting_for_review",
      waitingOn: [reviewer],
      severity: "watch",
      waitClass: "review",
      notificationClass: "automation_noise",
    }),
  ];

  it.each(noiseFixtures)("$nodeIdを候補から除外する", (item) => {
    const selection = selectOne(item);

    expect(selection).toMatchObject({
      action: "skip_digest",
      reason: "no_candidates",
      candidates: [],
      ledgerReservations: [],
    });
  });

  it("依存解消と責務遷移は直近の意味ある進捗があっても候補にする", () => {
    const newlyUnblocked = createItem("I_recent_unblocked", {
      newlyUnblocked: true,
      priorityWeight: 25,
      lastProgressAt: NOW,
    });
    const responsibilityChanged = createItem("I_recent_responsibility", {
      waitingOn: [createWaitingOn("user", "next-owner", "assignee")],
      ownerSince: NOW,
      lastProgressAt: NOW,
      previous: createPrevious(
        "in_progress",
        [createWaitingOn("user", "old-owner", "assignee")],
        "none",
        PREVIOUS_STALL_SINCE,
        PREVIOUS_OBSERVED_AT,
      ),
    });

    const selection = selectDiscordNotifications(
      createInput(NOW, [newlyUnblocked, responsibilityChanged], [], settings),
    );

    expect(candidateReasonCodes(selection).sort()).toEqual([
      "newly_unblocked",
      "responsibility_changed",
    ]);
  });
});

describe("順位と件数上限", () => {
  it("通常50件と要対応3件から要対応だけを上限内で選ぶ", () => {
    const ordinaryItems = Array.from({ length: 50 }, (_, index) =>
      createItem(`I_ordinary_${index.toString().padStart(2, "0")}`, {}),
    );
    const attentionItems = [
      createItem("I_attention_review", {
        status: "waiting_for_review",
        waitingOn: [reviewer],
        severity: "urgent",
        waitClass: "review",
      }),
      createItem("I_attention_owner", {
        status: "unknown",
        waitingOn: [unknownOwner],
        severity: "critical",
        waitClass: "owner",
      }),
      createItem("I_attention_cycle", {
        currentDependencyCycleIds: ["dependency-cycle:attention-cycle" satisfies DependencyCycleId],
      }),
    ];

    const selection = selectDiscordNotifications(
      createInput(NOW, [...ordinaryItems, ...attentionItems], [], settings),
    );

    expect(selection.candidates).toHaveLength(3);
    expect(new Set(selectedNodeIds(selection))).toEqual(
      new Set(attentionItems.map((item) => item.nodeId)),
    );
    expect(selection.candidates.length).toBeLessThanOrEqual(settings.maxItemsPerDigest);
  });

  it("critical、cycle、urgentの順で設定上限まで選ぶ", () => {
    const limitedSettings = Object.freeze({
      ...settings,
      maxItemsPerDigest: 2,
    });
    const urgent = createItem("I_rank_urgent", {
      status: "waiting_for_review",
      waitingOn: [reviewer],
      severity: "urgent",
      waitClass: "review",
    });
    const cycle = createItem("I_rank_cycle", {
      currentDependencyCycleIds: ["dependency-cycle:rank-cycle" satisfies DependencyCycleId],
    });
    const critical = createItem("I_rank_critical", {
      status: "waiting_for_review",
      waitingOn: [reviewer],
      severity: "critical",
      waitClass: "review",
    });

    const selection = selectDiscordNotifications(
      createInput(NOW, [urgent, cycle, critical], [], limitedSettings),
    );

    expect(selectedNodeIds(selection)).toEqual([critical.nodeId, cycle.nodeId]);
  });

  it("同じseverityのblockerではdownstream impactが大きい項目を優先する", () => {
    const limitedSettings = Object.freeze({
      ...settings,
      maxItemsPerDigest: 1,
    });
    const smallImpact = createItem("I_small_blocker", {
      severity: "urgent",
      downstreamOpenNodeCount: 2,
      downstreamRepositoryCount: 1,
    });
    const largeImpact = createItem("I_large_blocker", {
      severity: "urgent",
      downstreamOpenNodeCount: 8,
      downstreamRepositoryCount: 4,
    });

    const selection = selectDiscordNotifications(
      createInput(NOW, [smallImpact, largeImpact], [], limitedSettings),
    );

    expect(selectedNodeIds(selection)).toEqual([largeImpact.nodeId]);
    expect(candidateReasonCodes(selection)).toEqual(["blocker_overdue"]);
  });

  it("blocked親自身は催促せずblockerだけを候補にする", () => {
    const blockedParent = createItem("I_blocked_parent", {
      status: "waiting_for_unblock",
      waitingOn: [createWaitingOn("item", "I_actual_blocker", "dependency")],
      severity: "none",
      waitClass: "blockedParent",
      previous: createPrevious(
        "waiting_for_unblock",
        [createWaitingOn("item", "I_actual_blocker", "dependency")],
        "none",
        CREATED_AT,
        PREVIOUS_OBSERVED_AT,
      ),
    });
    const blocker = createItem("I_actual_blocker", {
      severity: "urgent",
      downstreamOpenNodeCount: 6,
      downstreamRepositoryCount: 3,
    });

    const selection = selectDiscordNotifications(
      createInput(NOW, [blockedParent, blocker], [], settings),
    );

    expect(selectedNodeIds(selection)).toEqual([blocker.nodeId]);
  });
});

describe("ledgerとcooldown", () => {
  function overdueItem(previousSeverity: Severity): DiscordNotificationItem {
    return createItem("I_cooldown", {
      status: "waiting_for_review",
      waitingOn: [reviewer],
      severity: "urgent",
      waitClass: "review",
      previous: createPrevious(
        "waiting_for_review",
        [reviewer],
        previousSeverity,
        CREATED_AT,
        PREVIOUS_OBSERVED_AT,
      ),
    });
  }

  it("同日再実行を抑え、unchanged urgentを3日ごとに候補へ戻す", () => {
    const first = selectDiscordNotifications(
      createInput(NOW, [overdueItem("watch")], [], settings),
    );
    expect(first.action).toBe("create_digest");
    const sentLedger = markReservationsSent(first.ledgerReservations, NOW);
    const sameDay = selectDiscordNotifications(
      createInput(addHours(NOW, 1), [overdueItem("urgent")], sentLedger, settings),
    );
    const nextDay = selectDiscordNotifications(
      createInput(addHours(NOW, 24), [overdueItem("urgent")], sentLedger, settings),
    );
    const cooldownBoundary = selectDiscordNotifications(
      createInput(addHours(NOW, 72), [overdueItem("urgent")], sentLedger, settings),
    );

    expect(sameDay.action).toBe("skip_digest");
    expect(nextDay.action).toBe("skip_digest");
    expect(cooldownBoundary.action).toBe("create_digest");
    expect(first.ledgerReservations[0]?.cooldownUntil).toBe(addHours(NOW, 72));
  });

  it("unchanged criticalへ設定した2日のcooldownを使う", () => {
    const criticalItem = createItem("I_critical_cooldown", {
      status: "unknown",
      waitingOn: [unknownOwner],
      severity: "critical",
      waitClass: "owner",
      previous: createPrevious(
        "unknown",
        [unknownOwner],
        "urgent",
        CREATED_AT,
        PREVIOUS_OBSERVED_AT,
      ),
    });
    const unchangedCritical = createItem("I_critical_cooldown", {
      status: "unknown",
      waitingOn: [unknownOwner],
      severity: "critical",
      waitClass: "owner",
      previous: createPrevious(
        "unknown",
        [unknownOwner],
        "critical",
        CREATED_AT,
        PREVIOUS_OBSERVED_AT,
      ),
    });
    const first = selectDiscordNotifications(createInput(NOW, [criticalItem], [], settings));
    const sentLedger = markReservationsSent(first.ledgerReservations, NOW);
    const beforeBoundary = selectDiscordNotifications(
      createInput(addHours(NOW, 47), [unchangedCritical], sentLedger, settings),
    );
    const boundary = selectDiscordNotifications(
      createInput(addHours(NOW, 48), [unchangedCritical], sentLedger, settings),
    );

    expect(first.ledgerReservations[0]?.cooldownUntil).toBe(addHours(NOW, 48));
    expect(beforeBoundary.action).toBe("skip_digest");
    expect(boundary.action).toBe("create_digest");
  });

  it("連日実行と各日の再実行でurgentを0日目、3日目、6日目だけ選ぶ", () => {
    let ledger: readonly NotificationLedgerEntry[] = [];
    const notifiedDays: number[] = [];
    for (let day = 0; day <= 6; day += 1) {
      const evaluatedAt = addHours(NOW, day * 24);
      const daily = selectDiscordNotifications(
        createInput(evaluatedAt, [overdueItem(day === 0 ? "watch" : "urgent")], ledger, settings),
      );
      if (daily.action === "create_digest") {
        notifiedDays.push(day);
        ledger = markReservationsSent(daily.ledgerReservations, evaluatedAt);
      }
      const rerun = selectDiscordNotifications(
        createInput(evaluatedAt, [overdueItem("urgent")], ledger, settings),
      );
      expect(rerun.action).toBe("skip_digest");
    }

    expect(notifiedDays).toEqual([0, 3, 6]);
  });

  it("cooldownが0日でも同日の重複だけは抑える", () => {
    const noCooldownSettings = Object.freeze({
      ...settings,
      cooldownDays: Object.freeze({
        urgent: 0,
        critical: 0,
      }),
    });
    const first = selectDiscordNotifications(
      createInput(NOW, [overdueItem("watch")], [], noCooldownSettings),
    );
    const sentLedger = markReservationsSent(first.ledgerReservations, NOW);
    const rerun = selectDiscordNotifications(
      createInput(addHours(NOW, 12), [overdueItem("urgent")], sentLedger, noCooldownSettings),
    );

    expect(first.action).toBe("create_digest");
    expect(rerun.action).toBe("skip_digest");
  });

  it("reservedは24時間だけ抑制し、期限切れ後は再送しない理由も候補へ戻す", () => {
    const item = createItem("I_expired_reservation", {
      newlyUnblocked: true,
      priorityWeight: 25,
    });
    const first = selectDiscordNotifications(createInput(NOW, [item], [], settings));
    const beforeExpiry = selectDiscordNotifications(
      createInput(addHours(NOW, 23), [item], first.ledgerReservations, settings),
    );
    const atExpiry = selectDiscordNotifications(
      createInput(addHours(NOW, 24), [item], first.ledgerReservations, settings),
    );

    expect(first.ledgerReservations[0]).toMatchObject({
      status: "reserved",
      expiresAt: addHours(NOW, 24),
    });
    expect(beforeExpiry.action).toBe("skip_digest");
    expect(atExpiry.action).toBe("create_digest");
  });
});

describe("空digestとautomation追跡分離", () => {
  it("候補0件ではdigest作成とledger予約を行わない", () => {
    const selection = selectDiscordNotifications(
      createInput(NOW, [createItem("I_no_candidate", {})], [], settings),
    );

    expect(selection).toEqual({
      action: "skip_digest",
      reason: "no_candidates",
      candidates: [],
      ledgerReservations: [],
    });
  });

  it("automation dashboardをgraphに残しつつ既定digestから除外する", () => {
    const automationItem = createItem("I_graph_automation", {
      status: "waiting_for_review",
      waitingOn: [reviewer],
      severity: "critical",
      waitClass: "review",
      notificationClass: "automation_noise",
      latestChange: "renovate_dashboard_update",
    });
    const graphNode = Object.freeze({
      kind: "issue",
      nodeId: automationItem.nodeId,
      repositoryId: createGitHubRepositoryId("R_automation"),
      state: "open",
      directNotification: "eligible",
    } satisfies TrackedGraphAnalysisNode);
    const graph = analyzeGraph({
      current: {
        nodes: [graphNode],
        edges: [],
      },
      previous: {
        availability: "unavailable",
      },
    });

    const selection = selectOne(automationItem);

    expect(graph.actionableFrontier).toEqual([automationItem.nodeId]);
    expect(selection.action).toBe("skip_digest");
  });

  it("同じ入力から同じ候補とledger予約を返す", () => {
    const item = createItem("I_deterministic", {
      status: "waiting_for_review",
      waitingOn: [reviewer],
      severity: "urgent",
      waitClass: "review",
    });
    const input = createInput(NOW, [item], [], settings);

    expect(selectDiscordNotifications(input)).toEqual(selectDiscordNotifications(input));
  });
});
