import { performance } from "node:perf_hooks";

import { z } from "zod";

import {
  CodexOutputValidationError,
  AI_ANALYSIS_ELEMENT_INPUT_PROJECTION_VERSIONS,
  AI_ANALYSIS_ELEMENT_REVISIONS,
  createCodexAnalysisInput,
  hashCanonicalJson,
  reduceCodexAnalysis,
  serializeCanonicalJson,
  validateCodexAnalysisOutput,
  type CodexAnalysisInput,
  type CodexElementOutput,
  type DeterministicCodexDecision,
  type ReducedCodexDecision,
} from "../codex/index.js";
import {
  AI_ANALYSIS_ELEMENT_SCHEMA_VERSION,
  AI_ANALYSIS_ELEMENTS,
  aiAnalysisElementApplicationsSchema,
  aiAnalysisElementReuseProofSchema,
  createAiAnalysisElementGenerationSchema,
  createAiAnalysisMigrationElementResultSchema,
} from "../domain/ai-analysis-elements.js";
import {
  buildSourceId,
  calculateStaleness,
  aiAnalysisElementApplicationUsesAiValue,
  aiAnalysisDependencyForApplication,
  combineAiAnalysisDependencies,
  type AiAnalysisDependency,
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
  type AiAnalysisElement,
  type AiAnalysisElementApplication,
  type AiAnalysisElementMigrationResult,
  type BlockedParentContext,
  type BlockerDecisionTrace,
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
  type TrackedItemAiDependencies,
  type TrackedItemAiAnalysisApplications,
  type TrackedItemAiAnalysisCurrentAdoptedElement,
  type TrackedItemAiAnalysisCurrentAdoptedElements,
  type TrackedItemAiAnalysisCurrentElement,
  type TrackedItemAiAnalysisCurrentElements,
  type UtcIsoDateTime,
  type WaitingOn,
} from "../domain/index.js";
import { selectDiscordNotifications, type DiscordNotificationItem } from "../discord/index.js";
import {
  applyPersonalReminderCauseOutcomes,
  createPersonalReminderRuntimeContext,
  planPersonalReminderCauses,
  type PersonalReminderRuntimeCollectionCompleteness,
  type PersonalReminderRuntimeCandidateEndpointItem,
  type PersonalReminderRuntimeGraph,
  type PersonalReminderRuntimeItem,
  type PersonalReminderRuntimeLocalDecision,
} from "../cli/personal-reminder-runtime.js";
import {
  analyzeGraph,
  analyzeGraphAiDependencies,
  normalizeRelationCandidates,
  reconcileGraph,
  type AnalyzeGraphInput,
  type BlockerNodeAiDependency,
  type GraphAnalysisNode,
  type OrganizationRelationCandidateNode,
  type ReconciledGraphEdge,
  type RelationCandidate,
  type RelationCandidateAssessment,
  type RelationCandidateDecisionProof,
  type RelationCandidateId,
  type RelationCandidateResolution,
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
import { assertNonNullable, UnreachableError } from "../util/index.js";
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
  fixedAiAnalysis: PreparedGoldenFixedAiAnalysis | undefined;
  aiAnalysisApplications: TrackedItemAiAnalysisApplications;
  aiDependencies: TrackedItemAiDependencies;
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

function goldenRelationEndpointNodeIds(
  candidate: RelationCandidate,
): readonly [GraphNodeId, GraphNodeId] {
  switch (candidate.relation.type) {
    case "blocks":
      return Object.freeze([candidate.relation.blocker.nodeId, candidate.relation.blocked.nodeId]);
    case "parent_of":
      return Object.freeze([candidate.relation.parent.nodeId, candidate.relation.subtask.nodeId]);
    case "implements":
      return Object.freeze([
        candidate.relation.implementation.nodeId,
        candidate.relation.target.nodeId,
      ]);
    case "unclassified":
      return Object.freeze([
        candidate.relation.referencing.nodeId,
        candidate.relation.referenced.nodeId,
      ]);
  }
}

function goldenRelationAssessmentOwnerNodeId(candidate: RelationCandidate): GraphNodeId {
  switch (candidate.relation.type) {
    case "blocks":
      return candidate.relation.blocked.nodeId;
    case "parent_of":
      return candidate.relation.parent.nodeId;
    case "implements":
      return candidate.relation.implementation.nodeId;
    case "unclassified":
      return candidate.relation.referencing.nodeId;
  }
}

function goldenPersonalReminderCandidateRelation(
  candidate: RelationCandidate,
  aiDependenciesByCandidateId: ReadonlyMap<RelationCandidateId, AiAnalysisDependency>,
  proof: RelationCandidateDecisionProof,
  resolution: RelationCandidateResolution,
): PersonalReminderRuntimeGraph["candidateRelations"][number] {
  const [firstNode, secondNode] = goldenRelationEndpointNodeIds(candidate);
  if (firstNode === secondNode) {
    throw new TypeError(`個人催促relation候補のendpointが同一です。対象: ${candidate.id}`);
  }
  const endpointNodeIds = [firstNode, secondNode].sort(compareStrings);
  const firstEndpoint = endpointNodeIds[0];
  const secondEndpoint = endpointNodeIds[1];
  assertNonNullable(
    firstEndpoint,
    `個人催促relation候補のendpointがありません。対象: ${candidate.id}`,
  );
  assertNonNullable(
    secondEndpoint,
    `個人催促relation候補のendpointがありません。対象: ${candidate.id}`,
  );
  const sourceIds = [...new Set(candidate.sourceIds)].sort(compareStrings);
  const firstSourceId = sourceIds[0];
  assertNonNullable(
    firstSourceId,
    `個人催促relation候補のsourceがありません。対象: ${candidate.id}`,
  );
  const endpointTuple: readonly [GraphNodeId, GraphNodeId] = [firstEndpoint, secondEndpoint];
  const sourceTuple: readonly [SourceId, ...SourceId[]] = [firstSourceId, ...sourceIds.slice(1)];
  const aiDependency = aiDependenciesByCandidateId.get(candidate.id);
  assertNonNullable(
    aiDependency,
    `個人催促relation候補のAI依存がありません。対象: ${candidate.id}`,
  );
  if (proof.candidateId !== candidate.id || resolution.candidateId !== candidate.id) {
    throw new TypeError(`個人催促relation候補のproof IDが一致しません。対象: ${candidate.id}`);
  }
  if (proof.authority !== candidate.authority) {
    throw new TypeError(
      `個人催促relation候補のproof authorityが一致しません。対象: ${candidate.id}`,
    );
  }
  if (proof.endpointNodeIds[0] !== firstNode || proof.endpointNodeIds[1] !== secondNode) {
    throw new TypeError(
      `個人催促relation候補のproof endpointが一致しません。対象: ${candidate.id}`,
    );
  }
  if (proof.resolution.status !== resolution.status) {
    throw new TypeError(`個人催促relation候補のresolutionが一致しません。対象: ${candidate.id}`);
  }
  if (serializeCanonicalJson(proof.resolution) !== serializeCanonicalJson(resolution)) {
    throw new TypeError(
      `個人催促relation候補のresolution内容が一致しません。対象: ${candidate.id}`,
    );
  }
  if (serializeCanonicalJson(proof.dependency) !== serializeCanonicalJson(aiDependency)) {
    throw new TypeError(`個人催促relation候補のproof AI依存が一致しません。対象: ${candidate.id}`);
  }
  return Object.freeze({
    candidateId: candidate.id,
    endpointNodeIds: Object.freeze(endpointTuple),
    ownerNodeId: goldenRelationAssessmentOwnerNodeId(candidate),
    relationType: candidate.relation.type,
    authority: candidate.authority,
    provenance: candidate.provenance,
    resolution,
    ...(proof.canonicalRelation == null ? {} : { canonicalRelation: proof.canonicalRelation }),
    evidenceSourceIds: Object.freeze(sourceTuple),
    aiDependency,
  });
}

function goldenPersonalReminderCandidateRelations(
  candidates: readonly RelationCandidate[],
  aiDependenciesByCandidateId: ReadonlyMap<RelationCandidateId, AiAnalysisDependency>,
  proofs: readonly RelationCandidateDecisionProof[],
  resolutions: readonly RelationCandidateResolution[],
): readonly PersonalReminderRuntimeGraph["candidateRelations"][number][] {
  const proofsByCandidateId = new Map<RelationCandidateId, RelationCandidateDecisionProof>();
  for (const proof of proofs) {
    if (proofsByCandidateId.has(proof.candidateId)) {
      throw new TypeError(
        `個人催促relation候補のproof IDが重複しています。対象: ${proof.candidateId}`,
      );
    }
    proofsByCandidateId.set(proof.candidateId, proof);
  }
  const resolutionsByCandidateId = new Map<RelationCandidateId, RelationCandidateResolution>();
  for (const resolution of resolutions) {
    if (resolutionsByCandidateId.has(resolution.candidateId)) {
      throw new TypeError(
        `個人催促relation候補のresolution IDが重複しています。対象: ${resolution.candidateId}`,
      );
    }
    resolutionsByCandidateId.set(resolution.candidateId, resolution);
  }
  const candidateIds = new Set<RelationCandidateId>();
  for (const candidate of candidates) {
    if (candidateIds.has(candidate.id)) {
      throw new TypeError(`個人催促relation候補のIDが重複しています。対象: ${candidate.id}`);
    }
    candidateIds.add(candidate.id);
    if (!proofsByCandidateId.has(candidate.id) || !resolutionsByCandidateId.has(candidate.id)) {
      throw new TypeError(
        `個人催促relation候補のproofまたはresolutionがありません。対象: ${candidate.id}`,
      );
    }
  }
  for (const candidateId of proofsByCandidateId.keys()) {
    if (!candidateIds.has(candidateId)) {
      throw new TypeError(`個人催促relation候補のproof対象がありません。対象: ${candidateId}`);
    }
  }
  for (const candidateId of resolutionsByCandidateId.keys()) {
    if (!candidateIds.has(candidateId)) {
      throw new TypeError(`個人催促relation候補のresolution対象がありません。対象: ${candidateId}`);
    }
  }
  return Object.freeze(
    candidates.map((candidate) => {
      const proof = proofsByCandidateId.get(candidate.id);
      const resolution = resolutionsByCandidateId.get(candidate.id);
      assertNonNullable(proof, `個人催促relation候補のproofがありません。対象: ${candidate.id}`);
      assertNonNullable(
        resolution,
        `個人催促relation候補のresolutionがありません。対象: ${candidate.id}`,
      );
      return goldenPersonalReminderCandidateRelation(
        candidate,
        aiDependenciesByCandidateId,
        proof,
        resolution,
      );
    }),
  );
}

function goldenPersonalReminderCandidateEndpointItems(
  input: StandardGoldenInput,
  candidates: readonly RelationCandidate[],
): ReadonlyMap<GraphNodeId, PersonalReminderRuntimeCandidateEndpointItem> {
  const endpointItems = new Map<GraphNodeId, PersonalReminderRuntimeCandidateEndpointItem>();
  for (const item of input.items) {
    const nodeId = createGitHubNodeId(item.nodeId);
    if (endpointItems.has(nodeId)) {
      throw new TypeError(`個人催促relation候補endpoint itemが重複しています。対象: ${nodeId}`);
    }
    endpointItems.set(
      nodeId,
      Object.freeze({
        nodeId,
        type: item.type,
        state: item.state,
        author: Object.freeze({
          status: "identified",
          type: item.author.type,
          login: item.author.login,
        }),
      }),
    );
  }
  for (const candidate of candidates) {
    for (const nodeId of goldenRelationEndpointNodeIds(candidate)) {
      if (!endpointItems.has(nodeId)) {
        throw new TypeError(
          `個人催促relation候補endpoint itemがありません。対象: ${candidate.id} node: ${nodeId}`,
        );
      }
    }
  }
  return endpointItems;
}

function goldenPersonalReminderRuntimeGraph(
  input: StandardGoldenInput,
  candidates: readonly RelationCandidate[],
  reconciled: ReturnType<typeof reconcileGraph>,
  relationAiDependencies: ReadonlyMap<RelationCandidateId, AiAnalysisDependency>,
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
  const candidateRelations = goldenPersonalReminderCandidateRelations(
    candidates,
    relationAiDependencies,
    reconciled.candidateDecisionProofs,
    reconciled.candidateResolutions,
  );
  const candidateEndpointItemsByNodeId = goldenPersonalReminderCandidateEndpointItems(
    input,
    candidates,
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
    candidateEndpointItemsByNodeId,
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
  genericDecisionsByNodeId: ReadonlyMap<string, ReducedCodexDecision>,
  preparedAnalyses: readonly PreparedGoldenFixedAiAnalysis[],
  applicationsByNodeId: ReadonlyMap<string, TrackedItemAiAnalysisApplications>,
  relationAiDependencies: ReadonlyMap<RelationCandidateId, AiAnalysisDependency>,
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
      aiAnalysisApplications: TrackedItemAiAnalysisApplications;
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
    const aiAnalysisApplications = applicationsByNodeId.get(item.nodeId);
    assertNonNullable(aiAnalysisApplications, `項目 ${item.nodeId}のAI適用元がありません`);
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
        aiAnalysisApplications,
        bodyObserved: body?.observed ?? false,
      }),
    );
  }
  const graph = goldenPersonalReminderRuntimeGraph(
    input,
    candidates,
    reconciled,
    relationAiDependencies,
  );
  const snapshotEvidenceSourceIds = new Set<SourceId>([
    ...[...genericDecisionsByNodeId.values()].flatMap((decision) =>
      decision.evidence.map((evidence) => evidence.sourceId),
    ),
    ...reconciled.edges.flatMap((edge) => edge.evidence.map((evidence) => evidence.sourceId)),
  ]);
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
      aiAnalysisApplications: value.aiAnalysisApplications,
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
    snapshotEvidenceSourceIds,
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
  const causesByNodeId = new Map(applied.causesByNodeId);
  const planningEntries: readonly (readonly [GitHubNodeId, PersonalReminderCausePlanning])[] =
    input.items.map((item) => {
      const nodeId = createGitHubNodeId(item.nodeId);
      const collectionItem = collectionItems.find((value) => value.item.nodeId === nodeId);
      if (collectionItem == null) {
        const planning: PersonalReminderCausePlanning =
          item.state === "open"
            ? {
                status: "pending",
                planningVersion: PERSONAL_REMINDER_CAUSE_PLANNING_VERSION,
              }
            : {
                status: "excluded",
                planningVersion: PERSONAL_REMINDER_CAUSE_PLANNING_VERSION,
                reason: "terminal_without_cause",
              };
        return [nodeId, planning];
      }
      if (collectionItem.completeness.status === "incomplete") {
        const planning: PersonalReminderCausePlanning = Object.freeze({
          status: "pending",
          planningVersion: PERSONAL_REMINDER_CAUSE_PLANNING_VERSION,
        });
        return [nodeId, planning];
      }
      const hasPlannedCause = plan.entries.some((entry) => entry.seed.itemNodeId === nodeId);
      if (item.state !== "open" && !hasPlannedCause) {
        const planning: PersonalReminderCausePlanning = Object.freeze({
          status: "excluded",
          planningVersion: PERSONAL_REMINDER_CAUSE_PLANNING_VERSION,
          reason: "terminal_without_cause",
        });
        return [nodeId, planning];
      }
      const causeSetAiDependency = plan.causeSetAiDependencyByNodeId.get(nodeId);
      assertNonNullable(
        causeSetAiDependency,
        `個人催促cause集合のAI依存がありません。対象: ${nodeId}`,
      );
      const causeSetSubjectChanges = plan.causeSetSubjectChangesByNodeId.get(nodeId);
      assertNonNullable(
        causeSetSubjectChanges,
        `個人催促cause集合の主体変化範囲がありません。対象: ${nodeId}`,
      );
      const planning: PersonalReminderCausePlanning = Object.freeze({
        status: "completed",
        planningVersion: PERSONAL_REMINDER_CAUSE_PLANNING_VERSION,
        observedAt: createUtcIsoDateTime(input.evaluatedAt),
        causeSetAiDependency,
        causeSetSubjectChanges,
      });
      return [nodeId, planning];
    });
  return Object.freeze({
    causesByNodeId,
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
  candidates: readonly RelationCandidate[],
): ReadonlyMap<SourceId, UtcIsoDateTime> {
  const sourceOccurredAtById = new Map<SourceId, UtcIsoDateTime>();
  for (const relation of input.relations) {
    const currentItem = items.get(relation.currentNodeId);
    assertNonNullable(currentItem, `関係 ${relation.id}のcurrent itemがありません`);
    const sourceId = buildSourceId("golden_relation", relation.sourceId);
    const occurredAt = createUtcIsoDateTime(currentItem.createdAt);
    const existingOccurredAt = sourceOccurredAtById.get(sourceId);
    if (existingOccurredAt == null || occurredAt < existingOccurredAt) {
      sourceOccurredAtById.set(sourceId, occurredAt);
    }
  }
  for (const candidate of candidates) {
    for (const sourceId of candidate.sourceIds) {
      if (!sourceOccurredAtById.has(sourceId)) {
        throw new TypeError(
          `関係候補 ${candidate.id}のsource ${sourceId}に対応する発生時刻がありません`,
        );
      }
    }
  }
  return sourceOccurredAtById;
}

function createFixedRelationAiDependencies(
  candidates: readonly RelationCandidate[],
  items: ReadonlyMap<string, GoldenItemInput>,
  assessments: readonly RelationCandidateAssessment[],
  applicationsByNodeId: ReadonlyMap<string, TrackedItemAiAnalysisApplications>,
): ReadonlyMap<RelationCandidateId, AiAnalysisDependency> {
  const candidatesById = new Map<RelationCandidateId, RelationCandidate>();
  for (const candidate of candidates) {
    if (candidatesById.has(candidate.id)) {
      throw new TypeError(`関係候補IDが重複しています。対象: ${candidate.id}`);
    }
    candidatesById.set(candidate.id, candidate);
  }
  const assessmentsByCandidateId = new Map<RelationCandidateId, RelationCandidateAssessment>();
  for (const assessment of assessments) {
    const candidate = candidatesById.get(assessment.candidateId);
    assertNonNullable(candidate, `関係候補 ${assessment.candidateId}がありません`);
    if (assessmentsByCandidateId.has(assessment.candidateId)) {
      throw new TypeError(`関係候補 ${assessment.candidateId}のAI依存が重複しています`);
    }
    const ownerNodeId = goldenRelationAssessmentOwnerNodeId(candidate);
    if (assessment.currentNodeId !== ownerNodeId) {
      throw new TypeError(
        `関係候補 ${assessment.candidateId}のAI判定ownerが一致しません。対象: ${ownerNodeId}`,
      );
    }
    assessmentsByCandidateId.set(assessment.candidateId, assessment);
  }
  const dependencies = new Map<RelationCandidateId, AiAnalysisDependency>();
  for (const candidate of candidates) {
    if (candidate.provenance === "native") {
      dependencies.set(candidate.id, GOLDEN_NOT_DEPENDENT_AI_DEPENDENCY);
      continue;
    }
    const ownerNodeId = goldenRelationAssessmentOwnerNodeId(candidate);
    const owner = items.get(ownerNodeId);
    assertNonNullable(owner, `関係候補 ${candidate.id}のtracked owner itemがありません`);
    const ownerGitHubNodeId = createGitHubNodeId(owner.nodeId);
    const assessment = assessmentsByCandidateId.get(candidate.id);
    if (assessment == null) {
      dependencies.set(
        candidate.id,
        aiAnalysisDependencyForApplication(ownerGitHubNodeId, "relations", {
          status: "unknown",
          reason: "proof_unknown",
        }),
      );
      continue;
    }
    const applications = applicationsByNodeId.get(owner.nodeId);
    assertNonNullable(applications, `関係候補 ${candidate.id}のcurrent itemのAI適用元がありません`);
    dependencies.set(
      candidate.id,
      aiAnalysisDependencyForApplication(ownerGitHubNodeId, "relations", applications.relations),
    );
  }
  return dependencies;
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

function createFixedAiAnalysisApplications(
  analysis: PreparedGoldenFixedAiAnalysis,
  reduction: ReturnType<typeof reduceCodexAnalysis>,
): TrackedItemAiAnalysisApplications {
  if (reduction.ai.status !== "available") {
    throw new TypeError(`固定AI判定 ${analysis.itemNodeId}が利用不可になりました`);
  }
  const reductionElements = reduction.ai.elements;
  const selectedElements = new Set<AiAnalysisElement>(analysis.input.selectedElements);
  const applicationFor = (element: AiAnalysisElement): AiAnalysisElementApplication => {
    if (!selectedElements.has(element)) {
      return Object.freeze({
        status: "not_required",
      });
    }
    const reductionElement = reductionElements[element];
    assertNonNullable(reductionElement, `固定AI判定 ${analysis.itemNodeId}の適用元がありません`);
    switch (reductionElement.application) {
      case "applied":
        return Object.freeze({
          status: "current_ai",
          origin: "executed",
        });
      case "deterministic_fallback":
        return Object.freeze({
          status: "deterministic_fallback",
        });
      case "preserved":
        throw new TypeError(
          `固定AI判定 ${analysis.itemNodeId}でpreservedの適用元は指定できません。対象: ${element}`,
        );
      default:
        throw new UnreachableError(reductionElement.application);
    }
  };
  return Object.freeze({
    status: applicationFor("status"),
    waitingOn: applicationFor("waitingOn"),
    nextAction: applicationFor("nextAction"),
    relations: applicationFor("relations"),
    progress: applicationFor("progress"),
    importance: applicationFor("importance"),
    deadline: applicationFor("deadline"),
    notification: applicationFor("notification"),
    selfCommitment: applicationFor("selfCommitment"),
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
  applicationsByNodeId: ReadonlyMap<string, TrackedItemAiAnalysisApplications>;
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
  const applicationsByNodeId = new Map<string, TrackedItemAiAnalysisApplications>(
    input.items.map((item) => [item.nodeId, createGoldenAiAnalysisApplications("not_required")]),
  );
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
    applicationsByNodeId.set(
      analysis.itemNodeId,
      createFixedAiAnalysisApplications(analysis, reduction),
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
    applicationsByNodeId,
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
    aiDependency: edge.aiDependency,
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

function createGoldenAiAnalysisApplications(
  status: "not_required" | "disabled",
): TrackedItemAiAnalysisApplications {
  return Object.freeze(
    aiAnalysisElementApplicationsSchema.parse(
      Object.fromEntries(AI_ANALYSIS_ELEMENTS.map((element) => [element, { status }])),
    ),
  );
}

const GOLDEN_NOT_DEPENDENT_AI_DEPENDENCY = Object.freeze({
  status: "not_dependent",
}) satisfies AiAnalysisDependency;

function createGoldenNotDependentAiDependencies(): TrackedItemAiDependencies {
  return Object.freeze({
    status: GOLDEN_NOT_DEPENDENT_AI_DEPENDENCY,
    waitingOn: GOLDEN_NOT_DEPENDENT_AI_DEPENDENCY,
    nextAction: GOLDEN_NOT_DEPENDENT_AI_DEPENDENCY,
    primaryWaitingOn: GOLDEN_NOT_DEPENDENT_AI_DEPENDENCY,
    confidence: GOLDEN_NOT_DEPENDENT_AI_DEPENDENCY,
    evidence: GOLDEN_NOT_DEPENDENT_AI_DEPENDENCY,
    uncertainties: GOLDEN_NOT_DEPENDENT_AI_DEPENDENCY,
    deadline: GOLDEN_NOT_DEPENDENT_AI_DEPENDENCY,
    deadlineLevel: GOLDEN_NOT_DEPENDENT_AI_DEPENDENCY,
    lastProgressAt: GOLDEN_NOT_DEPENDENT_AI_DEPENDENCY,
    stallSince: GOLDEN_NOT_DEPENDENT_AI_DEPENDENCY,
    severity: GOLDEN_NOT_DEPENDENT_AI_DEPENDENCY,
    downstreamImpact: GOLDEN_NOT_DEPENDENT_AI_DEPENDENCY,
    importance: GOLDEN_NOT_DEPENDENT_AI_DEPENDENCY,
    attention: GOLDEN_NOT_DEPENDENT_AI_DEPENDENCY,
    blockers: GOLDEN_NOT_DEPENDENT_AI_DEPENDENCY,
    relationSet: GOLDEN_NOT_DEPENDENT_AI_DEPENDENCY,
  });
}

function goldenAiDependencyForApplication(
  nodeId: GitHubNodeId,
  applications: TrackedItemAiAnalysisApplications,
  element: AiAnalysisElement,
): AiAnalysisDependency {
  const application = applications[element];
  assertNonNullable(application, `AI適用元がありません。対象: ${nodeId} element: ${element}`);
  return aiAnalysisDependencyForApplication(nodeId, element, application);
}

function goldenCodexElementResult(
  output: CodexElementOutput,
  element: AiAnalysisElement,
): AiAnalysisElementMigrationResult | undefined {
  switch (element) {
    case "status":
      return output.status;
    case "waitingOn":
      return output.waitingOn;
    case "nextAction":
      return output.nextAction;
    case "relations":
      return output.relations;
    case "progress":
      return output.progress;
    case "importance":
      return output.importance;
    case "deadline":
      return output.deadline;
    case "notification":
      return output.notification;
    case "selfCommitment":
      return output.selfCommitment;
    default:
      throw new UnreachableError(element);
  }
}

const GOLDEN_STATE_AI_ANALYSIS_ELEMENTS: readonly AiAnalysisElement[] = Object.freeze([
  "status",
  "waitingOn",
  "nextAction",
]);

function combineGoldenAiDependencies(
  dependencies: readonly AiAnalysisDependency[],
): AiAnalysisDependency {
  if (dependencies.length === 0) {
    return GOLDEN_NOT_DEPENDENT_AI_DEPENDENCY;
  }
  return combineAiAnalysisDependencies(dependencies);
}

function goldenAiDependencyIndependencePriority(dependency: AiAnalysisDependency): number {
  switch (dependency.status) {
    case "not_dependent":
      return 0;
    case "current":
      return 1;
    case "unverified":
      return 2;
    case "unknown":
      return 3;
    default:
      throw new UnreachableError(dependency);
  }
}

function goldenCandidateAiDependency(
  dependency: AiAnalysisDependency,
  conditionDependencies: readonly AiAnalysisDependency[],
): AiAnalysisDependency {
  return combineGoldenAiDependencies([dependency, ...conditionDependencies]);
}

function preferGoldenAiDependency(
  dependencies: readonly AiAnalysisDependency[],
): AiAnalysisDependency {
  if (dependencies.length === 0) {
    return GOLDEN_NOT_DEPENDENT_AI_DEPENDENCY;
  }
  const minimumPriority = Math.min(...dependencies.map(goldenAiDependencyIndependencePriority));
  return combineGoldenAiDependencies(
    dependencies.filter(
      (dependency) => goldenAiDependencyIndependencePriority(dependency) === minimumPriority,
    ),
  );
}

function preferredGoldenAiDependencies(
  dependencies: readonly AiAnalysisDependency[],
  count: number,
): readonly AiAnalysisDependency[] {
  if (count < 0 || !Number.isInteger(count)) {
    throw new TypeError("選択するAI依存数は0以上の整数でなければなりません");
  }
  if (count > dependencies.length) {
    throw new TypeError("選択するAI依存数が候補数を超えています");
  }
  return Object.freeze(
    dependencies
      .map((dependency, index) => Object.freeze({ dependency, index }))
      .sort((left, right) => {
        const priorityOrder =
          goldenAiDependencyIndependencePriority(left.dependency) -
          goldenAiDependencyIndependencePriority(right.dependency);
        return priorityOrder === 0 ? left.index - right.index : priorityOrder;
      })
      .slice(0, count)
      .map((entry) => entry.dependency),
  );
}

type GoldenBlockerValueAiDependencies = Readonly<{
  stateSupport: "conditional" | "authoritative_blocker";
  status: AiAnalysisDependency;
  waitingOn: AiAnalysisDependency;
  primaryWaitingOn: AiAnalysisDependency;
  nextAction: AiAnalysisDependency;
  confidence: AiAnalysisDependency;
  evidence: AiAnalysisDependency;
  uncertainties: AiAnalysisDependency;
}>;

type GoldenBlockerDependencyContext = Readonly<{
  dependenciesByBlockedNodeId: ReadonlyMap<
    GraphNodeId,
    ReadonlyMap<string, BlockerNodeAiDependency>
  >;
  negativeDependenciesByNodeId: ReadonlyMap<GraphNodeId, AiAnalysisDependency>;
}>;

function createGoldenBlockerDependencyContext(
  graph: ReturnType<typeof analyzeGraphAiDependencies>,
): GoldenBlockerDependencyContext {
  const dependenciesByBlockedNodeId = new Map<GraphNodeId, Map<string, BlockerNodeAiDependency>>();
  for (const dependency of graph.blockerNodeAiDependencies) {
    const dependenciesByBlockerNodeId = dependenciesByBlockedNodeId.get(dependency.blockedNodeId);
    if (dependenciesByBlockerNodeId == null) {
      dependenciesByBlockedNodeId.set(
        dependency.blockedNodeId,
        new Map([[dependency.blockerNodeId, dependency]]),
      );
      continue;
    }
    if (dependenciesByBlockerNodeId.has(dependency.blockerNodeId)) {
      throw new TypeError(
        `blocker node AI依存が重複しています。対象: ${dependency.blockedNodeId} blocker: ${dependency.blockerNodeId}`,
      );
    }
    dependenciesByBlockerNodeId.set(dependency.blockerNodeId, dependency);
  }
  const negativeDependenciesByNodeId = new Map<GraphNodeId, AiAnalysisDependency>();
  for (const entry of graph.negativeBlockerAiDependencies) {
    if (negativeDependenciesByNodeId.has(entry.nodeId)) {
      throw new TypeError(`negative blocker AI依存が重複しています。対象: ${entry.nodeId}`);
    }
    negativeDependenciesByNodeId.set(entry.nodeId, entry.dependency);
  }
  return Object.freeze({
    dependenciesByBlockedNodeId,
    negativeDependenciesByNodeId,
  });
}

function goldenNotDependentBlockerValueAiDependencies(): GoldenBlockerValueAiDependencies {
  return Object.freeze({
    stateSupport: "conditional",
    status: GOLDEN_NOT_DEPENDENT_AI_DEPENDENCY,
    waitingOn: GOLDEN_NOT_DEPENDENT_AI_DEPENDENCY,
    primaryWaitingOn: GOLDEN_NOT_DEPENDENT_AI_DEPENDENCY,
    nextAction: GOLDEN_NOT_DEPENDENT_AI_DEPENDENCY,
    confidence: GOLDEN_NOT_DEPENDENT_AI_DEPENDENCY,
    evidence: GOLDEN_NOT_DEPENDENT_AI_DEPENDENCY,
    uncertainties: GOLDEN_NOT_DEPENDENT_AI_DEPENDENCY,
  });
}

function goldenGraphAiDependencyForNode(
  dependenciesByNodeId: ReadonlyMap<GraphNodeId, AiAnalysisDependency>,
  nodeId: GraphNodeId,
  description: string,
): AiAnalysisDependency {
  const dependency = dependenciesByNodeId.get(nodeId);
  assertNonNullable(dependency, `${description}のAI依存がありません。対象: ${nodeId}`);
  return dependency;
}

function goldenBlockerNodeAiDependencyForTrace(
  context: GoldenBlockerDependencyContext,
  blockedNodeId: GraphNodeId,
  blockerNodeId: string,
): BlockerNodeAiDependency {
  const dependenciesByBlockerNodeId = context.dependenciesByBlockedNodeId.get(blockedNodeId);
  assertNonNullable(
    dependenciesByBlockerNodeId,
    `blocker node AI依存indexがありません。対象: ${blockedNodeId}`,
  );
  const dependency = dependenciesByBlockerNodeId.get(blockerNodeId);
  assertNonNullable(
    dependency,
    `blocker node AI依存がありません。対象: ${blockedNodeId} blocker: ${blockerNodeId}`,
  );
  return dependency;
}

function combineGoldenBlockerPrimitiveDependencies(
  dependency: BlockerNodeAiDependency,
  primitives: readonly (keyof Pick<
    BlockerNodeAiDependency,
    "presence" | "confidence" | "sourceIds" | "becameBlockingAt"
  >)[],
): AiAnalysisDependency {
  return combineGoldenAiDependencies(primitives.map((primitive) => dependency[primitive]));
}

function goldenBlockerValueAiDependencies(
  nodeId: GraphNodeId,
  trace: BlockerDecisionTrace,
  context: GoldenBlockerDependencyContext,
): GoldenBlockerValueAiDependencies {
  if (trace.status === "not_evaluated") {
    return goldenNotDependentBlockerValueAiDependencies();
  }
  const negativeDependency = goldenGraphAiDependencyForNode(
    context.negativeDependenciesByNodeId,
    nodeId,
    "negative blocker",
  );
  const uncertainDependencies = trace.uncertainBlockerIds.map((blockerNodeId) =>
    goldenBlockerNodeAiDependencyForTrace(context, nodeId, blockerNodeId),
  );
  const uncertainConditions = uncertainDependencies.map((dependency) =>
    combineGoldenBlockerPrimitiveDependencies(dependency, ["presence", "confidence"]),
  );
  const uncertainEvidence = uncertainDependencies.map((dependency) =>
    combineGoldenBlockerPrimitiveDependencies(dependency, ["presence", "confidence", "sourceIds"]),
  );
  if (trace.result === "fallthrough") {
    const stateDependency = combineGoldenAiDependencies([
      ...uncertainConditions,
      negativeDependency,
    ]);
    return Object.freeze({
      stateSupport: "conditional",
      status: stateDependency,
      waitingOn: stateDependency,
      primaryWaitingOn: stateDependency,
      nextAction: stateDependency,
      confidence: stateDependency,
      evidence: combineGoldenAiDependencies([...uncertainEvidence, negativeDependency]),
      uncertainties: stateDependency,
    });
  }

  const confirmedDependencies = trace.confirmedBlockers.map((blocker) =>
    Object.freeze({
      ...blocker,
      dependency: goldenBlockerNodeAiDependencyForTrace(context, nodeId, blocker.candidateId),
    }),
  );
  const primaryBlocker = confirmedDependencies.find(
    (blocker) => blocker.candidateId === trace.primaryBlockerId,
  );
  assertNonNullable(primaryBlocker, `primary blockerのAI依存がありません。対象: ${nodeId}`);
  const confirmedConditions = confirmedDependencies.map((blocker) =>
    combineGoldenBlockerPrimitiveDependencies(blocker.dependency, ["presence", "confidence"]),
  );
  const confirmedEvidence = confirmedDependencies.map((blocker) =>
    combineGoldenBlockerPrimitiveDependencies(blocker.dependency, [
      "presence",
      "confidence",
      "sourceIds",
    ]),
  );
  const confirmedWaitingOn = confirmedDependencies.map((blocker) =>
    combineGoldenBlockerPrimitiveDependencies(blocker.dependency, [
      "presence",
      "confidence",
      "sourceIds",
      "becameBlockingAt",
    ]),
  );
  const selectionConditions = [
    ...confirmedDependencies.map((blocker) =>
      combineGoldenBlockerPrimitiveDependencies(blocker.dependency, [
        "presence",
        "confidence",
        "becameBlockingAt",
      ]),
    ),
    ...uncertainDependencies.map((dependency) =>
      combineGoldenBlockerPrimitiveDependencies(dependency, [
        "presence",
        "confidence",
        "becameBlockingAt",
      ]),
    ),
    negativeDependency,
  ];
  const primarySelectionDependency =
    primaryBlocker.authority === "authoritative"
      ? GOLDEN_NOT_DEPENDENT_AI_DEPENDENCY
      : combineGoldenAiDependencies(selectionConditions);
  const authoritativeConfirmedCount = confirmedDependencies.filter(
    (blocker) => blocker.authority === "authoritative",
  ).length;
  const inferredConfirmedConditions = confirmedDependencies.flatMap((blocker) =>
    blocker.authority === "inferred"
      ? [combineGoldenBlockerPrimitiveDependencies(blocker.dependency, ["presence", "confidence"])]
      : [],
  );
  const multiplicityDependency =
    confirmedDependencies.length === 1
      ? combineGoldenAiDependencies([...uncertainConditions, negativeDependency])
      : combineGoldenAiDependencies(
          preferredGoldenAiDependencies(
            inferredConfirmedConditions,
            Math.max(0, 2 - authoritativeConfirmedCount),
          ),
        );
  const confidenceConditions =
    primaryBlocker.authority === "authoritative"
      ? confirmedDependencies
          .filter(
            (blocker) =>
              blocker.candidateId !== primaryBlocker.candidateId &&
              blocker.authority === "inferred",
          )
          .map((blocker) =>
            combineGoldenBlockerPrimitiveDependencies(blocker.dependency, [
              "presence",
              "confidence",
            ]),
          )
          .concat(uncertainConditions, [negativeDependency])
      : selectionConditions;
  return Object.freeze({
    stateSupport:
      primaryBlocker.authority === "authoritative" ? "authoritative_blocker" : "conditional",
    status: preferGoldenAiDependency(confirmedConditions),
    waitingOn: combineGoldenAiDependencies([
      ...confirmedWaitingOn,
      ...uncertainConditions,
      negativeDependency,
    ]),
    primaryWaitingOn: combineGoldenAiDependencies([
      primarySelectionDependency,
      multiplicityDependency,
    ]),
    nextAction: primarySelectionDependency,
    confidence: combineGoldenAiDependencies([
      primaryBlocker.dependency.confidence,
      ...confidenceConditions,
    ]),
    evidence: combineGoldenAiDependencies([
      ...confirmedEvidence,
      ...uncertainEvidence,
      negativeDependency,
    ]),
    uncertainties: combineGoldenAiDependencies([
      ...confirmedConditions,
      ...uncertainConditions,
      negativeDependency,
    ]),
  });
}

function goldenStateAiDependencies(
  nodeId: GitHubNodeId,
  applications: TrackedItemAiAnalysisApplications,
  blockerDependencies: GoldenBlockerValueAiDependencies,
): Readonly<{
  status: AiAnalysisDependency;
  waitingOn: AiAnalysisDependency;
  primaryWaitingOn: AiAnalysisDependency;
  nextAction: AiAnalysisDependency;
}> {
  const applicationDependency = (
    element: "status" | "waitingOn" | "nextAction",
  ): AiAnalysisDependency => goldenAiDependencyForApplication(nodeId, applications, element);
  const stateValueDependency = (
    element: "status" | "waitingOn" | "nextAction",
    blockerDependency: AiAnalysisDependency,
  ): AiAnalysisDependency => {
    if (aiAnalysisElementApplicationUsesAiValue(applications[element])) {
      return applicationDependency(element);
    }
    if (
      blockerDependencies.stateSupport === "authoritative_blocker" &&
      (element === "status" || element === "nextAction")
    ) {
      return blockerDependency;
    }
    return combineGoldenAiDependencies([applicationDependency(element), blockerDependency]);
  };
  return Object.freeze({
    status: stateValueDependency("status", blockerDependencies.status),
    waitingOn: stateValueDependency("waitingOn", blockerDependencies.waitingOn),
    primaryWaitingOn: aiAnalysisElementApplicationUsesAiValue(applications.waitingOn)
      ? applicationDependency("waitingOn")
      : blockerDependencies.stateSupport === "authoritative_blocker"
        ? blockerDependencies.primaryWaitingOn
        : combineGoldenAiDependencies([
            applicationDependency("waitingOn"),
            blockerDependencies.primaryWaitingOn,
          ]),
    nextAction: stateValueDependency("nextAction", blockerDependencies.nextAction),
  });
}

function goldenConfidenceAiDependency(
  nodeId: GitHubNodeId,
  applications: TrackedItemAiAnalysisApplications,
  blockerDependencies: GoldenBlockerValueAiDependencies,
): AiAnalysisDependency {
  if (blockerDependencies.stateSupport === "authoritative_blocker") {
    return blockerDependencies.confidence;
  }
  const dependencies: AiAnalysisDependency[] = [];
  const allStateValuesUseAi = GOLDEN_STATE_AI_ANALYSIS_ELEMENTS.every((element) =>
    aiAnalysisElementApplicationUsesAiValue(applications[element]),
  );
  if (!allStateValuesUseAi) {
    dependencies.push(blockerDependencies.confidence);
  }
  for (const element of GOLDEN_STATE_AI_ANALYSIS_ELEMENTS) {
    if (
      !aiAnalysisElementApplicationUsesAiValue(applications[element]) &&
      applications[element].status !== "unavailable"
    ) {
      continue;
    }
    dependencies.push(goldenAiDependencyForApplication(nodeId, applications, element));
  }
  return combineGoldenAiDependencies(dependencies);
}

function goldenEvidenceAiDependency(
  nodeId: GitHubNodeId,
  decision: ReducedCodexDecision,
  deterministicDecision: IssueStateDecision | PullRequestStateDecision,
  applications: TrackedItemAiAnalysisApplications,
  blockerDependencies: GoldenBlockerValueAiDependencies,
): AiAnalysisDependency {
  if (blockerDependencies.stateSupport === "authoritative_blocker") {
    return blockerDependencies.evidence;
  }
  const dependencies: AiAnalysisDependency[] = [];
  for (const element of GOLDEN_STATE_AI_ANALYSIS_ELEMENTS) {
    if (
      aiAnalysisElementApplicationUsesAiValue(applications[element]) ||
      applications[element].status === "unavailable"
    ) {
      dependencies.push(goldenAiDependencyForApplication(nodeId, applications, element));
    }
  }
  const deterministicEvidence = new Set(
    deterministicDecision.evidence.map((evidence) => serializeCanonicalJson(evidence)),
  );
  if (
    decision.evidence.some((evidence) =>
      deterministicEvidence.has(serializeCanonicalJson(evidence)),
    )
  ) {
    dependencies.push(blockerDependencies.evidence);
  }
  return combineGoldenAiDependencies(dependencies);
}

function goldenUncertaintiesAiDependency(
  nodeId: GitHubNodeId,
  applications: TrackedItemAiAnalysisApplications,
  blockerDependency: AiAnalysisDependency,
): AiAnalysisDependency {
  return combineGoldenAiDependencies([
    ...GOLDEN_STATE_AI_ANALYSIS_ELEMENTS.map((element) =>
      goldenAiDependencyForApplication(nodeId, applications, element),
    ),
    blockerDependency,
  ]);
}

function goldenLastProgressAiDependency(
  item: GoldenItemInput,
  staleness: StalenessResult,
  applications: TrackedItemAiAnalysisApplications,
): AiAnalysisDependency {
  const latestProgress = staleness.meaningfulProgress.filter(
    (progress) => progress.occurredAt === staleness.lastProgressAt,
  );
  const dependencies = latestProgress.flatMap((progress) => {
    if (progress.kind === "dependency_resolved") {
      return [progress.aiDependency];
    }
    if (progress.determination === "ai") {
      return [
        goldenAiDependencyForApplication(createGitHubNodeId(item.nodeId), applications, "progress"),
      ];
    }
    return [GOLDEN_NOT_DEPENDENT_AI_DEPENDENCY];
  });
  if (
    staleness.lastProgressAt === createUtcIsoDateTime(item.createdAt) ||
    (item.previousState.availability === "available" &&
      staleness.lastProgressAt === createUtcIsoDateTime(item.previousState.lastProgressAt))
  ) {
    dependencies.push(GOLDEN_NOT_DEPENDENT_AI_DEPENDENCY);
  }
  if (dependencies.length > 0) {
    return preferGoldenAiDependency(dependencies);
  }
  return GOLDEN_NOT_DEPENDENT_AI_DEPENDENCY;
}

function goldenLastResponsibleHumanActivityAt(
  item: GoldenItemInput,
  waitingOn: readonly WaitingOn[],
): UtcIsoDateTime | undefined {
  const accountIdentifiers = resolveWaitingOnAccountIdentifiers(waitingOn);
  let latest: UtcIsoDateTime | undefined;
  for (const event of item.events) {
    if (event.actor.type !== "human") {
      continue;
    }
    if (!accountIdentifiers.has(event.actor.login) && !accountIdentifiers.has(event.actor.nodeId)) {
      continue;
    }
    const occurredAt = createUtcIsoDateTime(event.occurredAt);
    if (latest == null || occurredAt > latest) {
      latest = occurredAt;
    }
  }
  return latest;
}

function goldenLastHumanReviewAt(item: GoldenItemInput): UtcIsoDateTime | undefined {
  let latest: UtcIsoDateTime | undefined;
  for (const event of item.events) {
    if (event.kind !== "review" || event.actor.type !== "human") {
      continue;
    }
    const occurredAt = createUtcIsoDateTime(event.occurredAt);
    if (latest == null || occurredAt > latest) {
      latest = occurredAt;
    }
  }
  return latest;
}

type GoldenAiDependencyTimeCandidate = Readonly<{
  occurredAt: UtcIsoDateTime;
  dependency: AiAnalysisDependency;
}>;

function goldenStallSinceAiDependency(
  input: StandardGoldenInput,
  item: GoldenItemInput,
  deterministicDecision: IssueStateDecision | PullRequestStateDecision,
  decision: ReducedCodexDecision,
  staleness: StalenessResult,
  itemDependencies: Readonly<{
    status: AiAnalysisDependency;
    waitingOn: AiAnalysisDependency;
    lastProgressAt: AiAnalysisDependency;
  }>,
): AiAnalysisDependency {
  const nodeId = createGitHubNodeId(item.nodeId);
  const evaluatedAt = createUtcIsoDateTime(input.evaluatedAt);
  const basis = transitionBasis(evaluatedAt, deterministicDecision, decision);
  const candidates: GoldenAiDependencyTimeCandidate[] = [];
  const add = (occurredAt: UtcIsoDateTime, dependency: AiAnalysisDependency): void => {
    candidates.push(Object.freeze({ occurredAt, dependency }));
  };
  const previous = item.previousState.availability === "available" ? item.previousState : undefined;
  if (previous == null) {
    add(basis.statusBasis.occurredAt, itemDependencies.status);
    add(basis.responsibilityBasis.occurredAt, itemDependencies.waitingOn);
  } else {
    const previousStatusSince = createUtcIsoDateTime(previous.statusSince);
    const previousOwnerSince = createUtcIsoDateTime(previous.ownerSince);
    const statusChanged = staleness.statusSince !== previousStatusSince;
    const ownerChanged = staleness.ownerSince !== previousOwnerSince;
    add(previousStatusSince, GOLDEN_NOT_DEPENDENT_AI_DEPENDENCY);
    add(previousOwnerSince, GOLDEN_NOT_DEPENDENT_AI_DEPENDENCY);
    if (ownerChanged) {
      const ownerTransitionDependencies = statusChanged
        ? [itemDependencies.status, itemDependencies.waitingOn]
        : [itemDependencies.waitingOn];
      add(staleness.ownerSince, combineGoldenAiDependencies(ownerTransitionDependencies));
    }
  }

  const lastResponsibleHumanActivityAt = goldenLastResponsibleHumanActivityAt(
    item,
    decision.waitingOn,
  );
  const responsibleActivityDependency = goldenCandidateAiDependency(
    GOLDEN_NOT_DEPENDENT_AI_DEPENDENCY,
    [itemDependencies.waitingOn],
  );
  const reviewWait =
    item.type === "pull_request" &&
    (decision.status === "waiting_for_owner" || decision.status === "waiting_for_review");
  const lastHumanReviewAt = goldenLastHumanReviewAt(item);
  if (reviewWait) {
    if (lastResponsibleHumanActivityAt != null) {
      add(lastResponsibleHumanActivityAt, responsibleActivityDependency);
    }
    if (lastHumanReviewAt != null) {
      add(
        lastHumanReviewAt,
        goldenCandidateAiDependency(GOLDEN_NOT_DEPENDENT_AI_DEPENDENCY, [itemDependencies.status]),
      );
    }
    if (previous != null) {
      add(createUtcIsoDateTime(previous.stallSince), GOLDEN_NOT_DEPENDENT_AI_DEPENDENCY);
    }
  } else {
    add(staleness.lastProgressAt, itemDependencies.lastProgressAt);
    if (lastResponsibleHumanActivityAt != null) {
      add(lastResponsibleHumanActivityAt, responsibleActivityDependency);
    }
    if (previous != null && staleness.ownerSince === createUtcIsoDateTime(previous.ownerSince)) {
      add(createUtcIsoDateTime(previous.stallSince), GOLDEN_NOT_DEPENDENT_AI_DEPENDENCY);
    }
  }

  const selectedCandidates = candidates.filter(
    (candidate) => candidate.occurredAt === staleness.stallSince,
  );
  if (selectedCandidates.length === 0) {
    throw new TypeError(`stallSinceのAI依存候補がありません。対象: ${nodeId}`);
  }
  return preferGoldenAiDependency(selectedCandidates.map((candidate) => candidate.dependency));
}

function goldenStateDependenciesForWaitClass(
  decision: Readonly<Pick<ReducedCodexDecision, "status" | "waitingOn">>,
  waitClass: StalenessResult["waitClass"],
  dependencies: Readonly<{
    status: AiAnalysisDependency;
    waitingOn: AiAnalysisDependency;
    evidence: AiAnalysisDependency;
  }>,
): readonly AiAnalysisDependency[] {
  if (waitClass === "notApplicable" || waitClass === "blockedParent") {
    return Object.freeze([]);
  }
  const primaryWaitingOn = decision.waitingOn[0];
  assertNonNullable(primaryWaitingOn, "継続中状態のprimary waitingOnがありません");
  const routes: AiAnalysisDependency[] = [];
  switch (waitClass) {
    case "owner":
      if (decision.status === "waiting_for_owner" || decision.status === "unknown") {
        routes.push(dependencies.status);
      }
      if (primaryWaitingOn.kind === "unknown" || primaryWaitingOn.role === "unknown") {
        routes.push(dependencies.waitingOn);
      }
      break;
    case "automation":
      if (decision.status === "waiting_for_automation") {
        routes.push(dependencies.status);
      }
      if (primaryWaitingOn.kind === "automation") {
        routes.push(dependencies.waitingOn);
      }
      break;
    case "review":
      if (decision.status === "waiting_for_review") {
        routes.push(dependencies.status);
      }
      if (primaryWaitingOn.role === "reviewer") {
        routes.push(dependencies.waitingOn);
      }
      break;
    case "assessment":
    case "decision":
    case "merge":
    case "reply":
      routes.push(dependencies.status);
      break;
    case "revision":
      routes.push(dependencies.status);
      if (decision.status === "waiting_for_revision") {
        routes.push(dependencies.waitingOn, dependencies.evidence);
      }
      break;
    case "work":
      routes.push(dependencies.status);
      break;
    default:
      throw new UnreachableError(waitClass);
  }
  if (routes.length === 0) {
    throw new TypeError(`wait class ${waitClass}の成立経路がありません`);
  }
  return Object.freeze([preferGoldenAiDependency(routes)]);
}

function goldenCriticalSeverityWasRequested(reason: StalenessResult["severityReason"]): boolean {
  if (reason.kind !== "elapsed_threshold") {
    return false;
  }
  return (
    reason.baseSeverity === "critical" ||
    (reason.baseSeverity === "urgent" && reason.labelLiftRequested === 1)
  );
}

function goldenSeverityAiDependency(
  decision: ReducedCodexDecision,
  staleness: StalenessResult,
  itemDependencies: TrackedItemAiDependencies,
): AiAnalysisDependency {
  if (staleness.waitClass === "notApplicable" || staleness.waitClass === "blockedParent") {
    return itemDependencies.status;
  }
  const stateDependencies = goldenStateDependenciesForWaitClass(
    decision,
    staleness.waitClass,
    itemDependencies,
  );
  const dependencies = [itemDependencies.stallSince, ...stateDependencies];
  if (goldenCriticalSeverityWasRequested(staleness.severityReason)) {
    dependencies.push(itemDependencies.confidence);
  }
  return combineGoldenAiDependencies(dependencies);
}

function goldenBlockersAiDependency(
  nodeId: GitHubNodeId,
  graph: ReturnType<typeof analyzeGraphAiDependencies>,
): AiAnalysisDependency {
  const blocker = graph.blockerSetAiDependencies.find((candidate) => candidate.nodeId === nodeId);
  assertNonNullable(blocker, `項目 ${nodeId}のblocker集合AI依存がありません`);
  return blocker.dependency;
}

function goldenDownstreamImpactAiDependency(
  nodeId: GraphNodeId,
  graph: ReturnType<typeof analyzeGraphAiDependencies>,
): AiAnalysisDependency {
  const impact = graph.downstreamImpactAiDependencies.find(
    (candidate) => candidate.nodeId === nodeId,
  );
  assertNonNullable(impact, `項目 ${nodeId}のdownstream impact AI依存がありません`);
  return impact.dependency;
}

function goldenRelationSetAiDependency(
  nodeId: GraphNodeId,
  graph: ReturnType<typeof analyzeGraphAiDependencies>,
): AiAnalysisDependency {
  const relationSet = graph.relationSetAiDependencies.find(
    (candidate) => candidate.nodeId === nodeId,
  );
  assertNonNullable(relationSet, `項目 ${nodeId}のrelation set AI依存がありません`);
  return relationSet.dependency;
}

function createGoldenTrackedItemAiDependencies(
  input: StandardGoldenInput,
  item: GoldenItemInput,
  deterministicDecision: IssueStateDecision | PullRequestStateDecision,
  decision: ReducedCodexDecision,
  staleness: StalenessResult,
  applications: TrackedItemAiAnalysisApplications,
  graph: ReturnType<typeof analyzeGraphAiDependencies>,
  blockerDependencyContext: GoldenBlockerDependencyContext,
): TrackedItemAiDependencies {
  const nodeId = createGitHubNodeId(item.nodeId);
  const blockerDependencies = goldenBlockerValueAiDependencies(
    nodeId,
    deterministicDecision.blockerDecisionTrace,
    blockerDependencyContext,
  );
  const stateDependencies = goldenStateAiDependencies(nodeId, applications, blockerDependencies);
  const deadlineDependency = goldenAiDependencyForApplication(nodeId, applications, "deadline");
  const baseDependencies = {
    status: stateDependencies.status,
    waitingOn: stateDependencies.waitingOn,
    nextAction: stateDependencies.nextAction,
    primaryWaitingOn: stateDependencies.primaryWaitingOn,
    confidence: goldenConfidenceAiDependency(nodeId, applications, blockerDependencies),
    evidence: goldenEvidenceAiDependency(
      nodeId,
      decision,
      deterministicDecision,
      applications,
      blockerDependencies,
    ),
    uncertainties: goldenUncertaintiesAiDependency(
      nodeId,
      applications,
      blockerDependencies.uncertainties,
    ),
    deadline: deadlineDependency,
    deadlineLevel: deadlineDependency,
    lastProgressAt: goldenLastProgressAiDependency(item, staleness, applications),
    stallSince: GOLDEN_NOT_DEPENDENT_AI_DEPENDENCY,
    severity: GOLDEN_NOT_DEPENDENT_AI_DEPENDENCY,
    downstreamImpact: goldenDownstreamImpactAiDependency(nodeId, graph),
    importance: GOLDEN_NOT_DEPENDENT_AI_DEPENDENCY,
    attention: GOLDEN_NOT_DEPENDENT_AI_DEPENDENCY,
    blockers: goldenBlockersAiDependency(nodeId, graph),
    relationSet: goldenRelationSetAiDependency(nodeId, graph),
  } satisfies TrackedItemAiDependencies;
  const stallSince = goldenStallSinceAiDependency(
    input,
    item,
    deterministicDecision,
    decision,
    staleness,
    baseDependencies,
  );
  const dependenciesWithStallSince = Object.freeze({
    ...baseDependencies,
    stallSince,
  });
  return Object.freeze({
    ...dependenciesWithStallSince,
    severity: goldenSeverityAiDependency(decision, staleness, dependenciesWithStallSince),
  });
}

type MutableGoldenAiAnalysisCurrentElements = {
  -readonly [
    Element in keyof TrackedItemAiAnalysisCurrentElements
  ]?: TrackedItemAiAnalysisCurrentElements[Element];
};

type MutableGoldenAiAnalysisCurrentAdoptedElements = {
  -readonly [
    Element in keyof TrackedItemAiAnalysisCurrentAdoptedElements
  ]?: TrackedItemAiAnalysisCurrentAdoptedElements[Element];
};

type GoldenCurrentAiAnalysisRecord<Element extends AiAnalysisElement = AiAnalysisElement> =
  Readonly<{
    evaluated: TrackedItemAiAnalysisCurrentElement<Element>;
    adopted: TrackedItemAiAnalysisCurrentAdoptedElement<Element>;
  }>;

function goldenCurrentAiAnalysisRecord(
  analysis: PreparedGoldenFixedAiAnalysis,
  element: "status",
): GoldenCurrentAiAnalysisRecord<"status">;
function goldenCurrentAiAnalysisRecord(
  analysis: PreparedGoldenFixedAiAnalysis,
  element: "waitingOn",
): GoldenCurrentAiAnalysisRecord<"waitingOn">;
function goldenCurrentAiAnalysisRecord(
  analysis: PreparedGoldenFixedAiAnalysis,
  element: "nextAction",
): GoldenCurrentAiAnalysisRecord<"nextAction">;
function goldenCurrentAiAnalysisRecord(
  analysis: PreparedGoldenFixedAiAnalysis,
  element: "relations",
): GoldenCurrentAiAnalysisRecord<"relations">;
function goldenCurrentAiAnalysisRecord(
  analysis: PreparedGoldenFixedAiAnalysis,
  element: "progress",
): GoldenCurrentAiAnalysisRecord<"progress">;
function goldenCurrentAiAnalysisRecord(
  analysis: PreparedGoldenFixedAiAnalysis,
  element: "importance",
): GoldenCurrentAiAnalysisRecord<"importance">;
function goldenCurrentAiAnalysisRecord(
  analysis: PreparedGoldenFixedAiAnalysis,
  element: "deadline",
): GoldenCurrentAiAnalysisRecord<"deadline">;
function goldenCurrentAiAnalysisRecord(
  analysis: PreparedGoldenFixedAiAnalysis,
  element: "notification",
): GoldenCurrentAiAnalysisRecord<"notification">;
function goldenCurrentAiAnalysisRecord(
  analysis: PreparedGoldenFixedAiAnalysis,
  element: "selfCommitment",
): GoldenCurrentAiAnalysisRecord<"selfCommitment">;
function goldenCurrentAiAnalysisRecord(
  analysis: PreparedGoldenFixedAiAnalysis,
  element: AiAnalysisElement,
): GoldenCurrentAiAnalysisRecord {
  const rawResult = goldenCodexElementResult(analysis.acceptedOutput, element);
  assertNonNullable(rawResult, `固定AI判定 ${analysis.itemNodeId}の${element}がありません`);
  const result = createAiAnalysisMigrationElementResultSchema(element).parse(rawResult);
  const inputFingerprint = hashCanonicalJson({
    element,
    input: analysis.input,
  });
  const dependencyFingerprint = hashCanonicalJson({ kind: "golden_eval", element });
  const proof = aiAnalysisElementReuseProofSchema.parse({
    status: "verified",
    reuseSchemaVersion: "1",
    source: "current_generation",
    revision: AI_ANALYSIS_ELEMENT_REVISIONS[element],
    inputProjectionVersion: AI_ANALYSIS_ELEMENT_INPUT_PROJECTION_VERSIONS[element],
    inputFingerprint,
    dependencyFingerprint,
    compatibilityPath: ["current_generation"],
  });
  const generation = createAiAnalysisElementGenerationSchema(element).parse({
    metadata: {
      model: "golden-eval",
      reasoningEffort: "none",
      backendVersion: "golden-eval",
      schemaVersion: AI_ANALYSIS_ELEMENT_SCHEMA_VERSION,
      revision: AI_ANALYSIS_ELEMENT_REVISIONS[element],
      inputFingerprint,
      executionFingerprint: hashCanonicalJson({ kind: "golden_eval_execution", element }),
      promptFingerprint: hashCanonicalJson({ kind: "golden_eval_prompt", element }),
      outputHash: hashCanonicalJson(result),
      generatedAt: analysis.input.now,
    },
    result,
  });
  return Object.freeze({
    evaluated: Object.freeze({ generation, result, evaluationProof: proof }),
    adopted: Object.freeze({ origin: "current", generation, result, reuseProof: proof }),
  });
}

function goldenCurrentAiAnalysisRecords(
  analysis: PreparedGoldenFixedAiAnalysis | undefined,
  applications: TrackedItemAiAnalysisApplications,
): Readonly<{
  elements: TrackedItemAiAnalysisCurrentElements;
  adoptedElements: TrackedItemAiAnalysisCurrentAdoptedElements;
}> {
  const elements: MutableGoldenAiAnalysisCurrentElements = {};
  const adoptedElements: MutableGoldenAiAnalysisCurrentAdoptedElements = {};
  if (analysis == null) {
    return Object.freeze({
      elements: Object.freeze(elements),
      adoptedElements: Object.freeze(adoptedElements),
    });
  }
  for (const element of AI_ANALYSIS_ELEMENTS) {
    if (applications[element].status !== "current_ai") {
      continue;
    }
    switch (element) {
      case "status": {
        const record = goldenCurrentAiAnalysisRecord(analysis, element);
        elements.status = record.evaluated;
        adoptedElements.status = record.adopted;
        break;
      }
      case "waitingOn": {
        const record = goldenCurrentAiAnalysisRecord(analysis, element);
        elements.waitingOn = record.evaluated;
        adoptedElements.waitingOn = record.adopted;
        break;
      }
      case "nextAction": {
        const record = goldenCurrentAiAnalysisRecord(analysis, element);
        elements.nextAction = record.evaluated;
        adoptedElements.nextAction = record.adopted;
        break;
      }
      case "relations": {
        const record = goldenCurrentAiAnalysisRecord(analysis, element);
        elements.relations = record.evaluated;
        adoptedElements.relations = record.adopted;
        break;
      }
      case "progress": {
        const record = goldenCurrentAiAnalysisRecord(analysis, element);
        elements.progress = record.evaluated;
        adoptedElements.progress = record.adopted;
        break;
      }
      case "importance": {
        const record = goldenCurrentAiAnalysisRecord(analysis, element);
        elements.importance = record.evaluated;
        adoptedElements.importance = record.adopted;
        break;
      }
      case "deadline": {
        const record = goldenCurrentAiAnalysisRecord(analysis, element);
        elements.deadline = record.evaluated;
        adoptedElements.deadline = record.adopted;
        break;
      }
      case "notification": {
        const record = goldenCurrentAiAnalysisRecord(analysis, element);
        elements.notification = record.evaluated;
        adoptedElements.notification = record.adopted;
        break;
      }
      case "selfCommitment": {
        const record = goldenCurrentAiAnalysisRecord(analysis, element);
        elements.selfCommitment = record.evaluated;
        adoptedElements.selfCommitment = record.adopted;
        break;
      }
      default:
        throw new UnreachableError(element);
    }
  }
  return Object.freeze({
    elements: Object.freeze(elements),
    adoptedElements: Object.freeze(adoptedElements),
  });
}

function createTrackedItem(repositoryName: string, analysis: ItemAnalysis): TrackedItem {
  const item = analysis.input;
  const decision = analysis.decision;
  const aiAnalysisRecords = goldenCurrentAiAnalysisRecords(
    analysis.fixedAiAnalysis,
    analysis.aiAnalysisApplications,
  );
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
      status: analysis.fixedAiAnalysis == null ? "not_required" : "used",
      elements: aiAnalysisRecords.elements,
      adoptedElements: aiAnalysisRecords.adoptedElements,
      applications: analysis.aiAnalysisApplications,
    }),
    aiDependencies: analysis.aiDependencies,
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
    schemaVersion: "18",
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
    graphNodeStateObservations: [],
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
  const candidates = normalizeRelationCandidates(
    input.relations.map((relation) => createRelationCandidate(relation, items, repositories)),
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
  const candidateIds = new Set(candidates.map((candidate) => candidate.id));
  const relationAssessments = fixedAi.relationAssessments.filter((assessment) =>
    candidateIds.has(assessment.candidateId),
  );
  const relationAiDependencies = createFixedRelationAiDependencies(
    candidates,
    items,
    relationAssessments,
    fixedAi.applicationsByNodeId,
  );
  const reconciled = reconcileGraph({
    previousGraph: Object.freeze({
      edges: Object.freeze([]),
      historyEvents: Object.freeze([]),
    }),
    candidates,
    assessments: relationAssessments,
    relationAiDependencies,
    sourceOccurredAtById: createRelationSourceOccurredAtById(input, items, candidates),
    minimumInferredConfidence: CONFIDENCE_THRESHOLDS.medium,
    reconciledAt: createUtcIsoDateTime(input.evaluatedAt),
  });
  const nodes = graphNodes(input);
  const previousGraphAvailable = Object.keys(input.previousNodeStates).length > 0;
  const currentGraph: AnalyzeGraphInput["current"] = Object.freeze({
    nodes,
    edges: reconciled.edges,
  });
  const previousGraph: AnalyzeGraphInput["previous"] = previousGraphAvailable
    ? Object.freeze({
        availability: "available",
        snapshot: Object.freeze({
          nodes: previousGraphNodes(input, nodes),
          edges: reconciled.edges,
        }),
      })
    : Object.freeze({
        availability: "unavailable",
      });
  const graph = analyzeGraph({
    current: currentGraph,
    previous: previousGraph,
  });
  const graphAi = analyzeGraphAiDependencies({
    current: currentGraph,
    candidateProofSnapshot: currentGraph,
    previous: previousGraph,
    candidateDecisionProofs: reconciled.candidateDecisionProofs,
  });
  const blockerDependencyContext = createGoldenBlockerDependencyContext(graphAi);
  const personalReminder = createGoldenPersonalReminderAnalysis(
    input,
    repositories,
    candidates,
    reconciled,
    localResponsibilityDecisions,
    fixedAi.decisions,
    preparedAnalyses,
    fixedAi.applicationsByNodeId,
    relationAiDependencies,
  );
  const analyses = Object.freeze(
    input.items.map((item) => {
      const deterministicDecision = fixedAi.reassessedDeterministicDecisions.get(item.nodeId);
      const decision = fixedAi.decisions.get(item.nodeId);
      const aiAnalysisApplications = fixedAi.applicationsByNodeId.get(item.nodeId);
      const deadlineAssessment = fixedAi.deadlineAssessments.get(item.nodeId);
      const notificationRecommendation = fixedAi.notificationRecommendations.get(item.nodeId);
      const preparedAnalysis = preparedByNodeId.get(item.nodeId);
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
      assertNonNullable(aiAnalysisApplications, `項目 ${item.nodeId}のAI適用元がありません`);
      assertNonNullable(deadlineAssessment, `項目 ${item.nodeId}の期限判定がありません`);
      assertNonNullable(
        notificationRecommendation,
        `項目 ${item.nodeId}のCodex通知提案がありません`,
      );
      const staleness = createStaleness(input, item, deterministicDecision, decision);
      return Object.freeze({
        input: item,
        deterministicDecision,
        decision,
        fixedAiAnalysis: preparedAnalysis,
        aiAnalysisApplications,
        aiDependencies: createGoldenTrackedItemAiDependencies(
          input,
          item,
          deterministicDecision,
          decision,
          staleness,
          aiAnalysisApplications,
          graphAi,
          blockerDependencyContext,
        ),
        deadlineAssessment,
        notificationRecommendation,
        staleness,
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

type LargeBlocker = Readonly<{
  candidateId: GitHubNodeId;
  authority: "authoritative" | "inferred";
  confidence: number;
  sourceIds: readonly [SourceId, ...SourceId[]];
  becameBlockingAt: UtcIsoDateTime;
}>;

function compareLargeBlockers(left: LargeBlocker, right: LargeBlocker): -1 | 0 | 1 {
  if (left.authority !== right.authority) {
    return left.authority === "authoritative" ? -1 : 1;
  }
  if (left.confidence !== right.confidence) {
    return left.confidence > right.confidence ? -1 : 1;
  }
  if (left.becameBlockingAt < right.becameBlockingAt) {
    return -1;
  }
  if (left.becameBlockingAt > right.becameBlockingAt) {
    return 1;
  }
  if (left.candidateId < right.candidateId) {
    return -1;
  }
  if (left.candidateId > right.candidateId) {
    return 1;
  }
  return 0;
}

function largeBlockersByTargetNodeId(
  edges: readonly (ReconciledGraphEdge & Readonly<{ active: true }>)[],
  becameBlockingAt: UtcIsoDateTime,
): ReadonlyMap<GitHubNodeId, readonly LargeBlocker[]> {
  const blockersByTargetNodeId = new Map<GitHubNodeId, LargeBlocker[]>();
  for (const edge of edges) {
    if (edge.type !== "blocks" || edge.provenance !== "native") {
      throw new TypeError("large fixtureのblocker relationが不正です");
    }
    const targetNodeId = createGitHubNodeId(edge.toNodeId);
    const firstSourceId = edge.evidence[0]?.sourceId;
    assertNonNullable(firstSourceId, `large fixtureのrelation ${edge.id}に根拠がありません`);
    const blocker = Object.freeze({
      candidateId: createGitHubNodeId(edge.fromNodeId),
      authority: edge.authoritative ? "authoritative" : "inferred",
      confidence: edge.confidence,
      sourceIds: Object.freeze([
        firstSourceId,
        ...edge.evidence.slice(1).map((evidence) => evidence.sourceId),
      ]) satisfies readonly [SourceId, ...SourceId[]],
      becameBlockingAt,
    } satisfies LargeBlocker);
    const blockers = blockersByTargetNodeId.get(targetNodeId);
    if (blockers == null) {
      blockersByTargetNodeId.set(targetNodeId, [blocker]);
    } else {
      blockers.push(blocker);
    }
  }
  return new Map(
    [...blockersByTargetNodeId].map(([nodeId, blockers]) => [
      nodeId,
      Object.freeze(blockers.sort(compareLargeBlockers)),
    ]),
  );
}

function createLargeItems(
  itemCount: number,
  evaluatedAt: UtcIsoDateTime,
  edges: readonly (ReconciledGraphEdge & Readonly<{ active: true }>)[],
): readonly TrackedItem[] {
  const createdAt = createUtcIsoDateTime("2026-01-01T00:00:00.000Z");
  const blockersByTargetNodeId = largeBlockersByTargetNodeId(edges, createdAt);
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
      const blockers = blockersByTargetNodeId.get(nodeId) ?? Object.freeze([]);
      const primaryBlocker = blockers[0];
      const status = primaryBlocker == null ? "in_progress" : "waiting_for_unblock";
      const waitingOn =
        primaryBlocker == null
          ? Object.freeze([largeWaitingOn(nodeId)])
          : Object.freeze(
              blockers.map((blocker) =>
                Object.freeze({
                  kind: "item",
                  candidateId: blocker.candidateId,
                  role: "dependency",
                  reasonSummary: "この項目の完了を待っています",
                  sourceIds: blocker.sourceIds,
                  confidence: blocker.confidence,
                } satisfies WaitingOn),
              ),
            );
      const primaryWaitingOn = Object.freeze({
        index: 0,
        selectionReason:
          blockers.length <= 1
            ? "唯一の確定済みopen blockerをprimaryに選定しました"
            : "authoritative、confidence、blockerになった時刻、candidate IDの順で選定しました",
      });
      const nextAction =
        primaryBlocker == null
          ? "担当者が作業を進める"
          : `${primaryBlocker.candidateId}の完了を待つ`;
      const aiAnalysisStatus = primaryBlocker == null ? "disabled" : "not_required";
      const evidence =
        primaryBlocker == null
          ? Object.freeze([
              Object.freeze({
                sourceId: buildSourceId("golden_large", nodeId),
                supports: "status",
                summary: "匿名の性能fixtureです",
              }),
            ])
          : Object.freeze([
              ...blockers.flatMap((blocker) =>
                blocker.sourceIds.map((sourceId) =>
                  Object.freeze({
                    sourceId,
                    supports: "status" as const,
                    summary: "確定済みのopen blockerがあります",
                  }),
                ),
              ),
              ...blockers.flatMap((blocker) =>
                blocker.sourceIds.map((sourceId) =>
                  Object.freeze({
                    sourceId,
                    supports: "waiting_on" as const,
                    summary: "open blockerの完了待ちです",
                  }),
                ),
              ),
            ]);
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
        status,
        waitingOn,
        primaryWaitingOn,
        nextAction,
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
        personalReminderCausePlanning: createGoldenPersonalReminderCausePlanning(status),
        aiAnalysis: Object.freeze({
          origin: "current",
          status: aiAnalysisStatus,
          elements: Object.freeze({}),
          adoptedElements: Object.freeze({}),
          applications: createGoldenAiAnalysisApplications(aiAnalysisStatus),
        }),
        aiDependencies: createGoldenNotDependentAiDependencies(),
        inputEvents: Object.freeze([]),
        confidence: 1,
        evidence,
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
        aiDependency: GOLDEN_NOT_DEPENDENT_AI_DEPENDENCY,
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
  const edges = createLargeEdges(input.itemCount, input.edgeCount, evaluatedAt);
  const items = createLargeItems(input.itemCount, evaluatedAt, edges);
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
    schemaVersion: "18",
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
        waitClass: item.status === "waiting_for_unblock" ? "blockedParent" : "work",
        decisionBasis: "deterministic",
      },
    })),
    graphNodeStateObservations: [],
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
  const blockersByTargetNodeId = largeBlockersByTargetNodeId(
    edges,
    createUtcIsoDateTime("2026-01-01T00:00:00.000Z"),
  );
  const largeItemsMatchExpectation = snapshot.items.every((item) => {
    const blockers = blockersByTargetNodeId.get(item.nodeId) ?? Object.freeze([]);
    const primaryBlocker = blockers[0];
    if (primaryBlocker == null) {
      const waitingOn = item.waitingOn[0];
      return (
        item.status === "in_progress" &&
        item.severity === "none" &&
        item.severityContext.waitClass === "work" &&
        item.waitingOn.length === 1 &&
        waitingOn?.kind === "role" &&
        waitingOn.candidateId === "assignee" &&
        waitingOn.role === "assignee"
      );
    }
    return (
      item.status === "waiting_for_unblock" &&
      item.severity === "none" &&
      item.severityContext.waitClass === "blockedParent" &&
      item.waitingOn.length === blockers.length &&
      item.waitingOn.every((waitingOn, index) => {
        const blocker = blockers[index];
        return (
          blocker != null &&
          waitingOn.kind === "item" &&
          waitingOn.candidateId === blocker.candidateId &&
          waitingOn.role === "dependency"
        );
      }) &&
      item.primaryWaitingOn.index === 0 &&
      item.nextAction === `${primaryBlocker.candidateId}の完了を待つ`
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
  const inProgressItems = snapshot.items.filter((item) => item.status === "in_progress");
  const waitingForUnblockItems = snapshot.items.filter(
    (item) => item.status === "waiting_for_unblock",
  );
  const inProgressRepresentative = inProgressItems[0];
  const waitingForUnblockRepresentative = waitingForUnblockItems[0];
  assertNonNullable(inProgressRepresentative, "large fixtureのin progress itemがありません");
  assertNonNullable(
    waitingForUnblockRepresentative,
    "large fixtureのwaiting for unblock itemがありません",
  );
  const output = goldenEvalOutputSchema.parse({
    schemaVersion: "1",
    kind: "large",
    itemCount: input.itemCount,
    activeEdgeCount: input.edgeCount,
    changedItemCount: input.changedItemCount,
    items: Object.freeze([
      Object.freeze({
        count: inProgressItems.length,
        status: inProgressRepresentative.status,
        waitingOn: waitingOnOutput(inProgressRepresentative.waitingOn),
        severity: inProgressRepresentative.severity,
      }),
      Object.freeze({
        count: waitingForUnblockItems.length,
        status: waitingForUnblockRepresentative.status,
        waitingOn: waitingOnOutput(waitingForUnblockRepresentative.waitingOn),
        severity: waitingForUnblockRepresentative.severity,
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
