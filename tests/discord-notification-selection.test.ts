import { describe, expect, it } from "vitest";

import {
  buildSourceId,
  createGitHubNodeId,
  createUtcIsoDateTime,
  type NotificationReasonCode,
  type Severity,
  type SourceId,
  type Status,
  type UtcIsoDateTime,
  type WaitingOn,
  type WaitingOnKind,
  type WaitingOnRole,
} from "../src/domain/index.js";
import {
  selectDiscordNotifications,
  type DiscordNotificationDecisionBasis,
  type DiscordNotificationEvent,
  type DiscordNotificationItem,
  type DiscordNotificationLatestChange,
  type DiscordNotificationReasonCode,
  type DiscordNotificationRecommendation,
  type DiscordNotificationSelection,
  type DiscordNotificationSelectionSettings,
  type NormalDigestRunContext,
} from "../src/discord/index.js";
import { type DependencyCycleId } from "../src/graph/index.js";

const REFERENCE_AT = createUtcIsoDateTime("2026-08-10T23:00:00.000Z");
const CREATED_AT = createUtcIsoDateTime("2026-08-01T00:00:00.000Z");
const CYCLE_ID = "dependency-cycle:cycle-a" satisfies DependencyCycleId;
const THRESHOLDS = Object.freeze({
  assessment: Object.freeze({ watch: 48, urgent: 96, critical: 168 }),
  owner: Object.freeze({ watch: 48, urgent: 96, critical: 168 }),
  decision: Object.freeze({ watch: 48, urgent: 96, critical: 168 }),
  review: Object.freeze({ watch: 48, urgent: 120, critical: 240 }),
  revision: Object.freeze({ watch: 72, urgent: 168, critical: 336 }),
  reply: Object.freeze({ watch: 48, urgent: 120, critical: 240 }),
  work: Object.freeze({ watch: 168, urgent: 336, critical: 720 }),
  merge: Object.freeze({ watch: 24, urgent: 72, critical: 168 }),
  automation: Object.freeze({ watch: 6, urgent: 24, critical: 72 }),
});
const SETTINGS = Object.freeze({
  maxItemsPerDigest: 10,
  repeatDays: Object.freeze({ urgent: 3, critical: 2 }),
  recentProgressGraceHours: 24,
  minimumAiConfidence: 0.65,
  severityThresholds: THRESHOLDS,
}) satisfies DiscordNotificationSelectionSettings;

type ItemOverrides = Readonly<{
  createdAt?: UtcIsoDateTime;
  status?: Status;
  waitingOn?: readonly WaitingOn[];
  severity?: Severity;
  waitClass?: DiscordNotificationItem["current"]["waitClass"];
  statusSince?: UtcIsoDateTime;
  ownerSince?: UtcIsoDateTime;
  stallSince?: UtcIsoDateTime;
  lastProgressAt?: UtcIsoDateTime;
  draftState?: DiscordNotificationItem["draftState"];
  repositoryFreshness?: DiscordNotificationItem["repositoryFreshness"];
  notificationClass?: DiscordNotificationItem["notificationClass"];
  notificationsSuppressedByLabel?: boolean;
  latestChange?: DiscordNotificationLatestChange;
  decisionBasis?: DiscordNotificationDecisionBasis;
  recommendation?: DiscordNotificationRecommendation;
  priorityWeight?: number;
  events?: readonly DiscordNotificationEvent[];
  dependencyCycles?: DiscordNotificationItem["graph"]["dependencyCycles"];
  downstreamOpenNodeCount?: number;
  downstreamRepositoryCount?: number;
}>;

function waitingOn(kind: WaitingOnKind, candidateId: string, role: WaitingOnRole): WaitingOn {
  const sourceId = buildSourceId("notification_fixture", candidateId);
  const sourceIds: readonly [SourceId, ...SourceId[]] = [sourceId];
  return Object.freeze({
    kind,
    candidateId,
    role,
    reasonSummary: "通知fixtureの待機根拠です",
    sourceIds,
    confidence: 1,
  });
}

