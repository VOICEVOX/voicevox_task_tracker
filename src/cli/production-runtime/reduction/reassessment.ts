import {
  createLabelEffectsResolver,
  determineIssueLocalResponsibility,
  determineIssueState,
  determinePullRequestLocalResponsibility,
  determinePullRequestState,
  resolveRepositoryMaintainers,
  type GraphNodeId,
  type IssueBlocker,
  type NaturalLanguageProgressAssessment,
  type PullRequestCheckFailureAssessment,
  type SourceId,
  type TrackedItem,
  type UtcIsoDateTime,
} from "../../../domain/index.js";
import type { FreshObservedGitHubItem, GitHubItemDetail } from "../../../github/index.js";
import type { ReconciledGraphEdge } from "../../../graph/index.js";
import { assertNonNullable } from "../../../util/index.js";
import {
  createNativeBlockers,
  type DeterministicItemAnalysis,
} from "../../initial-item-analysis.js";
import { createIssueRequestCandidates } from "../../issue-responsibility-candidates.js";
import type { GraphResult, RepositoryInventory, RuntimeConfiguration } from "../contracts.js";
import { normalizeLabelRules } from "../label-rules.js";
import { findRepository, repositoryFullName } from "../repository-lookup.js";
import { checkFailureSourceIds, nonEmptySourceIds } from "../source-ids.js";
import type { ConsumerCodexElementOutput } from "./consumer-output.js";
import {
  createEffectiveAssigneeAssessment,
  explicitRequestAssessment,
} from "./responsibility-assessments.js";

function checkFailureAssessment(
  detail: Extract<GitHubItemDetail, Readonly<{ type: "pull_request" }>>,
  output: ConsumerCodexElementOutput | undefined,
): PullRequestCheckFailureAssessment {
  const sourceIds = checkFailureSourceIds(detail);
  if (sourceIds == null || output?.status == null || output.waitingOn == null) {
    return Object.freeze({
      cause: "not_assessed",
    });
  }
  const effectiveConfidence = Math.min(
    output.status.confidence,
    output.waitingOn.confidence,
    ...output.waitingOn.value.map((waitingOn) => waitingOn.confidence),
  );
  const authorAction =
    output.status.value === "waiting_for_revision" ||
    output.waitingOn.value.some((waitingOn) => waitingOn.role === "author");
  if (authorAction) {
    return Object.freeze({
      cause: "pull_request_change",
      confidence: effectiveConfidence,
      sourceIds,
    });
  }
  const infrastructureOrFlaky =
    output.status.value === "waiting_for_automation" ||
    output.status.value === "waiting_for_decision" ||
    output.status.value === "unknown" ||
    output.waitingOn.value.some(
      (waitingOn) =>
        waitingOn.kind === "automation" ||
        waitingOn.kind === "unknown" ||
        waitingOn.role === "ci" ||
        waitingOn.role === "maintainer" ||
        waitingOn.role === "unknown",
    );
  return Object.freeze({
    cause: infrastructureOrFlaky ? "infrastructure_or_flaky" : "ambiguous",
    confidence: effectiveConfidence,
    sourceIds,
  });
}

export function naturalLanguageProgressAssessments(
  analysis: DeterministicItemAnalysis,
  output: ConsumerCodexElementOutput | undefined,
): readonly NaturalLanguageProgressAssessment[] {
  const progressResult = output?.progress;
  if (progressResult == null) {
    return Object.freeze([]);
  }
  return Object.freeze(
    analysis.item.events
      .filter((event) => event.kind === "comment" && event.actor.type === "human")
      .map((event) =>
        Object.freeze({
          candidateSourceId: event.sourceId,
          verdict:
            progressResult.value.latestMeaningfulSourceId === event.sourceId
              ? "meaningful_progress"
              : "not_meaningful_progress",
          confidence: Math.min(progressResult.confidence, progressResult.value.confidence),
          sourceIds: Object.freeze([event.sourceId] satisfies [SourceId]),
        }),
      ),
  );
}

type GraphBlockerIndex = Readonly<{
  blockingEdgesByTargetNodeId: ReadonlyMap<GraphNodeId, readonly ReconciledGraphEdge[]>;
  stateByNodeId: ReadonlyMap<GraphNodeId, TrackedItem["state"]>;
}>;

export function createGraphBlockerIndex(graph: GraphResult): GraphBlockerIndex {
  const mutableBlockingEdgesByTargetNodeId = new Map<GraphNodeId, ReconciledGraphEdge[]>();
  for (const edge of graph.edges) {
    if (!edge.active || edge.type !== "blocks") {
      continue;
    }
    const edges = mutableBlockingEdgesByTargetNodeId.get(edge.toNodeId) ?? [];
    edges.push(edge);
    mutableBlockingEdgesByTargetNodeId.set(edge.toNodeId, edges);
  }
  const blockingEdgesByTargetNodeId = new Map<GraphNodeId, readonly ReconciledGraphEdge[]>(
    [...mutableBlockingEdgesByTargetNodeId].map(([nodeId, edges]) => [
      nodeId,
      Object.freeze(edges),
    ]),
  );
  return Object.freeze({
    blockingEdgesByTargetNodeId,
    stateByNodeId: graph.effectiveStateByNodeId,
  });
}

