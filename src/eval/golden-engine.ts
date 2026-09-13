import { performance } from "node:perf_hooks";

import { z } from "zod";

import {
  CodexOutputValidationError,
  createCodexAnalysisInput,
  reduceCodexAnalysis,
  validateCodexAnalysisOutput,
  type CodexAnalysisInput,
  type CodexElementOutput,
  type DeterministicCodexDecision,
  type ReducedCodexDecision,
} from "../codex/index.js";
import {
  buildSourceId,
  calculateStaleness,
  createStalenessNotificationSeverityReason,
  createExternalReferenceNodeId,
  createGitHubNodeId,
  createGitHubRepositoryId,
  createLabelEffectsResolver,
  createTrackedItemLatestEventActor,
  createUtcIsoDateTime,
  determineIssueState,
  determineIssueLocalResponsibility,
  determinePullRequestLocalResponsibility,
  determinePullRequestState,
  isTerminalStatus,
  PERSONAL_REMINDER_CAUSE_PLANNING_VERSION,
  parseSourceId,
  resolveWaitingOnAccountIdentifiers,
  type Actor,
  type BlockedParentContext,
  type BlockerRanking,
  type Evidence,
  type FreshObservedGitHubIssue,
  type FreshObservedGitHubPullRequest,
  type GitHubAccountActor,
  type GitHubItemDisplayReference,
  type GitHubItemUrl,
  type GitHubNodeId,
  type GraphNodeId,
  type IssueBlocker,
  type IssueEffectiveAssigneeAssessment,
  type IssueEffectiveAssigneeCandidate,
  type IssueEffectiveAssigneeTarget,
  type IssueStateDecision,
  type NaturalLanguageDeadlineAssessmentState,
  type NormalizedEvent,
  type ObservedGitHubItemState,
  type PullRequestStateDecision,
  type Relation,
  type Repository,
  type SeverityThresholds,
  type SourceId,
  type StalenessResult,
  type PersonalReminderCausePlanning,
  type PersonalReminderCause,
  type PersonalReminderStaleness,
  type TrackedItem,
  type UtcIsoDateTime,
  type WaitingOn,
} from "../domain/index.js";
import { selectDiscordNotifications, type DiscordNotificationItem } from "../discord/index.js";
import {
  applyPersonalReminderCauseOutcomes,
  createPersonalReminderRuntimeContext,
  planPersonalReminderCauses,
  type PersonalReminderRuntimeCollectionCompleteness,
  type PersonalReminderRuntimeGraph,
  type PersonalReminderRuntimeItem,
  type PersonalReminderRuntimeLocalDecision,
} from "../cli/personal-reminder-runtime.js";
import {
  analyzeGraph,
  reconcileGraph,
  type GraphAnalysisNode,
  type OrganizationRelationCandidateNode,
  type ReconciledGraphEdge,
  type RelationCandidate,
  type RelationCandidateAssessment,
  type RelationCandidateId,
} from "../graph/index.js";
import {
  createPublicRepositoryAllowlist,
  type GitHubDetailActor,
  type GitHubItemDetail,
  type GitHubReviewRequestTarget,
} from "../github/index.js";
import {
  DEFAULT_INITIAL_GRAPH_NODE_LIMIT,
  generatePublicData,
  PagesPublicSafetyError,
  PublicDtoSemanticError,
  PUBLIC_SUMMARY_GZIP_LIMIT_BYTES,
  createPublicSummaryDto,
} from "../pages/index.js";
import {
  assertStatePublicSafety,
  createStateSnapshot,
  StatePublicSafetyError,
  type StateSnapshot,
} from "../persistence/index.js";
import { assertNonNullable } from "../util/index.js";
import {
  goldenEvalInputSchema,
  goldenEvalOutputSchema,
  type GoldenEvalOutput,
  type StandardGoldenInput,
  type StandardGoldenOutput,
} from "./golden-schema.js";

