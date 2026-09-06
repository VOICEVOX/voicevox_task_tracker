import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildSourceId,
  calculateStaleness,
  createGitHubNodeId,
  createLabelEffectsResolver,
  createUtcIsoDateTime,
  determinePullRequestState,
  type FreshObservedGitHubPullRequest,
  type GitHubAccountActor,
  type NormalizedEvent,
  type PreviousStalenessState,
  type PullRequestStateDecision,
  type SeverityThresholds,
  type SourceId,
  type StalenessResult,
  type StalenessState,
  type StalenessTransitionBasis,
  type Status,
  type TrackedItemType,
  type UtcIsoDateTime,
  type WaitingOn,
} from "../domain/index.js";

const itemNodeId = createGitHubNodeId("test-item");
const authorNodeId = createGitHubNodeId("test-author");
const reviewerNodeId = createGitHubNodeId("test-reviewer");
const thirdPartyNodeId = createGitHubNodeId("test-third-party");
const botNodeId = createGitHubNodeId("test-bot");

const author = createAccountActor("human", authorNodeId, "author");
const reviewer = createAccountActor("human", reviewerNodeId, "reviewer");
const thirdParty = createAccountActor("human", thirdPartyNodeId, "third-party");
const bot = createAccountActor("bot", botNodeId, "bot");

const createdAt = timestamp("2026-01-01T00:00:00Z");
const statusSince = timestamp("2026-01-01T02:00:00Z");
const ownerSince = timestamp("2026-01-01T03:00:00Z");
const initialStallSince = timestamp("2026-01-01T04:00:00Z");
const activityAt = timestamp("2026-01-01T10:00:00Z");
const commentAt = timestamp("2026-01-01T12:00:00Z");
const reviewAt = timestamp("2026-01-01T14:00:00Z");
const evaluatedAt = timestamp("2026-01-03T00:00:00Z");

const thresholdsHours = createSeverityThresholds();
const resolveLabelEffects = createLabelEffectsResolver([]);

type EventByKind<Kind extends NormalizedEvent["kind"]> = Extract<NormalizedEvent, { kind: Kind }>;
type ReviewEvent = EventByKind<"review">;
type ReviewRequestEvent = EventByKind<"review_request">;
type StalenessTimes = Pick<
  StalenessState,
  "statusSince" | "ownerSince" | "stallSince" | "lastProgressAt" | "lastHumanActivityAt"
>;
type Fixture = Readonly<{
  itemType: TrackedItemType;
  status: Status;
  waitingOn: readonly WaitingOn[];
  statusBasis: StalenessTransitionBasis;
  responsibilityBasis: StalenessTransitionBasis;
  previousState: PreviousStalenessState;
  events: readonly NormalizedEvent[];
  responsibleAccountIdentifiers: ReadonlySet<string>;
}>;

function timestamp(value: string): UtcIsoDateTime {
  return createUtcIsoDateTime(value);
}

function source(value: string): SourceId {
  return buildSourceId("test", value);
}

function oneSourceId(value: SourceId): readonly [SourceId, ...SourceId[]] {
  const values: [SourceId] = [value];
  return Object.freeze(values);
}

function createAccountActor(
  type: GitHubAccountActor["type"],
  nodeId: GitHubAccountActor["nodeId"],
  login: string,
): GitHubAccountActor {
  return Object.freeze({ type, nodeId, login });
}

function createWaitingOn(
  kind: WaitingOn["kind"],
  candidateId: string,
  role: WaitingOn["role"],
  sourceId: SourceId,
): WaitingOn {
  return Object.freeze({
    kind,
    candidateId,
    role,
    reasonSummary: "テストの待機相手です",
    sourceIds: oneSourceId(sourceId),
    confidence: 1,
  });
}

