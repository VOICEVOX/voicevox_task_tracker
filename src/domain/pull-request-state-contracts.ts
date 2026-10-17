import { z } from "zod";

import { type AiAnalysisElementNecessity } from "./ai-analysis-elements.js";
import { type FreshObservedGitHubPullRequest } from "./github-item-observation.js";
import { type ResolvedLabelEffects } from "./label-resolution.js";
import { type SourceId } from "./source-id.js";
import {
  type BlockerDecisionTrace,
  type Evidence,
  type GitHubAccountActor,
  type NormalizedEvent,
  type PrimaryWaitingOn,
  type Status,
  type UtcIsoDateTime,
  type WaitingOn,
} from "./types.js";

export const confidenceSchema = z.number().min(0).max(1);

/** Pull Request判定へ適用した決定規則のversion。 */
export const PULL_REQUEST_DETERMINISTIC_RULES_VERSION = "pull-request-v12";

/** 依存グラフからPull Request判定へ渡すblocker。 */
export type PullRequestBlocker = Readonly<{
  candidateId: string;
  state: "open" | "closed" | "merged";
  authority: "authoritative" | "inferred";
  confidence: number;
  sourceIds: readonly [SourceId, ...SourceId[]];
  becameBlockingAt: UtcIsoDateTime;
}>;

/** required check失敗原因の決定論的な事前評価。 */
export type PullRequestCheckFailureAssessment =
  | Readonly<{
      cause: "not_assessed";
    }>
  | Readonly<{
      cause: "pull_request_change" | "infrastructure_or_flaky" | "ambiguous";
      confidence: number;
      sourceIds: readonly [SourceId, ...SourceId[]];
    }>;

/** Pull Requestのローカル責務判定で実際に参照した外部assessment。 */
export type PullRequestResponsibilityAssessmentTrace = Readonly<{
  kind: "check_failure";
  assessment: PullRequestCheckFailureAssessment;
}>;

/** Pull Request状態機械へ渡す設定解決済み入力。 */
export type PullRequestStateMachineInput = Readonly<{
  pullRequest: FreshObservedGitHubPullRequest;
  blockers: readonly PullRequestBlocker[];
  checkFailureAssessment: PullRequestCheckFailureAssessment;
  labelEffects: ResolvedLabelEffects;
  maintainers: readonly string[];
  confidenceThresholds: Readonly<{
    high: number;
    medium: number;
  }>;
  evaluatedAt: UtcIsoDateTime;
}>;

/**
 * statusまたは責務を生じさせた時刻と根拠。
 * eventはGitHubイベント時刻そのものを表し、inferredはGitHub由来の時刻から決定論的に導いた下限を表す。
 */
export type PullRequestTransitionBasis = Readonly<{
  sourceIds: readonly [SourceId, ...SourceId[]];
  occurredAt: UtcIsoDateTime;
  precision: "event" | "inferred";
}>;

/** primary waitingOnの選定結果。 */
export type PullRequestPrimaryWaitingOn = PrimaryWaitingOn;

/** 決定論的なPull Request状態機械の判定結果。 */
export type PullRequestStateDecision = Readonly<{
  deterministicRulesVersion: typeof PULL_REQUEST_DETERMINISTIC_RULES_VERSION;
  evaluatedAt: UtcIsoDateTime;
  determination: "determined" | "codex_candidate";
  aiAnalysisElementNecessities: Readonly<{
    status: AiAnalysisElementNecessity;
    waitingOn: AiAnalysisElementNecessity;
    nextAction: AiAnalysisElementNecessity;
  }>;
  status: Status;
  waitingOn: readonly WaitingOn[];
  primaryWaitingOn: PullRequestPrimaryWaitingOn;
  nextAction: string;
  confidence: number;
  evidence: readonly Evidence[];
  uncertainties: readonly string[];
  statusBasis: PullRequestTransitionBasis;
  responsibilityBasis: PullRequestTransitionBasis;
  assessmentTrace: readonly PullRequestResponsibilityAssessmentTrace[];
  blockerDecisionTrace: BlockerDecisionTrace;
}>;

export type DecisionDraft = Readonly<{
  status: Status;
  waitingOn: readonly WaitingOn[];
  primarySelectionReason: string;
  nextAction: string;
  confidence: number;
  evidence: readonly Evidence[];
  statusBasis: PullRequestTransitionBasis;
  responsibilityBasis: PullRequestTransitionBasis;
}>;

export interface DecisionContext {
  uncertainties: string[];
  evidence: Evidence[];
  confidenceCap: number;
  uncertainStateElements: Set<"status" | "waitingOn" | "nextAction">;
  assessmentTrace: PullRequestResponsibilityAssessmentTrace[];
  blockerDecisionTrace: BlockerDecisionTrace;
}

export type ReviewEvent = Extract<NormalizedEvent, { kind: "review" }> & {
  actor: GitHubAccountActor & { type: "human" };
};

export type HumanCommentEvent = Extract<NormalizedEvent, { kind: "comment" }> & {
  actor: GitHubAccountActor & { type: "human" };
};

export type LabelEvent = Extract<NormalizedEvent, { kind: "label" }>;

export type LabelEventReplay = Readonly<{
  activeAdditionByLabelName: ReadonlyMap<string, LabelEvent>;
}>;

export type ResolvedReviewRequest = Readonly<{
  requestSourceId: SourceId;
  requestEventSourceIds: readonly SourceId[];
  waitingOn: WaitingOn;
  basis: PullRequestTransitionBasis;
}>;

export type CheckFailureAnalysis = Readonly<{
  authorAction:
    | Readonly<{
        sourceIds: readonly [SourceId, ...SourceId[]];
        confidence: number;
      }>
    | "not_applicable";
}>;
