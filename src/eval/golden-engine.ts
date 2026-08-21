import { performance } from "node:perf_hooks";

import { z } from "zod";

import {
  CodexOutputValidationError,
  createCodexAnalysisInput,
  reduceCodexAnalysis,
  validateCodexAnalysisOutput,
  type DeterministicCodexDecision,
  type ReducedCodexDecision,
} from "../codex/index.js";
import {
  buildSourceId,
  calculateStaleness,
  createExternalReferenceNodeId,
  createGitHubNodeId,
  createGitHubRepositoryId,
  createLabelEffectsResolver,
  createTrackedItemLatestEventActor,
  createUtcIsoDateTime,
  determineIssueState,
  determinePullRequestState,
  isTerminalStatus,
  resolveWaitingOnAccountIdentifiers,
  type Actor,
  type BlockedParentContext,
  type BlockerRanking,
  type FreshObservedGitHubIssue,
  type FreshObservedGitHubPullRequest,
  type GitHubAccountActor,
  type GitHubItemDisplayReference,
  type GitHubItemUrl,
  type GitHubNodeId,
  type IssueBlocker,
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
  type TrackedItem,
  type UtcIsoDateTime,
  type WaitingOn,
} from "../domain/index.js";
import { selectDiscordNotifications, type DiscordNotificationItem } from "../discord/index.js";
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
import { createPublicRepositoryAllowlist } from "../github/index.js";
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
  cooldownDays: Object.freeze({
    urgent: 3,
    critical: 2,
  }),
  recentProgressGraceHours: 24,
  minimumAiConfidence: CONFIDENCE_THRESHOLDS.medium,
});
const MAINTAINERS = Object.freeze(["fixture-maintainer"]);

type GoldenItemInput = StandardGoldenInput["items"][number];
type GoldenRelationInput = StandardGoldenInput["relations"][number];

type ItemAnalysis = Readonly<{
  input: GoldenItemInput;
  deterministicDecision: IssueStateDecision | PullRequestStateDecision;
  decision: ReducedCodexDecision;
  deadlineAssessment: NaturalLanguageDeadlineAssessmentState;
  notificationRecommendation: DiscordNotificationItem["notificationRecommendation"];
  staleness: StalenessResult;
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

function determineItemState(
  item: GoldenItemInput,
  input: StandardGoldenInput,
  items: ReadonlyMap<string, GoldenItemInput>,
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
  deterministicDecisions: ReadonlyMap<string, IssueStateDecision | PullRequestStateDecision>,
): Readonly<{
  decisions: ReadonlyMap<string, ReducedCodexDecision>;
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
  for (const analysis of input.fixedAiAnalyses) {
    const decision = deterministicDecisions.get(analysis.itemNodeId);
    assertNonNullable(decision, `固定AI判定 ${analysis.itemNodeId}の対象がありません`);
    const codexInput = createCodexAnalysisInput(analysis.input);
    if (codexInput.item.nodeId !== analysis.itemNodeId) {
      throw new TypeError("固定AI判定のitem node IDが入力と一致しません");
    }
    const acceptedOutput = validateCodexAnalysisOutput(analysis.acceptedOutput, codexInput);
    for (const rejectedOutput of analysis.rejectedOutputs) {
      try {
        validateCodexAnalysisOutput(rejectedOutput, codexInput);
      } catch (error: unknown) {
        if (!(error instanceof CodexOutputValidationError)) {
          throw error;
        }
        rejectedOutputCount += 1;
        continue;
      }
      throw new TypeError("拒否対象の固定AI出力が検証を通過しました");
    }
    const reduction = reduceCodexAnalysis(
      codexInput,
      deterministicCodexDecision(decision),
      Object.freeze({
        status: "validated",
        output: acceptedOutput,
      }),
      CONFIDENCE_THRESHOLDS,
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
    deadlineAssessments,
    notificationRecommendations,
    relationAssessments: Object.freeze(relationAssessments),
    acceptedOutputCount: input.fixedAiAnalyses.length,
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

function createTrackedItem(repositoryName: string, analysis: ItemAnalysis): TrackedItem {
  const item = analysis.input;
  const decision = analysis.decision;
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
            selectionReason: "waitingOnがないためprimaryはありません",
          })
        : Object.freeze({
            index: 0,
            selectionReason: "waitingOnの先頭候補をprimaryとして選びました",
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
    aiAnalysis: Object.freeze({
      status: "not_required",
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
    evidence: decision.evidence,
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
    schemaVersion: "10",
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
  previousGraphAvailable: boolean,
): readonly StandardGoldenOutput["notifications"][number][] {
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
        waitClass: analysis.staleness.waitClass,
        statusSince: analysis.staleness.statusSince,
        ownerSince: analysis.staleness.ownerSince,
        stallSince: analysis.staleness.stallSince,
        lastProgressAt: analysis.staleness.lastProgressAt,
      }),
      previous: notificationPrevious(analysis),
      graph: Object.freeze({
        downstreamImpact: findDownstreamImpact(nodeId, graph.downstreamImpacts),
        newlyUnblocked: graph.newlyUnblockedNodeIds.includes(nodeId),
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
  const deterministicDecisions = new Map(
    input.items.map((item) => [item.nodeId, determineItemState(item, input, items)]),
  );
  const fixedAi = applyFixedAiAnalyses(input, deterministicDecisions);
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
  const analyses = Object.freeze(
    input.items.map((item) => {
      const deterministicDecision = deterministicDecisions.get(item.nodeId);
      const decision = fixedAi.decisions.get(item.nodeId);
      const deadlineAssessment = fixedAi.deadlineAssessments.get(item.nodeId);
      const notificationRecommendation = fixedAi.notificationRecommendations.get(item.nodeId);
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
      });
    }),
  );
  const inventory = createInventory(input);
  const snapshot = createSnapshot(input, analyses, reconciled.activeEdges, repositories);
  const publication = publicationStatus(snapshot, inventory);
  const notifications =
    publication.status === "published"
      ? selectNotifications(input, analyses, graph, previousGraphAvailable)
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
          selectionReason: "waitingOnの先頭候補をprimaryとして選びました",
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
        aiAnalysis: Object.freeze({
          status: "disabled",
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
    schemaVersion: "10",
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
