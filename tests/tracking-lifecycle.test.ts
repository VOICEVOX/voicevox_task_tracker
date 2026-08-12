import { describe, expect, it } from "vitest";

import {
  DEFAULT_TERMINAL_RETENTION_DAYS,
  buildSourceId,
  classifyTrackingNotification,
  createExternalReferenceNodeId,
  createGitHubNodeId,
  createLabelEffectsResolver,
  createUtcIsoDateTime,
  determineDefaultDigestDecision,
  determineMeaningfulProgress,
  determineTerminalRetention,
  determineTrackedItemWork,
  selectTrackingItems,
  type ExternalPublicTrackingCandidate,
  type DetermineTrackedItemWorkInput,
  type GitHubAccountActor,
  type GitHubItemUrl,
  type NormalizedEvent,
  type OrganizationTrackingCandidate,
  type RetentionItemState,
  type SelectTrackingItemsInput,
  type TrackingActivity,
  type TrackingAutoIncludeSettings,
  type TrackingCandidate,
  type TrackingConnection,
  type UtcIsoDateTime,
} from "../src/domain/index.js";

const START_AT = createUtcIsoDateTime("2026-07-01T00:00:00Z");
const EVALUATED_AT = createUtcIsoDateTime("2026-08-01T00:00:00Z");
const OLD_CREATED_AT = createUtcIsoDateTime("2026-01-01T00:00:00Z");
const NO_AUTO_INCLUDE = Object.freeze({
  createdAfterStart: false,
  changedAfterStart: false,
  referencedByTracked: false,
  referencesTracked: false,
  nativeRelations: false,
  relationDepth: 0,
} satisfies TrackingAutoIncludeSettings);

type OrganizationCandidateOptions = Readonly<{
  nodeId: string;
  repositoryFullName: string;
  number: number;
  createdAt: UtcIsoDateTime;
  activity: TrackingActivity;
  authorType: OrganizationTrackingCandidate["authorType"];
  notificationClass: OrganizationTrackingCandidate["notificationClass"];
  itemState: RetentionItemState;
}>;

function createItemUrl(repositoryFullName: string, number: number): GitHubItemUrl {
  return `https://github.com/${repositoryFullName}/issues/${number.toString()}`;
}

function createActivity(
  lastHumanActivityAt: UtcIsoDateTime,
  lastProgressAt: UtcIsoDateTime,
): TrackingActivity {
  return Object.freeze({
    lastHumanActivityAt,
    lastProgressAt,
  });
}

function createOrganizationCandidate(
  options: OrganizationCandidateOptions,
): OrganizationTrackingCandidate {
  const fields = {
    scope: "organization",
    nodeId: createGitHubNodeId(options.nodeId),
    repositoryFullName: options.repositoryFullName,
    number: options.number,
    url: createItemUrl(options.repositoryFullName, options.number),
    title: `追跡候補${options.number.toString()}`,
    createdAt: options.createdAt,
    activity: options.activity,
    authorType: options.authorType,
    notificationClass: options.notificationClass,
  } satisfies Omit<OrganizationTrackingCandidate, keyof RetentionItemState>;
  if (options.itemState.state === "open") {
    return Object.freeze({
      ...fields,
      state: "open",
    });
  }
  return Object.freeze({
    ...fields,
    state: options.itemState.state,
    terminalAt: options.itemState.terminalAt,
  });
}

function createOpenCandidate(
  nodeId: string,
  repositoryFullName: string,
  number: number,
  createdAt: UtcIsoDateTime,
): OrganizationTrackingCandidate {
  return createOrganizationCandidate({
    nodeId,
    repositoryFullName,
    number,
    createdAt,
    activity: createActivity(createdAt, createdAt),
    authorType: "human",
    notificationClass: "standard",
    itemState: {
      state: "open",
    },
  });
}

function createExternalCandidate(
  nodeId: string,
  repositoryFullName: string,
  number: number,
  state: ExternalPublicTrackingCandidate["state"],
): ExternalPublicTrackingCandidate {
  return Object.freeze({
    scope: "external_public",
    nodeId: createExternalReferenceNodeId(nodeId),
    repositoryFullName,
    number,
    url: createItemUrl(repositoryFullName, number),
    title: `外部blocker${number.toString()}`,
    state,
  });
}