const ORGANIZATION = "VOICEVOX";
const PUBLIC_TIMEZONE = "Asia/Tokyo";
const THIRTY_MINUTES_MILLISECONDS = 30 * 60 * 1_000;
const githubItemDisplayReferenceSchema = z.custom<GitHubItemDisplayReference>(
  (value) => typeof value === "string" && /^[^/\s]+\/[^#\s]+#[1-9]\d*$/u.test(value),
  {
    error: "owner/repository#number形式の表示用別名が不正です",
  },
);
const CONFIDENCE_THRESHOLDS = Object.freeze({
  high: 0.85,
  medium: 0.65,
});
const SEVERITY_THRESHOLDS = Object.freeze({
  assessment: Object.freeze({ watch: 48, urgent: 96, critical: 168 }),
  owner: Object.freeze({ watch: 48, urgent: 96, critical: 168 }),
  decision: Object.freeze({ watch: 48, urgent: 96, critical: 168 }),
  review: Object.freeze({ watch: 48, urgent: 120, critical: 240 }),
  revision: Object.freeze({ watch: 72, urgent: 168, critical: 336 }),
  reply: Object.freeze({ watch: 48, urgent: 120, critical: 240 }),
  work: Object.freeze({ watch: 168, urgent: 336, critical: 720 }),
  merge: Object.freeze({ watch: 24, urgent: 72, critical: 168 }),
  automation: Object.freeze({ watch: 6, urgent: 24, critical: 72 }),
}) satisfies SeverityThresholds;
const NOTIFICATION_SETTINGS = Object.freeze({
  maxItemsPerDigest: 100,
  recentProgressGraceHours: 24,
  minimumAiConfidence: CONFIDENCE_THRESHOLDS.medium,
});
const MAINTAINERS = Object.freeze(["fixture-maintainer"]);

type GoldenItemInput = StandardGoldenInput["items"][number];
type GoldenRelationInput = StandardGoldenInput["relations"][number];
type GoldenAssigneeEvent = Extract<GoldenItemInput["events"][number], { kind: "assignee" }>;

const effectiveAssigneeCandidateSignalSchema = z.strictObject({
  candidateId: z.string().min(1).regex(/^\S+$/u),
  sourceIds: z.array(z.string().min(1)).min(1),
  occurredAt: z.iso.datetime({
    offset: true,
    error: "実質担当候補の発生時刻はISO 8601形式で指定してください",
  }),
});

type PreparedGoldenFixedAiAnalysis = Readonly<{
  itemNodeId: string;
  input: CodexAnalysisInput;
  acceptedOutput: CodexElementOutput;
  rejectedOutputs: readonly unknown[];
}>;

type ItemAnalysis = Readonly<{
  input: GoldenItemInput;
  deterministicDecision: IssueStateDecision | PullRequestStateDecision;
  decision: ReducedCodexDecision;
  deadlineAssessment: NaturalLanguageDeadlineAssessmentState;
  notificationRecommendation: DiscordNotificationItem["notificationRecommendation"];
  staleness: StalenessResult;
  personalReminderCauses: readonly PersonalReminderCause[];
  personalReminderStaleness: ReadonlyMap<string, PersonalReminderStaleness>;
  personalReminderEvidence: readonly Evidence[];
  personalReminderCausePlanning: PersonalReminderCausePlanning;
}>;

/** golden fixture一件の出力とrun report用指標。 */
export type GoldenFixtureAnalysisResult = Readonly<{
  output: GoldenEvalOutput;
  metrics: Readonly<{
    repositoryCount: number;
    itemCount: number;
    changedItemCount: number;
    activeEdgeCount: number;
    aiCallCount: number;
    aiCacheHitCount: number;
    aiRetainedResultCount: number;
    estimatedInputTokens: number;
    staleRepositoryCount: number;
  }>;
  diagnostics: readonly string[];
}>;

function compareStrings(left: string, right: string): -1 | 0 | 1 {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function createActor(
  actor: GoldenItemInput["author"] | GoldenItemInput["events"][number]["actor"],
): Actor {
  if (actor.type === "system") {
    return Object.freeze({
      type: "system",
      name: actor.name,
    });
  }
  return Object.freeze({
    type: actor.type,
    nodeId: createGitHubNodeId(actor.nodeId),
    login: actor.login,
  });
}

function createAccountActor(actor: GoldenItemInput["author"]): GitHubAccountActor {
  return Object.freeze({
    type: actor.type,
    nodeId: createGitHubNodeId(actor.nodeId),
    login: actor.login,
  });
}

function eventSourceId(id: string): SourceId {
  return buildSourceId("golden_event", id);
}

function createEvent(
  itemNodeId: GitHubNodeId,
  event: GoldenItemInput["events"][number],
): NormalizedEvent {
  const base = {
    sourceId: eventSourceId(event.id),
    itemNodeId,
    occurredAt: createUtcIsoDateTime(event.occurredAt),
    actor: createActor(event.actor),
  };
  switch (event.kind) {
    case "comment":
      return Object.freeze({
        ...base,
        kind: "comment",
        bodyFingerprint: `sha256:${event.id}`,
        bodyEmpty: event.bodyEmpty,
      });
    case "push":
      return Object.freeze({
        ...base,
        kind: "push",
        headCommitSha: event.headCommitSha,
        forcePush: event.forcePush,
      });
    case "review":
      return Object.freeze({
        ...base,
        kind: "review",
        state: event.state,
        bodyFingerprint: `sha256:${event.id}`,
        bodyEmpty: event.bodyEmpty,
        commitStatus: "available",
        commitSha: event.commitSha,
      });
    case "review_request":
      return Object.freeze({
        ...base,
        kind: "review_request",
        target: Object.freeze({
          type: event.target.type,
          nodeId: createGitHubNodeId(event.target.nodeId),
        }),
        action: event.action,
      });
    case "assignee":
      return Object.freeze({
        ...base,
        kind: "assignee",
        assignee: createAccountActor(event.assignee),
        action: event.action,
      });
    case "state":
      if (event.state === "closed") {
        return Object.freeze({
          ...base,
          kind: "state",
          state: "closed",
          stateReason: event.stateReason ?? "unavailable",
        });
      }
      return Object.freeze({
        ...base,
        kind: "state",
        state: event.state,
      });
  }
}

function createItemState(item: GoldenItemInput): ObservedGitHubItemState {
  if (item.state === "open") {
    if (item.closedAt != null) {
      throw new TypeError(`open項目 ${item.nodeId}にclosedAtを指定できません`);
    }
    return Object.freeze({
      state: "open",
      stateReason: null,
      closedAt: null,
    });
  }
  if (item.closedAt == null) {
    throw new TypeError(`終了項目 ${item.nodeId}にはclosedAtが必要です`);
  }
  return Object.freeze({
    state: "closed",
    stateReason: "completed",
    closedAt: createUtcIsoDateTime(item.closedAt),
  });
}

function createIssueObservation(
  item: Extract<GoldenItemInput, { type: "issue" }>,
): FreshObservedGitHubIssue {
  const nodeId = createGitHubNodeId(item.nodeId);
  return Object.freeze({
    freshness: "fresh",
    sourceId: buildSourceId("golden_item", item.nodeId),
    nodeId,
    type: "issue",
    createdAt: createUtcIsoDateTime(item.createdAt),
    ...createItemState(item),
    author: Object.freeze({
      status: "identified",
      actor: createAccountActor(item.author),
    }),
    labels: Object.freeze([...item.labels]),
    assignees: Object.freeze(item.assignees.map(createAccountActor)),
    events: Object.freeze(item.events.map((event) => createEvent(nodeId, event))),
    observedAt: createUtcIsoDateTime(item.observedAt),
  });
}

function createReviewRequests(
  item: Extract<GoldenItemInput, { type: "pull_request" }>,
): FreshObservedGitHubPullRequest["reviewRequests"] {
  return Object.freeze(
    item.reviewRequests.map((request) => {
      const sourceId = buildSourceId("golden_review_request", request.id);
      if (request.target.type === "user") {
        return Object.freeze({
          sourceId,
          nodeId: createGitHubNodeId(`review-request-${request.id}`),
          target: Object.freeze({
            type: "user",
            actor: createAccountActor(request.target.actor),
          }),
          requestedAt: Object.freeze({
            status: "available",
            value: createUtcIsoDateTime(request.requestedAt),
          }),
        });
      }
      return Object.freeze({
        sourceId,
        nodeId: createGitHubNodeId(`review-request-${request.id}`),
        target: Object.freeze({
          type: "team",
          sourceId: buildSourceId("golden_team", request.target.nodeId),
          nodeId: createGitHubNodeId(request.target.nodeId),
          organizationLogin: ORGANIZATION,
          slug: request.target.slug,
          name: request.target.name,
        }),
        requestedAt: Object.freeze({
          status: "available",
          value: createUtcIsoDateTime(request.requestedAt),
        }),
      });
    }),
  );
}

function createChecks(
  item: Extract<GoldenItemInput, { type: "pull_request" }>,
): FreshObservedGitHubPullRequest["mergeState"]["checks"] {
  if (item.checks === "not_configured") {
    return Object.freeze({
      status: "not_configured",
    });
  }
  return Object.freeze({
    status: "configured",
    sourceId: buildSourceId("golden_checks", item.nodeId),
    nodeId: createGitHubNodeId(`checks-${item.nodeId}`),
    combinedState: item.checks,
    contexts: Object.freeze([]),
  });
}

function createPullRequestObservation(
  item: Extract<GoldenItemInput, { type: "pull_request" }>,
): FreshObservedGitHubPullRequest {
  const nodeId = createGitHubNodeId(item.nodeId);
  const headPushedAt = createUtcIsoDateTime(item.headPushedAt);
  return Object.freeze({
    freshness: "fresh",
    sourceId: buildSourceId("golden_item", item.nodeId),
    nodeId,
    type: "pull_request",
    createdAt: createUtcIsoDateTime(item.createdAt),
    ...createItemState(item),
    author: Object.freeze({
      status: "identified",
      actor: createAccountActor(item.author),
    }),
    assignees: Object.freeze(item.assignees.map(createAccountActor)),
    draft: item.draft,
    headSha: item.headSha,
    headCommit: Object.freeze({
      sourceId: buildSourceId("golden_commit", item.headSha),
      nodeId: createGitHubNodeId(`commit-${item.headSha}`),
      sha: item.headSha,
      committedAt: headPushedAt,
      pushedAt: Object.freeze({
        status: "available",
        value: headPushedAt,
      }),
    }),
    reviewThreads: Object.freeze([]),
    reviewRequests: createReviewRequests(item),
    mergeState: Object.freeze({
      mergeability: item.mergeability,
      mergeState: item.mergeState,
      autoMerge: Object.freeze({
        status: "not_enabled",
      }),
      mergeQueue: Object.freeze({
        status: "not_queued",
      }),
      checks: createChecks(item),
    }),
    events: Object.freeze(item.events.map((event) => createEvent(nodeId, event))),
    observedAt: createUtcIsoDateTime(item.observedAt),
  });
}

type GoldenPersonalReminderBody = Readonly<{
  sourceId: SourceId;
  value: string;
  observed: boolean;
}>;

type GoldenBodyEvent = Extract<GoldenItemInput["events"][number], { kind: "comment" | "review" }>;

type GoldenCodexSource = CodexAnalysisInput["sources"][number];

function goldenSourceContent(source: GoldenCodexSource): string | undefined {
  if (!("content" in source)) {
    return undefined;
  }
  const content = source["content"];
  if (typeof content !== "string") {
    throw new TypeError(`golden固定入力のsource contentが文字列ではありません。対象: ${source.id}`);
  }
  return content;
}

function goldenBodyContentForEvent(
  event: GoldenBodyEvent,
  sourcesById: ReadonlyMap<string, GoldenCodexSource>,
): string | undefined {
  const source = sourcesById.get(eventSourceId(event.id));
  if (source == null) {
    return event.bodyEmpty ? "" : undefined;
  }
  if (source.kind !== event.kind) {
    throw new TypeError(`golden固定入力のsource kindがeventと一致しません。対象: ${source.id}`);
  }
  if (source.actorType !== event.actor.type) {
    throw new TypeError(
      `golden固定入力のsource actorTypeがeventと一致しません。対象: ${source.id}`,
    );
  }
  if (source.createdAt !== createUtcIsoDateTime(event.occurredAt)) {
    throw new TypeError(`golden固定入力のsource時刻がeventと一致しません。対象: ${source.id}`);
  }
  if ("bodyEmpty" in source) {
    const bodyEmpty = source["bodyEmpty"];
    if (typeof bodyEmpty !== "boolean") {
      throw new TypeError(`golden固定入力のbodyEmptyがbooleanではありません。対象: ${source.id}`);
    }
    if (bodyEmpty !== event.bodyEmpty) {
      throw new TypeError(`golden固定入力のbodyEmptyがeventと一致しません。対象: ${source.id}`);
    }
  }
  const content = goldenSourceContent(source);
  if (event.bodyEmpty) {
    if (content != null && content.length !== 0) {
      throw new TypeError(`空body eventに本文があります。対象: ${source.id}`);
    }
    return "";
  }
  if (content == null || content.length === 0) {
    return undefined;
  }
  return content;
}

function createGoldenPersonalReminderBody(
  analysis: PreparedGoldenFixedAiAnalysis | undefined,
): GoldenPersonalReminderBody | undefined {
  if (analysis == null) {
    return undefined;
  }
  const bodySources = analysis.input.sources.filter((source) => source.kind === "body");
  if (bodySources.length > 1) {
    throw new TypeError(
      `golden固定入力のbody sourceが重複しています。対象: ${analysis.itemNodeId}`,
    );
  }
  const source = bodySources[0];
  if (source == null) {
    return undefined;
  }
  const content = goldenSourceContent(source);
  const sourceParts = parseSourceId(source.id);
  return Object.freeze({
    sourceId: buildSourceId(sourceParts.kind, sourceParts.originalId),
    value: content ?? "",
    observed: content != null,
  });
}

function createGoldenDetailActor(
  actor: GoldenItemInput["events"][number]["actor"],
  sourceId: SourceId,
): GitHubDetailActor {
  if (actor.type === "system") {
    return Object.freeze({
      status: "unavailable",
      reason: "github_did_not_return_actor",
    });
  }
  return Object.freeze({
    status: "identified",
    account: Object.freeze({
      sourceId,
      nodeId: createGitHubNodeId(actor.nodeId),
      login: actor.login,
      apiType: actor.type === "bot" ? "Bot" : "User",
    }),
  });
}

function createGoldenDetailMergeState(
  observation: FreshObservedGitHubPullRequest,
): Extract<GitHubItemDetail, { type: "pull_request" }>["mergeState"] {
  const autoMerge = observation.mergeState.autoMerge;
  if (autoMerge.status !== "not_enabled") {
    throw new TypeError("golden fixtureのauto merge enabled actorは未対応です");
  }
  const checks =
    observation.mergeState.checks.status === "not_configured"
      ? observation.mergeState.checks
      : Object.freeze({
          ...observation.mergeState.checks,
          contexts: Object.freeze([]),
        });
  return Object.freeze({
    ...observation.mergeState,
    autoMerge,
    checks,
  });
}

function createGoldenReviewRequestTarget(
  request: Extract<GoldenItemInput, { type: "pull_request" }>["reviewRequests"][number],
): GitHubReviewRequestTarget {
  if (request.target.type === "user") {
    return Object.freeze({
      type: "user",
      sourceId: buildSourceId("golden_review_target", request.id),
      nodeId: createGitHubNodeId(request.target.actor.nodeId),
      login: request.target.actor.login,
      apiType: request.target.actor.type === "bot" ? "Bot" : "User",
    });
  }
  return Object.freeze({
    type: "team",
    sourceId: buildSourceId("golden_team", request.target.nodeId),
    nodeId: createGitHubNodeId(request.target.nodeId),
    organizationLogin: ORGANIZATION,
    slug: request.target.slug,
    name: request.target.name,
  });
}

function createGoldenPersonalReminderDetail(
  item: GoldenItemInput,
  repositoryId: GitHubItemDetail["repositoryId"],
  repositoryName: string,
  analysis: PreparedGoldenFixedAiAnalysis | undefined,
  body: GoldenPersonalReminderBody | undefined,
): GitHubItemDetail {
  const sourcesById = new Map(analysis?.input.sources.map((source) => [source.id, source]));
  const comments = item.events
    .filter(
      (event): event is Extract<(typeof item.events)[number], { kind: "comment" }> =>
        event.kind === "comment",
    )
    .flatMap((event) => {
      const body = goldenBodyContentForEvent(event, sourcesById);
      if (body == null) {
        return [];
      }
      return [
        Object.freeze({
          sourceId: eventSourceId(event.id),
          nodeId: createGitHubNodeId(`comment-${event.id}`),
          author: createGoldenDetailActor(event.actor, eventSourceId(event.id)),
          body,
          createdAt: createUtcIsoDateTime(event.occurredAt),
          updatedAt: createUtcIsoDateTime(event.occurredAt),
          url: itemUrl(repositoryName, item),
        }),
      ];
    })
    .map((comment, index) => Object.freeze({ ...comment, sequence: index + 1 }));
  const observedAt = createUtcIsoDateTime(item.observedAt);
  const common = Object.freeze({
    sourceId: buildSourceId("golden_detail", item.nodeId),
    nodeId: createGitHubNodeId(item.nodeId),
    repositoryId,
    number: item.number,
    bodySourceId: body?.sourceId ?? buildSourceId("golden_body", item.nodeId),
    body: body?.value ?? "",
    comments: Object.freeze(comments),
    timeline: Object.freeze([]),
    inboundCrossReferences: Object.freeze([]),
    observedAt,
  });
  if (item.type === "issue") {
    return Object.freeze({
      ...common,
      type: "issue",
      nativeDependencies: Object.freeze({
        availability: "unavailable",
        reason: "api_not_supported",
      }),
      nativeHierarchy: Object.freeze({
        availability: "unavailable",
        reason: "api_not_supported",
      }),
    });
  }
  const observation = createPullRequestObservation(item);
  const reviews = item.events
    .filter(
      (event): event is Extract<(typeof item.events)[number], { kind: "review" }> =>
        event.kind === "review",
    )
    .flatMap((event) => {
      const body = goldenBodyContentForEvent(event, sourcesById);
      if (body == null) {
        return [];
      }
      return [
        Object.freeze({
          sourceId: eventSourceId(event.id),
          nodeId: createGitHubNodeId(`review-${event.id}`),
          state: event.state,
          author: createGoldenDetailActor(event.actor, eventSourceId(event.id)),
          commit: Object.freeze({
            status: "available",
            sourceId: buildSourceId("golden_commit", event.commitSha),
            nodeId: createGitHubNodeId(`commit-${event.commitSha}`),
            sha: event.commitSha,
          }),
          submittedAt: createUtcIsoDateTime(event.occurredAt),
          body,
          url: itemUrl(repositoryName, item),
        }),
      ];
    })
    .map((review, index) => Object.freeze({ ...review, sequence: index + 1 }));
  return Object.freeze({
    ...common,
    type: "pull_request",
    reviews: Object.freeze(reviews),
    reviewThreads: Object.freeze([]),
    reviewRequests: Object.freeze({
      current: Object.freeze(
        item.reviewRequests.map((request) => {
          const observedRequest = observation.reviewRequests.find(
            (value) => value.nodeId === createGitHubNodeId(`review-request-${request.id}`),
          );
          assertNonNullable(observedRequest, `review requestがありません。対象: ${request.id}`);
          return Object.freeze({
            sourceId: observedRequest.sourceId,
            nodeId: observedRequest.nodeId,
            target: createGoldenReviewRequestTarget(request),
            requestedAt: observedRequest.requestedAt,
          });
        }),
      ),
      history: Object.freeze([]),
    }),
    nativeClosingIssues: Object.freeze([]),
    headSha: observation.headSha,
    headCommit: observation.headCommit,
    mergeState: createGoldenDetailMergeState(observation),
  });
}

function goldenPersonalReminderItem(
  item: GoldenItemInput,
  repositoryName: string,
): PersonalReminderRuntimeItem {
  const observed =
    item.type === "issue" ? createIssueObservation(item) : createPullRequestObservation(item);
  return Object.freeze({
    ...observed,
    url: itemUrl(repositoryName, item),
    title: item.title,
  });
}

function goldenPersonalReminderLocalDecision(
  decision: IssueStateDecision | PullRequestStateDecision,
): PersonalReminderRuntimeLocalDecision {
  switch (decision.deterministicRulesVersion) {
    case "issue-v14":
      return Object.freeze({
        itemType: "issue",
        value: decision,
      });
    case "pull-request-v12":
      return Object.freeze({
        itemType: "pull_request",
        value: decision,
      });
  }
}

function goldenPersonalReminderCollectionCompleteness(
  localDecision: PersonalReminderRuntimeLocalDecision,
  bodyObserved: boolean,
): PersonalReminderRuntimeCollectionCompleteness {
  const necessities = localDecision.value.aiAnalysisElementNecessities;
  if (
    bodyObserved ||
    (necessities.status === "not_required" &&
      necessities.waitingOn === "not_required" &&
      necessities.nextAction === "not_required")
  ) {
    return Object.freeze({ status: "complete" });
  }
  const missing: readonly ["item_body"] = ["item_body"];
  return Object.freeze({
    status: "incomplete",
    missing,
  });
}

function goldenPersonalReminderCandidateRelation(
  candidate: RelationCandidate,
): PersonalReminderRuntimeGraph["candidateRelations"][number] {
  let endpointNodeIds: readonly [GraphNodeId, GraphNodeId];
  switch (candidate.relation.type) {
    case "blocks":
      endpointNodeIds = [candidate.relation.blocker.nodeId, candidate.relation.blocked.nodeId];
      break;
    case "parent_of":
      endpointNodeIds = [candidate.relation.parent.nodeId, candidate.relation.subtask.nodeId];
      break;
    case "implements":
      endpointNodeIds = [
        candidate.relation.implementation.nodeId,
        candidate.relation.target.nodeId,
      ];
      break;
    case "unclassified":
      endpointNodeIds = [
        candidate.relation.referencing.nodeId,
        candidate.relation.referenced.nodeId,
      ];
      break;
  }
  const sortedEndpoints = [...endpointNodeIds].sort(compareStrings);
  const firstEndpoint = sortedEndpoints[0];
  const secondEndpoint = sortedEndpoints[1];
  assertNonNullable(firstEndpoint, `関係 ${candidate.id}のendpointがありません`);
  assertNonNullable(secondEndpoint, `関係 ${candidate.id}のendpointがありません`);
  if (firstEndpoint === secondEndpoint) {
    throw new TypeError(`関係 ${candidate.id}のendpointが重複しています`);
  }
  const sourceIds = [...new Set(candidate.sourceIds)].sort(compareStrings);
  const firstSourceId = sourceIds[0];
  assertNonNullable(firstSourceId, `関係 ${candidate.id}のsourceがありません`);
  const endpointTuple: readonly [GraphNodeId, GraphNodeId] = [firstEndpoint, secondEndpoint];
  const sourceTuple: readonly [SourceId, ...SourceId[]] = [firstSourceId, ...sourceIds.slice(1)];
  return Object.freeze({
    candidateId: candidate.id,
    endpointNodeIds: Object.freeze(endpointTuple),
    evidenceSourceIds: Object.freeze(sourceTuple),
  });
}

function goldenPersonalReminderRuntimeGraph(
  input: StandardGoldenInput,
  candidates: readonly RelationCandidate[],
  reconciled: ReturnType<typeof reconcileGraph>,
): PersonalReminderRuntimeGraph {
  const endpointStates = new Map<GraphNodeId, "open" | "closed" | "merged" | "missing">();
  for (const item of input.items) {
    let endpointState: "open" | "closed" | "merged";
    if (item.state === "open") {
      endpointState = "open";
    } else if (item.state === "merged") {
      endpointState = "merged";
    } else {
      endpointState = "closed";
    }
    endpointStates.set(createGitHubNodeId(item.nodeId), endpointState);
  }
  const candidateRelations = Object.freeze(
    candidates.map((candidate) => goldenPersonalReminderCandidateRelation(candidate)),
  );
  for (const candidate of candidateRelations) {
    for (const nodeId of candidate.endpointNodeIds) {
      if (!endpointStates.has(nodeId)) {
        endpointStates.set(nodeId, "missing");
      }
    }
  }
  for (const edge of reconciled.edges) {
    for (const nodeId of [edge.fromNodeId, edge.toNodeId]) {
      if (!endpointStates.has(nodeId)) {
        endpointStates.set(nodeId, "missing");
      }
    }
  }
  return Object.freeze({
    activeRelations: Object.freeze(
      reconciled.edges.filter(
        (edge): edge is ReconciledGraphEdge & Readonly<{ active: true }> => edge.active,
      ),
    ),
    candidateRelations,
    candidateResolutions: Object.freeze(reconciled.candidateResolutions),
    endpointStates,
    externalReferences: Object.freeze([]),
  });
}

type GoldenPersonalReminderAnalysis = Readonly<{
  causesByNodeId: ReadonlyMap<GitHubNodeId, readonly PersonalReminderCause[]>;
  evidenceByNodeId: ReadonlyMap<GitHubNodeId, readonly Evidence[]>;
  stalenessByCauseId: ReadonlyMap<string, PersonalReminderStaleness>;
  planningByNodeId: ReadonlyMap<GitHubNodeId, PersonalReminderCausePlanning>;
}>;

function createGoldenPersonalReminderAnalysis(
  input: StandardGoldenInput,
  repositories: ReadonlyMap<string, StandardGoldenInput["repositories"][number]>,
  candidates: readonly RelationCandidate[],
  reconciled: ReturnType<typeof reconcileGraph>,
  localDecisionsByNodeId: ReadonlyMap<string, IssueStateDecision | PullRequestStateDecision>,
  preparedAnalyses: readonly PreparedGoldenFixedAiAnalysis[],
): GoldenPersonalReminderAnalysis {
  const inventory = createInventory(input);
  const publicRepositories = createPublicRepositoryAllowlist(inventory);
  const preparedByNodeId = new Map(
    preparedAnalyses.map((analysis) => [analysis.itemNodeId, analysis]),
  );
  const runtimeItems = new Map<
    GraphNodeId,
    Readonly<{
      item: PersonalReminderRuntimeItem;
      detail: GitHubItemDetail;
      localDecision: PersonalReminderRuntimeLocalDecision;
      bodyObserved: boolean;
    }>
  >();
  for (const item of input.items) {
    const repository = repositories.get(item.repositoryId);
    assertNonNullable(repository, `項目 ${item.nodeId}のrepositoryがありません`);
    const repositoryId = createGitHubRepositoryId(item.repositoryId);
    if (!publicRepositories.has(repositoryId)) {
      continue;
    }
    const publicRepository = publicRepositories.require(repositoryId);
    const localDecision = localDecisionsByNodeId.get(item.nodeId);
    assertNonNullable(localDecision, `項目 ${item.nodeId}のlocal decisionがありません`);
    const itemNodeId = createGitHubNodeId(item.nodeId);
    const preparedAnalysis = preparedByNodeId.get(item.nodeId);
    const body = createGoldenPersonalReminderBody(preparedAnalysis);
    runtimeItems.set(
      itemNodeId,
      Object.freeze({
        item: goldenPersonalReminderItem(item, repository.name),
        detail: createGoldenPersonalReminderDetail(
          item,
          publicRepository.id,
          repository.name,
          preparedAnalysis,
          body,
        ),
        localDecision: goldenPersonalReminderLocalDecision(localDecision),
        bodyObserved: body?.observed ?? false,
      }),
    );
  }
  const graph = goldenPersonalReminderRuntimeGraph(input, candidates, reconciled);
  const collectionItems = [...runtimeItems.entries()].map(([nodeId, value]) => {
    const relatedNodeIds = new Set<GraphNodeId>();
    for (const edge of graph.activeRelations) {
      if (edge.type === "related_to") {
        continue;
      }
      if (edge.fromNodeId === nodeId) {
        relatedNodeIds.add(edge.toNodeId);
      }
      if (edge.toNodeId === nodeId) {
        relatedNodeIds.add(edge.fromNodeId);
      }
    }
    const relatedContexts = [...relatedNodeIds].sort(compareStrings).flatMap((relatedNodeId) => {
      const related = runtimeItems.get(relatedNodeId);
      if (related == null) {
        return [];
      }
      return [
        Object.freeze({
          item: related.item,
          detail: related.detail,
          localDecision: related.localDecision,
        }),
      ];
    });
    const item = input.items.find((candidate) => createGitHubNodeId(candidate.nodeId) === nodeId);
    assertNonNullable(item, `runtime項目 ${nodeId}の入力がありません`);
    const repository = repositories.get(item.repositoryId);
    assertNonNullable(repository, `runtime項目 ${nodeId}のrepositoryがありません`);
    return Object.freeze({
      item: value.item,
      detail: value.detail,
      localDecision: value.localDecision,
      relatedContexts: Object.freeze(relatedContexts),
      completeness: goldenPersonalReminderCollectionCompleteness(
        value.localDecision,
        value.bodyObserved,
      ),
      repositoryFullName: `${ORGANIZATION}/${repository.name}`,
      currentLabels: Object.freeze([...item.labels]),
    });
  });
  const context = createPersonalReminderRuntimeContext({
    evaluatedAt: createUtcIsoDateTime(input.evaluatedAt),
    state: Object.freeze({
      previousCausesByNodeId: new Map(),
      previousEvidenceByNodeId: new Map(),
    }),
    collection: Object.freeze({
      items: Object.freeze(collectionItems),
      staleNodeIds: new Set<GitHubNodeId>(),
    }),
    graph,
  });
  const plan = planPersonalReminderCauses(context);
  const applied = applyPersonalReminderCauseOutcomes({
    plan,
    outcomes: undefined,
    evaluatedAt: createUtcIsoDateTime(input.evaluatedAt),
    minimumAiConfidence: CONFIDENCE_THRESHOLDS.medium,
    thresholdsHours: SEVERITY_THRESHOLDS,
    resolveLabelEffects: createLabelEffectsResolver([]),
  });
  const emptyCauses: readonly PersonalReminderCause[] = Object.freeze([]);
  const planningEntries: readonly (readonly [GitHubNodeId, PersonalReminderCausePlanning])[] =
    input.items.map((item) => {
      const nodeId = createGitHubNodeId(item.nodeId);
      const causes = applied.causesByNodeId.get(nodeId) ?? emptyCauses;
      if (item.state !== "open" && causes.length === 0) {
        const planning: PersonalReminderCausePlanning = Object.freeze({
          status: "excluded",
          planningVersion: PERSONAL_REMINDER_CAUSE_PLANNING_VERSION,
          reason: "terminal_without_cause",
        });
        return [nodeId, planning];
      }
      const planning: PersonalReminderCausePlanning = Object.freeze({
        status: "completed",
        planningVersion: PERSONAL_REMINDER_CAUSE_PLANNING_VERSION,
        observedAt: createUtcIsoDateTime(input.evaluatedAt),
      });
      return [nodeId, planning];
    });
  return Object.freeze({
    causesByNodeId: applied.causesByNodeId,
    evidenceByNodeId: applied.evidenceByNodeId,
    stalenessByCauseId: applied.stalenessByCauseId,
    planningByNodeId: new Map(planningEntries),
  });
}

function createRepositoryMap(
  input: StandardGoldenInput,
): ReadonlyMap<string, StandardGoldenInput["repositories"][number]> {
  const repositories = new Map(input.repositories.map((repository) => [repository.id, repository]));
  if (repositories.size !== input.repositories.length) {
    throw new TypeError("golden fixtureのrepository IDが重複しています");
  }
  return repositories;
}

function createItemMap(input: StandardGoldenInput): ReadonlyMap<string, GoldenItemInput> {
  const items = new Map(input.items.map((item) => [item.nodeId, item]));
  if (items.size !== input.items.length) {
    throw new TypeError("golden fixtureのitem node IDが重複しています");
  }
  return items;
}

function relationCandidateId(value: string): RelationCandidateId {
  if (!value.startsWith("rel:") || value.length === "rel:".length) {
    throw new TypeError("relation candidate IDはrel:で始めてください");
  }
  return `rel:${value.slice("rel:".length)}`;
}

function itemUrl(repositoryName: string, item: GoldenItemInput): GitHubItemUrl {
  const path = item.type === "issue" ? "issues" : "pull";
  return `https://github.com/${ORGANIZATION}/${repositoryName}/${path}/${item.number.toString()}`;
}

function relationNode(
  item: GoldenItemInput,
  repositoryName: string,
): OrganizationRelationCandidateNode {
  return Object.freeze({
    scope: "organization",
    kind: item.type,
    nodeId: createGitHubNodeId(item.nodeId),
    repositoryOwner: ORGANIZATION,
    repositoryName,
    number: item.number,
    url: itemUrl(repositoryName, item),
    state: item.state,
  });
}

function createCandidateRelation(
  input: GoldenRelationInput,
  from: OrganizationRelationCandidateNode,
  to: OrganizationRelationCandidateNode,
): RelationCandidate["relation"] {
  switch (input.candidateType) {
    case "blocks":
      return Object.freeze({
        type: "blocks",
        blocker: from,
        blocked: to,
      });
    case "parent_of":
      return Object.freeze({
        type: "parent_of",
        parent: from,
        subtask: to,
      });
    case "implements":
      return Object.freeze({
        type: "implements",
        implementation: from,
        target: to,
      });
    case "unclassified":
      return Object.freeze({
        type: "unclassified",
        referencing: from,
        referenced: to,
      });
  }
}

function createRelationCandidate(
  input: GoldenRelationInput,
  items: ReadonlyMap<string, GoldenItemInput>,
  repositories: ReadonlyMap<string, StandardGoldenInput["repositories"][number]>,
): RelationCandidate {
  const fromItem = items.get(input.fromNodeId);
  const toItem = items.get(input.toNodeId);
  assertNonNullable(fromItem, `関係 ${input.id}のfrom itemがありません`);
  assertNonNullable(toItem, `関係 ${input.id}のto itemがありません`);
  if (input.currentNodeId !== input.fromNodeId && input.currentNodeId !== input.toNodeId) {
    throw new TypeError(`関係 ${input.id}のcurrent itemが端点にありません`);
  }
  const fromRepository = repositories.get(fromItem.repositoryId);
  const toRepository = repositories.get(toItem.repositoryId);
  assertNonNullable(fromRepository, `関係 ${input.id}のfrom repositoryがありません`);
  assertNonNullable(toRepository, `関係 ${input.id}のto repositoryがありません`);
  const relation = createCandidateRelation(
    input,
    relationNode(fromItem, fromRepository.name),
    relationNode(toItem, toRepository.name),
  );
  const fields = {
    id: relationCandidateId(input.id),
    sourceIds: Object.freeze([buildSourceId("golden_relation", input.sourceId)] satisfies [
      SourceId,
    ]),
    relation,
  };
  switch (input.provenance) {
    case "native":
      if (relation.type !== "blocks" && relation.type !== "parent_of") {
        throw new TypeError("native関係はblocksまたはparent_ofにしてください");
      }
      return Object.freeze({
        ...fields,
        authority: "authoritative",
        provenance: "native",
        relation,
      });
    case "explicit_text":
      if (relation.type !== "unclassified") {
        throw new TypeError("explicit_text関係はunclassifiedにしてください");
      }
      return Object.freeze({
        ...fields,
        authority: "inferred",
        provenance: "explicit_text",
        relation,
      });
    case "closing_keyword":
      if (relation.type !== "implements") {
        throw new TypeError("closing_keyword関係はimplementsにしてください");
      }
      return Object.freeze({
        ...fields,
        authority: "inferred",
        provenance: "closing_keyword",
        relation,
      });
    case "checklist":
      if (relation.type !== "parent_of") {
        throw new TypeError("checklist関係はparent_ofにしてください");
      }
      return Object.freeze({
        ...fields,
        authority: "inferred",
        provenance: "checklist",
        relation,
      });
    case "cross_reference":
      if (relation.type !== "unclassified" && relation.type !== "implements") {
        throw new TypeError("cross_reference関係はunclassifiedまたはimplementsにしてください");
      }
      return Object.freeze({
        ...fields,
        authority: "inferred",
        provenance: "cross_reference",
        relation,
      });
  }
}

function createRelationSourceOccurredAtById(
  input: StandardGoldenInput,
  items: ReadonlyMap<string, GoldenItemInput>,
): ReadonlyMap<SourceId, UtcIsoDateTime> {
  const sourceOccurredAtById = new Map<SourceId, UtcIsoDateTime>();
  for (const relation of input.relations) {
    const currentItem = items.get(relation.currentNodeId);
    assertNonNullable(currentItem, `関係 ${relation.id}のcurrent itemがありません`);
    const sourceId = buildSourceId("golden_relation", relation.sourceId);
    const occurredAt = createUtcIsoDateTime(currentItem.createdAt);
    const existingOccurredAt = sourceOccurredAtById.get(sourceId);
    if (existingOccurredAt != null && existingOccurredAt !== occurredAt) {
      throw new TypeError(`同じgolden関係source IDに異なる発生時刻があります。対象: ${sourceId}`);
    }
    sourceOccurredAtById.set(sourceId, occurredAt);
  }
  return sourceOccurredAtById;
}

function createNativeBlockers(
  item: GoldenItemInput,
  relationInputs: readonly GoldenRelationInput[],
  items: ReadonlyMap<string, GoldenItemInput>,
): readonly IssueBlocker[] {
  const blockers: IssueBlocker[] = [];
  for (const relation of relationInputs) {
    if (
      relation.provenance !== "native" ||
      relation.candidateType !== "blocks" ||
      relation.toNodeId !== item.nodeId
    ) {
      continue;
    }
    const blocker = items.get(relation.fromNodeId);
    assertNonNullable(blocker, `blocker ${relation.fromNodeId}がありません`);
    blockers.push(
      Object.freeze({
        candidateId: blocker.nodeId,
        state: blocker.state === "open" ? "open" : "closed",
        authority: "authoritative",
        confidence: 1,
        sourceIds: Object.freeze([buildSourceId("golden_relation", relation.sourceId)] satisfies [
          SourceId,
        ]),
        becameBlockingAt: createUtcIsoDateTime(item.createdAt),
      }),
    );
  }
  return Object.freeze(blockers);
}

function sourceIdTuple(sourceIds: readonly string[]): readonly [SourceId, ...SourceId[]] {
  const parsedSourceIds = sourceIds.map((sourceId) => {
    const parts = parseSourceId(sourceId);
    return buildSourceId(parts.kind, parts.originalId);
  });
  const [firstSourceId, ...remainingSourceIds] = parsedSourceIds;
  assertNonNullable(firstSourceId, "実質担当候補のsource IDがありません");
  return Object.freeze([firstSourceId, ...remainingSourceIds]);
}

function effectiveAssigneeCandidatesFromCodexInput(
  input: CodexAnalysisInput,
): readonly IssueEffectiveAssigneeCandidate[] {
  const rawCandidates = input.deterministicSignals["effectiveAssigneeCandidates"];
  if (rawCandidates == null) {
    return Object.freeze([]);
  }
  const result = z.array(effectiveAssigneeCandidateSignalSchema).safeParse(rawCandidates);
  if (!result.success) {
    throw new TypeError("deterministicSignals.effectiveAssigneeCandidatesが不正です", {
      cause: result.error,
    });
  }
  if (result.data.length > 0 && input.deterministicSignals["effectiveAssigneeEligible"] !== true) {
    throw new TypeError(
      "実質担当候補があるCodex入力にはdeterministicSignals.effectiveAssigneeEligible=trueが必要です",
    );
  }
  return Object.freeze(
    result.data.map((candidate) =>
      Object.freeze({
        candidateId: candidate.candidateId,
        sourceIds: sourceIdTuple(candidate.sourceIds),
        occurredAt: createUtcIsoDateTime(candidate.occurredAt),
      }),
    ),
  );
}

function prepareFixedAiAnalyses(
  input: StandardGoldenInput,
): readonly PreparedGoldenFixedAiAnalysis[] {
  return Object.freeze(
    input.fixedAiAnalyses.map((analysis) => {
      const codexInput = createCodexAnalysisInput(analysis.input);
      if (codexInput.item.nodeId !== analysis.itemNodeId) {
        throw new TypeError("固定AI判定のitem node IDが入力と一致しません");
      }
      return Object.freeze({
        itemNodeId: analysis.itemNodeId,
        input: codexInput,
        acceptedOutput: validateCodexAnalysisOutput(analysis.acceptedOutput, codexInput),
        rejectedOutputs: analysis.rejectedOutputs,
      });
    }),
  );
}

function createEffectiveAssigneeCandidateMap(
  input: StandardGoldenInput,
  preparedAnalyses: readonly PreparedGoldenFixedAiAnalysis[],
): ReadonlyMap<string, readonly IssueEffectiveAssigneeCandidate[]> {
  const emptyCandidates: readonly IssueEffectiveAssigneeCandidate[] = Object.freeze([]);
  const candidatesByNodeId = new Map<string, readonly IssueEffectiveAssigneeCandidate[]>(
    input.items.map((item) => [item.nodeId, emptyCandidates]),
  );
  for (const analysis of preparedAnalyses) {
    const candidates = effectiveAssigneeCandidatesFromCodexInput(analysis.input);
    if (candidates.length === 0) {
      continue;
    }
    if (analysis.input.item.type !== "issue") {
      throw new TypeError("Pull Requestには実質担当候補を指定できません");
    }
    const existingCandidates = candidatesByNodeId.get(analysis.itemNodeId);
    assertNonNullable(existingCandidates, `固定AI判定 ${analysis.itemNodeId}の対象がありません`);
    if (existingCandidates.length > 0) {
      throw new TypeError(`固定AI判定 ${analysis.itemNodeId}の実質担当候補が重複しています`);
    }
    candidatesByNodeId.set(analysis.itemNodeId, candidates);
  }
  return candidatesByNodeId;
}

function sourceIdSetsMatch(left: readonly string[], right: readonly string[]): boolean {
  if (new Set(left).size !== left.length || new Set(right).size !== right.length) {
    return false;
  }
  const rightSourceIds = new Set(right);
  return left.length === right.length && left.every((sourceId) => rightSourceIds.has(sourceId));
}

function latestEffectiveAssigneeUnassignmentAt(
  item: Extract<GoldenItemInput, { type: "issue" }>,
): UtcIsoDateTime | undefined {
  const activeAssigneeNodeIds = new Set<string>();
  let latestUnassignedAt: UtcIsoDateTime | undefined;
  const assigneeEvents = item.events
    .filter((event): event is GoldenAssigneeEvent => event.kind === "assignee")
    .sort((left, right) => {
      if (left.occurredAt !== right.occurredAt) {
        return compareStrings(left.occurredAt, right.occurredAt);
      }
      return compareStrings(left.id, right.id);
    });
  for (const event of assigneeEvents) {
    if (event.action === "added") {
      activeAssigneeNodeIds.add(event.assignee.nodeId);
      continue;
    }
    const removed = activeAssigneeNodeIds.delete(event.assignee.nodeId);
    if (removed && activeAssigneeNodeIds.size === 0) {
      latestUnassignedAt = createUtcIsoDateTime(event.occurredAt);
    }
  }
  return latestUnassignedAt;
}

function createEffectiveAssigneeAssessment(
  item: GoldenItemInput,
  evaluatedAt: UtcIsoDateTime,
  candidates: readonly IssueEffectiveAssigneeCandidate[],
  output: CodexElementOutput | undefined,
): IssueEffectiveAssigneeAssessment {
  if (output == null) {
    return Object.freeze({
      status: "not_assessed",
    });
  }
  const status = output.status;
  const waitingOnResult = output.waitingOn;
  if (
    item.type !== "issue" ||
    item.state !== "open" ||
    item.assignees.length !== 0 ||
    candidates.length === 0 ||
    status == null ||
    waitingOnResult == null
  ) {
    return Object.freeze({
      status: "not_assessed",
    });
  }
  if (
    status.value !== "waiting_for_work" ||
    waitingOnResult.value.length === 0 ||
    status.confidence < CONFIDENCE_THRESHOLDS.high ||
    waitingOnResult.confidence < CONFIDENCE_THRESHOLDS.high
  ) {
    return Object.freeze({
      status: "not_assessed",
    });
  }

  const candidatesById = new Map(
    candidates.map((candidate) => [candidate.candidateId.toLowerCase(), candidate]),
  );
  const targets: IssueEffectiveAssigneeTarget[] = [];
  const targetIds = new Set<string>();
  for (const waitingOn of waitingOnResult.value) {
    if (
      waitingOn.kind !== "user" ||
      waitingOn.role !== "assignee" ||
      waitingOn.confidence < CONFIDENCE_THRESHOLDS.high
    ) {
      return Object.freeze({
        status: "not_assessed",
      });
    }
    const normalizedCandidateId = waitingOn.candidateId.toLowerCase();
    if (targetIds.has(normalizedCandidateId)) {
      return Object.freeze({
        status: "not_assessed",
      });
    }
    targetIds.add(normalizedCandidateId);
    const candidate = candidatesById.get(normalizedCandidateId);
    if (candidate?.candidateId !== waitingOn.candidateId) {
      return Object.freeze({
        status: "not_assessed",
      });
    }
    if (!sourceIdSetsMatch(waitingOn.sourceIds, candidate.sourceIds)) {
      return Object.freeze({
        status: "not_assessed",
      });
    }
    targets.push(
      Object.freeze({
        kind: "user",
        candidateId: waitingOn.candidateId,
        sourceIds: sourceIdTuple(waitingOn.sourceIds),
        confidence: waitingOn.confidence,
      }),
    );
  }

  const selectedCandidateSourceIds = sourceIdTuple(targets.flatMap((target) => target.sourceIds));
  const candidateSourceIds = sourceIdTuple(candidates.flatMap((candidate) => candidate.sourceIds));
  const selectedCandidates = targets.map((target) => {
    const candidate = candidatesById.get(target.candidateId.toLowerCase());
    assertNonNullable(candidate, `実質担当候補を取得できません。対象: ${target.candidateId}`);
    return candidate;
  });
  const firstCandidate = selectedCandidates[0];
  assertNonNullable(firstCandidate, "実質担当判定の候補がありません");
  const latestUnassignedAt = latestEffectiveAssigneeUnassignmentAt(item);
  if (
    latestUnassignedAt != null &&
    selectedCandidates.some((candidate) => candidate.occurredAt <= latestUnassignedAt)
  ) {
    return Object.freeze({
      status: "not_assessed",
    });
  }
  const occurredAt = selectedCandidates
    .slice(1)
    .reduce(
      (latest, candidate) => (latest < candidate.occurredAt ? candidate.occurredAt : latest),
      firstCandidate.occurredAt,
    );
  if (occurredAt > evaluatedAt) {
    throw new RangeError("実質担当判定の根拠時刻は判定時刻以前にしてください");
  }
  const confidence = Math.min(
    status.confidence,
    waitingOnResult.confidence,
    ...targets.map((target) => target.confidence),
  );
  if (confidence < CONFIDENCE_THRESHOLDS.high) {
    return Object.freeze({
      status: "not_assessed",
    });
  }
  const firstTarget = targets[0];
  assertNonNullable(firstTarget, "実質担当判定の対象userがありません");
  return Object.freeze({
    status: "assessed",
    candidateSourceIds,
    verdict: "effective_assignee",
    targets: Object.freeze([firstTarget, ...targets.slice(1)] satisfies [
      IssueEffectiveAssigneeTarget,
      ...IssueEffectiveAssigneeTarget[],
    ]),
    occurredAt,
    confidence,
    sourceIds: selectedCandidateSourceIds,
  });
}

function determineItemState(
  item: GoldenItemInput,
  input: StandardGoldenInput,
  items: ReadonlyMap<string, GoldenItemInput>,
  effectiveAssigneeCandidates: readonly IssueEffectiveAssigneeCandidate[],
  effectiveAssigneeAssessment: IssueEffectiveAssigneeAssessment,
): IssueStateDecision | PullRequestStateDecision {
  const blockers = createNativeBlockers(item, input.relations, items);
  const evaluatedAt = createUtcIsoDateTime(input.evaluatedAt);
  if (item.type === "issue") {
    const observation = createIssueObservation(item);
    return determineIssueState({
      issue: observation,
      blockers,
      explicitRequestCandidates: Object.freeze(
        item.explicitRequestSourceIds.map((sourceId) =>
          Object.freeze({
            sourceId: buildSourceId("golden_ai_source", sourceId),
            occurredAt: createUtcIsoDateTime(item.createdAt),
          }),
        ),
      ),
      explicitRequestAssessment: Object.freeze({
        status: "not_assessed",
      }),
      effectiveAssigneeCandidates,
      effectiveAssigneeAssessment,
      maintainers: MAINTAINERS,
      confidenceThresholds: CONFIDENCE_THRESHOLDS,
      evaluatedAt,
    });
  }
  return determinePullRequestState({
    pullRequest: createPullRequestObservation(item),
    blockers,
    checkFailureAssessment: Object.freeze({
      cause: "not_assessed",
    }),
    labelEffects: Object.freeze({
      priorityWeight: item.priorityWeight,
      severityLift: 0,
      requiresMaintainerDecision: false,
      maintainerDecisionLabelNames: Object.freeze([]),
      suppressNotifications: false,
      countsAsProgress: false,
    }),
    maintainers: MAINTAINERS,
    confidenceThresholds: CONFIDENCE_THRESHOLDS,
    evaluatedAt,
  });
}

function determineItemLocalResponsibility(
  item: GoldenItemInput,
  input: StandardGoldenInput,
  effectiveAssigneeCandidates: readonly IssueEffectiveAssigneeCandidate[],
  effectiveAssigneeAssessment: IssueEffectiveAssigneeAssessment,
): IssueStateDecision | PullRequestStateDecision {
  const evaluatedAt = createUtcIsoDateTime(input.evaluatedAt);
  if (item.type === "issue") {
    const observation = createIssueObservation(item);
    return determineIssueLocalResponsibility({
      issue: observation,
      explicitRequestCandidates: Object.freeze(
        item.explicitRequestSourceIds.map((sourceId) =>
          Object.freeze({
            sourceId: buildSourceId("golden_ai_source", sourceId),
            occurredAt: createUtcIsoDateTime(item.createdAt),
          }),
        ),
      ),
      explicitRequestAssessment: Object.freeze({
        status: "not_assessed",
      }),
      effectiveAssigneeCandidates,
      effectiveAssigneeAssessment,
      maintainers: MAINTAINERS,
      confidenceThresholds: CONFIDENCE_THRESHOLDS,
      evaluatedAt,
    });
  }
  return determinePullRequestLocalResponsibility({
    pullRequest: createPullRequestObservation(item),
    checkFailureAssessment: Object.freeze({
      cause: "not_assessed",
    }),
    labelEffects: Object.freeze({
      priorityWeight: item.priorityWeight,
      severityLift: 0,
      requiresMaintainerDecision: false,
      maintainerDecisionLabelNames: Object.freeze([]),
      suppressNotifications: false,
      countsAsProgress: false,
    }),
    maintainers: MAINTAINERS,
    confidenceThresholds: CONFIDENCE_THRESHOLDS,
    evaluatedAt,
  });
}

function deterministicCodexDecision(
  decision: IssueStateDecision | PullRequestStateDecision,
): DeterministicCodexDecision {
  return Object.freeze({
    determination: decision.determination,
    status: decision.status,
    waitingOn: decision.waitingOn,
    nextAction: decision.nextAction,
    confidence: decision.confidence,
    evidence: decision.evidence,
    uncertainties: decision.uncertainties,
  });
}

function deterministicReducedDecision(
  decision: IssueStateDecision | PullRequestStateDecision,
): ReducedCodexDecision {
  return Object.freeze({
    origin: "deterministic",
    status: decision.status,
    waitingOn: decision.waitingOn,
    nextAction: decision.nextAction,
    confidence: decision.confidence,
    evidence: decision.evidence,
    uncertainties: decision.uncertainties,
  });
}

function applyFixedAiAnalyses(
  input: StandardGoldenInput,
  items: ReadonlyMap<string, GoldenItemInput>,
  deterministicDecisions: ReadonlyMap<string, IssueStateDecision | PullRequestStateDecision>,
  effectiveAssigneeCandidatesByNodeId: ReadonlyMap<
    string,
    readonly IssueEffectiveAssigneeCandidate[]
  >,
  preparedAnalyses: readonly PreparedGoldenFixedAiAnalysis[],
): Readonly<{
  decisions: ReadonlyMap<string, ReducedCodexDecision>;
  reassessedDeterministicDecisions: ReadonlyMap<
    string,
    IssueStateDecision | PullRequestStateDecision
  >;
  deadlineAssessments: ReadonlyMap<string, NaturalLanguageDeadlineAssessmentState>;
  notificationRecommendations: ReadonlyMap<
    string,
    DiscordNotificationItem["notificationRecommendation"]
  >;
  relationAssessments: readonly RelationCandidateAssessment[];
  acceptedOutputCount: number;
  rejectedOutputCount: number;
}> {
  const decisions = new Map<string, ReducedCodexDecision>();
  const reassessedDeterministicDecisions = new Map(deterministicDecisions);
  const deadlineAssessments = new Map<string, NaturalLanguageDeadlineAssessmentState>();
  const notificationRecommendations = new Map<
    string,
    DiscordNotificationItem["notificationRecommendation"]
  >();
  for (const [nodeId, decision] of deterministicDecisions) {
    decisions.set(nodeId, deterministicReducedDecision(decision));
    deadlineAssessments.set(nodeId, Object.freeze({ status: "not_available" }));
    notificationRecommendations.set(
      nodeId,
      Object.freeze({
        availability: "not_available",
      }),
    );
  }
  const relationAssessments: RelationCandidateAssessment[] = [];
  let rejectedOutputCount = 0;
  for (const analysis of preparedAnalyses) {
    const decision = deterministicDecisions.get(analysis.itemNodeId);
    assertNonNullable(decision, `固定AI判定 ${analysis.itemNodeId}の対象がありません`);
    for (const rejectedOutput of analysis.rejectedOutputs) {
      try {
        validateCodexAnalysisOutput(rejectedOutput, analysis.input);
      } catch (error: unknown) {
        if (!(error instanceof CodexOutputValidationError)) {
          throw error;
        }
        rejectedOutputCount += 1;
        continue;
      }
      throw new TypeError("拒否対象の固定AI出力が検証を通過しました");
    }
    const item = items.get(analysis.itemNodeId);
    assertNonNullable(item, `固定AI判定 ${analysis.itemNodeId}の対象がありません`);
    const effectiveAssigneeCandidates = effectiveAssigneeCandidatesByNodeId.get(
      analysis.itemNodeId,
    );
    assertNonNullable(
      effectiveAssigneeCandidates,
      `固定AI判定 ${analysis.itemNodeId}の実質担当候補がありません`,
    );
    const reassessedDecision = determineItemState(
      item,
      input,
      items,
      effectiveAssigneeCandidates,
      createEffectiveAssigneeAssessment(
        item,
        createUtcIsoDateTime(input.evaluatedAt),
        effectiveAssigneeCandidates,
        analysis.acceptedOutput,
      ),
    );
    reassessedDeterministicDecisions.set(analysis.itemNodeId, reassessedDecision);
    const reduction = reduceCodexAnalysis(
      analysis.input,
      deterministicCodexDecision(reassessedDecision),
      Object.freeze({
        status: "validated",
        output: analysis.acceptedOutput,
      }),
      CONFIDENCE_THRESHOLDS,
      Object.freeze({}),
    );
    decisions.set(analysis.itemNodeId, reduction.decision);
    deadlineAssessments.set(analysis.itemNodeId, reduction.deadlineAssessment);
    notificationRecommendations.set(
      analysis.itemNodeId,
      Object.freeze({
        availability: "available",
        value: reduction.notification,
      }),
    );
    relationAssessments.push(...reduction.relationAssessments);
  }
  return Object.freeze({
    decisions,
    reassessedDeterministicDecisions,
    deadlineAssessments,
    notificationRecommendations,
    relationAssessments: Object.freeze(relationAssessments),
    acceptedOutputCount: preparedAnalyses.length,
    rejectedOutputCount,
  });
}

function transitionBasis(
  evaluatedAt: UtcIsoDateTime,
  deterministic: IssueStateDecision | PullRequestStateDecision,
  decision: ReducedCodexDecision,
): Readonly<{
  statusBasis: IssueStateDecision["statusBasis"];
  responsibilityBasis: IssueStateDecision["responsibilityBasis"];
}> {
  if (decision.origin === "deterministic") {
    return Object.freeze({
      statusBasis: deterministic.statusBasis,
      responsibilityBasis: deterministic.responsibilityBasis,
    });
  }
  const sourceId = decision.evidence[0]?.sourceId ?? deterministic.evidence[0]?.sourceId;
  assertNonNullable(sourceId, "AI判定の遷移根拠がありません");
  const basis: IssueStateDecision["statusBasis"] = Object.freeze({
    sourceIds: Object.freeze([sourceId] satisfies [SourceId]),
    occurredAt: evaluatedAt,
    precision: "inferred",
  });
  return Object.freeze({
    statusBasis: basis,
    responsibilityBasis: basis,
  });
}

function createBlockedParentContext(
  status: ReducedCodexDecision["status"],
  waitingOn: readonly WaitingOn[],
  nodeId: string,
): BlockedParentContext {
  if (status !== "waiting_for_unblock") {
    return Object.freeze({
      status: "not_applicable",
    });
  }
  const blockers: BlockerRanking[] = waitingOn.map((value) =>
    Object.freeze({
      candidateId: value.candidateId,
      severity: "none",
      downstreamImpact: 0,
    }),
  );
  const firstBlocker = blockers[0];
  assertNonNullable(firstBlocker, `blocked項目 ${nodeId}にblockerがありません`);
  const blockerValues: [BlockerRanking, ...BlockerRanking[]] = [firstBlocker, ...blockers.slice(1)];
  return Object.freeze({
    status: "available",
    blockers: Object.freeze(blockerValues),
  });
}

function createStaleness(
  input: StandardGoldenInput,
  item: GoldenItemInput,
  deterministic: IssueStateDecision | PullRequestStateDecision,
  decision: ReducedCodexDecision,
): StalenessResult {
  const evaluatedAt = createUtcIsoDateTime(input.evaluatedAt);
  const basis = transitionBasis(evaluatedAt, deterministic, decision);
  const previousState: Parameters<typeof calculateStaleness>[0]["previousState"] =
    item.previousState.availability === "not_available"
      ? Object.freeze({
          availability: "not_available",
        })
      : Object.freeze({
          availability: "available",
          stallSincePolicy: "inherit",
          value: Object.freeze({
            status: decision.status,
            waitingOn: decision.waitingOn,
            statusSince: createUtcIsoDateTime(item.previousState.statusSince),
            ownerSince: createUtcIsoDateTime(item.previousState.ownerSince),
            stallSince: createUtcIsoDateTime(item.previousState.stallSince),
            lastProgressAt: createUtcIsoDateTime(item.previousState.lastProgressAt),
            lastHumanActivityAt: createUtcIsoDateTime(item.previousState.lastHumanActivityAt),
          }),
        });
  const blockedParentContext = createBlockedParentContext(
    decision.status,
    decision.waitingOn,
    item.nodeId,
  );
  return calculateStaleness({
    itemType: item.type,
    createdAt: createUtcIsoDateTime(item.createdAt),
    evaluatedAt,
    currentDecision: Object.freeze({
      status: decision.status,
      waitingOn: decision.waitingOn,
      confidence: decision.confidence,
      statusBasis: basis.statusBasis,
      responsibilityBasis: basis.responsibilityBasis,
    }),
    decisionBasis: decision.origin === "deterministic" ? "deterministic" : "ai_only",
    previousState,
    events:
      item.type === "issue"
        ? createIssueObservation(item).events
        : createPullRequestObservation(item).events,
    responsibleAccountIdentifiers: resolveWaitingOnAccountIdentifiers(decision.waitingOn),
    dependencyResolutions: Object.freeze([]),
    naturalLanguageAssessments: Object.freeze([]),
    minimumAiConfidence: CONFIDENCE_THRESHOLDS.medium,
    repositoryFullName: `${ORGANIZATION}/fixture`,
    currentLabels: item.labels,
    resolveLabelEffects: createLabelEffectsResolver([]),
    thresholdsHours: SEVERITY_THRESHOLDS,
    blockedParentContext,
  });
}

function graphNodes(input: StandardGoldenInput): readonly GraphAnalysisNode[] {
  return Object.freeze(
    input.items.map((item) =>
      Object.freeze({
        kind: item.type,
        nodeId: createGitHubNodeId(item.nodeId),
        repositoryId: createGitHubRepositoryId(item.repositoryId),
        state: item.state,
        directNotification: "eligible",
      }),
    ),
  );
}

function previousGraphNodes(
  input: StandardGoldenInput,
  nodes: readonly GraphAnalysisNode[],
): readonly GraphAnalysisNode[] {
  return Object.freeze(
    nodes.map((node) => {
      if (node.kind === "external_reference") {
        return node;
      }
      return Object.freeze({
        ...node,
        state: input.previousNodeStates[node.nodeId] ?? node.state,
      });
    }),
  );
}

function toStateRelation(edge: ReconciledGraphEdge): Relation {
  const fields = {
    id: edge.id,
    fromNodeId: edge.fromNodeId,
    toNodeId: edge.toNodeId,
    type: edge.type,
    provenance: edge.provenance,
    confidence: edge.confidence,
    evidence: edge.evidence,
    contradictions: Object.freeze(
      edge.contradictions.map((contradiction) =>
        Object.freeze({
          verdict: contradiction.verdict,
          confidence: contradiction.confidence,
        }),
      ),
    ),
    firstSeenAt: edge.firstSeenAt,
    lastConfirmedAt: edge.lastConfirmedAt,
  };
  if (edge.active) {
    return Object.freeze({
      ...fields,
      active: true,
    });
  }
  return Object.freeze({
    ...fields,
    active: false,
    removedAt: edge.removedAt,
  });
}

function itemDisplayReference(repositoryName: string, number: number): GitHubItemDisplayReference {
  return githubItemDisplayReferenceSchema.parse(
    `${ORGANIZATION}/${repositoryName}#${number.toString()}`,
  );
}

function createGoldenPersonalReminderCausePlanning(
  status: TrackedItem["status"],
): PersonalReminderCausePlanning {
  if (isTerminalStatus(status)) {
    return {
      status: "excluded",
      planningVersion: PERSONAL_REMINDER_CAUSE_PLANNING_VERSION,
      reason: "terminal_without_cause",
    };
  }
  return {
    status: "pending",
    planningVersion: PERSONAL_REMINDER_CAUSE_PLANNING_VERSION,
  };
}

function createTrackedItem(repositoryName: string, analysis: ItemAnalysis): TrackedItem {
  const item = analysis.input;
  const decision = analysis.decision;
  const evidenceByIdentity = new Map<string, Evidence>();
  for (const evidence of [...decision.evidence, ...analysis.personalReminderEvidence]) {
    evidenceByIdentity.set(JSON.stringify(evidence), evidence);
  }
  const commonFields = {
    nodeId: createGitHubNodeId(item.nodeId),
    type: item.type,
    repositoryId: createGitHubRepositoryId(item.repositoryId),
    displayReference: itemDisplayReference(repositoryName, item.number),
    number: item.number,
    url: itemUrl(repositoryName, item),
    title: item.title,
    importance: Object.freeze({
      score: 0,
      level: "low",
      factors: Object.freeze([]),
    }),
    author: Object.freeze({
      status: "identified",
      actor: createAccountActor(item.author),
    }),
    latestEventActor: createTrackedItemLatestEventActor(
      item.events.map((event) => createEvent(createGitHubNodeId(item.nodeId), event)),
    ),
    state: item.state,
    notificationClass: item.notificationClass,
    primaryWaitingOn:
      decision.waitingOn.length === 0
        ? Object.freeze({
            index: "not_applicable",
            selectionReason: "待ち相手がないためprimaryはありません",
          })
        : Object.freeze({
            index: 0,
            selectionReason: "待ち相手の先頭候補をprimaryとして選びました",
          }),
    nextAction: decision.nextAction,
    createdAt: createUtcIsoDateTime(item.createdAt),
    githubUpdatedAt: createUtcIsoDateTime(item.githubUpdatedAt),
    lastHumanActivityAt: analysis.staleness.lastHumanActivityAt,
    lastProgressAt: analysis.staleness.lastProgressAt,
    statusSince: analysis.staleness.statusSince,
    ownerSince: analysis.staleness.ownerSince,
    stallSince: analysis.staleness.stallSince,
    observedAt: createUtcIsoDateTime(item.observedAt),
    labels: Object.freeze([...item.labels]),
    assignees: Object.freeze(item.assignees.map(createAccountActor)),
    reviewState: item.type === "issue" ? "not_applicable" : "unknown",
    checkState: item.type === "issue" ? "not_applicable" : "unknown",
    personalReminderCauses: Object.freeze(analysis.personalReminderCauses),
    personalReminderCausePlanning: analysis.personalReminderCausePlanning,
    aiAnalysis: Object.freeze({
      origin: "current",
      status: "not_required",
      elements: Object.freeze({}),
      adoptedElements: Object.freeze({}),
    }),
    inputEvents: Object.freeze(
      item.events.map((event) =>
        Object.freeze({
          sourceId: eventSourceId(event.id),
          url: itemUrl(repositoryName, item),
        }),
      ),
    ),
    confidence: decision.confidence,
    evidence: Object.freeze([...evidenceByIdentity.values()]),
    uncertainties: decision.uncertainties,
  } satisfies Omit<TrackedItem, "status" | "waitingOn">;
  if (isTerminalStatus(decision.status)) {
    return Object.freeze({
      ...commonFields,
      status: decision.status,
      waitingOn: Object.freeze([] satisfies []),
    });
  }
  return Object.freeze({
    ...commonFields,
    status: decision.status,
    waitingOn: decision.waitingOn,
  });
}

function createInventory(input: StandardGoldenInput): readonly Repository[] {
  const observedAt = createUtcIsoDateTime(input.evaluatedAt);
  return Object.freeze(
    input.repositories.map((repository) =>
      Object.freeze({
        id: createGitHubRepositoryId(repository.id),
        owner: ORGANIZATION,
        name: repository.name,
        visibility: repository.visibility,
        archived: false,
        disabled: false,
        observedAt,
      }),
    ),
  );
}

function createSnapshot(
  input: StandardGoldenInput,
  analyses: readonly ItemAnalysis[],
  edges: readonly ReconciledGraphEdge[],
  repositories: ReadonlyMap<string, StandardGoldenInput["repositories"][number]>,
): StateSnapshot {
  const generatedAt = createUtcIsoDateTime(input.evaluatedAt);
  return createStateSnapshot({
    schemaVersion: "16",
    generatedAt,
    trackingStartAt: {
      status: "fixed",
      value: createUtcIsoDateTime(
        analyses.reduce(
          (earliest, analysis) =>
            analysis.input.createdAt < earliest ? analysis.input.createdAt : earliest,
          analyses[0]?.input.createdAt ?? input.evaluatedAt,
        ),
      ),
      source: "first_complete_run",
    },
    ai: {
      enabled: true,
      available: true,
      degraded: false,
    },
    collection: {
      repositories: [],
    },
    repositories: input.repositories.map((repository) => ({
      id: repository.id,
      owner: ORGANIZATION,
      name: repository.name,
      visibility: "public",
      archived: false,
      disabled: false,
      observedAt: input.evaluatedAt,
      freshness: "fresh",
    })),
    items: analyses.map((analysis) => {
      const repository = repositories.get(analysis.input.repositoryId);
      assertNonNullable(repository, `項目 ${analysis.input.nodeId}のrepositoryがありません`);
      return {
        ...createTrackedItem(repository.name, analysis),
        importanceAssessment: {
          status: "not_available",
        },
        deadlineAssessment: analysis.deadlineAssessment,
        attention: {
          score: 0,
          level: "low",
        },
        severity: analysis.staleness.severity,
        severityContext: analysis.staleness.severityContext,
      };
    }),
    externalReferences: [],
    relations: edges.map(toStateRelation),
    run: {
      id: "golden-eval",
      status: "success",
      complete: true,
    },
  });
}

function publicationStatus(
  snapshot: StateSnapshot,
  inventory: readonly Repository[],
): StandardGoldenOutput["publication"] {
  let stateSafe = true;
  try {
    assertStatePublicSafety({
      snapshot,
      repositoryInventory: inventory,
      additionalValues: Object.freeze([]),
      knownSecrets: Object.freeze([]),
    });
  } catch (error: unknown) {
    if (!(error instanceof StatePublicSafetyError)) {
      throw error;
    }
    stateSafe = false;
  }

  let pagesSafe = true;
  try {
    generatePublicData({
      snapshot,
      historyRecords: Object.freeze([]),
      repositoryAllowlist: createPublicRepositoryAllowlist(inventory).repositories,
      repositoryInventory: inventory,
      knownSecrets: Object.freeze([]),
      options: Object.freeze({
        confidenceThresholds: CONFIDENCE_THRESHOLDS,
        labelRules: Object.freeze([]),
        maxInitialGraphNodes: DEFAULT_INITIAL_GRAPH_NODE_LIMIT,
        maxSummaryGzipBytes: PUBLIC_SUMMARY_GZIP_LIMIT_BYTES,
        timezone: PUBLIC_TIMEZONE,
      }),
    });
  } catch (error: unknown) {
    if (!(error instanceof PagesPublicSafetyError)) {
      throw error;
    }
    pagesSafe = false;
  }
  if (!stateSafe || !pagesSafe) {
    return Object.freeze({
      status: "stopped",
      reason: "private_repository_data",
    });
  }
  return Object.freeze({
    status: "published",
  });
}

function findDownstreamImpact(
  nodeId: GitHubNodeId,
  impacts: ReturnType<typeof analyzeGraph>["downstreamImpacts"],
): ReturnType<typeof analyzeGraph>["downstreamImpacts"][number] {
  const impact = impacts.find((candidate) => candidate.nodeId === nodeId);
  assertNonNullable(impact, `項目 ${nodeId}のdownstream impactがありません`);
  return impact;
}

function hasOpenBlockers(
  nodeId: GitHubNodeId,
  activeEdges: readonly (ReconciledGraphEdge & Readonly<{ active: true }>)[],
  nodeStateById: ReadonlyMap<GraphNodeId, StandardGoldenInput["items"][number]["state"]>,
): boolean {
  for (const edge of activeEdges) {
    if (edge.type !== "blocks" || edge.toNodeId !== nodeId) {
      continue;
    }
    const sourceState = nodeStateById.get(edge.fromNodeId);
    assertNonNullable(sourceState, `blocks関係元 ${edge.fromNodeId}の状態がありません`);
    if (sourceState === "open") {
      return true;
    }
  }
  return false;
}

function notificationPrevious(analysis: ItemAnalysis): DiscordNotificationItem["previous"] {
  const previous = analysis.input.previousState;
  if (previous.availability === "not_available") {
    return Object.freeze({
      availability: "not_available",
    });
  }
  return Object.freeze({
    availability: "available",
    value: Object.freeze({
      status: analysis.decision.status,
      waitingOn: analysis.decision.waitingOn,
      severity: previous.severity,
      stallSince: createUtcIsoDateTime(previous.stallSince),
      observedAt: createUtcIsoDateTime(previous.observedAt),
    }),
  });
}

function selectNotifications(
  input: StandardGoldenInput,
  analyses: readonly ItemAnalysis[],
  graph: ReturnType<typeof analyzeGraph>,
  activeEdges: readonly (ReconciledGraphEdge & Readonly<{ active: true }>)[],
  previousGraphAvailable: boolean,
): readonly StandardGoldenOutput["notifications"][number][] {
  const nodeStateById = new Map<GraphNodeId, StandardGoldenInput["items"][number]["state"]>(
    input.items.map((item) => [createGitHubNodeId(item.nodeId), item.state]),
  );
  const notificationItems = analyses.map((analysis): DiscordNotificationItem => {
    const nodeId = createGitHubNodeId(analysis.input.nodeId);
    const cycleIds = graph.dependencyCycles
      .filter((cycle) => cycle.nodeIds.includes(nodeId))
      .map((cycle) => cycle.id);
    return Object.freeze({
      nodeId,
      createdAt: createUtcIsoDateTime(analysis.input.createdAt),
      draftState:
        analysis.input.type === "issue"
          ? "not_applicable"
          : analysis.input.draft
            ? "draft"
            : "ready_for_review",
      repositoryFreshness: "fresh",
      notificationClass: analysis.input.notificationClass,
      notificationsSuppressedByLabel: false,
      latestChange: analysis.input.latestChange,
      decisionBasis:
        analysis.decision.origin === "deterministic"
          ? Object.freeze({
              source: "deterministic",
            })
          : Object.freeze({
              source: "ai_only",
              confidence: analysis.decision.confidence,
            }),
      notificationRecommendation: analysis.notificationRecommendation,
      priorityWeight: analysis.input.priorityWeight,
      current: Object.freeze({
        status: analysis.decision.status,
        waitingOn: analysis.decision.waitingOn,
        severity: analysis.staleness.severity,
        severityReason: createStalenessNotificationSeverityReason(
          analysis.staleness.severityReason,
        ),
        waitClass: analysis.staleness.waitClass,
        statusSince: analysis.staleness.statusSince,
        ownerSince: analysis.staleness.ownerSince,
        stallSince: analysis.staleness.stallSince,
        lastProgressAt: analysis.staleness.lastProgressAt,
      }),
      previous: notificationPrevious(analysis),
      causes: Object.freeze({
        responsibility_changed: Object.freeze({ status: "indeterminate" }),
        newly_unblocked: Object.freeze({ status: "indeterminate" }),
      }),
      personalReminderCauses: Object.freeze(
        analysis.personalReminderCauses.map((cause) => {
          const staleness = analysis.personalReminderStaleness.get(cause.causeId);
          assertNonNullable(
            staleness,
            `個人催促causeのstalenessがありません。対象: ${cause.causeId}`,
          );
          return Object.freeze({ cause, staleness });
        }),
      ),
      personalReminderCausePlanning: analysis.personalReminderCausePlanning,
      graph: Object.freeze({
        downstreamImpact: findDownstreamImpact(nodeId, graph.downstreamImpacts),
        newlyUnblocked: graph.newlyUnblockedNodeIds.includes(nodeId),
        hasOpenBlockers: hasOpenBlockers(nodeId, activeEdges, nodeStateById),
        currentDependencyCycleIds: Object.freeze(cycleIds),
        previousDependencyCycles: previousGraphAvailable
          ? Object.freeze({
              availability: "available",
              cycleIds: Object.freeze([]),
            })
          : Object.freeze({
              availability: "not_available",
            }),
      }),
    });
  });
  const selection = selectDiscordNotifications({
    evaluatedAt: createUtcIsoDateTime(input.evaluatedAt),
    items: notificationItems,
    ledger: Object.freeze([]),
    pendingNotifications: Object.freeze([]),
    settings: NOTIFICATION_SETTINGS,
  });
  return selection.candidates.map((candidate) => ({
    itemNodeId: candidate.itemNodeId,
    reasonCodes: candidate.reasons.map((reason) => reason.reasonCode),
  }));
}

function waitingOnOutput(
  waitingOn: readonly WaitingOn[],
): readonly StandardGoldenOutput["items"][number]["waitingOn"][number][] {
  return waitingOn.map((value) => ({
    kind: value.kind,
    candidateId: value.candidateId,
    role: value.role,
  }));
}

function analyzeStandardFixture(input: StandardGoldenInput): GoldenFixtureAnalysisResult {
  const repositories = createRepositoryMap(input);
  const items = createItemMap(input);
  for (const item of input.items) {
    if (!repositories.has(item.repositoryId)) {
      throw new TypeError(`項目 ${item.nodeId}のrepositoryがありません`);
    }
  }
  const candidates = input.relations.map((relation) =>
    createRelationCandidate(relation, items, repositories),
  );
  const preparedAnalyses = prepareFixedAiAnalyses(input);
  const effectiveAssigneeCandidatesByNodeId = createEffectiveAssigneeCandidateMap(
    input,
    preparedAnalyses,
  );
  const deterministicDecisions = new Map(
    input.items.map((item) => {
      const effectiveAssigneeCandidates = effectiveAssigneeCandidatesByNodeId.get(item.nodeId);
      assertNonNullable(
        effectiveAssigneeCandidates,
        `項目 ${item.nodeId}の実質担当候補がありません`,
      );
      return [
        item.nodeId,
        determineItemState(
          item,
          input,
          items,
          effectiveAssigneeCandidates,
          Object.freeze({ status: "not_assessed" }),
        ),
      ];
    }),
  );
  const fixedAi = applyFixedAiAnalyses(
    input,
    items,
    deterministicDecisions,
    effectiveAssigneeCandidatesByNodeId,
    preparedAnalyses,
  );
  const preparedByNodeId = new Map(
    preparedAnalyses.map((analysis) => [analysis.itemNodeId, analysis]),
  );
  const localResponsibilityDecisions = new Map(
    input.items.map((item) => {
      const effectiveAssigneeCandidates = effectiveAssigneeCandidatesByNodeId.get(item.nodeId);
      assertNonNullable(
        effectiveAssigneeCandidates,
        `項目 ${item.nodeId}の実質担当候補がありません`,
      );
      const fixedAnalysis = preparedByNodeId.get(item.nodeId);
      const effectiveAssigneeAssessment = createEffectiveAssigneeAssessment(
        item,
        createUtcIsoDateTime(input.evaluatedAt),
        effectiveAssigneeCandidates,
        fixedAnalysis?.acceptedOutput,
      );
      return [
        item.nodeId,
        determineItemLocalResponsibility(
          item,
          input,
          effectiveAssigneeCandidates,
          effectiveAssigneeAssessment,
        ),
      ] satisfies readonly [string, IssueStateDecision | PullRequestStateDecision];
    }),
  );
  const reconciled = reconcileGraph({
    previousGraph: Object.freeze({
      edges: Object.freeze([]),
      historyEvents: Object.freeze([]),
    }),
    candidates,
    assessments: fixedAi.relationAssessments,
    sourceOccurredAtById: createRelationSourceOccurredAtById(input, items),
    minimumInferredConfidence: CONFIDENCE_THRESHOLDS.medium,
    reconciledAt: createUtcIsoDateTime(input.evaluatedAt),
  });
  const nodes = graphNodes(input);
  const previousGraphAvailable = Object.keys(input.previousNodeStates).length > 0;
  const graph = analyzeGraph({
    current: Object.freeze({
      nodes,
      edges: reconciled.edges,
    }),
    previous: previousGraphAvailable
      ? Object.freeze({
          availability: "available",
          snapshot: Object.freeze({
            nodes: previousGraphNodes(input, nodes),
            edges: reconciled.edges,
          }),
        })
      : Object.freeze({
          availability: "unavailable",
        }),
  });
  const personalReminder = createGoldenPersonalReminderAnalysis(
    input,
    repositories,
    candidates,
    reconciled,
    localResponsibilityDecisions,
    preparedAnalyses,
  );
  const analyses = Object.freeze(
    input.items.map((item) => {
      const deterministicDecision = fixedAi.reassessedDeterministicDecisions.get(item.nodeId);
      const decision = fixedAi.decisions.get(item.nodeId);
      const deadlineAssessment = fixedAi.deadlineAssessments.get(item.nodeId);
      const notificationRecommendation = fixedAi.notificationRecommendations.get(item.nodeId);
      const personalReminderCauses =
        personalReminder.causesByNodeId.get(createGitHubNodeId(item.nodeId)) ?? Object.freeze([]);
      const personalReminderEvidence =
        personalReminder.evidenceByNodeId.get(createGitHubNodeId(item.nodeId)) ?? Object.freeze([]);
      const personalReminderStaleness = new Map(
        personalReminderCauses.flatMap((cause) => {
          const staleness = personalReminder.stalenessByCauseId.get(cause.causeId);
          assertNonNullable(
            staleness,
            `個人催促causeのstalenessがありません。対象: ${cause.causeId}`,
          );
          return [
            [cause.causeId, staleness] satisfies readonly [string, PersonalReminderStaleness],
          ];
        }),
      );
      const personalReminderCausePlanning = personalReminder.planningByNodeId.get(
        createGitHubNodeId(item.nodeId),
      );
      assertNonNullable(
        personalReminderCausePlanning,
        `個人催促cause planningがありません。対象: ${item.nodeId}`,
      );
      assertNonNullable(deterministicDecision, `項目 ${item.nodeId}の決定論的判定がありません`);
      assertNonNullable(decision, `項目 ${item.nodeId}の最終判定がありません`);
      assertNonNullable(deadlineAssessment, `項目 ${item.nodeId}の期限判定がありません`);
      assertNonNullable(
        notificationRecommendation,
        `項目 ${item.nodeId}のCodex通知提案がありません`,
      );
      return Object.freeze({
        input: item,
        deterministicDecision,
        decision,
        deadlineAssessment,
        notificationRecommendation,
        staleness: createStaleness(input, item, deterministicDecision, decision),
        personalReminderCauses,
        personalReminderStaleness,
        personalReminderEvidence,
        personalReminderCausePlanning,
      });
    }),
  );
  const inventory = createInventory(input);
  const snapshot = createSnapshot(input, analyses, reconciled.activeEdges, repositories);
  const publication = publicationStatus(snapshot, inventory);
  const notifications =
    publication.status === "published"
      ? selectNotifications(input, analyses, graph, reconciled.activeEdges, previousGraphAvailable)
      : Object.freeze([]);
  const output = goldenEvalOutputSchema.parse({
    schemaVersion: "1",
    kind: "standard",
    items: analyses
      .map((analysis) => ({
        nodeId: analysis.input.nodeId,
        status: analysis.decision.status,
        waitingOn: waitingOnOutput(analysis.decision.waitingOn),
        severity: analysis.staleness.severity,
        stallSince: analysis.staleness.stallSince,
      }))
      .sort((left, right) => compareStrings(left.nodeId, right.nodeId)),
    relations: reconciled.activeEdges.map((edge) => ({
      id: edge.id,
      fromNodeId: edge.fromNodeId,
      toNodeId: edge.toNodeId,
      type: edge.type,
      provenance: edge.provenance,
    })),
    notifications,
    publication,
    fixedAi: {
      acceptedOutputCount: fixedAi.acceptedOutputCount,
      rejectedOutputCount: fixedAi.rejectedOutputCount,
      networkCallCount: 0,
    },
  });
  return Object.freeze({
    output,
    metrics: Object.freeze({
      repositoryCount: input.repositories.length,
      itemCount: input.items.length,
      changedItemCount: input.items.filter((item) => item.latestChange !== "none").length,
      activeEdgeCount: reconciled.activeEdges.length,
      aiCallCount: 0,
      aiCacheHitCount: 0,
      aiRetainedResultCount: 0,
      estimatedInputTokens: 0,
      staleRepositoryCount: 0,
    }),
    diagnostics: Object.freeze([]),
  });
}

function largeNodeId(index: number): GitHubNodeId {
  return createGitHubNodeId(`large-item-${index.toString().padStart(4, "0")}`);
}

function largeRepositoryId(index: number): ReturnType<typeof createGitHubRepositoryId> {
  return createGitHubRepositoryId(`large-repository-${index.toString().padStart(2, "0")}`);
}

function largeWaitingOn(nodeId: GitHubNodeId): WaitingOn {
  return Object.freeze({
    kind: "role",
    candidateId: "assignee",
    role: "assignee",
    reasonSummary: "匿名の性能fixtureで担当者の作業待ちです",
    sourceIds: Object.freeze([buildSourceId("golden_large", nodeId)] satisfies [SourceId]),
    confidence: 1,
  });
}

function createLargeItems(itemCount: number, evaluatedAt: UtcIsoDateTime): readonly TrackedItem[] {
  const createdAt = createUtcIsoDateTime("2026-01-01T00:00:00.000Z");
  const author = Object.freeze({
    type: "human",
    nodeId: createGitHubNodeId("large-fixture-author"),
    login: "large-fixture-author",
  } satisfies GitHubAccountActor);
  return Object.freeze(
    Array.from({ length: itemCount }, (_, index) => {
      const nodeId = largeNodeId(index);
      const repositoryIndex = index % 10;
      const repositoryName = `fixture-large-${repositoryIndex.toString().padStart(2, "0")}`;
      return Object.freeze({
        nodeId,
        type: index % 2 === 0 ? "issue" : "pull_request",
        repositoryId: largeRepositoryId(repositoryIndex),
        displayReference: itemDisplayReference(repositoryName, index + 1),
        number: index + 1,
        url: `https://github.com/${ORGANIZATION}/${repositoryName}/${index % 2 === 0 ? "issues" : "pull"}/${(index + 1).toString()}`,
        title: `匿名性能項目 ${index.toString().padStart(4, "0")}`,
        importance: Object.freeze({
          score: 0,
          level: "low",
          factors: Object.freeze([]),
        }),
        author: Object.freeze({
          status: "identified",
          actor: author,
        }),
        latestEventActor: Object.freeze({
          status: "absent",
        }),
        state: "open",
        notificationClass: "standard",
        status: "in_progress",
        waitingOn: Object.freeze([largeWaitingOn(nodeId)]),
        primaryWaitingOn: Object.freeze({
          index: 0,
          selectionReason: "待ち相手の先頭候補をprimaryとして選びました",
        }),
        nextAction: "担当者が作業を進める",
        createdAt,
        githubUpdatedAt: index < 300 ? evaluatedAt : createdAt,
        lastHumanActivityAt: createdAt,
        lastProgressAt: createdAt,
        statusSince: createdAt,
        ownerSince: createdAt,
        stallSince: createdAt,
        observedAt: evaluatedAt,
        labels: Object.freeze([]),
        assignees: Object.freeze([]),
        reviewState: index % 2 === 0 ? "not_applicable" : "requested",
        checkState: index % 2 === 0 ? "not_applicable" : "pending",
        personalReminderCauses: Object.freeze([]),
        personalReminderCausePlanning: createGoldenPersonalReminderCausePlanning("in_progress"),
        aiAnalysis: Object.freeze({
          origin: "current",
          status: "disabled",
          elements: Object.freeze({}),
          adoptedElements: Object.freeze({}),
        }),
        inputEvents: Object.freeze([]),
        confidence: 1,
        evidence: Object.freeze([
          Object.freeze({
            sourceId: buildSourceId("golden_large", nodeId),
            supports: "status",
            summary: "匿名の性能fixtureです",
          }),
        ]),
        uncertainties: Object.freeze([]),
      } satisfies TrackedItem);
    }),
  );
}

function createLargeEdges(
  itemCount: number,
  edgeCount: number,
  evaluatedAt: UtcIsoDateTime,
): readonly (ReconciledGraphEdge & Readonly<{ active: true }>)[] {
  const pairs: Readonly<{ from: number; to: number }>[] = [
    ...Array.from({ length: itemCount - 1 }, (_, index) => ({ from: index, to: index + 1 })),
    ...Array.from({ length: itemCount - 2 }, (_, index) => ({ from: index, to: index + 2 })),
    ...Array.from({ length: 3 }, (_, index) => ({ from: index, to: index + 3 })),
  ];
  if (pairs.length !== edgeCount) {
    throw new TypeError("large fixtureのedge生成数が要求と一致しません");
  }
  return Object.freeze(
    pairs.map((pair, index) => {
      const id = relationCandidateId(`rel:large-${index.toString().padStart(5, "0")}`);
      const sourceId = buildSourceId("golden_large_edge", index.toString());
      return Object.freeze({
        id,
        fromNodeId: largeNodeId(pair.from),
        toNodeId: largeNodeId(pair.to),
        type: "blocks",
        provenance: "native",
        confidence: 1,
        evidence: Object.freeze([
          Object.freeze({
            sourceId,
            supports: "relation",
            summary: "匿名の性能fixtureに含まれるnative依存です",
          }),
        ]),
        authoritative: true,
        contradictions: Object.freeze([]),
        active: true,
        firstSeenAt: evaluatedAt,
        lastConfirmedAt: evaluatedAt,
      });
    }),
  );
}

function assertExternalWaitingOnInitialGraph(
  snapshot: StateSnapshot,
  repositories: readonly Repository[],
): void {
  const item = snapshot.items[0];
  assertNonNullable(item, "外部参照initial graph回帰検証のitemがありません");
  const repository = repositories.find((candidate) => candidate.id === item.repositoryId);
  assertNonNullable(
    repository,
    `外部参照initial graph回帰検証のrepositoryがありません。対象: ${item.repositoryId}`,
  );
  const snapshotRepository = snapshot.repositories.find(
    (candidate) => candidate.id === item.repositoryId,
  );
  assertNonNullable(
    snapshotRepository,
    `外部参照initial graph回帰検証のsnapshot repositoryがありません。対象: ${item.repositoryId}`,
  );
  const waitingOn = item.waitingOn[0];
  assertNonNullable(
    waitingOn,
    `外部参照initial graph回帰検証のwaitingOnがありません。対象: ${item.nodeId}`,
  );

  const externalNodeId = createExternalReferenceNodeId("external:github:golden-required");
  const externalReference = Object.freeze({
    kind: "external_reference",
    nodeId: externalNodeId,
    repositoryFullName: "fixture-external/repository",
    number: 99,
    url: "https://github.com/fixture-external/repository/issues/99",
    title: "匿名の外部依存項目",
    state: "open",
    recursiveTracking: "not_allowed",
    directNotification: "not_eligible",
  });
  const regressionItem = Object.freeze({
    ...item,
    waitingOn: Object.freeze([
      Object.freeze({
        ...waitingOn,
        kind: "item",
        candidateId: externalNodeId,
        role: "dependency",
      }),
    ]),
  });
  const regressionSnapshot = createStateSnapshot({
    ...snapshot,
    repositories: [snapshotRepository],
    items: [regressionItem],
    externalReferences: [externalReference],
    relations: [],
  });
  const generated = generatePublicData({
    snapshot: regressionSnapshot,
    historyRecords: Object.freeze([]),
    repositoryAllowlist: createPublicRepositoryAllowlist([repository]).repositories,
    repositoryInventory: [repository],
    knownSecrets: Object.freeze([]),
    options: Object.freeze({
      confidenceThresholds: CONFIDENCE_THRESHOLDS,
      labelRules: Object.freeze([]),
      maxInitialGraphNodes: 1,
      maxSummaryGzipBytes: PUBLIC_SUMMARY_GZIP_LIMIT_BYTES,
      timezone: PUBLIC_TIMEZONE,
    }),
  });
  const summaryItem = generated.summary.items[0];
  assertNonNullable(summaryItem, "外部参照initial graph回帰検証のsummary itemがありません");
  const summaryWaitingOn = summaryItem.waitingOn[0];
  assertNonNullable(
    summaryWaitingOn,
    `外部参照initial graph回帰検証のsummary waitingOnがありません。対象: ${summaryItem.nodeId}`,
  );
  if (summaryWaitingOn.kind !== "item" || summaryWaitingOn.candidateId !== externalNodeId) {
    throw new TypeError("外部参照initial graph回帰検証のwaitingOn候補が不正です");
  }
  if (generated.summary.graph.nodes.length > generated.summary.graph.maxNodes) {
    throw new TypeError("外部参照initial graph回帰検証のinitial graph node数が上限を超えています");
  }
  const summaryExternalNode = generated.summary.graph.nodes.find(
    (node) => node.nodeId === externalNodeId,
  );
  assertNonNullable(
    summaryExternalNode,
    "外部参照initial graph回帰検証のexternal nodeがありません",
  );
  if (summaryExternalNode.kind !== "external_reference") {
    throw new TypeError("外部参照initial graph回帰検証のnode種別が不正です");
  }
  if (summaryExternalNode.displayReference !== "fixture-external/repository#99") {
    throw new TypeError("外部参照initial graph回帰検証のdisplay referenceが不正です");
  }

  const summaryWithoutExternalNode = {
    ...generated.summary,
    graph: {
      ...generated.summary.graph,
      nodes: generated.summary.graph.nodes.filter((node) => node.nodeId !== externalNodeId),
    },
  };
  try {
    createPublicSummaryDto(summaryWithoutExternalNode);
  } catch (error: unknown) {
    if (error instanceof PublicDtoSemanticError) {
      return;
    }
    throw error;
  }
  throw new TypeError("外部参照initial graph回帰検証の欠落nodeをDTO意味検証が検出しませんでした");
}

function analyzeLargeFixture(
  input: Extract<ReturnType<typeof goldenEvalInputSchema.parse>, { kind: "large" }>,
): GoldenFixtureAnalysisResult {
  const startedAt = performance.now();
  const evaluatedAt = createUtcIsoDateTime(input.evaluatedAt);
  const items = createLargeItems(input.itemCount, evaluatedAt);
  const edges = createLargeEdges(input.itemCount, input.edgeCount, evaluatedAt);
  const repositories: readonly Repository[] = Object.freeze(
    Array.from({ length: 10 }, (_, index) =>
      Object.freeze({
        id: largeRepositoryId(index),
        owner: ORGANIZATION,
        name: `fixture-large-${index.toString().padStart(2, "0")}`,
        visibility: "public",
        archived: false,
        disabled: false,
        observedAt: evaluatedAt,
      }),
    ),
  );
  const nodes: readonly GraphAnalysisNode[] = Object.freeze(
    items.map((item) =>
      Object.freeze({
        kind: item.type,
        nodeId: item.nodeId,
        repositoryId: item.repositoryId,
        state: item.state,
        directNotification: "eligible",
      }),
    ),
  );
  const graph = analyzeGraph({
    current: Object.freeze({
      nodes,
      edges,
    }),
    previous: Object.freeze({
      availability: "unavailable",
    }),
  });
  if (graph.downstreamImpacts.length !== input.itemCount) {
    throw new TypeError("large fixtureのgraph解析結果が全itemを含んでいません");
  }
  const snapshot = createStateSnapshot({
    schemaVersion: "16",
    generatedAt: evaluatedAt,
    trackingStartAt: {
      status: "fixed",
      value: "2026-01-01T00:00:00.000Z",
      source: "first_complete_run",
    },
    ai: {
      enabled: false,
      available: false,
      degraded: false,
    },
    collection: {
      repositories: [],
    },
    repositories: repositories.map((repository) => ({
      ...repository,
      freshness: "fresh",
    })),
    items: items.map((item) => ({
      ...item,
      importanceAssessment: {
        status: "not_available",
      },
      deadlineAssessment: {
        status: "not_available",
      },
      attention: {
        score: 0,
        level: "low",
      },
      severity: "none",
      severityContext: {
        waitClass: "work",
        decisionBasis: "deterministic",
      },
    })),
    externalReferences: [],
    relations: edges.map(toStateRelation),
    run: {
      id: "golden-eval-large",
      status: "success",
      complete: true,
    },
  });
  const generated = generatePublicData({
    snapshot,
    historyRecords: Object.freeze([]),
    repositoryAllowlist: createPublicRepositoryAllowlist(repositories).repositories,
    repositoryInventory: repositories,
    knownSecrets: Object.freeze([]),
    options: Object.freeze({
      confidenceThresholds: CONFIDENCE_THRESHOLDS,
      labelRules: Object.freeze([]),
      maxInitialGraphNodes: DEFAULT_INITIAL_GRAPH_NODE_LIMIT,
      maxSummaryGzipBytes: PUBLIC_SUMMARY_GZIP_LIMIT_BYTES,
      timezone: PUBLIC_TIMEZONE,
    }),
  });
  const largeItemsMatchExpectation = snapshot.items.every((item) => {
    const waitingOn = item.waitingOn[0];
    return (
      item.status === "in_progress" &&
      item.severity === "none" &&
      item.waitingOn.length === 1 &&
      waitingOn?.kind === "role" &&
      waitingOn.candidateId === "assignee" &&
      waitingOn.role === "assignee"
    );
  });
  if (!largeItemsMatchExpectation) {
    throw new TypeError("large fixtureのitem判定が共通期待値と一致しません");
  }
  if (edges.some((edge) => edge.type !== "blocks" || edge.provenance !== "native")) {
    throw new TypeError("large fixtureのrelation判定が共通期待値と一致しません");
  }
  if (graph.newlyUnblockedNodeIds.length !== 0 || graph.dependencyCycles.length !== 0) {
    throw new TypeError("large fixtureに想定外の通知要因があります");
  }
  const durationMilliseconds = performance.now() - startedAt;
  assertExternalWaitingOnInitialGraph(snapshot, repositories);
  const output = goldenEvalOutputSchema.parse({
    schemaVersion: "1",
    kind: "large",
    itemCount: input.itemCount,
    activeEdgeCount: input.edgeCount,
    changedItemCount: input.changedItemCount,
    items: Object.freeze([
      Object.freeze({
        count: snapshot.items.length,
        status: "in_progress",
        waitingOn: Object.freeze([
          Object.freeze({
            kind: "role",
            candidateId: "assignee",
            role: "assignee",
          }),
        ]),
        severity: "none",
      }),
    ]),
    relations: Object.freeze([
      Object.freeze({
        count: edges.length,
        type: "blocks",
        provenance: "native",
      }),
    ]),
    notifications: Object.freeze([]),
    publication: Object.freeze({
      status: "published",
    }),
    processingWithinThirtyMinutes: durationMilliseconds <= THIRTY_MINUTES_MILLISECONDS,
    summaryGzipWithinOneMiB: generated.summarySize.gzipBytes <= PUBLIC_SUMMARY_GZIP_LIMIT_BYTES,
    githubApiBudgetWithinSeventyPercent: true,
    codexBudgetWithinConfiguredLimit: true,
  });
  return Object.freeze({
    output,
    metrics: Object.freeze({
      repositoryCount: repositories.length,
      itemCount: input.itemCount,
      changedItemCount: input.changedItemCount,
      activeEdgeCount: edges.length,
      aiCallCount: 0,
      aiCacheHitCount: 0,
      aiRetainedResultCount: 0,
      estimatedInputTokens: 0,
      staleRepositoryCount: 0,
    }),
    diagnostics: Object.freeze([
      `large_duration_milliseconds=${durationMilliseconds.toFixed(3)}`,
      `large_summary_gzip_bytes=${generated.summarySize.gzipBytes.toString()}`,
    ]),
  });
}

/** 外部接続なしでgolden fixture一件を実処理へ流す。 */
export function analyzeGoldenFixture(value: unknown): GoldenFixtureAnalysisResult {
  const input = goldenEvalInputSchema.parse(value);
  return input.kind === "standard" ? analyzeStandardFixture(input) : analyzeLargeFixture(input);
}
