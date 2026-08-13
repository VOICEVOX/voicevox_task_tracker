import { describe, expect, it } from "vitest";

import {
  buildSourceId,
  calculateStaleness,
  createGitHubNodeId,
  createLabelEffectsResolver,
  createUtcIsoDateTime,
  recalculateStalenessSeverity,
  resolveWaitingOnAccountIdentifiers,
  type CalculateStalenessInput,
  type DependencyResolutionProgress,
  type GitHubAccountActor,
  type NaturalLanguageProgressAssessment,
  type NormalizedEvent,
  type SeverityThresholds,
  type SourceId,
  type StateDecisionForStaleness,
  type Status,
  type UtcIsoDateTime,
  type WaitClass,
  type WaitingOn,
  type WaitingOnKind,
  type WaitingOnRole,
} from "../src/domain/index.js";

const CREATED_AT = createUtcIsoDateTime("2026-01-01T00:00:00Z");
const ITEM_NODE_ID = createGitHubNodeId("I_staleness");
const human = Object.freeze({
  type: "human",
  nodeId: createGitHubNodeId("U_human"),
  login: "human",
} satisfies GitHubAccountActor);
const thirdParty = Object.freeze({
  type: "human",
  nodeId: createGitHubNodeId("U_third_party"),
  login: "third-party",
} satisfies GitHubAccountActor);
const bot = Object.freeze({
  type: "bot",
  nodeId: createGitHubNodeId("B_preview"),
  login: "preview[bot]",
} satisfies GitHubAccountActor);
const thresholdsHours = Object.freeze({
  assessment: { watch: 48, urgent: 96, critical: 168 },
  owner: { watch: 48, urgent: 96, critical: 168 },
  decision: { watch: 48, urgent: 96, critical: 168 },
  review: { watch: 48, urgent: 120, critical: 240 },
  revision: { watch: 72, urgent: 168, critical: 336 },
  reply: { watch: 48, urgent: 120, critical: 240 },
  work: { watch: 168, urgent: 336, critical: 720 },
  merge: { watch: 24, urgent: 72, critical: 168 },
  automation: { watch: 6, urgent: 24, critical: 72 },
} satisfies SeverityThresholds);
const noLabelEffects = createLabelEffectsResolver([]);

type PullRequestLifecycleEvent = Extract<
  NormalizedEvent,
  {
    kind:
      | "ready_for_review"
      | "converted_to_draft"
      | "added_to_merge_queue"
      | "removed_from_merge_queue"
      | "auto_merge_enabled"
      | "auto_merge_disabled";
  }
>;

type DecisionOptions = Readonly<{
  status: Status;
  waitingOn: readonly WaitingOn[];
  statusAt: UtcIsoDateTime;
  ownerAt: UtcIsoDateTime;
  statusSourceId: SourceId;
  ownerSourceId: SourceId;
  precision: "event" | "inferred";
  confidence: number;
}>;

function addHours(value: UtcIsoDateTime, hours: number): UtcIsoDateTime {
  return createUtcIsoDateTime(new Date(Date.parse(value) + hours * 60 * 60 * 1000).toISOString());
}

function createSourceIds(sourceId: SourceId): readonly [SourceId] {
  return Object.freeze([sourceId]);
}

function createWaitingOn(
  kind: WaitingOnKind,
  candidateId: string,
  role: WaitingOnRole,
  sourceId: SourceId,
): WaitingOn {
  return Object.freeze({
    kind,
    candidateId,
    role,
    reasonSummary: "テスト用の待機根拠です",
    sourceIds: [sourceId],
    confidence: 1,
  } satisfies WaitingOn);
}

function createDecision(options: DecisionOptions): StateDecisionForStaleness {
  return Object.freeze({
    status: options.status,
    waitingOn: Object.freeze([...options.waitingOn]),
    confidence: options.confidence,
    statusBasis: Object.freeze({
      sourceIds: createSourceIds(options.statusSourceId),
      occurredAt: options.statusAt,
      precision: options.precision,
    }),
    responsibilityBasis: Object.freeze({
      sourceIds: createSourceIds(options.ownerSourceId),
      occurredAt: options.ownerAt,
      precision: options.precision,
    }),
  } satisfies StateDecisionForStaleness);
}

function createComment(
  sourceName: string,
  occurredAt: UtcIsoDateTime,
  actor: GitHubAccountActor,
): Extract<NormalizedEvent, { kind: "comment" }> {
  return Object.freeze({
    kind: "comment",
    sourceId: buildSourceId("comment", sourceName),
    itemNodeId: ITEM_NODE_ID,
    occurredAt,
    actor,
    bodyFingerprint: `sha256:${sourceName}`,
    bodyEmpty: false,
  });
}