function createBasis(
  sourceId: SourceId,
  occurredAt: UtcIsoDateTime,
  precision: StalenessTransitionBasis["precision"],
): StalenessTransitionBasis {
  return Object.freeze({
    sourceIds: oneSourceId(sourceId),
    occurredAt,
    precision,
  });
}

function createPushEvent(
  id: string,
  occurredAt: UtcIsoDateTime,
  actor: GitHubAccountActor,
): EventByKind<"push"> {
  return Object.freeze({
    kind: "push",
    sourceId: source(id),
    itemNodeId,
    occurredAt,
    actor,
    headCommitSha: `sha-${id}`,
    forcePush: false,
  });
}

function createCommentEvent(
  id: string,
  occurredAt: UtcIsoDateTime,
  actor: GitHubAccountActor,
): EventByKind<"comment"> {
  return Object.freeze({
    kind: "comment",
    sourceId: source(id),
    itemNodeId,
    occurredAt,
    actor,
    bodyFingerprint: `body-${id}`,
    bodyEmpty: true,
  });
}

function createReviewEvent(
  id: string,
  occurredAt: UtcIsoDateTime,
  actor: GitHubAccountActor,
  state: ReviewEvent["state"],
): ReviewEvent {
  return Object.freeze({
    kind: "review",
    sourceId: source(id),
    itemNodeId,
    occurredAt,
    actor,
    state,
    bodyFingerprint: `body-${id}`,
    bodyEmpty: true,
    commitStatus: "unavailable",
  });
}

function createReviewRequestEvent(
  id: string,
  occurredAt: UtcIsoDateTime,
  actor: GitHubAccountActor,
  target: ReviewRequestEvent["target"],
): ReviewRequestEvent {
  return Object.freeze({
    kind: "review_request",
    sourceId: source(id),
    itemNodeId,
    occurredAt,
    actor,
    target,
    action: "added",
  });
}

type ProductionReviewRequestFixture = Readonly<{
  requestSourceId: SourceId;
  requestEventSourceId: SourceId;
  reviewer: GitHubAccountActor;
  requestedAt: UtcIsoDateTime;
}>;

function productionSource(
  kind:
    | "github_commit"
    | "github_item"
    | "github_pull_request_review"
    | "github_review_request"
    | "github_timeline_event",
  value: string,
): SourceId {
  return buildSourceId(kind, value);
}

function createProductionReviewRequestFixture(
  reviewer: GitHubAccountActor,
  requestId: string,
  requestEventId: string,
  requestedAt: UtcIsoDateTime,
): ProductionReviewRequestFixture {
  return Object.freeze({
    requestSourceId: productionSource("github_review_request", requestId),
    requestEventSourceId: productionSource("github_timeline_event", requestEventId),
    reviewer,
    requestedAt,
  });
}

function createProductionReviewRequest(
  fixture: ProductionReviewRequestFixture,
): FreshObservedGitHubPullRequest["reviewRequests"][number] {
  return Object.freeze({
    sourceId: fixture.requestSourceId,
    nodeId: createGitHubNodeId(`review-request-${fixture.requestSourceId}`),
    target: Object.freeze({ type: "user", actor: fixture.reviewer }),
    requestedAt: Object.freeze({ status: "available", value: fixture.requestedAt }),
  });
}

function createProductionReviewRequestEvent(
  fixture: ProductionReviewRequestFixture,
): ReviewRequestEvent {
  return Object.freeze({
    kind: "review_request",
    sourceId: fixture.requestEventSourceId,
    itemNodeId,
    occurredAt: fixture.requestedAt,
    actor: author,
    target: Object.freeze({ type: "user", nodeId: fixture.reviewer.nodeId }),
    action: "added",
  });
}

function createProductionReviewEvent(
  id: string,
  occurredAt: UtcIsoDateTime,
  actor: GitHubAccountActor,
  state: ReviewEvent["state"],
  commitSha: string,
): ReviewEvent {
  return Object.freeze({
    kind: "review",
    sourceId: productionSource("github_pull_request_review", id),
    itemNodeId,
    occurredAt,
    actor,
    state,
    bodyFingerprint: `body-${id}`,
    bodyEmpty: true,
    commitStatus: "available",
    commitSha,
  });
}