function createSelectionInput(candidates: readonly TrackingCandidate[]): SelectTrackingItemsInput {
  return Object.freeze({
    startAt: START_AT,
    evaluatedAt: EVALUATED_AT,
    candidates,
    connections: [],
    previouslyTrackedNodeIds: [],
    explicitIncludes: [],
    autoInclude: NO_AUTO_INCLUDE,
    backfill: {
      mode: "none",
    },
    maxBackfillItemsPerRun: 500,
  } satisfies SelectTrackingItemsInput);
}

function selectedNodeIds(result: ReturnType<typeof selectTrackingItems>): readonly string[] {
  return result.trackedItems.map((selected) => selected.item.nodeId);
}

function addDays(value: UtcIsoDateTime, days: number): UtcIsoDateTime {
  return createUtcIsoDateTime(
    new Date(Date.parse(value) + days * 24 * 60 * 60 * 1000).toISOString(),
  );
}

describe("追跡対象への追加", () => {
  it("startAtの1秒前を除外し、1秒後に作成されたopen項目だけを自動追加する", () => {
    const before = createOpenCandidate(
      "I_before",
      "VOICEVOX/example",
      1,
      createUtcIsoDateTime("2026-06-30T23:59:59Z"),
    );
    const after = createOpenCandidate(
      "I_after",
      "VOICEVOX/example",
      2,
      createUtcIsoDateTime("2026-07-01T00:00:01Z"),
    );
    const input = createSelectionInput([before, after]);
    const result = selectTrackingItems({
      ...input,
      autoInclude: {
        ...NO_AUTO_INCLUDE,
        createdAfterStart: true,
      },
    });

    expect(selectedNodeIds(result)).toEqual([after.nodeId]);
    expect(result.trackedItems[0]?.reasons.map((reason) => reason.kind)).toEqual([
      "created_after_start",
    ]);
  });

  it("T12がhuman活動として算出した開始後コメントで古いIssueを追加する", () => {
    const itemNodeId = createGitHubNodeId("I_human_comment");
    const commentAt = createUtcIsoDateTime("2026-07-02T00:00:00Z");
    const human = Object.freeze({
      type: "human",
      nodeId: createGitHubNodeId("U_commenter"),
      login: "commenter",
    } satisfies GitHubAccountActor);
    const comment = Object.freeze({
      kind: "comment",
      sourceId: buildSourceId("comment", "new-human-comment"),
      itemNodeId,
      occurredAt: commentAt,
      actor: human,
      bodyFingerprint: "sha256:new-human-comment",
      bodyEmpty: false,
    } satisfies Extract<NormalizedEvent, { kind: "comment" }>);
    const activity = determineMeaningfulProgress({
      createdAt: OLD_CREATED_AT,
      evaluatedAt: EVALUATED_AT,
      events: [comment],
      dependencyResolutions: [],
      naturalLanguageAssessments: [],
      minimumAiConfidence: 0.65,
      previousActivity: {
        status: "not_available",
      },
      repositoryFullName: "VOICEVOX/example",
      resolveLabelEffects: createLabelEffectsResolver([]),
    });
    const candidate = createOrganizationCandidate({
      nodeId: itemNodeId,
      repositoryFullName: "VOICEVOX/example",
      number: 10,
      createdAt: OLD_CREATED_AT,
      activity,
      authorType: "human",
      notificationClass: "standard",
      itemState: {
        state: "open",
      },
    });
    const input = createSelectionInput([candidate]);
    const result = selectTrackingItems({
      ...input,
      autoInclude: {
        ...NO_AUTO_INCLUDE,
        changedAfterStart: true,
      },
    });

    expect(activity.lastHumanActivityAt).toBe(commentAt);
    expect(selectedNodeIds(result)).toEqual([candidate.nodeId]);
    expect(result.trackedItems[0]?.reasons.map((reason) => reason.kind)).toEqual([
      "changed_after_start",
    ]);
  });

  it("tracked itemが参照した開始日前のblockerを追加する", () => {
    const tracked = createOpenCandidate(
      "I_tracked_reference",
      "VOICEVOX/example",
      20,
      createUtcIsoDateTime("2026-07-02T00:00:00Z"),
    );
    const blocker = createOpenCandidate("I_old_blocker", "VOICEVOX/dependency", 21, OLD_CREATED_AT);
    const connection = Object.freeze({
      kind: "reference",
      sourceId: buildSourceId("relation", "old-blocker-url"),
      referencingNodeId: tracked.nodeId,
      referencedNodeId: blocker.nodeId,
      relation: Object.freeze({
        type: "blocks",
        blockerNodeId: blocker.nodeId,
        blockedNodeId: tracked.nodeId,
      }),
    } satisfies TrackingConnection);
    const input = createSelectionInput([tracked, blocker]);
    const result = selectTrackingItems({
      ...input,
      connections: [connection],
      autoInclude: {
        ...NO_AUTO_INCLUDE,
        createdAfterStart: true,
        referencedByTracked: true,
      },
    });

    expect(selectedNodeIds(result)).toEqual([blocker.nodeId, tracked.nodeId]);
    expect(
      result.trackedItems
        .find((selected) => selected.item.nodeId === blocker.nodeId)
        ?.reasons.map((reason) => reason.kind),
    ).toContain("referenced_by_tracked");
  });

  it("tracked itemを新たに参照した開始日前のsourceを追加する", () => {
    const tracked = createOpenCandidate(
      "I_cross_reference_target",
      "VOICEVOX/example",
      30,
      createUtcIsoDateTime("2026-07-02T00:00:00Z"),
    );
    const oldSource = createOpenCandidate(
      "I_old_cross_reference_source",
      "VOICEVOX/project",
      31,
      OLD_CREATED_AT,
    );
    const connection = Object.freeze({
      kind: "reference",
      sourceId: buildSourceId("cross_reference", "old-source"),
      referencingNodeId: oldSource.nodeId,
      referencedNodeId: tracked.nodeId,
      relation: Object.freeze({
        type: "non_blocking",
        relationType: "related_to",
      }),
    } satisfies TrackingConnection);
    const input = createSelectionInput([tracked, oldSource]);
    const result = selectTrackingItems({
      ...input,
      connections: [connection],
      autoInclude: {
        ...NO_AUTO_INCLUDE,
        createdAfterStart: true,
        referencesTracked: true,
      },
    });

    expect(selectedNodeIds(result)).toEqual([tracked.nodeId, oldSource.nodeId]);
    expect(
      result.trackedItems
        .find((selected) => selected.item.nodeId === oldSource.nodeId)
        ?.reasons.map((reason) => reason.kind),
    ).toContain("references_tracked");
  });

  it("native関係を深度3まで辿り、cycleがあっても深度4を追加しない", () => {
    const candidates = Array.from({ length: 6 }, (_, index) =>
      createOpenCandidate(
        `I_native_${index.toString()}`,
        "VOICEVOX/native",
        index + 1,
        OLD_CREATED_AT,
      ),
    );
    const node = (index: number) => {
      const candidate = candidates[index];
      if (candidate == null) {
        throw new Error(`native候補${index.toString()}がありません`);
      }
      return candidate.nodeId;
    };
    const connections = [
      {
        kind: "native_dependency",
        sourceId: buildSourceId("github", "native-0-1"),
        blockerNodeId: node(1),
        blockedNodeId: node(0),
      },
      {
        kind: "native_sub_issue",
        sourceId: buildSourceId("github", "native-1-2"),
        parentNodeId: node(1),
        subIssueNodeId: node(2),
      },
      {
        kind: "native_dependency",
        sourceId: buildSourceId("github", "native-2-3"),
        blockerNodeId: node(3),
        blockedNodeId: node(2),
      },
      {
        kind: "native_sub_issue",
        sourceId: buildSourceId("github", "native-3-4"),
        parentNodeId: node(3),
        subIssueNodeId: node(4),
      },
      {
        kind: "native_dependency",
        sourceId: buildSourceId("github", "native-cycle-2-5"),
        blockerNodeId: node(5),
        blockedNodeId: node(2),
      },
      {
        kind: "native_sub_issue",
        sourceId: buildSourceId("github", "native-cycle-5-1"),
        parentNodeId: node(5),
        subIssueNodeId: node(1),
      },
    ] satisfies readonly TrackingConnection[];
    const input = createSelectionInput(candidates);
    const result = selectTrackingItems({
      ...input,
      connections,
      previouslyTrackedNodeIds: [node(0)],
      autoInclude: {
        ...NO_AUTO_INCLUDE,
        nativeRelations: true,
        relationDepth: 3,
      },
    });

    expect(selectedNodeIds(result)).toEqual([node(0), node(1), node(2), node(3), node(5)]);
    expect(
      result.trackedItems
        .find((selected) => selected.item.nodeId === node(3))
        ?.reasons.find((reason) => reason.kind === "native_relation"),
    ).toMatchObject({
      depth: 3,
    });
  });

  it("closed項目をURLで、別の古い項目をnode IDで明示追加する", () => {
    const closed = createOrganizationCandidate({
      nodeId: "I_explicit_closed",
      repositoryFullName: "VOICEVOX/example",
      number: 40,
      createdAt: OLD_CREATED_AT,
      activity: createActivity(OLD_CREATED_AT, OLD_CREATED_AT),
      authorType: "human",
      notificationClass: "standard",
      itemState: {
        state: "closed",
        terminalAt: createUtcIsoDateTime("2026-07-15T00:00:00Z"),
      },
    });
    const byNodeId = createOpenCandidate("I_explicit_node", "VOICEVOX/example", 41, OLD_CREATED_AT);
    const input = createSelectionInput([closed, byNodeId]);
    const result = selectTrackingItems({
      ...input,
      explicitIncludes: [closed.url, byNodeId.nodeId],
    });

    expect(selectedNodeIds(result)).toEqual([closed.nodeId, byNodeId.nodeId]);
    expect(result.trackedItems[0]?.reasons[0]).toMatchObject({
      kind: "explicit_include",
      identifier: closed.url,
    });
  });
});