function createReviewRequest(
  sourceName: string,
  occurredAt: UtcIsoDateTime,
): Extract<NormalizedEvent, { kind: "review_request" }> {
  return Object.freeze({
    kind: "review_request",
    sourceId: buildSourceId("review_request", sourceName),
    itemNodeId: ITEM_NODE_ID,
    occurredAt,
    actor: human,
    target: Object.freeze({
      type: "user",
      nodeId: createGitHubNodeId(`U_${sourceName}`),
    }),
    action: "added",
  } satisfies Extract<NormalizedEvent, { kind: "review_request" }>);
}

function createReview(
  sourceName: string,
  occurredAt: UtcIsoDateTime,
  actor: GitHubAccountActor,
  state: Extract<NormalizedEvent, { kind: "review" }>["state"],
): Extract<NormalizedEvent, { kind: "review" }> {
  return Object.freeze({
    kind: "review",
    sourceId: buildSourceId("review", sourceName),
    itemNodeId: ITEM_NODE_ID,
    occurredAt,
    actor,
    state,
    bodyFingerprint: `sha256:${sourceName}`,
    bodyEmpty: false,
    commitStatus: "available",
    commitSha: "0123456789abcdef",
  });
}

function createLabelEvent(
  sourceName: string,
  occurredAt: UtcIsoDateTime,
  labelName: string,
): Extract<NormalizedEvent, { kind: "label" }> {
  return Object.freeze({
    kind: "label",
    sourceId: buildSourceId("label", sourceName),
    itemNodeId: ITEM_NODE_ID,
    occurredAt,
    actor: human,
    labelName,
    action: "added",
  });
}

function createPush(
  sourceName: string,
  occurredAt: UtcIsoDateTime,
  actor: GitHubAccountActor,
): Extract<NormalizedEvent, { kind: "push" }> {
  return Object.freeze({
    kind: "push",
    sourceId: buildSourceId("push", sourceName),
    itemNodeId: ITEM_NODE_ID,
    occurredAt,
    actor,
    headCommitSha: sourceName,
    forcePush: false,
  });
}

function createBaseInput(): CalculateStalenessInput {
  const sourceId = buildSourceId("github_item", "staleness");
  const waitingOn = createWaitingOn("role", "maintainer", "maintainer", sourceId);
  return Object.freeze({
    createdAt: CREATED_AT,
    evaluatedAt: addHours(CREATED_AT, 24),
    currentDecision: createDecision({
      status: "waiting_for_assessment",
      waitingOn: [waitingOn],
      statusAt: CREATED_AT,
      ownerAt: CREATED_AT,
      statusSourceId: sourceId,
      ownerSourceId: sourceId,
      precision: "event",
      confidence: 1,
    }),
    decisionBasis: "deterministic",
    events: [],
    responsibleAccountIdentifiers: new Set<string>(),
    dependencyResolutions: [],
    naturalLanguageAssessments: [],
    minimumAiConfidence: 0.65,
    repositoryFullName: "VOICEVOX/example",
    currentLabels: [],
    resolveLabelEffects: noLabelEffects,
    thresholdsHours,
    blockedParentContext: {
      status: "not_applicable",
    },
  } satisfies CalculateStalenessInput);
}

function createResponsibleInput(waitingOn: WaitingOn): CalculateStalenessInput {
  const input = createBaseInput();
  const sourceId = waitingOn.sourceIds[0];
  return Object.freeze({
    ...input,
    currentDecision: createDecision({
      status: "waiting_for_assessment",
      waitingOn: [waitingOn],
      statusAt: CREATED_AT,
      ownerAt: CREATED_AT,
      statusSourceId: sourceId,
      ownerSourceId: sourceId,
      precision: "event",
      confidence: 1,
    }),
    responsibleAccountIdentifiers: resolveWaitingOnAccountIdentifiers([waitingOn]),
  });
}

function createCommentAssessment(
  event: Extract<NormalizedEvent, { kind: "comment" }>,
  verdict: NaturalLanguageProgressAssessment["verdict"],
  confidence: number,
): NaturalLanguageProgressAssessment {
  return Object.freeze({
    candidateSourceId: event.sourceId,
    verdict,
    confidence,
    sourceIds: [event.sourceId],
  } satisfies NaturalLanguageProgressAssessment);
}