function createProductionPushEvent(
  id: string,
  occurredAt: UtcIsoDateTime,
  headCommitSha: string,
): EventByKind<"push"> {
  return Object.freeze({
    kind: "push",
    sourceId: productionSource("github_timeline_event", id),
    itemNodeId,
    occurredAt,
    actor: author,
    headCommitSha,
    forcePush: false,
  });
}

function createProductionPullRequest(
  requests: readonly ProductionReviewRequestFixture[],
  events: readonly NormalizedEvent[],
  headSha: string,
  headPushedAt: UtcIsoDateTime,
): FreshObservedGitHubPullRequest {
  return Object.freeze({
    freshness: "fresh",
    sourceId: productionSource("github_item", "staleness-test-item"),
    nodeId: itemNodeId,
    type: "pull_request",
    createdAt,
    state: "open",
    stateReason: null,
    closedAt: null,
    author: Object.freeze({ status: "identified", actor: author }),
    assignees: Object.freeze([]),
    draft: false,
    headSha,
    headCommit: Object.freeze({
      sourceId: productionSource("github_commit", `head-${headSha}`),
      nodeId: createGitHubNodeId(`head-${headSha}`),
      sha: headSha,
      committedAt: headPushedAt,
      pushedAt: Object.freeze({ status: "available", value: headPushedAt }),
    }),
    reviewThreads: Object.freeze([]),
    reviewRequests: Object.freeze(requests.map(createProductionReviewRequest)),
    mergeState: Object.freeze({
      mergeability: "mergeable",
      mergeState: "clean",
      autoMerge: Object.freeze({ status: "not_enabled" }),
      mergeQueue: Object.freeze({ status: "not_queued" }),
      checks: Object.freeze({ status: "not_configured" }),
    }),
    events: Object.freeze(events),
    observedAt: evaluatedAt,
  });
}

function determineProductionReviewDecision(
  requests: readonly ProductionReviewRequestFixture[],
  events: readonly NormalizedEvent[],
  headSha: string,
  headPushedAt: UtcIsoDateTime,
): PullRequestStateDecision {
  return determinePullRequestState({
    pullRequest: createProductionPullRequest(requests, events, headSha, headPushedAt),
    blockers: [],
    checkFailureAssessment: Object.freeze({ cause: "not_assessed" }),
    labelEffects: Object.freeze({
      priorityWeight: 0,
      severityLift: 0,
      requiresMaintainerDecision: false,
      maintainerDecisionLabelNames: Object.freeze([]),
      suppressNotifications: false,
      countsAsProgress: false,
    }),
    maintainers: ["maintainer"],
    confidenceThresholds: Object.freeze({ high: 0.8, medium: 0.5 }),
    evaluatedAt,
  });
}

function calculateDecisionStaleness(
  decision: PullRequestStateDecision,
  events: readonly NormalizedEvent[],
  previousState: PreviousStalenessState,
): StalenessResult {
  const threshold = Object.freeze({ watch: 100, urgent: 200, critical: 300 });
  return calculateStaleness({
    itemType: "pull_request",
    createdAt,
    evaluatedAt,
    currentDecision: {
      status: decision.status,
      waitingOn: decision.waitingOn,
      confidence: decision.confidence,
      statusBasis: decision.statusBasis,
      responsibilityBasis: decision.responsibilityBasis,
    },
    decisionBasis: "deterministic",
    previousState,
    events,
    responsibleAccountIdentifiers: new Set(
      decision.waitingOn.map((waitingOn) => waitingOn.candidateId),
    ),
    dependencyResolutions: [],
    naturalLanguageAssessments: [],
    minimumAiConfidence: 0.5,
    repositoryFullName: "voicevox/test",
    currentLabels: [],
    resolveLabelEffects,
    thresholdsHours: Object.freeze({
      assessment: threshold,
      owner: threshold,
      decision: threshold,
      review: threshold,
      revision: threshold,
      reply: threshold,
      work: threshold,
      merge: threshold,
      automation: threshold,
    }),
    blockedParentContext: { status: "not_applicable" },
  });
}

