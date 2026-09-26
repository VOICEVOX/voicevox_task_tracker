import {
  determineIssueLocalResponsibility,
  determineIssueState,
  type IssueBlocker,
  type IssueStateDecision,
  type IssueStateMachineInput,
} from "../domain/issue-state-machine.js";
import type { ResolvedLabelEffects } from "../domain/label-resolution.js";
import {
  determinePullRequestLocalResponsibility,
  determinePullRequestState,
  type PullRequestStateDecision,
} from "../domain/pull-request-state-machine.js";
import type { TrackingNotificationClass, UtcIsoDateTime } from "../domain/index.js";
import type { FreshObservedGitHubItem, GitHubItemDetail } from "../github/index.js";
import type { RelationCandidate } from "../graph/index.js";
import {
  createEffectiveAssigneeCandidateContexts,
  createIssueRequestCandidates,
  type EffectiveAssigneeCandidateContext,
  type EffectiveAssigneeCollectionContext,
} from "./issue-responsibility-candidates.js";

/** AI分析前の1件の判定へ渡す、設定解決済みの入力。 */
export type InitialItemAnalysisInput = Readonly<{
  item: FreshObservedGitHubItem;
  detail: GitHubItemDetail;
  blockers: readonly IssueBlocker[];
  maintainers: readonly string[];
  labelEffects: ResolvedLabelEffects;
  confidenceThresholds: IssueStateMachineInput["confidenceThresholds"];
  evaluatedAt: UtcIsoDateTime;
  notificationClass: TrackingNotificationClass;
  relationCandidates: readonly RelationCandidate[];
  effectiveAssigneeCollectionContext: EffectiveAssigneeCollectionContext;
}>;

/** AI分析前の項目判定と、後段へ引き渡す収集済み情報。 */
export type DeterministicItemAnalysis = Readonly<{
  item: FreshObservedGitHubItem;
  detail: GitHubItemDetail;
  decision: IssueStateDecision | PullRequestStateDecision;
  localResponsibilityDecision: IssueStateDecision | PullRequestStateDecision;
  notificationClass: TrackingNotificationClass;
  notificationsSuppressedByLabel: boolean;
  relationCandidates: readonly RelationCandidate[];
  effectiveAssigneeCandidates: readonly EffectiveAssigneeCandidateContext[];
}>;

/** GitHubの確定した関係候補からblockerを構築する。 */
export function createNativeBlockers(
  item: FreshObservedGitHubItem,
  candidates: readonly RelationCandidate[],
): readonly IssueBlocker[] {
  const blockers: IssueBlocker[] = [];
  for (const candidate of candidates) {
    if (
      candidate.authority !== "authoritative" ||
      candidate.relation.type !== "blocks" ||
      candidate.relation.blocked.nodeId !== item.nodeId
    ) {
      continue;
    }
    blockers.push(
      Object.freeze({
        candidateId: candidate.relation.blocker.nodeId,
        state: candidate.relation.blocker.state,
        authority: "authoritative",
        confidence: 1,
        sourceIds: candidate.sourceIds,
        becameBlockingAt: item.createdAt,
      }),
    );
  }
  return Object.freeze(blockers);
}

/** 収集済みのIssueまたはPull Requestを、AI分析前の契約で初期判定する。 */
export function analyzeInitialItem(input: InitialItemAnalysisInput): DeterministicItemAnalysis {
  const {
    item,
    detail,
    blockers,
    maintainers,
    labelEffects,
    confidenceThresholds,
    evaluatedAt,
    notificationClass,
    relationCandidates,
    effectiveAssigneeCollectionContext,
  } = input;
  const notificationsSuppressedByLabel = labelEffects.suppressNotifications;

  if (item.type === "issue" && detail.type === "issue") {
    const effectiveAssigneeCandidates = createEffectiveAssigneeCandidateContexts(
      effectiveAssigneeCollectionContext,
      item,
      detail,
      relationCandidates,
    );
    const decision = determineIssueState({
      issue: item,
      blockers,
      explicitRequestCandidates: createIssueRequestCandidates(item, detail),
      explicitRequestAssessment: {
        status: "not_assessed",
      },
      effectiveAssigneeCandidates: effectiveAssigneeCandidates.map(
        (candidate) => candidate.candidate,
      ),
      effectiveAssigneeAssessment: {
        status: "not_assessed",
      },
      maintainers,
      confidenceThresholds,
      evaluatedAt,
    });
    const localResponsibilityDecision = determineIssueLocalResponsibility({
      issue: item,
      explicitRequestCandidates: createIssueRequestCandidates(item, detail),
      explicitRequestAssessment: {
        status: "not_assessed",
      },
      effectiveAssigneeCandidates: effectiveAssigneeCandidates.map(
        (candidate) => candidate.candidate,
      ),
      effectiveAssigneeAssessment: {
        status: "not_assessed",
      },
      maintainers,
      confidenceThresholds,
      evaluatedAt,
    });
    return Object.freeze({
      item,
      detail,
      decision,
      localResponsibilityDecision,
      notificationClass,
      notificationsSuppressedByLabel,
      relationCandidates,
      effectiveAssigneeCandidates,
    });
  }

  if (item.type === "pull_request" && detail.type === "pull_request") {
    const decision = determinePullRequestState({
      pullRequest: item,
      blockers,
      checkFailureAssessment: {
        cause: "not_assessed",
      },
      labelEffects,
      maintainers,
      confidenceThresholds,
      evaluatedAt,
    });
    const localResponsibilityDecision = determinePullRequestLocalResponsibility({
      pullRequest: item,
      checkFailureAssessment: {
        cause: "not_assessed",
      },
      labelEffects,
      maintainers,
      confidenceThresholds,
      evaluatedAt,
    });
    return Object.freeze({
      item,
      detail,
      decision,
      localResponsibilityDecision,
      notificationClass,
      notificationsSuppressedByLabel,
      relationCandidates,
      effectiveAssigneeCandidates: Object.freeze([]),
    });
  }

  throw new TypeError(`GitHub項目と詳細の種別が一致しません。対象: ${item.nodeId}`);
}