describe("停滞時間", () => {
  it("責務主体本人のコメントでstallSinceを更新する", () => {
    const sourceId = buildSourceId("responsibility", "human-login");
    const waitingOn = createWaitingOn("user", human.login, "maintainer", sourceId);
    const input = createResponsibleInput(waitingOn);
    const commentedAt = addHours(CREATED_AT, 30);
    const comment = createComment("responsible-human", commentedAt, human);
    const result = calculateStaleness({
      ...input,
      evaluatedAt: addHours(CREATED_AT, 72),
      events: [comment],
    });

    expect(result.stallSince).toBe(commentedAt);
    expect(result.lastProgressAt).toBe(CREATED_AT);
    expect(result.lastHumanActivityAt).toBe(commentedAt);
    expect(result.elapsedHours.stall).toBe(42);
  });

  it("第三者の人間コメントではstallSinceを更新しない", () => {
    const sourceId = buildSourceId("responsibility", "third-party");
    const waitingOn = createWaitingOn("user", human.login, "maintainer", sourceId);
    const input = createResponsibleInput(waitingOn);
    const commentedAt = addHours(CREATED_AT, 30);
    const comment = createComment("third-party", commentedAt, thirdParty);
    const result = calculateStaleness({
      ...input,
      evaluatedAt: addHours(CREATED_AT, 72),
      events: [comment],
    });

    expect(result.stallSince).toBe(CREATED_AT);
    expect(result.lastProgressAt).toBe(CREATED_AT);
    expect(result.lastHumanActivityAt).toBe(commentedAt);
    expect(result.elapsedHours.stall).toBe(72);
  });

  it("責務主体と識別子が一致するbotコメントではstallSinceを更新しない", () => {
    const sourceId = buildSourceId("responsibility", "bot");
    const waitingOn = createWaitingOn("user", bot.login, "maintainer", sourceId);
    const input = createResponsibleInput(waitingOn);
    const botComment = createComment("preview-update", addHours(CREATED_AT, 30), bot);
    const result = calculateStaleness({
      ...input,
      evaluatedAt: addHours(CREATED_AT, 72),
      events: [botComment],
    });

    expect(result.stallSince).toBe(CREATED_AT);
    expect(result.lastProgressAt).toBe(CREATED_AT);
    expect(result.lastHumanActivityAt).toBe(CREATED_AT);
    expect(result.naturalLanguageProgressCandidates).toEqual([]);
    expect(result.elapsedHours.stall).toBe(72);
  });

  it("candidateIdがnode IDでも責務主体本人のコメントでstallSinceを更新する", () => {
    const sourceId = buildSourceId("responsibility", "human-node-id");
    const waitingOn = createWaitingOn("user", human.nodeId, "maintainer", sourceId);
    const input = createResponsibleInput(waitingOn);
    const commentedAt = addHours(CREATED_AT, 30);
    const comment = createComment("responsible-human-node-id", commentedAt, human);
    const result = calculateStaleness({
      ...input,
      evaluatedAt: addHours(CREATED_AT, 72),
      events: [comment],
    });

    expect(result.stallSince).toBe(commentedAt);
    expect(result.lastProgressAt).toBe(CREATED_AT);
  });

  it("team候補は責務アカウントを持たない", () => {
    const sourceId = buildSourceId("responsibility", "team");
    const waitingOn = createWaitingOn("team", "voicevox/ReViEwErS", "reviewer", sourceId);
    const input = createResponsibleInput(waitingOn);
    const memberCommentedAt = addHours(CREATED_AT, 30);
    const thirdPartyCommentedAt = addHours(CREATED_AT, 40);
    const result = calculateStaleness({
      ...input,
      evaluatedAt: addHours(CREATED_AT, 72),
      events: [
        createComment("team-member", memberCommentedAt, human),
        createComment("team-non-member", thirdPartyCommentedAt, thirdParty),
      ],
    });

    expect(result.stallSince).toBe(CREATED_AT);
    expect(result.lastProgressAt).toBe(CREATED_AT);
    expect(result.lastHumanActivityAt).toBe(thirdPartyCommentedAt);
  });

  it("責務主体本人のconverted_to_draftではstallSinceを更新しない", () => {
    const sourceId = buildSourceId("responsibility", "converted-to-draft");
    const waitingOn = createWaitingOn("user", human.login, "maintainer", sourceId);
    const input = createResponsibleInput(waitingOn);
    const convertedAt = addHours(CREATED_AT, 30);
    const convertedToDraft = Object.freeze({
      kind: "converted_to_draft",
      sourceId: buildSourceId("pull_request_lifecycle", "converted-to-draft"),
      itemNodeId: ITEM_NODE_ID,
      occurredAt: convertedAt,
      actor: human,
    } satisfies PullRequestLifecycleEvent);
    const result = calculateStaleness({
      ...input,
      evaluatedAt: addHours(CREATED_AT, 72),
      events: [convertedToDraft],
    });

    expect(result.stallSince).toBe(CREATED_AT);
    expect(result.lastProgressAt).toBe(CREATED_AT);
    expect(result.lastHumanActivityAt).toBe(CREATED_AT);
    expect(result.elapsedHours.stall).toBe(72);
  });

  it("Pull Request固有イベントを進捗とhuman活動へ反映しない", () => {
    const input = createBaseInput();
    const kinds = Object.freeze([
      "ready_for_review",
      "converted_to_draft",
      "added_to_merge_queue",
      "removed_from_merge_queue",
      "auto_merge_enabled",
      "auto_merge_disabled",
    ] satisfies readonly PullRequestLifecycleEvent["kind"][]);
    const events = kinds.map((kind, index) =>
      Object.freeze({
        kind,
        sourceId: buildSourceId("pull_request_lifecycle", kind),
        itemNodeId: ITEM_NODE_ID,
        occurredAt: addHours(CREATED_AT, index + 1),
        actor: human,
      } satisfies PullRequestLifecycleEvent),
    );

    const result = calculateStaleness({
      ...input,
      events,
    });

    expect(result.stallSince).toBe(CREATED_AT);
    expect(result.lastProgressAt).toBe(CREATED_AT);
    expect(result.lastHumanActivityAt).toBe(CREATED_AT);
    expect(result.meaningfulProgress).toEqual([]);
  });

  it("maintainerからreviewerへの責務移動をreview request時刻へ反映する", () => {
    const input = createBaseInput();
    const requestedAt = addHours(CREATED_AT, 36);
    const reviewRequest = createReviewRequest("reviewer", requestedAt);
    const reviewer = createWaitingOn("user", "reviewer", "reviewer", reviewRequest.sourceId);
    const result = calculateStaleness({
      ...input,
      evaluatedAt: addHours(CREATED_AT, 60),
      currentDecision: createDecision({
        status: "waiting_for_review",
        waitingOn: [reviewer],
        statusAt: requestedAt,
        ownerAt: requestedAt,
        statusSourceId: reviewRequest.sourceId,
        ownerSourceId: reviewRequest.sourceId,
        precision: "event",
        confidence: 1,
      }),
      events: [reviewRequest],
    });

    expect(result.statusSince).toBe(requestedAt);
    expect(result.ownerSince).toBe(requestedAt);
    expect(result.stallSince).toBe(requestedAt);
    expect(result.lastProgressAt).toBe(CREATED_AT);
    expect(result.lastHumanActivityAt).toBe(requestedAt);
    expect(result.elapsedHours).toEqual({
      status: 24,
      owner: 24,
      stall: 24,
    });
  });

  it("同じstatusでもwaitingOnの実体が変わればownerSinceとstallSinceを更新する", () => {
    const input = createBaseInput();
    const firstRequest = createReviewRequest("first-reviewer", addHours(CREATED_AT, 12));
    const secondRequest = createReviewRequest("second-reviewer", addHours(CREATED_AT, 30));
    const secondReviewer = createWaitingOn(
      "user",
      "second-reviewer",
      "reviewer",
      secondRequest.sourceId,
    );
    const result = calculateStaleness({
      ...input,
      evaluatedAt: addHours(CREATED_AT, 48),
      currentDecision: createDecision({
        status: "waiting_for_review",
        waitingOn: [secondReviewer],
        statusAt: firstRequest.occurredAt,
        ownerAt: secondRequest.occurredAt,
        statusSourceId: firstRequest.sourceId,
        ownerSourceId: secondRequest.sourceId,
        precision: "event",
        confidence: 1,
      }),
      events: [firstRequest, secondRequest],
    });

    expect(result.statusSince).toBe(firstRequest.occurredAt);
    expect(result.ownerSince).toBe(secondRequest.occurredAt);
    expect(result.stallSince).toBe(secondRequest.occurredAt);
  });

  it("waitingOnが同じでもstatusが変わればownerSinceとstallSinceを更新する", () => {
    const input = createBaseInput();
    const changedAt = addHours(CREATED_AT, 30);
    const sourceId = buildSourceId("status", "maintainer-decision");
    const maintainer = createWaitingOn("role", "maintainer", "maintainer", sourceId);
    const result = calculateStaleness({
      ...input,
      evaluatedAt: addHours(CREATED_AT, 48),
      currentDecision: createDecision({
        status: "waiting_for_decision",
        waitingOn: [maintainer],
        statusAt: changedAt,
        ownerAt: CREATED_AT,
        statusSourceId: sourceId,
        ownerSourceId: sourceId,
        precision: "event",
        confidence: 1,
      }),
    });

    expect(result.statusSince).toBe(changedAt);
    expect(result.ownerSince).toBe(changedAt);
    expect(result.stallSince).toBe(changedAt);
  });

  it("雑談コメントと回答コメントでlastProgressAtを区別する", () => {
    const input = createBaseInput();
    const commentedAt = addHours(CREATED_AT, 30);
    const comment = createComment("answer-candidate", commentedAt, human);
    const chatter = calculateStaleness({
      ...input,
      evaluatedAt: addHours(CREATED_AT, 72),
      events: [comment],
      naturalLanguageAssessments: [
        createCommentAssessment(comment, "not_meaningful_progress", 0.95),
      ],
    });
    const answer = calculateStaleness({
      ...input,
      evaluatedAt: addHours(CREATED_AT, 72),
      events: [comment],
      naturalLanguageAssessments: [createCommentAssessment(comment, "meaningful_progress", 0.95)],
    });

    expect(chatter.lastProgressAt).toBe(CREATED_AT);
    expect(chatter.stallSince).toBe(CREATED_AT);
    expect(answer.lastProgressAt).toBe(commentedAt);
    expect(answer.stallSince).toBe(commentedAt);
    expect(chatter.lastHumanActivityAt).toBe(commentedAt);
    expect(answer.lastHumanActivityAt).toBe(commentedAt);
    expect(answer.naturalLanguageProgressCandidates).toEqual([
      {
        kind: "human_comment",
        sourceId: comment.sourceId,
        occurredAt: commentedAt,
      },
    ]);
  });

  it("低confidenceの自然言語判定だけではstallSinceを更新しない", () => {
    const input = createBaseInput();
    const comment = createComment("low-confidence-answer", addHours(CREATED_AT, 30), human);
    const result = calculateStaleness({
      ...input,
      evaluatedAt: addHours(CREATED_AT, 72),
      events: [comment],
      naturalLanguageAssessments: [createCommentAssessment(comment, "meaningful_progress", 0.64)],
    });

    expect(result.lastProgressAt).toBe(CREATED_AT);
    expect(result.stallSince).toBe(CREATED_AT);
  });

  it("push、human review、依存解消をCodexなしで進捗にする", () => {
    const input = createBaseInput();
    const push = createPush("artifact", addHours(CREATED_AT, 10), bot);
    const review = createReview("approval", addHours(CREATED_AT, 20), human, "approved");
    const dependencyResolvedAt = addHours(CREATED_AT, 30);
    const dependencySourceId = buildSourceId("dependency", "resolved");
    const result = calculateStaleness({
      ...input,
      evaluatedAt: addHours(CREATED_AT, 48),
      events: [push, review],
      dependencyResolutions: [
        {
          occurredAt: dependencyResolvedAt,
          sourceIds: [dependencySourceId],
        },
      ],
    });

    expect(result.lastProgressAt).toBe(dependencyResolvedAt);
    expect(result.stallSince).toBe(dependencyResolvedAt);
    expect(result.meaningfulProgress.map((progress) => progress.kind)).toEqual([
      "push",
      "human_review",
      "dependency_resolved",
    ]);
    expect(
      result.meaningfulProgress.every((progress) => progress.determination === "deterministic"),
    ).toBe(true);
  });

  it("同じイベント列を再計算してもsnapshotなしで同じ結果を返す", () => {
    const input = createBaseInput();
    const push = createPush("cold-warm-push", addHours(CREATED_AT, 10), bot);
    const review = createReview("cold-warm-review", addHours(CREATED_AT, 20), human, "approved");
    const dependencyResolvedAt = addHours(CREATED_AT, 30);
    const dependencyResolution = Object.freeze({
      occurredAt: dependencyResolvedAt,
      sourceIds: [buildSourceId("dependency", "cold-warm")],
    } satisfies DependencyResolutionProgress);
    const first = calculateStaleness({
      ...input,
      evaluatedAt: addHours(CREATED_AT, 48),
      events: [push, review],
      dependencyResolutions: [dependencyResolution],
    });
    const second = calculateStaleness({
      ...input,
      evaluatedAt: addHours(CREATED_AT, 48),
      events: [push, review],
      dependencyResolutions: [dependencyResolution],
    });

    expect(second).toEqual(first);
  });

  it("イベント入力順を変えても進捗の順序と時刻を安定して返す", () => {
    const input = createBaseInput();
    const occurredAt = addHours(CREATED_AT, 10);
    const push = createPush("ordered-push", occurredAt, bot);
    const review = createReview("ordered-review", occurredAt, human, "approved");
    const dependencyResolution = Object.freeze({
      occurredAt: addHours(CREATED_AT, 20),
      sourceIds: [buildSourceId("dependency", "ordered")],
    } satisfies DependencyResolutionProgress);
    const first = calculateStaleness({
      ...input,
      evaluatedAt: addHours(CREATED_AT, 48),
      events: [push, review],
      dependencyResolutions: [dependencyResolution],
    });
    const second = calculateStaleness({
      ...input,
      evaluatedAt: addHours(CREATED_AT, 48),
      events: [review, push],
      dependencyResolutions: [dependencyResolution],
    });

    expect(second).toEqual(first);
    expect(first.meaningfulProgress.map((progress) => progress.sourceIds[0])).toEqual([
      push.sourceId,
      review.sourceId,
      dependencyResolution.sourceIds[0],
    ]);
    expect(first.lastProgressAt).toBe(dependencyResolution.occurredAt);
    expect(first.stallSince).toBe(dependencyResolution.occurredAt);
  });

  it("設定で進捗扱いしたラベルだけstallSinceを更新する", () => {
    const input = createBaseInput();
    const resolver = createLabelEffectsResolver([
      {
        repository: "VOICEVOX/*",
        namePattern: "^進捗確認済み$",
        effects: {
          countsAsProgress: true,
        },
      },
    ]);
    const labelEvent = createLabelEvent("progress-label", addHours(CREATED_AT, 30), "進捗確認済み");
    const result = calculateStaleness({
      ...input,
      evaluatedAt: addHours(CREATED_AT, 48),
      events: [labelEvent],
      currentLabels: ["進捗確認済み"],
      resolveLabelEffects: resolver,
    });

    expect(result.lastProgressAt).toBe(labelEvent.occurredAt);
    expect(result.stallSince).toBe(labelEvent.occurredAt);
    expect(result.meaningfulProgress[0]?.kind).toBe("configured_label");
  });
});