function createPreviousState(
  status: Status,
  waitingOn: readonly WaitingOn[],
  stallSincePolicy: "inherit" | "recalculate",
  stallSinceValue: UtcIsoDateTime,
  lastProgressAtValue: UtcIsoDateTime,
  lastHumanActivityAtValue: UtcIsoDateTime,
): PreviousStalenessState {
  const times: StalenessTimes = Object.freeze({
    statusSince,
    ownerSince,
    stallSince: stallSinceValue,
    lastProgressAt: lastProgressAtValue,
    lastHumanActivityAt: lastHumanActivityAtValue,
  });
  return Object.freeze({
    availability: "available",
    stallSincePolicy,
    value: Object.freeze({
      status,
      waitingOn,
      ...times,
    }),
  });
}

function createSeverityThresholds(): SeverityThresholds {
  const threshold = Object.freeze({ watch: 100, urgent: 200, critical: 300 });
  return Object.freeze({
    assessment: threshold,
    owner: threshold,
    decision: threshold,
    review: threshold,
    revision: threshold,
    reply: threshold,
    work: threshold,
    merge: threshold,
    automation: threshold,
  });
}

function createFixture(
  itemType: TrackedItemType,
  status: Status,
  waitingOn: readonly WaitingOn[],
  events: readonly NormalizedEvent[],
  previousState: PreviousStalenessState,
  responsibilityBasis: StalenessTransitionBasis,
  responsibleAccountIdentifiers: readonly string[],
): Fixture {
  return Object.freeze({
    itemType,
    status,
    waitingOn,
    statusBasis: createBasis(source("status-basis"), statusSince, "inferred"),
    responsibilityBasis,
    previousState,
    events,
    responsibleAccountIdentifiers: new Set(responsibleAccountIdentifiers),
  });
}

function calculateFixture(fixture: Fixture): StalenessResult {
  return calculateStaleness({
    itemType: fixture.itemType,
    createdAt,
    evaluatedAt,
    currentDecision: {
      status: fixture.status,
      waitingOn: fixture.waitingOn,
      confidence: 1,
      statusBasis: fixture.statusBasis,
      responsibilityBasis: fixture.responsibilityBasis,
    },
    decisionBasis: "deterministic",
    previousState: fixture.previousState,
    events: fixture.events,
    responsibleAccountIdentifiers: fixture.responsibleAccountIdentifiers,
    dependencyResolutions: [],
    naturalLanguageAssessments: [],
    minimumAiConfidence: 0.5,
    repositoryFullName: "voicevox/test",
    currentLabels: [],
    resolveLabelEffects,
    thresholdsHours,
    blockedParentContext: { status: "not_applicable" },
  });
}

void test("PRのowner待ちとreview待ちでは作者pushが全体進捗だけを進める", () => {
  const cases: readonly Readonly<{
    status: "waiting_for_owner" | "waiting_for_review";
    waitingOn: WaitingOn;
    responsibleAccountIdentifiers: readonly string[];
  }>[] = [
    {
      status: "waiting_for_owner",
      waitingOn: createWaitingOn("user", "maintainer", "maintainer", source("owner-wait")),
      responsibleAccountIdentifiers: ["reviewer"],
    },
    {
      status: "waiting_for_review",
      waitingOn: createWaitingOn("user", "reviewer", "reviewer", source("review-wait")),
      responsibleAccountIdentifiers: ["reviewer"],
    },
  ];

  for (const item of cases) {
    const previousState = createPreviousState(
      item.status,
      [item.waitingOn],
      "inherit",
      initialStallSince,
      initialStallSince,
      initialStallSince,
    );
    const result = calculateFixture(
      createFixture(
        "pull_request",
        item.status,
        [item.waitingOn],
        [createPushEvent("author-push", activityAt, author)],
        previousState,
        createBasis(source("responsibility-basis"), ownerSince, "inferred"),
        item.responsibleAccountIdentifiers,
      ),
    );

    assert.equal(result.lastProgressAt, activityAt);
    assert.equal(result.lastHumanActivityAt, activityAt);
    assert.equal(result.stallSince, initialStallSince);
  }
});