function addHours(value: UtcIsoDateTime, hours: number): UtcIsoDateTime {
  return createUtcIsoDateTime(new Date(Date.parse(value) + hours * 60 * 60 * 1000).toISOString());
}

function createItem(nodeIdValue: string, overrides: ItemOverrides): DiscordNotificationItem {
  const nodeId = createGitHubNodeId(nodeIdValue);
  const createdAt = overrides.createdAt ?? CREATED_AT;
  const status = overrides.status ?? "waiting_for_review";
  const currentWaitingOn =
    overrides.waitingOn ??
    (status.startsWith("terminal_") ? [] : [waitingOn("user", "reviewer", "reviewer")]);
  return Object.freeze({
    nodeId,
    createdAt,
    draftState: overrides.draftState ?? "not_applicable",
    repositoryFreshness: overrides.repositoryFreshness ?? "fresh",
    notificationClass: overrides.notificationClass ?? "standard",
    notificationsSuppressedByLabel: overrides.notificationsSuppressedByLabel ?? false,
    latestChange: overrides.latestChange ?? "none",
    decisionBasis:
      overrides.decisionBasis ??
      ({ source: "deterministic" } satisfies DiscordNotificationDecisionBasis),
    notificationRecommendation:
      overrides.recommendation ??
      ({ availability: "not_available" } satisfies DiscordNotificationRecommendation),
    priorityWeight: overrides.priorityWeight ?? 0,
    current: {
      status,
      waitingOn: currentWaitingOn,
      severity: overrides.severity ?? "none",
      waitClass: overrides.waitClass ?? "review",
      statusSince: overrides.statusSince ?? createdAt,
      ownerSince: overrides.ownerSince ?? createdAt,
      stallSince: overrides.stallSince ?? createdAt,
      lastProgressAt: overrides.lastProgressAt ?? createdAt,
    },
    events: overrides.events ?? [],
    graph: {
      downstreamImpact: {
        nodeId,
        openNodeCount: overrides.downstreamOpenNodeCount ?? 0,
        repositoryCount: overrides.downstreamRepositoryCount ?? 0,
      },
      dependencyCycles: overrides.dependencyCycles ?? [],
    },
  });
}

function overdueItem(
  nodeId: string,
  severity: Extract<Severity, "urgent" | "critical">,
  waitClass: DiscordNotificationItem["current"]["waitClass"],
  overrides: ItemOverrides,
): DiscordNotificationItem {
  if (waitClass === "blockedParent" || waitClass === "notApplicable") {
    throw new TypeError("停滞通知fixtureに対応しないwaitClassです");
  }
  const thresholdHours = THRESHOLDS[waitClass][severity];
  const stallSince = createUtcIsoDateTime(
    new Date(Date.parse(REFERENCE_AT) - thresholdHours * 60 * 60 * 1000).toISOString(),
  );
  return createItem(nodeId, {
    ...overrides,
    severity,
    waitClass,
    stallSince: overrides.stallSince ?? stallSince,
    lastProgressAt: overrides.lastProgressAt ?? addHours(stallSince, -1),
  });
}

function recommendation(
  recommended: boolean,
  reasonCode: NotificationReasonCode,
  policy: "eligible" | "normal_priority_only" | "suppressed",
  highPriorityEligible: boolean,
): DiscordNotificationRecommendation {
  return Object.freeze({
    availability: "available",
    value: Object.freeze({
      recommended,
      reasonCode,
      reasonSummary: "検証済みCodex出力による通知提案です",
      policy,
      highPriorityEligible,
    }),
  });
}

function select(
  items: readonly DiscordNotificationItem[],
  referenceAt: UtcIsoDateTime,
  settings: DiscordNotificationSelectionSettings,
): DiscordNotificationSelection {
  return selectDiscordNotifications({
    referenceAt,
    runContext: {
      eventName: "schedule",
      runAttempt: 1,
      scheduledFor: referenceAt,
    },
    items,
    settings,
  });
}