type WaitClassFixture = Readonly<{
  waitClass: WaitClass;
  status: Status;
  waitingKind: WaitingOnKind;
  candidateId: string;
  waitingRole: WaitingOnRole;
  precision: "event" | "inferred";
}>;

const waitClassFixtures = Object.freeze([
  {
    waitClass: "assessment",
    status: "waiting_for_assessment",
    waitingKind: "role",
    candidateId: "maintainer",
    waitingRole: "maintainer",
    precision: "event",
  },
  {
    waitClass: "owner",
    status: "waiting_for_owner",
    waitingKind: "role",
    candidateId: "maintainer",
    waitingRole: "maintainer",
    precision: "inferred",
  },
  {
    waitClass: "decision",
    status: "waiting_for_decision",
    waitingKind: "role",
    candidateId: "maintainer",
    waitingRole: "maintainer",
    precision: "inferred",
  },
  {
    waitClass: "review",
    status: "waiting_for_review",
    waitingKind: "team",
    candidateId: "VOICEVOX/reviewers",
    waitingRole: "reviewer",
    precision: "event",
  },
  {
    waitClass: "revision",
    status: "waiting_for_revision",
    waitingKind: "role",
    candidateId: "author",
    waitingRole: "author",
    precision: "event",
  },
  {
    waitClass: "reply",
    status: "waiting_for_reply",
    waitingKind: "user",
    candidateId: "respondent",
    waitingRole: "respondent",
    precision: "inferred",
  },
  {
    waitClass: "work",
    status: "waiting_for_work",
    waitingKind: "user",
    candidateId: "assignee",
    waitingRole: "assignee",
    precision: "event",
  },
  {
    waitClass: "merge",
    status: "waiting_for_merge",
    waitingKind: "role",
    candidateId: "maintainer",
    waitingRole: "merge_decider",
    precision: "inferred",
  },
  {
    waitClass: "automation",
    status: "waiting_for_automation",
    waitingKind: "automation",
    candidateId: "required_checks",
    waitingRole: "ci",
    precision: "inferred",
  },
] satisfies readonly WaitClassFixture[]);

