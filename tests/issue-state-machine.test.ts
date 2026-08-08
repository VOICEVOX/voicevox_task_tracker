import { describe, expect, expectTypeOf, it } from "vitest";

import {
  buildSourceId,
  createGitHubNodeId,
  createUtcIsoDateTime,
  determineIssueState,
  ISSUE_DETERMINISTIC_RULES_VERSION,
  resolveRepositoryTeams,
  type Actor,
  type FreshObservedGitHubIssue,
  type GitHubAccountActor,
  type GitHubTeamDirectory,
  type IssueBlocker,
  type IssueExplicitRequestCandidate,
  type IssueStateDecision,
  type IssueStateMachineInput,
  type NormalizedEvent,
  type PullRequestStateDecision,
  type ResolvedRepositoryTeams,
  type TeamResolutionSettings,
} from "../src/domain/index.js";

const observedAt = createUtcIsoDateTime("2026-07-31T08:00:00Z");
const evaluatedAt = createUtcIsoDateTime("2026-07-31T09:00:00Z");
const createdAt = createUtcIsoDateTime("2026-07-30T08:00:00Z");
const issueNodeId = createGitHubNodeId("I_state_machine");
const systemActor = {
  type: "system",
  name: "github",
} satisfies Actor;
const author = {
  type: "human",
  nodeId: createGitHubNodeId("U_author"),
  login: "author",
} satisfies GitHubAccountActor;
const maintainer = {
  type: "human",
  nodeId: createGitHubNodeId("U_maintainer"),
  login: "maintainer-user",
} satisfies GitHubAccountActor;
const reviewer = {
  type: "human",
  nodeId: createGitHubNodeId("U_reviewer"),
  login: "reviewer-user",
} satisfies GitHubAccountActor;
const firstAssignee = {
  type: "human",
  nodeId: createGitHubNodeId("U_first_assignee"),
  login: "first-assignee",
} satisfies GitHubAccountActor;
const secondAssignee = {
  type: "human",
  nodeId: createGitHubNodeId("U_second_assignee"),
  login: "second-assignee",
} satisfies GitHubAccountActor;
const requestedUser = {
  type: "human",
  nodeId: createGitHubNodeId("U_requested"),
  login: "requested-user",
} satisfies GitHubAccountActor;
const botAuthor = {
  type: "bot",
  nodeId: createGitHubNodeId("B_author"),
  login: "automation[bot]",
} satisfies GitHubAccountActor;

const teams = {
  maintainers: [
    {
      nodeId: createGitHubNodeId("T_maintainers"),
      org: "VOICEVOX",
      slug: "maintainers",
      members: [
        {
          nodeId: maintainer.nodeId,
          login: maintainer.login,
        },
      ],
    },
  ],
  reviewers: [
    {
      nodeId: createGitHubNodeId("T_reviewers"),
      org: "VOICEVOX",
      slug: "reviewers",
      members: [
        {
          nodeId: reviewer.nodeId,
          login: reviewer.login,
        },
      ],
    },
  ],
} satisfies ResolvedRepositoryTeams;

function createOpenIssue(): FreshObservedGitHubIssue {
  return {
    freshness: "fresh",
    sourceId: buildSourceId("github_item_detail", issueNodeId),
    nodeId: issueNodeId,
    type: "issue",
    createdAt,
    state: "open",
    stateReason: null,
    closedAt: null,
    author: {
      status: "identified",
      actor: author,
    },
    labels: [],
    assignees: [],
    events: [],
    observedAt,
  };
}

function createInput(issue: FreshObservedGitHubIssue): IssueStateMachineInput {
  return {
    issue,
    blockers: [],
    explicitRequestCandidates: [],
    explicitRequestAssessment: {
      status: "not_assessed",
    },
    teams,
    confidenceThresholds: {
      high: 0.85,
      medium: 0.65,
    },
    evaluatedAt,
  };
}

function createAssigneeEvent(
  id: string,
  assignee: GitHubAccountActor,
  occurredAt: ReturnType<typeof createUtcIsoDateTime>,
): Extract<NormalizedEvent, { kind: "assignee" }> {
  return {
    kind: "assignee",
    sourceId: buildSourceId("github_timeline_event", id),
    itemNodeId: issueNodeId,
    occurredAt,
    actor: systemActor,
    assignee,
    action: "added",
  };
}

function createUnassignEvent(
  id: string,
  assignee: GitHubAccountActor,
  occurredAt: ReturnType<typeof createUtcIsoDateTime>,
): Extract<NormalizedEvent, { kind: "assignee" }> {
  return {
    ...createAssigneeEvent(id, assignee, occurredAt),
    action: "removed",
  };
}