function candidateReasonCodes(selection: DiscordNotificationSelection): readonly string[] {
  return selection.candidates.map((candidate) => candidate.reasonCode);
}

function selectedNodeIds(selection: DiscordNotificationSelection): readonly string[] {
  return selection.candidates.map((candidate) => candidate.itemNodeId);
}

function aiEvent(reasonCode: DiscordNotificationReasonCode): DiscordNotificationEvent {
  return {
    kind: "ai_notification",
    reasonCode,
    occurredAt: createUtcIsoDateTime("2026-08-10T22:00:00.000Z"),
  };
}

describe("Discord notification selection", () => {
  it("前回状態とledgerを入力せず決定論的に同じ結果を返す", () => {
    const item = overdueItem("I_deterministic", "urgent", "review", {});
    expect(select([item], REFERENCE_AT, SETTINGS)).toEqual(select([item], REFERENCE_AT, SETTINGS));
  });

  it("deterministicな理由をreason codeごとに抽出する", () => {
    const cases = [
      ["assessment_overdue", "waiting_for_assessment", "assessment"],
      ["owner_overdue", "waiting_for_owner", "owner"],
      ["decision_overdue", "waiting_for_decision", "decision"],
      ["review_overdue", "waiting_for_review", "review"],
      ["revision_overdue", "waiting_for_revision", "revision"],
      ["reply_overdue", "waiting_for_reply", "reply"],
      ["merge_overdue", "waiting_for_merge", "merge"],
      ["automation_stuck", "waiting_for_automation", "automation"],
    ] satisfies readonly [
      NotificationReasonCode,
      Status,
      DiscordNotificationItem["current"]["waitClass"],
    ][];
    for (const [reasonCode, status, waitClass] of cases) {
      const item = overdueItem(`I_${reasonCode}`, "urgent", waitClass, {
        status,
        waitingOn: [waitingOn("role", "reviewer", "reviewer")],
      });
      expect(candidateReasonCodes(select([item], REFERENCE_AT, SETTINGS))).toEqual([reasonCode]);
    }
  });

  it("低confidenceのAI-only判定でもowner_unknown警告を残す", () => {
    const item = overdueItem("I_low_confidence_owner", "urgent", "owner", {
      status: "unknown",
      waitingOn: [waitingOn("unknown", "unknown", "unknown")],
      decisionBasis: {
        source: "ai_only",
        confidence: 0.4,
      },
    });
    expect(candidateReasonCodes(select([item], REFERENCE_AT, SETTINGS))).toEqual(["owner_unknown"]);
  });

  it("高confidence recommendationのAI理由を候補にする", () => {
    const item = createItem("I_high_recommendation", {
      decisionBasis: { source: "ai_only", confidence: 0.95 },
      recommendation: recommendation(true, "review_overdue", "eligible", true),
      events: [aiEvent("review_overdue")],
    });
    expect(candidateReasonCodes(select([item], REFERENCE_AT, SETTINGS))).toEqual([
      "review_overdue",
    ]);
  });

  it("中confidence recommendationは通常優先度へ制限する", () => {
    const medium = createItem("I_medium_recommendation", {
      decisionBasis: { source: "ai_only", confidence: 0.7 },
      recommendation: recommendation(true, "review_overdue", "normal_priority_only", false),
      events: [aiEvent("review_overdue")],
    });
    const deterministic = overdueItem("I_deterministic_watch", "urgent", "review", {});
    const settings = Object.freeze({ ...SETTINGS, maxItemsPerDigest: 1 });
    expect(selectedNodeIds(select([medium, deterministic], REFERENCE_AT, settings))).toEqual([
      deterministic.nodeId,
    ]);
  });

  it("低confidence recommendationだけでは候補にしない", () => {
    const item = createItem("I_low_recommendation", {
      decisionBasis: { source: "ai_only", confidence: 0.649_999 },
      recommendation: recommendation(true, "review_overdue", "eligible", true),
      events: [aiEvent("review_overdue")],
    });
    expect(select([item], REFERENCE_AT, SETTINGS)).toEqual({
      action: "skip_digest",
      reason: "no_candidates",
      candidates: [],
    });
  });

  it("recommended=falseでもdeterministic理由を残す", () => {
    const item = overdueItem("I_suppressed_recommendation", "urgent", "review", {
      recommendation: recommendation(false, "none", "suppressed", false),
    });
    expect(candidateReasonCodes(select([item], REFERENCE_AT, SETTINGS))).toEqual([
      "review_overdue",
    ]);
  });

  it("一回限りイベントはrecent progressで抑止しない", () => {
    const item = createItem("I_recent_event", {
      lastProgressAt: REFERENCE_AT,
      priorityWeight: 1,
      events: [
        {
          kind: "newly_unblocked",
          occurredAt: createUtcIsoDateTime("2026-08-10T22:59:59.999Z"),
        },
      ],
    });
    expect(candidateReasonCodes(select([item], REFERENCE_AT, SETTINGS))).toEqual([
      "newly_unblocked",
    ]);
  });

  it("waitingOn変更、cycle、検証済みAI理由を優先順位付きで選ぶ", () => {
    const item = createItem("I_multiple_reasons", {
      events: [
        {
          kind: "responsibility_changed",
          occurredAt: createUtcIsoDateTime("2026-08-10T20:00:00.000Z"),
        },
        aiEvent("owner_overdue"),
      ],
      dependencyCycles: [
        {
          cycleId: CYCLE_ID,
          occurredAt: createUtcIsoDateTime("2026-08-10T22:00:00.000Z"),
        },
      ],
      recommendation: recommendation(true, "owner_overdue", "eligible", true),
    });
    const selection = select([item], REFERENCE_AT, SETTINGS);
    expect(selection.action).toBe("create_digest");
    if (selection.action === "create_digest") {
      const candidate = selection.candidates[0];
      expect(candidate.reasons.map((reason) => reason.reasonCode)).toEqual([
        "dependency_cycle",
        "responsibility_changed",
        "owner_overdue",
      ]);
    }
  });

  it("critical、cycle、urgentの順で候補上限まで選ぶ", () => {
    const settings = Object.freeze({ ...SETTINGS, maxItemsPerDigest: 3 });
    const critical = overdueItem("I_rank_critical", "critical", "review", {
      createdAt: createUtcIsoDateTime("2026-07-01T00:00:00.000Z"),
    });
    const cycle = createItem("I_rank_cycle", {
      events: [
        {
          kind: "dependency_cycle",
          cycleId: CYCLE_ID,
          occurredAt: createUtcIsoDateTime("2026-08-10T22:00:00.000Z"),
        },
      ],
    });
    const urgent = overdueItem("I_rank_urgent", "urgent", "review", {});
    expect(selectedNodeIds(select([urgent, cycle, critical], REFERENCE_AT, settings))).toEqual([
      critical.nodeId,
      cycle.nodeId,
      urgent.nodeId,
    ]);
  });

  it("同じseverityではdownstream impactが大きい項目を優先する", () => {
    const settings = Object.freeze({ ...SETTINGS, maxItemsPerDigest: 1 });
    const small = overdueItem("I_small_impact", "urgent", "review", {
      downstreamOpenNodeCount: 2,
      downstreamRepositoryCount: 1,
    });
    const large = overdueItem("I_large_impact", "urgent", "review", {
      downstreamOpenNodeCount: 8,
      downstreamRepositoryCount: 4,
    });
    expect(selectedNodeIds(select([small, large], REFERENCE_AT, settings))).toEqual([large.nodeId]);
  });

  it("候補上限を超えた項目を決定論的に切り捨てる", () => {
    const settings = Object.freeze({ ...SETTINGS, maxItemsPerDigest: 2 });
    const items = [
      overdueItem("I_cap_1", "urgent", "review", {}),
      overdueItem("I_cap_2", "urgent", "review", {}),
      overdueItem("I_cap_3", "urgent", "review", {}),
    ];
    const selection = select(items, REFERENCE_AT, settings);
    expect(selection.action).toBe("create_digest");
    if (selection.action === "create_digest") {
      expect(selection.candidates).toHaveLength(2);
      expect(selection.candidates.length).toBeLessThanOrEqual(settings.maxItemsPerDigest);
    }
  });

  it("blockedParent自身を催促せずblockerだけを候補にする", () => {
    const parent = createItem("I_blocked_parent", {
      status: "waiting_for_unblock",
      waitingOn: [waitingOn("item", "I_actual_blocker", "dependency")],
      waitClass: "blockedParent",
    });
    const blocker = overdueItem("I_actual_blocker", "urgent", "review", {
      downstreamOpenNodeCount: 6,
      downstreamRepositoryCount: 3,
    });
    expect(selectedNodeIds(select([parent, blocker], REFERENCE_AT, SETTINGS))).toEqual([
      blocker.nodeId,
    ]);
  });

  it("stale、label、automation、recent draft、bot-onlyを抑止する", () => {
    const recentDraftAt = createUtcIsoDateTime("2026-08-10T12:00:00.000Z");
    const items = [
      overdueItem("I_stale", "urgent", "review", { repositoryFreshness: "stale" }),
      overdueItem("I_label", "urgent", "review", { notificationsSuppressedByLabel: true }),
      overdueItem("I_automation", "urgent", "review", { notificationClass: "automation_noise" }),
      overdueItem("I_bot_only", "urgent", "review", { latestChange: "bot_only" }),
      createItem("I_recent_draft", {
        createdAt: recentDraftAt,
        draftState: "draft",
        severity: "urgent",
        waitClass: "review",
      }),
    ];
    expect(select(items, REFERENCE_AT, SETTINGS)).toEqual({
      action: "skip_digest",
      reason: "no_candidates",
      candidates: [],
    });
  });

  it("候補0件ではdigestを作成しない", () => {
    expect(select([createItem("I_none", {})], REFERENCE_AT, SETTINGS)).toEqual({
      action: "skip_digest",
      reason: "no_candidates",
      candidates: [],
    });
  });

  it("repeatDaysに0日を指定した選別入力を拒否する", () => {
    const settings = Object.freeze({
      ...SETTINGS,
      repeatDays: Object.freeze({ urgent: 0, critical: 2 }),
    });
    expect(() =>
      select([overdueItem("I_invalid_repeat", "urgent", "review", {})], REFERENCE_AT, settings),
    ).toThrow("urgent repeat日数");
  });

  it("scheduleの初回だけを許可しmanualとrerunを抑止する", () => {
    const item = createItem("I_manual", {
      priorityWeight: 1,
      events: [
        {
          kind: "newly_unblocked",
          occurredAt: createUtcIsoDateTime("2026-08-10T22:00:00.000Z"),
        },
      ],
    });
    const manualContext: NormalDigestRunContext = {
      eventName: "workflow_dispatch",
      runAttempt: 1,
    };
    const rerunContext: NormalDigestRunContext = {
      eventName: "schedule",
      runAttempt: 2,
      scheduledFor: REFERENCE_AT,
    };
    expect(
      selectDiscordNotifications({
        referenceAt: REFERENCE_AT,
        runContext: manualContext,
        items: [item],
        settings: SETTINGS,
      }),
    ).toMatchObject({ action: "skip_digest", reason: "manual" });
    expect(
      selectDiscordNotifications({
        referenceAt: REFERENCE_AT,
        runContext: rerunContext,
        items: [item],
        settings: SETTINGS,
      }),
    ).toMatchObject({ action: "skip_digest", reason: "rerun" });
  });
});
