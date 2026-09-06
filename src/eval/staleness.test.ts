import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildSourceId,
  calculateStaleness,
  createGitHubNodeId,
  createLabelEffectsResolver,
  createUtcIsoDateTime,
  type GitHubAccountActor,
  type NormalizedEvent,
  type PreviousStalenessState,
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
      [newRequest],
      previousState,
      createBasis(newRequest.sourceId, reviewAt, "inferred"),
      ["reviewer"],
    ),
  );
  assert.equal(inferred.ownerSince, ownerSince);
  assert.equal(inferred.stallSince, initialStallSince);
});