function getWaitClassFixture(waitClass: WaitClass): WaitClassFixture {
  const fixture = waitClassFixtures.find((candidate) => candidate.waitClass === waitClass);
  if (fixture == null) {
    throw new Error(`wait class fixtureがありません: ${waitClass}`);
  }
  return fixture;
}

function createWaitClassInput(
  fixture: WaitClassFixture,
  elapsedHours: number,
): CalculateStalenessInput {
  const base = createBaseInput();
  const sourceId = buildSourceId("wait_class", fixture.waitClass);
  const waitingOn = createWaitingOn(
    fixture.waitingKind,
    fixture.candidateId,
    fixture.waitingRole,
    sourceId,
  );
  const events =
    fixture.waitClass === "revision"
      ? [createReview(fixture.waitClass, CREATED_AT, human, "changes_requested")]
      : [];
  const basisSourceId = events[0]?.sourceId ?? sourceId;
  return Object.freeze({
    ...base,
    evaluatedAt: addHours(CREATED_AT, elapsedHours),
    currentDecision: createDecision({
      status: fixture.status,
      waitingOn: [waitingOn],
      statusAt: CREATED_AT,
      ownerAt: CREATED_AT,
      statusSourceId: basisSourceId,
      ownerSourceId: basisSourceId,
      precision: fixture.precision,
      confidence: 1,
    }),
    events,
  });
}