describe("workflow_dispatch backfill", () => {
  it("noneでは古い未追跡項目を追加しない", () => {
    const candidate = createOpenCandidate(
      "I_backfill_none",
      "VOICEVOX/example",
      50,
      OLD_CREATED_AT,
    );
    const result = selectTrackingItems(createSelectionInput([candidate]));

    expect(result.trackedItems).toEqual([]);
    expect(result.backfill).toEqual({
      mode: "none",
      status: "not_requested",
      addedNodeIds: [],
    });
  });

  it("linkedではrepository filter内の接続項目だけを追加する", () => {
    const tracked = createOpenCandidate("I_linked_root", "VOICEVOX/root", 1, OLD_CREATED_AT);
    const allowed = createOpenCandidate("I_linked_allowed", "VOICEVOX/allowed", 2, OLD_CREATED_AT);
    const excluded = createOpenCandidate(
      "I_linked_excluded",
      "VOICEVOX/excluded",
      3,
      OLD_CREATED_AT,
    );
    const connections = [
      {
        kind: "reference",
        sourceId: buildSourceId("relation", "linked-allowed"),
        referencingNodeId: tracked.nodeId,
        referencedNodeId: allowed.nodeId,
        relation: {
          type: "non_blocking",
          relationType: "related_to",
        },
      },
      {
        kind: "native_sub_issue",
        sourceId: buildSourceId("relation", "linked-excluded"),
        parentNodeId: tracked.nodeId,
        subIssueNodeId: excluded.nodeId,
      },
    ] satisfies readonly TrackingConnection[];
    const input = createSelectionInput([tracked, allowed, excluded]);
    const result = selectTrackingItems({
      ...input,
      connections,
      previouslyTrackedNodeIds: [tracked.nodeId],
      backfill: {
        mode: "linked",
        repositoryFilter: ["VOICEVOX/allowed"],
        cursor: {
          status: "start",
        },
      },
    });

    expect(selectedNodeIds(result)).toEqual([allowed.nodeId, tracked.nodeId]);
    expect(result.backfill).toMatchObject({
      mode: "linked",
      status: "complete",
      addedNodeIds: [allowed.nodeId],
      remainingItemCount: 0,
    });
  });

  it("all-openの上限、再開位置、残件数を返し、次回に続きから処理する", () => {
    const first = createOpenCandidate("I_all_open_1", "VOICEVOX/backfill", 1, OLD_CREATED_AT);
    const second = createOpenCandidate("I_all_open_2", "VOICEVOX/backfill", 2, OLD_CREATED_AT);
    const third = createOpenCandidate("I_all_open_3", "VOICEVOX/backfill", 3, OLD_CREATED_AT);
    const otherRepository = createOpenCandidate(
      "I_all_open_other",
      "VOICEVOX/other",
      1,
      OLD_CREATED_AT,
    );
    const closed = createOrganizationCandidate({
      nodeId: "I_all_open_closed",
      repositoryFullName: "VOICEVOX/backfill",
      number: 4,
      createdAt: OLD_CREATED_AT,
      activity: createActivity(OLD_CREATED_AT, OLD_CREATED_AT),
      authorType: "human",
      notificationClass: "standard",
      itemState: {
        state: "closed",
        terminalAt: createUtcIsoDateTime("2026-06-01T00:00:00Z"),
      },
    });
    const candidates = [first, second, third, otherRepository, closed];
    const input = createSelectionInput(candidates);
    const firstRun = selectTrackingItems({
      ...input,
      backfill: {
        mode: "all-open",
        repositoryFilter: ["VOICEVOX/backfill"],
        cursor: {
          status: "start",
        },
      },
      maxBackfillItemsPerRun: 2,
    });

    expect(selectedNodeIds(firstRun)).toEqual([first.nodeId, second.nodeId]);
    expect(firstRun.backfill).toEqual({
      mode: "all-open",
      status: "limit_reached",
      eligibleItemCount: 3,
      addedNodeIds: [first.nodeId, second.nodeId],
      processedThrough: {
        status: "after",
        repositoryFullName: "VOICEVOX/backfill",
        number: 2,
        nodeId: second.nodeId,
      },
      remainingItemCount: 1,
    });
    if (
      firstRun.backfill.mode === "none" ||
      firstRun.backfill.processedThrough.status !== "after"
    ) {
      throw new Error("backfillの再開位置がありません");
    }

    const secondRun = selectTrackingItems({
      ...input,
      previouslyTrackedNodeIds: [first.nodeId, second.nodeId],
      backfill: {
        mode: "all-open",
        repositoryFilter: ["VOICEVOX/backfill"],
        cursor: firstRun.backfill.processedThrough,
      },
      maxBackfillItemsPerRun: 2,
    });

    expect(secondRun.backfill).toMatchObject({
      mode: "all-open",
      status: "complete",
      eligibleItemCount: 1,
      addedNodeIds: [third.nodeId],
      remainingItemCount: 0,
    });
    expect(secondRun.newlyTrackedItems.map((selected) => selected.item.nodeId)).toEqual([
      third.nodeId,
    ]);
  });
});