void test("現在の待ち相手のコメントとhuman reviewは進め、第三者コメントとbot reviewは進めない", () => {
  const reviewerWaitingOn = createWaitingOn(
    "user",
    "reviewer",
    "reviewer",
    source("reviewer-wait"),
  );
  const previousState = createPreviousState(
    "waiting_for_review",
    [reviewerWaitingOn],
    "inherit",
    initialStallSince,
    initialStallSince,
    initialStallSince,
  );
  const responsibilityBasis = createBasis(source("responsibility-basis"), ownerSince, "inferred");

  const currentComment = calculateFixture(
    createFixture(
      "pull_request",
      "waiting_for_review",
      [reviewerWaitingOn],
      [createCommentEvent("reviewer-comment", commentAt, reviewer)],
      previousState,
      responsibilityBasis,
      ["reviewer"],
    ),
  );
  assert.equal(currentComment.lastProgressAt, initialStallSince);
  assert.equal(currentComment.stallSince, commentAt);

  const humanReview = calculateFixture(
    createFixture(
      "pull_request",
      "waiting_for_review",
      [reviewerWaitingOn],
      [createReviewEvent("human-review", reviewAt, reviewer, "commented")],
      previousState,
      responsibilityBasis,
      ["reviewer"],
    ),
  );
  assert.equal(humanReview.lastProgressAt, reviewAt);
  assert.equal(humanReview.stallSince, reviewAt);

  const teamWaitingOn = createWaitingOn(
    "team",
    "voicevox/reviewers",
    "reviewer",
    source("team-wait"),
  );
  const teamReview = calculateFixture(
    createFixture(
      "pull_request",
      "waiting_for_review",
      [teamWaitingOn],
      [createReviewEvent("team-human-review", reviewAt, reviewer, "commented")],
      createPreviousState(
        "waiting_for_review",
        [teamWaitingOn],
        "inherit",
        initialStallSince,
        initialStallSince,
        initialStallSince,
      ),
      responsibilityBasis,
      [],
    ),
  );
  assert.equal(teamReview.stallSince, reviewAt);

  const unrelatedActivity = calculateFixture(
    createFixture(
      "pull_request",
      "waiting_for_review",
      [reviewerWaitingOn],
      [
        createCommentEvent("third-party-comment", commentAt, thirdParty),
        createReviewEvent("bot-review", reviewAt, bot, "commented"),
      ],
      previousState,
      responsibilityBasis,
      ["reviewer"],
    ),
  );
  assert.equal(unrelatedActivity.lastProgressAt, initialStallSince);
  assert.equal(unrelatedActivity.lastHumanActivityAt, commentAt);
  assert.equal(unrelatedActivity.stallSince, initialStallSince);
});