function createCommentEvent(
  id: string,
  actor: GitHubAccountActor,
  occurredAt: ReturnType<typeof createUtcIsoDateTime>,
): Extract<NormalizedEvent, { kind: "comment" }> {
  return {
    kind: "comment",
    sourceId: buildSourceId("github_issue_comment", id),
    itemNodeId: issueNodeId,
    occurredAt,
    actor,
    bodyFingerprint: `sha256:${id}`,
    bodyEmpty: false,
  };
}

function createBlocker(options: {
  candidateId: string;
  state: IssueBlocker["state"];
  authority: IssueBlocker["authority"];
  confidence: number;
  becameBlockingAt: ReturnType<typeof createUtcIsoDateTime>;
}): IssueBlocker {
  return {
    candidateId: options.candidateId,
    state: options.state,
    authority: options.authority,
    confidence: options.confidence,
    sourceIds: [buildSourceId("relation", options.candidateId)],
    becameBlockingAt: options.becameBlockingAt,
  };
}

function createRequestCandidate(
  event: Extract<NormalizedEvent, { kind: "comment" }>,
): IssueExplicitRequestCandidate {
  return {
    sourceId: event.sourceId,
    occurredAt: event.occurredAt,
  };
}

function createClosedIssue(stateReason: "completed" | "not_planned"): FreshObservedGitHubIssue {
  const closedAt = createUtcIsoDateTime("2026-07-31T07:00:00Z");
  const stateEvent = {
    kind: "state",
    sourceId: buildSourceId("github_timeline_event", `closed-${stateReason}`),
    itemNodeId: issueNodeId,
    occurredAt: closedAt,
    actor: maintainer,
    state: "closed",
    stateReason,
  } satisfies NormalizedEvent;
  return {
    ...createOpenIssue(),
    state: "closed",
    stateReason,
    closedAt,
    events: [stateEvent],
  };
}

describe("Issue状態機械の入力と出力契約", () => {
  it("ドメインの最新Issue観測値を直接受け取る", () => {
    expectTypeOf<IssueStateMachineInput["issue"]>().toEqualTypeOf<FreshObservedGitHubIssue>();
  });

  it("Pull Request状態機械とversion以外が同じ形の結果を返す", () => {
    expectTypeOf<Omit<IssueStateDecision, "deterministicRulesVersion">>().toEqualTypeOf<
      Omit<PullRequestStateDecision, "deterministicRulesVersion">
    >();

    const input = createInput(createOpenIssue());
    const first = determineIssueState(input);
    const second = determineIssueState(input);

    expect(second).toEqual(first);
    expect(first.deterministicRulesVersion).toBe(ISSUE_DETERMINISTIC_RULES_VERSION);
  });
});