function graphBlockers(
  index: GraphBlockerIndex,
  item: FreshObservedGitHubItem,
): readonly IssueBlocker[] {
  const blockersByCandidateId = new Map<GraphNodeId, IssueBlocker>();
  for (const edge of index.blockingEdgesByTargetNodeId.get(item.nodeId) ?? []) {
    const edgeSourceIds = nonEmptySourceIds(
      edge.evidence.map((evidence) => evidence.sourceId),
      `blocker edge ${edge.id}`,
    );
    const edgeBecameBlockingAt = edge.provenance === "native" ? item.createdAt : edge.firstSeenAt;
    const existing = blockersByCandidateId.get(edge.fromNodeId);
    if (existing == null) {
      const blockerState = index.stateByNodeId.get(edge.fromNodeId);
      assertNonNullable(blockerState, `blocker ${edge.fromNodeId}の状態がありません`);
      blockersByCandidateId.set(
        edge.fromNodeId,
        Object.freeze({
          candidateId: edge.fromNodeId,
          state: blockerState,
          authority: edge.authoritative ? "authoritative" : "inferred",
          confidence: edge.confidence,
          sourceIds: edgeSourceIds,
          becameBlockingAt: edgeBecameBlockingAt,
        }),
      );
      continue;
    }
    const authority =
      existing.authority === "authoritative" || edge.authoritative ? "authoritative" : "inferred";
    const becameBlockingAt =
      existing.becameBlockingAt < edgeBecameBlockingAt
        ? existing.becameBlockingAt
        : edgeBecameBlockingAt;
    blockersByCandidateId.set(
      edge.fromNodeId,
      Object.freeze({
        ...existing,
        authority,
        confidence: Math.max(existing.confidence, edge.confidence),
        sourceIds: nonEmptySourceIds(
          [...existing.sourceIds, ...edgeSourceIds],
          `blocker ${edge.fromNodeId}`,
        ),
        becameBlockingAt,
      }),
    );
  }
  return Object.freeze(
    [...blockersByCandidateId.values()].sort((left, right) =>
      left.candidateId.localeCompare(right.candidateId),
    ),
  );
}

export function reassessDeterministicAnalysis(
  evaluatedAt: UtcIsoDateTime,
  configuration: RuntimeConfiguration,
  inventory: RepositoryInventory,
  analysis: DeterministicItemAnalysis,
  output: ConsumerCodexElementOutput | undefined,
  graphBlockerIndex: GraphBlockerIndex | undefined,
): DeterministicItemAnalysis {
  const repository = findRepository(inventory, analysis.item.repositoryId);
  const maintainers = resolveRepositoryMaintainers(
    configuration.config.maintainers,
    repositoryFullName(repository),
  );
  const blockers =
    graphBlockerIndex == null
      ? createNativeBlockers(analysis.item, analysis.relationCandidates)
      : graphBlockers(graphBlockerIndex, analysis.item);
  if (analysis.item.type === "issue" && analysis.detail.type === "issue") {
    const explicitRequestAssessmentValue = explicitRequestAssessment(
      analysis.item,
      analysis.detail,
      output,
    );
    const effectiveAssigneeAssessmentValue = createEffectiveAssigneeAssessment(
      configuration,
      evaluatedAt,
      analysis,
      output,
    );
    return Object.freeze({
      ...analysis,
      decision: determineIssueState({
        issue: analysis.item,
        blockers,
        explicitRequestCandidates: createIssueRequestCandidates(analysis.item, analysis.detail),
        explicitRequestAssessment: explicitRequestAssessmentValue,
        effectiveAssigneeCandidates: analysis.effectiveAssigneeCandidates.map(
          (candidate) => candidate.candidate,
        ),
        effectiveAssigneeAssessment: effectiveAssigneeAssessmentValue,
        maintainers,
        confidenceThresholds: configuration.config.ai.confidence,
        evaluatedAt,
      }),
      localResponsibilityDecision: determineIssueLocalResponsibility({
        issue: analysis.item,
        explicitRequestCandidates: createIssueRequestCandidates(analysis.item, analysis.detail),
        explicitRequestAssessment: explicitRequestAssessmentValue,
        effectiveAssigneeCandidates: analysis.effectiveAssigneeCandidates.map(
          (candidate) => candidate.candidate,
        ),
        effectiveAssigneeAssessment: effectiveAssigneeAssessmentValue,
        maintainers,
        confidenceThresholds: configuration.config.ai.confidence,
        evaluatedAt,
      }),
    });
  }
  if (analysis.item.type === "pull_request" && analysis.detail.type === "pull_request") {
    const resolveLabelEffects = createLabelEffectsResolver(
      normalizeLabelRules(configuration.config),
    );
    const checkFailureAssessmentValue = checkFailureAssessment(analysis.detail, output);
    const labelEffects = resolveLabelEffects(repositoryFullName(repository), analysis.item.labels);
    return Object.freeze({
      ...analysis,
      decision: determinePullRequestState({
        pullRequest: analysis.item,
        blockers,
        checkFailureAssessment: checkFailureAssessmentValue,
        labelEffects,
        maintainers,
        confidenceThresholds: configuration.config.ai.confidence,
        evaluatedAt,
      }),
      localResponsibilityDecision: determinePullRequestLocalResponsibility({
        pullRequest: analysis.item,
        checkFailureAssessment: checkFailureAssessmentValue,
        labelEffects,
        maintainers,
        confidenceThresholds: configuration.config.ai.confidence,
        evaluatedAt,
      }),
    });
  }
  throw new TypeError(`GitHub項目と詳細の種別が一致しません。対象: ${analysis.item.nodeId}`);
}