void test("Issueの作業待ちとPull Requestの修正待ちでは一般進捗時計を更新する", () => {
  const issueWaitingOn = createWaitingOn("user", "author", "author", source("issue-wait"));
  const issue = calculateFixture(
    createFixture(
      "issue",
      "waiting_for_work",
      [issueWaitingOn],
      [createPushEvent("issue-author-push", activityAt, author)],
      createPreviousState(
        "waiting_for_work",
        [issueWaitingOn],
        "inherit",
        initialStallSince,
        initialStallSince,
        initialStallSince,
      ),
      createBasis(source("issue-responsibility"), ownerSince, "inferred"),
      ["author"],
    ),
  );
  assert.equal(issue.lastProgressAt, activityAt);
  assert.equal(issue.stallSince, activityAt);

  const revisionWaitingOn = createWaitingOn("user", "author", "author", source("revision-wait"));
  const changesRequested = createReviewEvent(
    "changes-requested",
    ownerSince,
    reviewer,
    "changes_requested",
  );
  const revision = calculateFixture(
    createFixture(
      "pull_request",
      "waiting_for_revision",
      [revisionWaitingOn],
      [changesRequested, createPushEvent("revision-author-push", activityAt, author)],
      createPreviousState(
        "waiting_for_revision",
        [revisionWaitingOn],
        "inherit",
        initialStallSince,
        initialStallSince,
        initialStallSince,
      ),
      createBasis(changesRequested.sourceId, ownerSince, "event"),
      ["author"],
    ),
  );
  assert.equal(revision.lastProgressAt, activityAt);
  assert.equal(revision.stallSince, activityAt);
});

void test("規則version更新の再計算では作者push由来stallSinceだけを巻き戻す", () => {
  const waitingOn = createWaitingOn("user", "reviewer", "reviewer", source("recalculate-wait"));
  const result = calculateFixture(
    createFixture(
      "pull_request",
      "waiting_for_review",
      [waitingOn],
      [createPushEvent("old-author-push", activityAt, author)],
      createPreviousState(
        "waiting_for_review",
        [waitingOn],
        "recalculate",
        activityAt,
        activityAt,
        activityAt,
      ),
      createBasis(source("recalculate-responsibility"), ownerSince, "inferred"),
      ["reviewer"],
    ),
  );

  assert.equal(result.statusSince, statusSince);
  assert.equal(result.ownerSince, ownerSince);
  assert.equal(result.lastProgressAt, activityAt);
  assert.equal(result.lastHumanActivityAt, activityAt);
  assert.equal(result.stallSince, ownerSince);
});

void test("同じreviewerへの明示的な新規依頼だけownerSinceを進める", () => {
  const oldRequest = source("old-review-request");
  const newRequest = createReviewRequestEvent(
    "new-review-request",
    reviewAt,
    author,
    Object.freeze({ type: "user", nodeId: reviewerNodeId }),
  );
  const previousWaitingOn = createWaitingOn("user", "reviewer", "reviewer", oldRequest);
  const currentWaitingOn = createWaitingOn("user", "reviewer", "reviewer", newRequest.sourceId);
  const previousState = createPreviousState(
    "waiting_for_review",
    [previousWaitingOn],
    "inherit",
    initialStallSince,
    initialStallSince,
    initialStallSince,
  );

  const explicitBasis = createBasis(newRequest.sourceId, reviewAt, "event");
  const explicit = calculateFixture(
    createFixture(
      "pull_request",
      "waiting_for_review",
      [currentWaitingOn],
      [newRequest],
      previousState,
      explicitBasis,
      ["reviewer"],
    ),
  );
  assert.equal(explicit.ownerSince, reviewAt);
  assert.equal(explicit.stallSince, reviewAt);

  const inferred = calculateFixture(
    createFixture(
      "pull_request",
      "waiting_for_review",
      [currentWaitingOn],
      [],
      previousState,
      createBasis(newRequest.sourceId, reviewAt, "inferred"),
      ["reviewer"],
    ),
  );
  assert.equal(inferred.ownerSince, ownerSince);
  assert.equal(inferred.stallSince, initialStallSince);
});