describe("Issueの既定責務", () => {
  it("コメントもラベルもない未アサインIssueを内容確認待ちにする", () => {
    const decision = determineIssueState(createInput(createOpenIssue()));

    expect(decision.status).toBe("waiting_for_assessment");
    expect(decision.waitingOn).toEqual([
      expect.objectContaining({
        kind: "team",
        candidateId: "VOICEVOX/maintainers",
        role: "maintainer",
      }),
    ]);
    expect(decision.determination).toBe("determined");
  });

  it("1名と複数名のassigneeを全員保持する", () => {
    const firstAssignedAt = createUtcIsoDateTime("2026-07-31T04:00:00Z");
    const secondAssignedAt = createUtcIsoDateTime("2026-07-31T05:00:00Z");
    const firstEvent = createAssigneeEvent("first-assigned", firstAssignee, firstAssignedAt);
    const secondEvent = createAssigneeEvent("second-assigned", secondAssignee, secondAssignedAt);
    const singleDecision = determineIssueState(
      createInput({
        ...createOpenIssue(),
        assignees: [firstAssignee],
        events: [firstEvent],
      }),
    );
    const multipleDecision = determineIssueState(
      createInput({
        ...createOpenIssue(),
        assignees: [secondAssignee, firstAssignee],
        events: [secondEvent, firstEvent],
      }),
    );

    expect(singleDecision.status).toBe("waiting_for_work");
    expect(singleDecision.waitingOn.map((value) => value.candidateId)).toEqual([
      firstAssignee.login,
    ]);
    expect(multipleDecision.waitingOn.map((value) => value.candidateId)).toEqual([
      firstAssignee.login,
      secondAssignee.login,
    ]);
    expect(multipleDecision.primaryWaitingOn.selectionReason).toBe(
      "assign時刻とcandidate IDの順でassigneeを選定しました",
    );
  });

  it("現行assigneeの最新の未解除assignイベントを観測時刻に依存せず基準にする", () => {
    const firstAssignment = createAssigneeEvent(
      "first-assignment",
      firstAssignee,
      createUtcIsoDateTime("2026-07-31T02:00:00Z"),
    );
    const unassignment = createUnassignEvent(
      "unassignment",
      firstAssignee,
      createUtcIsoDateTime("2026-07-31T03:00:00Z"),
    );
    const currentAssignment = createAssigneeEvent(
      "current-assignment",
      firstAssignee,
      createUtcIsoDateTime("2026-07-31T04:00:00Z"),
    );
    const issue = {
      ...createOpenIssue(),
      assignees: [firstAssignee],
      events: [currentAssignment, firstAssignment, unassignment],
    } satisfies FreshObservedGitHubIssue;
    const firstDecision = determineIssueState(
      createInput({
        ...issue,
        observedAt: createUtcIsoDateTime("2026-07-31T07:00:00Z"),
      }),
    );
    const secondDecision = determineIssueState(
      createInput({
        ...issue,
        observedAt: createUtcIsoDateTime("2026-07-31T08:00:00Z"),
      }),
    );

    expect(firstDecision.statusBasis).toEqual({
      sourceIds: [currentAssignment.sourceId],
      occurredAt: currentAssignment.occurredAt,
      precision: "event",
    });
    expect(secondDecision.statusBasis.occurredAt).toBe(firstDecision.statusBasis.occurredAt);
    expect(secondDecision.responsibilityBasis.occurredAt).toBe(
      firstDecision.responsibilityBasis.occurredAt,
    );
  });

  it("現行assigneeに未解除assignイベントがなければ作成時刻を基準にする", () => {
    const assignment = createAssigneeEvent(
      "released-assignment",
      firstAssignee,
      createUtcIsoDateTime("2026-07-31T02:00:00Z"),
    );
    const unassignment = createUnassignEvent(
      "released-unassignment",
      firstAssignee,
      createUtcIsoDateTime("2026-07-31T03:00:00Z"),
    );
    const issue = {
      ...createOpenIssue(),
      assignees: [firstAssignee],
      events: [assignment, unassignment],
    } satisfies FreshObservedGitHubIssue;
    const firstDecision = determineIssueState(
      createInput({
        ...issue,
        observedAt: createUtcIsoDateTime("2026-07-31T07:00:00Z"),
      }),
    );
    const secondDecision = determineIssueState(
      createInput({
        ...issue,
        observedAt: createUtcIsoDateTime("2026-07-31T08:00:00Z"),
      }),
    );

    expect(firstDecision.statusBasis).toEqual({
      sourceIds: [createOpenIssue().sourceId],
      occurredAt: createdAt,
      precision: "inferred",
    });
    expect(secondDecision.statusBasis.occurredAt).toBe(firstDecision.statusBasis.occurredAt);
    expect(secondDecision.responsibilityBasis.occurredAt).toBe(
      firstDecision.responsibilityBasis.occurredAt,
    );
  });

  it("assignee集合が最後に空になったunassignイベントを観測時刻に依存せず基準にする", () => {
    const firstAssignment = createAssigneeEvent(
      "unassigned-first-assignment",
      firstAssignee,
      createUtcIsoDateTime("2026-07-31T02:00:00Z"),
    );
    const secondAssignment = createAssigneeEvent(
      "unassigned-second-assignment",
      secondAssignee,
      createUtcIsoDateTime("2026-07-31T03:00:00Z"),
    );
    const firstUnassignment = createUnassignEvent(
      "unassigned-first-unassignment",
      firstAssignee,
      createUtcIsoDateTime("2026-07-31T04:00:00Z"),
    );
    const firstEmptyingUnassignment = createUnassignEvent(
      "unassigned-first-emptying-unassignment",
      secondAssignee,
      createUtcIsoDateTime("2026-07-31T05:00:00Z"),
    );
    const reassignment = createAssigneeEvent(
      "unassigned-reassignment",
      firstAssignee,
      createUtcIsoDateTime("2026-07-31T05:30:00Z"),
    );
    const lastUnassignment = createUnassignEvent(
      "unassigned-last-unassignment",
      firstAssignee,
      createUtcIsoDateTime("2026-07-31T06:00:00Z"),
    );
    const issue = {
      ...createOpenIssue(),
      events: [
        lastUnassignment,
        firstEmptyingUnassignment,
        reassignment,
        secondAssignment,
        firstUnassignment,
        firstAssignment,
      ],
    } satisfies FreshObservedGitHubIssue;
    const firstDecision = determineIssueState(
      createInput({
        ...issue,
        observedAt: createUtcIsoDateTime("2026-07-31T07:00:00Z"),
      }),
    );
    const secondDecision = determineIssueState(
      createInput({
        ...issue,
        observedAt: createUtcIsoDateTime("2026-07-31T08:00:00Z"),
      }),
    );

    expect(firstDecision.statusBasis).toEqual({
      sourceIds: [lastUnassignment.sourceId],
      occurredAt: lastUnassignment.occurredAt,
      precision: "event",
    });
    expect(secondDecision.statusBasis.occurredAt).toBe(firstDecision.statusBasis.occurredAt);
    expect(secondDecision.responsibilityBasis.occurredAt).toBe(
      firstDecision.responsibilityBasis.occurredAt,
    );
  });

  it("assignされたことがなければIssue作成時刻を未アサインの基準にする", () => {
    const unrelatedUnassignment = createUnassignEvent(
      "unrelated-unassignment",
      firstAssignee,
      createUtcIsoDateTime("2026-07-31T06:00:00Z"),
    );
    const issue = {
      ...createOpenIssue(),
      events: [unrelatedUnassignment],
    } satisfies FreshObservedGitHubIssue;
    const firstDecision = determineIssueState(
      createInput({
        ...issue,
        observedAt: createUtcIsoDateTime("2026-07-31T07:00:00Z"),
      }),
    );
    const secondDecision = determineIssueState(
      createInput({
        ...issue,
        observedAt: createUtcIsoDateTime("2026-07-31T08:00:00Z"),
      }),
    );

    expect(firstDecision.statusBasis).toEqual({
      sourceIds: [createOpenIssue().sourceId],
      occurredAt: createdAt,
      precision: "inferred",
    });
    expect(secondDecision.statusBasis.occurredAt).toBe(firstDecision.statusBasis.occurredAt);
    expect(secondDecision.responsibilityBasis.occurredAt).toBe(
      firstDecision.responsibilityBasis.occurredAt,
    );
  });

  it("authorがmaintainerでも設定済みmaintainer teamの責務にする", () => {
    const decision = determineIssueState(
      createInput({
        ...createOpenIssue(),
        author: {
          status: "identified",
          actor: maintainer,
        },
      }),
    );

    expect(decision.waitingOn[0]).toMatchObject({
      kind: "team",
      candidateId: "VOICEVOX/maintainers",
      role: "maintainer",
    });
    expect(decision.waitingOn.map((value) => value.candidateId)).not.toContain(maintainer.login);
  });

  it("作成者以外のhumanコメントがある未アサインIssueを担当決め待ちにする", () => {
    const reviewerActivity = createCommentEvent(
      "reviewer-activity",
      reviewer,
      createUtcIsoDateTime("2026-07-31T07:00:00Z"),
    );
    const decision = determineIssueState(
      createInput({
        ...createOpenIssue(),
        events: [reviewerActivity],
      }),
    );

    expect(decision.status).toBe("waiting_for_owner");
    expect(decision.waitingOn[0]).toMatchObject({
      kind: "team",
      candidateId: "VOICEVOX/maintainers",
      role: "maintainer",
    });
    expect(decision.responsibilityBasis).toEqual({
      sourceIds: [createOpenIssue().sourceId],
      occurredAt: createdAt,
      precision: "inferred",
    });
  });

  it("botコメントだけの未アサインIssueを内容確認待ちにする", () => {
    const botActivity = createCommentEvent(
      "bot-activity",
      botAuthor,
      createUtcIsoDateTime("2026-07-31T07:00:00Z"),
    );
    const decision = determineIssueState(
      createInput({
        ...createOpenIssue(),
        events: [botActivity],
      }),
    );

    expect(decision.status).toBe("waiting_for_assessment");
  });

  it("ラベルが付いた未アサインIssueを担当決め待ちにする", () => {
    const decision = determineIssueState(
      createInput({
        ...createOpenIssue(),
        labels: ["要検討"],
      }),
    );

    expect(decision.status).toBe("waiting_for_owner");
  });

  it("過去にassigneeがいた未アサインIssueを担当決め待ちにする", () => {
    const assignment = createAssigneeEvent(
      "past-assignment",
      firstAssignee,
      createUtcIsoDateTime("2026-07-31T05:00:00Z"),
    );
    const unassignment = createUnassignEvent(
      "past-unassignment",
      firstAssignee,
      createUtcIsoDateTime("2026-07-31T06:00:00Z"),
    );
    const decision = determineIssueState(
      createInput({
        ...createOpenIssue(),
        events: [assignment, unassignment],
      }),
    );

    expect(decision.status).toBe("waiting_for_owner");
  });

  it("2 repositoryでauthorのmembershipに関係なく設定済みmaintainer teamへ解決する", () => {
    const defaultMaintainer = {
      type: "human",
      nodeId: createGitHubNodeId("U_default_maintainer"),
      login: "default-maintainer",
    } satisfies GitHubAccountActor;
    const defaultReviewer = {
      type: "human",
      nodeId: createGitHubNodeId("U_default_reviewer"),
      login: "default-reviewer",
    } satisfies GitHubAccountActor;
    const overrideMaintainer = {
      type: "human",
      nodeId: createGitHubNodeId("U_override_maintainer"),
      login: "override-maintainer",
    } satisfies GitHubAccountActor;
    const overrideReviewer = {
      type: "human",
      nodeId: createGitHubNodeId("U_override_reviewer"),
      login: "override-reviewer",
    } satisfies GitHubAccountActor;
    const settings = {
      defaults: {
        maintainers: [{ org: "VOICEVOX", slug: "default-maintainers" }],
        reviewers: [{ org: "VOICEVOX", slug: "default-reviewers" }],
      },
      repositories: {
        "VOICEVOX/override": {
          maintainers: [{ org: "VOICEVOX", slug: "override-maintainers" }],
          reviewers: [{ org: "VOICEVOX", slug: "override-reviewers" }],
        },
      },
    } satisfies TeamResolutionSettings;
    const directory = [
      {
        nodeId: createGitHubNodeId("T_default_maintainers"),
        org: "VOICEVOX",
        slug: "default-maintainers",
        members: [defaultMaintainer],
      },
      {
        nodeId: createGitHubNodeId("T_default_reviewers"),
        org: "VOICEVOX",
        slug: "default-reviewers",
        members: [defaultReviewer],
      },
      {
        nodeId: createGitHubNodeId("T_override_maintainers"),
        org: "VOICEVOX",
        slug: "override-maintainers",
        members: [overrideMaintainer],
      },
      {
        nodeId: createGitHubNodeId("T_override_reviewers"),
        org: "VOICEVOX",
        slug: "override-reviewers",
        members: [overrideReviewer],
      },
    ] satisfies GitHubTeamDirectory;
    const defaultTeams = resolveRepositoryTeams("VOICEVOX/default", settings, directory);
    const overrideTeams = resolveRepositoryTeams("VOICEVOX/override", settings, directory);
    const decisions = [
      determineIssueState({
        ...createInput({
          ...createOpenIssue(),
          author: { status: "identified", actor: defaultMaintainer },
        }),
        teams: defaultTeams,
      }),
      determineIssueState({
        ...createInput({
          ...createOpenIssue(),
          author: { status: "identified", actor: defaultReviewer },
        }),
        teams: defaultTeams,
      }),
      determineIssueState({
        ...createInput({
          ...createOpenIssue(),
          author: { status: "identified", actor: overrideMaintainer },
        }),
        teams: overrideTeams,
      }),
      determineIssueState({
        ...createInput({
          ...createOpenIssue(),
          author: { status: "identified", actor: overrideReviewer },
        }),
        teams: overrideTeams,
      }),
    ];

    expect(
      decisions.map((decision) =>
        decision.waitingOn.map((waitingOn) => [
          waitingOn.kind,
          waitingOn.candidateId,
          waitingOn.role,
        ]),
      ),
    ).toEqual([
      [["team", "VOICEVOX/default-maintainers", "maintainer"]],
      [["team", "VOICEVOX/default-maintainers", "maintainer"]],
      [["team", "VOICEVOX/override-maintainers", "maintainer"]],
      [["team", "VOICEVOX/override-maintainers", "maintainer"]],
    ]);
  });

  it("botが作成したことだけを理由に既定責務を変えない", () => {
    const humanDecision = determineIssueState(createInput(createOpenIssue()));
    const botDecision = determineIssueState(
      createInput({
        ...createOpenIssue(),
        author: {
          status: "identified",
          actor: botAuthor,
        },
      }),
    );

    expect(botDecision.status).toBe(humanDecision.status);
    expect(botDecision.waitingOn).toEqual(humanDecision.waitingOn);
  });
});