describe("追跡後のライフサイクル", () => {
  it("作成日だけが異なるtracked itemへ同じ後段判定を適用する", () => {
    const old = createOpenCandidate("I_age_old", "VOICEVOX/age", 1, OLD_CREATED_AT);
    const recent = createOpenCandidate(
      "I_age_recent",
      "VOICEVOX/age",
      2,
      createUtcIsoDateTime("2026-07-20T00:00:00Z"),
    );
    const input = createSelectionInput([old, recent]);
    const selection = selectTrackingItems({
      ...input,
      previouslyTrackedNodeIds: [old.nodeId, recent.nodeId],
    });
    const commonWorkInput = Object.freeze({
      state: "open",
      analysisInputFingerprint: "sha256:same-history",
      analysisRulesFingerprint: "sha256:same-rules",
      previousAiAnalysisStatus: "used",
      previousObservation: Object.freeze({
        status: "available",
        state: "open",
        analysisInputFingerprint: "sha256:same-history",
        analysisRulesFingerprint: Object.freeze({
          status: "available",
          fingerprint: "sha256:same-rules",
        }),
      }),
    } satisfies DetermineTrackedItemWorkInput);
    const decisions = selection.trackedItems.map(() => determineTrackedItemWork(commonWorkInput));

    expect(
      selection.trackedItems.map((selected) => selected.reasons.map((reason) => reason.kind)),
    ).toEqual([["previously_tracked"], ["previously_tracked"]]);
    expect(decisions[0]).toEqual(decisions[1]);
  });

  it("close後179日はactiveに残し、180日を超えたらarchiveへ退避する", () => {
    const terminalAt = createUtcIsoDateTime("2026-01-01T00:00:00Z");
    const day179 = determineTerminalRetention({
      item: {
        state: "closed",
        terminalAt,
      },
      evaluatedAt: addDays(terminalAt, 179),
      retentionDays: DEFAULT_TERMINAL_RETENTION_DAYS,
    });
    const afterRetention = determineTerminalRetention({
      item: {
        state: "closed",
        terminalAt,
      },
      evaluatedAt: createUtcIsoDateTime(
        new Date(
          Date.parse(addDays(terminalAt, DEFAULT_TERMINAL_RETENTION_DAYS)) + 1000,
        ).toISOString(),
      ),
      retentionDays: DEFAULT_TERMINAL_RETENTION_DAYS,
    });

    expect(day179.dataset).toBe("active");
    expect(afterRetention).toMatchObject({
      dataset: "archive",
      reason: "terminal_retention_expired",
    });
  });

  it("terminalかつ未変更ならCodex再分析と停滞通知評価を行わない", () => {
    const decision = determineTrackedItemWork({
      state: "closed",
      analysisInputFingerprint: "sha256:unchanged",
      analysisRulesFingerprint: "sha256:unchanged-rules",
      previousAiAnalysisStatus: "used",
      previousObservation: {
        status: "available",
        state: "closed",
        analysisInputFingerprint: "sha256:unchanged",
        analysisRulesFingerprint: {
          status: "available",
          fingerprint: "sha256:unchanged-rules",
        },
      },
    });
    const codexCalls = [decision].filter((value) => value.codexAnalysis.action === "analyze");
    const stallNotifications = [decision].filter(
      (value) => value.stallNotification.action === "evaluate",
    );

    expect(codexCalls).toHaveLength(0);
    expect(stallNotifications).toHaveLength(0);
    expect(decision).toEqual({
      codexAnalysis: {
        action: "suppress",
        reason: "terminal_unchanged",
      },
      stallNotification: {
        action: "suppress",
        reason: "terminal_unchanged",
      },
    });
  });

  it("terminal遷移直後または分析入力変更時だけ再分析を許可する", () => {
    const transitioned = determineTrackedItemWork({
      state: "merged",
      analysisInputFingerprint: "sha256:merged",
      analysisRulesFingerprint: "sha256:same-rules",
      previousAiAnalysisStatus: "used",
      previousObservation: {
        status: "available",
        state: "open",
        analysisInputFingerprint: "sha256:open",
        analysisRulesFingerprint: {
          status: "available",
          fingerprint: "sha256:same-rules",
        },
      },
    });
    const changed = determineTrackedItemWork({
      state: "closed",
      analysisInputFingerprint: "sha256:changed",
      analysisRulesFingerprint: "sha256:same-rules",
      previousAiAnalysisStatus: "used",
      previousObservation: {
        status: "available",
        state: "closed",
        analysisInputFingerprint: "sha256:previous",
        analysisRulesFingerprint: {
          status: "available",
          fingerprint: "sha256:same-rules",
        },
      },
    });

    expect(transitioned.codexAnalysis).toEqual({
      action: "analyze",
      reason: "terminal_transition",
    });
    expect(changed.codexAnalysis).toEqual({
      action: "analyze",
      reason: "analysis_input_changed",
    });
  });

  it("terminal項目の判定規則が変更または未保存ならCodex再分析だけを行う", () => {
    const changed = determineTrackedItemWork({
      state: "closed",
      analysisInputFingerprint: "sha256:unchanged",
      analysisRulesFingerprint: "sha256:current-rules",
      previousAiAnalysisStatus: "used",
      previousObservation: {
        status: "available",
        state: "closed",
        analysisInputFingerprint: "sha256:unchanged",
        analysisRulesFingerprint: {
          status: "available",
          fingerprint: "sha256:previous-rules",
        },
      },
    });
    const unavailable = determineTrackedItemWork({
      state: "closed",
      analysisInputFingerprint: "sha256:unchanged",
      analysisRulesFingerprint: "sha256:current-rules",
      previousAiAnalysisStatus: "used",
      previousObservation: {
        status: "available",
        state: "closed",
        analysisInputFingerprint: "sha256:unchanged",
        analysisRulesFingerprint: {
          status: "unavailable",
        },
      },
    });
    const expected = {
      codexAnalysis: {
        action: "analyze",
        reason: "analysis_rules_changed",
      },
      stallNotification: {
        action: "suppress",
        reason: "terminal_unchanged",
      },
    } as const;

    expect(changed).toEqual(expected);
    expect(unavailable).toEqual(expected);
  });

  it("terminalかつ未変更でも前回AI分析が失敗または延期なら再分析する", () => {
    const retryCases = [
      Object.freeze({
        status: "failed",
        reason: "previous_analysis_failed",
      }),
      Object.freeze({
        status: "deferred",
        reason: "previous_analysis_deferred",
      }),
    ] satisfies readonly Readonly<{
      status: DetermineTrackedItemWorkInput["previousAiAnalysisStatus"];
      reason: string;
    }>[];

    const decisions = retryCases.map(({ status, reason }) => ({
      decision: determineTrackedItemWork({
        state: "closed",
        analysisInputFingerprint: "sha256:unchanged",
        analysisRulesFingerprint: "sha256:unchanged-rules",
        previousAiAnalysisStatus: status,
        previousObservation: {
          status: "available",
          state: "closed",
          analysisInputFingerprint: "sha256:unchanged",
          analysisRulesFingerprint: {
            status: "available",
            fingerprint: "sha256:unchanged-rules",
          },
        },
      }),
      reason,
    }));

    for (const { decision, reason } of decisions) {
      expect(decision).toEqual({
        codexAnalysis: {
          action: "analyze",
          reason,
        },
        stallNotification: {
          action: "suppress",
          reason: "terminal_unchanged",
        },
      });
    }
  });

  it("automation項目とbot作成項目を追跡し、automationだけを既定digestから外す", () => {
    const automationNoiseTitles = Object.freeze(["Dependency Dashboard", "Renovate Dashboard"]);
    expect(
      classifyTrackingNotification({
        authorType: "bot",
        title: "Dependency Dashboard",
        automationNoiseTitles,
        notificationsSuppressedByLabel: false,
      }),
    ).toBe("automation_noise");
    expect(
      classifyTrackingNotification({
        authorType: "bot",
        title: "依存更新ダッシュボード",
        automationNoiseTitles: ["依存更新ダッシュボード"],
        notificationsSuppressedByLabel: false,
      }),
    ).toBe("automation_noise");
    expect(
      classifyTrackingNotification({
        authorType: "bot",
        title: "依存更新",
        automationNoiseTitles,
        notificationsSuppressedByLabel: true,
      }),
    ).toBe("automation_noise");
    expect(
      classifyTrackingNotification({
        authorType: "bot",
        title: "依存更新",
        automationNoiseTitles,
        notificationsSuppressedByLabel: false,
      }),
    ).toBe("standard");
    expect(
      classifyTrackingNotification({
        authorType: "human",
        title: "Dependency Dashboard",
        automationNoiseTitles,
        notificationsSuppressedByLabel: false,
      }),
    ).toBe("standard");
    expect(
      classifyTrackingNotification({
        authorType: "human",
        title: "",
        automationNoiseTitles,
        notificationsSuppressedByLabel: false,
      }),
    ).toBe("standard");
    const automation = createOrganizationCandidate({
      nodeId: "I_automation_dashboard",
      repositoryFullName: "VOICEVOX/core",
      number: 60,
      createdAt: createUtcIsoDateTime("2026-07-20T00:00:00Z"),
      activity: createActivity(
        createUtcIsoDateTime("2026-07-20T00:00:00Z"),
        createUtcIsoDateTime("2026-07-20T00:00:00Z"),
      ),
      authorType: "bot",
      notificationClass: classifyTrackingNotification({
        authorType: "bot",
        title: "Dependency Dashboard",
        automationNoiseTitles,
        notificationsSuppressedByLabel: false,
      }),
      itemState: {
        state: "open",
      },
    });
    const ordinaryBotItem = createOrganizationCandidate({
      nodeId: "I_ordinary_bot_item",
      repositoryFullName: "VOICEVOX/core",
      number: 61,
      createdAt: createUtcIsoDateTime("2026-07-21T00:00:00Z"),
      activity: createActivity(
        createUtcIsoDateTime("2026-07-21T00:00:00Z"),
        createUtcIsoDateTime("2026-07-21T00:00:00Z"),
      ),
      authorType: "bot",
      notificationClass: classifyTrackingNotification({
        authorType: "bot",
        title: "依存更新",
        automationNoiseTitles,
        notificationsSuppressedByLabel: false,
      }),
      itemState: {
        state: "open",
      },
    });
    const input = createSelectionInput([automation, ordinaryBotItem]);
    const result = selectTrackingItems({
      ...input,
      autoInclude: {
        ...NO_AUTO_INCLUDE,
        createdAfterStart: true,
      },
    });

    expect(selectedNodeIds(result)).toEqual([automation.nodeId, ordinaryBotItem.nodeId]);
    expect(determineDefaultDigestDecision(automation.notificationClass)).toEqual({
      action: "suppress",
      reason: "automation_noise",
    });
    expect(determineDefaultDigestDecision(ordinaryBotItem.notificationClass)).toEqual({
      action: "include",
      reason: "standard_item",
    });
  });

  it("外部public blockerを最小メタデータのghost nodeにして再帰追跡しない", () => {
    const tracked = createOpenCandidate(
      "I_external_blocked",
      "VOICEVOX/example",
      70,
      createUtcIsoDateTime("2026-07-20T00:00:00Z"),
    );
    const externalBlocker = createExternalCandidate(
      "external:https://github.com/example/dependency/issues/1",
      "example/dependency",
      1,
      "open",
    );
    const externalNeighbor = createExternalCandidate(
      "external:https://github.com/example/dependency/issues/2",
      "example/dependency",
      2,
      "open",
    );
    const connections = [
      {
        kind: "reference",
        sourceId: buildSourceId("relation", "external-blocker"),
        referencingNodeId: tracked.nodeId,
        referencedNodeId: externalBlocker.nodeId,
        relation: {
          type: "blocks",
          blockerNodeId: externalBlocker.nodeId,
          blockedNodeId: tracked.nodeId,
        },
      },
      {
        kind: "native_dependency",
        sourceId: buildSourceId("relation", "external-recursion"),
        blockerNodeId: externalNeighbor.nodeId,
        blockedNodeId: externalBlocker.nodeId,
      },
    ] satisfies readonly TrackingConnection[];
    const input = createSelectionInput([tracked, externalBlocker, externalNeighbor]);
    const result = selectTrackingItems({
      ...input,
      connections,
      autoInclude: {
        ...NO_AUTO_INCLUDE,
        createdAfterStart: true,
        referencedByTracked: true,
        nativeRelations: true,
        relationDepth: 3,
      },
    });

    expect(selectedNodeIds(result)).toEqual([tracked.nodeId]);
    expect(result.ghostNodes).toEqual([
      {
        kind: "external_reference",
        nodeId: externalBlocker.nodeId,
        repositoryFullName: "example/dependency",
        number: 1,
        url: externalBlocker.url,
        title: "外部blocker1",
        state: "open",
        recursiveTracking: "not_allowed",
        directNotification: "not_eligible",
      },
    ]);
  });
});