void test("現行review requestの実eventを通常依頼と再reviewの責務時計へ反映する", () => {
  const regularRequest = createProductionReviewRequestFixture(
    reviewer,
    "regular-current",
    "regular-added",
    reviewAt,
  );
  const regularEvents = Object.freeze([
    createProductionReviewRequestEvent(regularRequest),
  ] satisfies readonly NormalizedEvent[]);
  const regularDecision = determineProductionReviewDecision(
    [regularRequest],
    regularEvents,
    "regular-head",
    ownerSince,
  );
  assert.equal(regularDecision.status, "waiting_for_review");
  assert.ok(
    regularDecision.responsibilityBasis.sourceIds.includes(regularRequest.requestEventSourceId),
  );
  const regularResult = calculateDecisionStaleness(
    regularDecision,
    regularEvents,
    createPreviousState(
      "waiting_for_review",
      regularDecision.waitingOn,
      "inherit",
      initialStallSince,
      initialStallSince,
      initialStallSince,
    ),
  );
  assert.equal(regularResult.ownerSince, reviewAt);
  assert.equal(regularResult.stallSince, reviewAt);

  const rereviewRequest = createProductionReviewRequestFixture(
    reviewer,
    "rereview-current",
    "rereview-added",
    reviewAt,
  );
  const rereviewEvents = Object.freeze([
    createProductionReviewEvent(
      "rereview-changes",
      ownerSince,
      reviewer,
      "changes_requested",
      "old-head",
    ),
    createProductionPushEvent("rereview-push", activityAt, "rereview-head"),
    createProductionReviewRequestEvent(rereviewRequest),
  ] satisfies readonly NormalizedEvent[]);
  const rereviewDecision = determineProductionReviewDecision(
    [rereviewRequest],
    rereviewEvents,
    "rereview-head",
    activityAt,
  );
  assert.equal(rereviewDecision.status, "waiting_for_review");
  assert.equal(rereviewDecision.responsibilityBasis.occurredAt, activityAt);
  assert.ok(
    rereviewDecision.responsibilityBasis.sourceIds.includes(rereviewRequest.requestEventSourceId),
  );
  const rereviewResult = calculateDecisionStaleness(
    rereviewDecision,
    rereviewEvents,
    createPreviousState(
      "waiting_for_review",
      rereviewDecision.waitingOn,
      "inherit",
      initialStallSince,
      initialStallSince,
      initialStallSince,
    ),
  );
  assert.equal(rereviewResult.ownerSince, reviewAt);
  assert.equal(rereviewResult.stallSince, reviewAt);

  const secondaryReviewer = createAccountActor(
    "human",
    createGitHubNodeId("secondary-reviewer"),
    "secondary-reviewer",
  );
  const primaryRequest = createProductionReviewRequestFixture(
    reviewer,
    "primary-current",
    "primary-added",
    activityAt,
  );
  const secondaryRequest = createProductionReviewRequestFixture(
    secondaryReviewer,
    "secondary-current",
    "secondary-added",
    reviewAt,
  );
  const multipleReviewerEvents = Object.freeze([
    createProductionReviewRequestEvent(primaryRequest),
    createProductionReviewRequestEvent(secondaryRequest),
  ] satisfies readonly NormalizedEvent[]);
  const multipleReviewerDecision = determineProductionReviewDecision(
    [primaryRequest, secondaryRequest],
    multipleReviewerEvents,
    "multiple-reviewer-head",
    ownerSince,
  );
  assert.equal(multipleReviewerDecision.status, "waiting_for_review");
  assert.ok(
    multipleReviewerDecision.responsibilityBasis.sourceIds.includes(
      secondaryRequest.requestEventSourceId,
    ),
  );
  const multipleReviewerResult = calculateDecisionStaleness(
    multipleReviewerDecision,
    multipleReviewerEvents,
    createPreviousState(
      "waiting_for_review",
      multipleReviewerDecision.waitingOn,
      "inherit",
      initialStallSince,
      initialStallSince,
      initialStallSince,
    ),
  );
  assert.equal(multipleReviewerResult.ownerSince, reviewAt);
  assert.equal(multipleReviewerResult.stallSince, reviewAt);
});