describe("Issueのblockerとterminal", () => {
  it("openとclosedのblockerが混在するとopenだけをwaitingOnにする", () => {
    const assignment = createAssigneeEvent(
      "assigned",
      firstAssignee,
      createUtcIsoDateTime("2026-07-31T05:00:00Z"),
    );
    const requestEvent = createCommentEvent(
      "blocked-request-candidate",
      author,
      createUtcIsoDateTime("2026-07-31T06:00:00Z"),
    );
    const decision = determineIssueState({
      ...createInput({
        ...createOpenIssue(),
        assignees: [firstAssignee],
        events: [assignment, requestEvent],
      }),
      explicitRequestCandidates: [createRequestCandidate(requestEvent)],
      blockers: [
        createBlocker({
          candidateId: "VOICEVOX/core#1",
          state: "open",
          authority: "authoritative",
          confidence: 1,
          becameBlockingAt: createUtcIsoDateTime("2026-07-30T00:00:00Z"),
        }),
        createBlocker({
          candidateId: "VOICEVOX/core#2",
          state: "closed",
          authority: "authoritative",
          confidence: 1,
          becameBlockingAt: createUtcIsoDateTime("2026-07-29T00:00:00Z"),
        }),
      ],
    });

    expect(decision.status).toBe("waiting_for_unblock");
    expect(decision.waitingOn.map((value) => value.candidateId)).toEqual(["VOICEVOX/core#1"]);
    expect(decision.determination).toBe("determined");
  });

  it("複数のopen blockerを保持してprimaryの選定理由を返す", () => {
    const decision = determineIssueState({
      ...createInput(createOpenIssue()),
      blockers: [
        createBlocker({
          candidateId: "VOICEVOX/core#3",
          state: "open",
          authority: "inferred",
          confidence: 0.95,
          becameBlockingAt: createUtcIsoDateTime("2026-07-27T00:00:00Z"),
        }),
        createBlocker({
          candidateId: "VOICEVOX/core#2",
          state: "open",
          authority: "authoritative",
          confidence: 0.9,
          becameBlockingAt: createUtcIsoDateTime("2026-07-29T00:00:00Z"),
        }),
        createBlocker({
          candidateId: "VOICEVOX/core#1",
          state: "open",
          authority: "authoritative",
          confidence: 1,
          becameBlockingAt: createUtcIsoDateTime("2026-07-30T00:00:00Z"),
        }),
      ],
    });

    expect(decision.waitingOn.map((value) => value.candidateId)).toEqual([
      "VOICEVOX/core#1",
      "VOICEVOX/core#2",
      "VOICEVOX/core#3",
    ]);
    expect(decision.primaryWaitingOn).toEqual({
      index: 0,
      selectionReason:
        "authoritative、confidence、blockerになった時刻、candidate IDの順で選定しました",
    });
  });

  it.each([
    ["terminal_completed", "completed"],
    ["terminal_not_planned", "not_planned"],
  ] satisfies readonly (readonly [
    "terminal_completed" | "terminal_not_planned",
    "completed" | "not_planned",
  ])[])("%sを他のclosed状態と区別する", (expectedStatus, stateReason) => {
    const decision = determineIssueState(createInput(createClosedIssue(stateReason)));

    expect(decision.status).toBe(expectedStatus);
    expect(decision.waitingOn).toEqual([]);
    expect(decision.primaryWaitingOn.index).toBe("not_applicable");
  });

  it("terminalをblockerと明示依頼候補より優先する", () => {
    const requestEvent = createCommentEvent(
      "terminal-request-candidate",
      author,
      createUtcIsoDateTime("2026-07-31T06:00:00Z"),
    );
    const closedIssue = createClosedIssue("completed");
    const decision = determineIssueState({
      ...createInput({
        ...closedIssue,
        events: [...closedIssue.events, requestEvent],
      }),
      blockers: [
        createBlocker({
          candidateId: "VOICEVOX/core#1",
          state: "open",
          authority: "authoritative",
          confidence: 1,
          becameBlockingAt: createUtcIsoDateTime("2026-07-30T00:00:00Z"),
        }),
      ],
      explicitRequestCandidates: [createRequestCandidate(requestEvent)],
    });

    expect(decision.status).toBe("terminal_completed");
    expect(decision.waitingOn).toEqual([]);
    expect(decision.determination).toBe("determined");
  });
});