describe("wait classとseverity", () => {
  it("待ち先不明を担当決め待ちと同じownerへ分類する", () => {
    const input = createBaseInput();
    const sourceId = buildSourceId("wait_class", "unknown-owner");
    const waitingOn = createWaitingOn("unknown", "unknown", "unknown", sourceId);
    const result = calculateStaleness({
      ...input,
      currentDecision: createDecision({
        status: "unknown",
        waitingOn: [waitingOn],
        statusAt: CREATED_AT,
        ownerAt: CREATED_AT,
        statusSourceId: sourceId,
        ownerSourceId: sourceId,
        precision: "inferred",
        confidence: 1,
      }),
    });

    expect(result.waitClass).toBe("owner");
  });

  it("保存済みの算出条件からrun時刻までseverityを進める", () => {
    const fixture = getWaitClassFixture("assessment");
    const threshold = thresholdsHours.assessment.watch;
    const input = createWaitClassInput(fixture, threshold - 1);
    const initial = calculateStaleness(input);
    const recalculated = recalculateStalenessSeverity({
      evaluatedAt: addHours(CREATED_AT, threshold),
      stallSince: initial.stallSince,
      confidence: input.currentDecision.confidence,
      minimumAiConfidence: input.minimumAiConfidence,
      repositoryFullName: input.repositoryFullName,
      currentLabels: input.currentLabels,
      resolveLabelEffects: input.resolveLabelEffects,
      thresholdsHours: input.thresholdsHours,
      severityContext: initial.severityContext,
    });

    expect(initial.severity).toBe("none");
    expect(recalculated).toMatchObject({
      elapsedHours: threshold,
      waitClass: "assessment",
      severity: "watch",
    });
  });

  it("各wait classへ設定した閾値を境界時刻から適用する", () => {
    for (const fixture of waitClassFixtures) {
      const threshold = thresholdsHours[fixture.waitClass];
      const beforeWatch = calculateStaleness(
        createWaitClassInput(fixture, Math.max(0, threshold.watch - 0.001)),
      );
      const watch = calculateStaleness(createWaitClassInput(fixture, threshold.watch));
      const urgent = calculateStaleness(createWaitClassInput(fixture, threshold.urgent));
      const critical = calculateStaleness(createWaitClassInput(fixture, threshold.critical));

      expect(beforeWatch.waitClass, fixture.waitClass).toBe(fixture.waitClass);
      expect(beforeWatch.severity, fixture.waitClass).toBe("none");
      expect(watch.severity, fixture.waitClass).toBe("watch");
      expect(urgent.severity, fixture.waitClass).toBe("urgent");
      expect(critical.severity, fixture.waitClass).toBe("critical");
      expect(critical.severityReason, fixture.waitClass).toMatchObject({
        kind: "elapsed_threshold",
        crossedThreshold: {
          status: "reached",
          severity: "critical",
          thresholdHours: threshold.critical,
        },
      });
    }
  });

  it("優先度ラベル追加ではseverityだけを最大1段階引き上げる", () => {
    const base = createWaitClassInput(getWaitClassFixture("assessment"), 60);
    const initial = calculateStaleness(base);
    const labelEvent = createLabelEvent("priority", addHours(CREATED_AT, 66), "優先度：高");
    const resolver = createLabelEffectsResolver([
      {
        repository: "VOICEVOX/*",
        namePattern: "^優先度",
        effects: {
          severityLift: 1,
        },
      },
      {
        repository: "VOICEVOX/example",
        namePattern: "高$",
        effects: {
          severityLift: 1,
        },
      },
    ]);
    const result = calculateStaleness({
      ...base,
      evaluatedAt: addHours(CREATED_AT, 72),
      events: [labelEvent],
      currentLabels: ["優先度：高"],
      resolveLabelEffects: resolver,
    });

    expect(initial.severity).toBe("watch");
    expect(result.severity).toBe("urgent");
    expect(result.stallSince).toBe(CREATED_AT);
    expect(result.lastProgressAt).toBe(CREATED_AT);
    expect(result.severityReason).toMatchObject({
      kind: "elapsed_threshold",
      baseSeverity: "watch",
      labelLiftRequested: 1,
      labelLiftApplied: 1,
    });
  });

  it("決定論的判定は両basisがinferredでもcriticalを許可する", () => {
    const fixture = getWaitClassFixture("review");
    const input = createWaitClassInput(fixture, thresholdsHours.review.critical);
    const inferredDecision = createDecision({
      ...input.currentDecision,
      statusAt: CREATED_AT,
      ownerAt: CREATED_AT,
      statusSourceId: input.currentDecision.statusBasis.sourceIds[0],
      ownerSourceId: input.currentDecision.responsibilityBasis.sourceIds[0],
      precision: "inferred",
      confidence: 0.64,
    });
    const result = calculateStaleness({
      ...input,
      currentDecision: inferredDecision,
      decisionBasis: "deterministic",
    });

    expect(result.severity).toBe("critical");
    expect(result.severityContext.decisionBasis).toBe("deterministic");
  });

  it("低信頼のCodex由来判定だけを根拠にcriticalへしない", () => {
    const fixture = getWaitClassFixture("review");
    const input = createWaitClassInput(fixture, thresholdsHours.review.critical);
    const inferredDecision = createDecision({
      ...input.currentDecision,
      statusAt: CREATED_AT,
      ownerAt: CREATED_AT,
      statusSourceId: input.currentDecision.statusBasis.sourceIds[0],
      ownerSourceId: input.currentDecision.responsibilityBasis.sourceIds[0],
      precision: "inferred",
      confidence: 0.64,
    });
    const result = calculateStaleness({
      ...input,
      currentDecision: inferredDecision,
      decisionBasis: "ai_only",
    });

    expect(result.severity).toBe("urgent");
    expect(result.severityContext.decisionBasis).toBe("ai_only");
    expect(result.severityReason).toMatchObject({
      kind: "elapsed_threshold",
      baseSeverity: "critical",
      criticalSuppressed: true,
    });
  });

  it("blocked親は自身の経過時間でseverityを上げずblocker順位を返す", () => {
    const base = createBaseInput();
    const firstSourceId = buildSourceId("blocker", "first");
    const secondSourceId = buildSourceId("blocker", "second");
    const first = createWaitingOn("item", "VOICEVOX/a#1", "dependency", firstSourceId);
    const second = createWaitingOn("item", "VOICEVOX/b#2", "dependency", secondSourceId);
    const result = calculateStaleness({
      ...base,
      evaluatedAt: addHours(CREATED_AT, 1000),
      currentDecision: createDecision({
        status: "waiting_for_unblock",
        waitingOn: [first, second],
        statusAt: CREATED_AT,
        ownerAt: CREATED_AT,
        statusSourceId: firstSourceId,
        ownerSourceId: firstSourceId,
        precision: "event",
        confidence: 1,
      }),
      blockedParentContext: {
        status: "available",
        blockers: [
          {
            candidateId: "VOICEVOX/a#1",
            severity: "urgent",
            downstreamImpact: 10,
          },
          {
            candidateId: "VOICEVOX/b#2",
            severity: "critical",
            downstreamImpact: 2,
          },
        ],
      },
    });

    expect(result.waitClass).toBe("blockedParent");
    expect(result.severity).toBe("none");
    expect(result.severityReason).toMatchObject({
      kind: "blocked_parent",
      blockerRanking: [
        {
          candidateId: "VOICEVOX/b#2",
          severity: "critical",
          downstreamImpact: 2,
        },
        {
          candidateId: "VOICEVOX/a#1",
          severity: "urgent",
          downstreamImpact: 10,
        },
      ],
    });
  });
});