describe("Issueの明示依頼候補", () => {
  it("明示依頼らしき候補をCodex候補として印付けする", () => {
    const requestEvent = createCommentEvent(
      "request-candidate",
      author,
      createUtcIsoDateTime("2026-07-31T06:00:00Z"),
    );
    const assignment = createAssigneeEvent(
      "assigned",
      firstAssignee,
      createUtcIsoDateTime("2026-07-31T05:00:00Z"),
    );
    const decision = determineIssueState({
      ...createInput({
        ...createOpenIssue(),
        assignees: [firstAssignee],
        events: [assignment, requestEvent],
      }),
      explicitRequestCandidates: [createRequestCandidate(requestEvent)],
    });

    expect(decision.status).toBe("waiting_for_work");
    expect(decision.waitingOn[0]?.candidateId).toBe(firstAssignee.login);
    expect(decision.determination).toBe("codex_candidate");
    expect(decision.confidence).toBeLessThanOrEqual(0.65);
    expect(decision.uncertainties).toContain(
      "未回答の明示依頼らしき候補を決定論的に確定できません",
    );
    expect(decision.evidence).toContainEqual({
      sourceId: requestEvent.sourceId,
      supports: "uncertainty",
      summary: "未回答の明示依頼らしき候補を決定論的に確定できません",
    });
  });

  it("コメントで名指しされた第三者を返答待ちの回答者としてassigneeより優先する", () => {
    const requestEvent = createCommentEvent(
      "confirmed-request",
      author,
      createUtcIsoDateTime("2026-07-31T06:00:00Z"),
    );
    const assignment = createAssigneeEvent(
      "assigned-before-request",
      firstAssignee,
      createUtcIsoDateTime("2026-07-31T05:00:00Z"),
    );
    const decision = determineIssueState({
      ...createInput({
        ...createOpenIssue(),
        assignees: [firstAssignee],
        events: [assignment, requestEvent],
      }),
      explicitRequestCandidates: [createRequestCandidate(requestEvent)],
      explicitRequestAssessment: {
        status: "assessed",
        candidateSourceIds: [requestEvent.sourceId],
        verdict: "unanswered_request",
        requestSourceId: requestEvent.sourceId,
        targets: [
          {
            kind: "user",
            candidateId: requestedUser.login,
            role: "unknown",
            sourceIds: [requestEvent.sourceId],
            confidence: 0.95,
          },
        ],
        confidence: 0.95,
        sourceIds: [requestEvent.sourceId],
      },
    });

    expect(decision.status).toBe("waiting_for_reply");
    expect(decision.waitingOn).toEqual([
      expect.objectContaining({
        kind: "user",
        candidateId: requestedUser.login,
        role: "respondent",
      }),
    ]);
    expect(decision.determination).toBe("determined");
    expect(decision.responsibilityBasis).toEqual({
      sourceIds: [requestEvent.sourceId],
      occurredAt: requestEvent.occurredAt,
      precision: "inferred",
    });
  });

  it("名指しされた相手がassignee本人でも返答待ちの回答者とする", () => {
    const requestEvent = createCommentEvent(
      "assignee-request",
      author,
      createUtcIsoDateTime("2026-07-31T06:00:00Z"),
    );
    const assignment = createAssigneeEvent(
      "assigned-request-target",
      firstAssignee,
      createUtcIsoDateTime("2026-07-31T05:00:00Z"),
    );
    const decision = determineIssueState({
      ...createInput({
        ...createOpenIssue(),
        assignees: [firstAssignee],
        events: [assignment, requestEvent],
      }),
      explicitRequestCandidates: [createRequestCandidate(requestEvent)],
      explicitRequestAssessment: {
        status: "assessed",
        candidateSourceIds: [requestEvent.sourceId],
        verdict: "unanswered_request",
        requestSourceId: requestEvent.sourceId,
        targets: [
          {
            kind: "user",
            candidateId: firstAssignee.login,
            role: "assignee",
            sourceIds: [requestEvent.sourceId],
            confidence: 0.95,
          },
        ],
        confidence: 0.95,
        sourceIds: [requestEvent.sourceId],
      },
    });

    expect(decision.status).toBe("waiting_for_reply");
    expect(decision.waitingOn).toEqual([
      expect.objectContaining({
        kind: "user",
        candidateId: firstAssignee.login,
        role: "respondent",
      }),
    ]);
  });

  it("明示依頼先がmaintainer役割だけなら方針判断待ちを維持する", () => {
    const requestEvent = createCommentEvent(
      "maintainer-role-request",
      author,
      createUtcIsoDateTime("2026-07-31T06:00:00Z"),
    );
    const decision = determineIssueState({
      ...createInput({
        ...createOpenIssue(),
        events: [requestEvent],
      }),
      explicitRequestCandidates: [createRequestCandidate(requestEvent)],
      explicitRequestAssessment: {
        status: "assessed",
        candidateSourceIds: [requestEvent.sourceId],
        verdict: "unanswered_request",
        requestSourceId: requestEvent.sourceId,
        targets: [
          {
            kind: "role",
            candidateId: "maintainer",
            role: "maintainer",
            sourceIds: [requestEvent.sourceId],
            confidence: 0.95,
          },
        ],
        confidence: 0.95,
        sourceIds: [requestEvent.sourceId],
      },
    });

    expect(decision.status).toBe("waiting_for_decision");
    expect(decision.waitingOn).toEqual([
      expect.objectContaining({
        kind: "team",
        candidateId: "VOICEVOX/maintainers",
        role: "maintainer",
      }),
    ]);
  });

  it("名指しの根拠に選定した依頼のsourceがなければ回答者にしない", () => {
    const requestEvent = createCommentEvent(
      "request-without-target-source",
      author,
      createUtcIsoDateTime("2026-07-31T06:00:00Z"),
    );
    const unrelatedEvent = createCommentEvent(
      "unrelated-target-source",
      requestedUser,
      createUtcIsoDateTime("2026-07-31T07:00:00Z"),
    );

    expect(() =>
      determineIssueState({
        ...createInput({
          ...createOpenIssue(),
          events: [requestEvent, unrelatedEvent],
        }),
        explicitRequestCandidates: [createRequestCandidate(requestEvent)],
        explicitRequestAssessment: {
          status: "assessed",
          candidateSourceIds: [requestEvent.sourceId],
          verdict: "unanswered_request",
          requestSourceId: requestEvent.sourceId,
          targets: [
            {
              kind: "user",
              candidateId: requestedUser.login,
              role: "unknown",
              sourceIds: [unrelatedEvent.sourceId],
              confidence: 0.95,
            },
          ],
          confidence: 0.95,
          sourceIds: [requestEvent.sourceId, unrelatedEvent.sourceId],
        },
      }),
    ).toThrowError(
      `明示依頼先の根拠に選定した依頼のsource IDがありません。対象: ${requestedUser.login}`,
    );
  });

  it("低信頼の外部判定では明示依頼先へ責務を移さない", () => {
    const requestEvent = createCommentEvent(
      "low-confidence-request",
      author,
      createUtcIsoDateTime("2026-07-31T06:00:00Z"),
    );
    const assignment = createAssigneeEvent(
      "assigned-low-confidence",
      firstAssignee,
      createUtcIsoDateTime("2026-07-31T05:00:00Z"),
    );
    const decision = determineIssueState({
      ...createInput({
        ...createOpenIssue(),
        assignees: [firstAssignee],
        events: [assignment, requestEvent],
      }),
      explicitRequestCandidates: [createRequestCandidate(requestEvent)],
      explicitRequestAssessment: {
        status: "assessed",
        candidateSourceIds: [requestEvent.sourceId],
        verdict: "unanswered_request",
        requestSourceId: requestEvent.sourceId,
        targets: [
          {
            kind: "user",
            candidateId: requestedUser.login,
            role: "unknown",
            sourceIds: [requestEvent.sourceId],
            confidence: 0.5,
          },
        ],
        confidence: 0.5,
        sourceIds: [requestEvent.sourceId],
      },
    });

    expect(decision.waitingOn[0]?.candidateId).toBe(firstAssignee.login);
    expect(decision.determination).toBe("codex_candidate");
    expect(decision.confidence).toBe(0.5);
    expect(decision.uncertainties).toContain(
      "明示依頼の相手に関する外部判定の信頼度が低いため責務へ反映しません",
    );
  });

  it("未回答の依頼ではないという高信頼の外部判定後はassignee判定へ進む", () => {
    const requestEvent = createCommentEvent(
      "rejected-request",
      author,
      createUtcIsoDateTime("2026-07-31T06:00:00Z"),
    );
    const assignment = createAssigneeEvent(
      "assigned-rejected-request",
      firstAssignee,
      createUtcIsoDateTime("2026-07-31T05:00:00Z"),
    );
    const decision = determineIssueState({
      ...createInput({
        ...createOpenIssue(),
        assignees: [firstAssignee],
        events: [assignment, requestEvent],
      }),
      explicitRequestCandidates: [createRequestCandidate(requestEvent)],
      explicitRequestAssessment: {
        status: "assessed",
        candidateSourceIds: [requestEvent.sourceId],
        verdict: "no_unanswered_request",
        confidence: 0.95,
        sourceIds: [requestEvent.sourceId],
      },
    });

    expect(decision.waitingOn[0]?.candidateId).toBe(firstAssignee.login);
    expect(decision.determination).toBe("determined");
    expect(decision.uncertainties).toEqual([]);
  });
});
