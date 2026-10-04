import { z } from "zod";

import { type AiAnalysisElementNecessity } from "./ai-analysis-elements.js";
import { type FreshObservedGitHubIssue } from "./github-item-observation.js";
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
  type WaitingOnRole,
} from "./types.js";

export const confidenceSchema = z.number().min(0).max(1);

/** Issue判定へ適用した決定規則のversion。 */
export const ISSUE_DETERMINISTIC_RULES_VERSION = "issue-v14";

/** 依存グラフからIssue判定へ渡すblocker。 */
export type IssueBlocker = Readonly<{
  candidateId: string;
  state: "open" | "closed" | "merged";
  authority: "authoritative" | "inferred";
  confidence: number;
  sourceIds: readonly [SourceId, ...SourceId[]];
  becameBlockingAt: UtcIsoDateTime;
}>;

/** 決定論的な抽出で見つけた明示依頼らしき候補。 */
export type IssueExplicitRequestCandidate = Readonly<{
  sourceId: SourceId;
  occurredAt: UtcIsoDateTime;
}>;

/** 検証済みの外部判定が明示依頼の相手として返す候補。 */
export type IssueExplicitRequestTarget = Readonly<{
  kind: "user" | "team" | "role";
  candidateId: string;
  role: Exclude<WaitingOnRole, "dependency" | "merge_decider" | "ci">;
  sourceIds: readonly [SourceId, ...SourceId[]];
  confidence: number;
}>;

/** 明示依頼候補に対する検証済みの外部判定。 */
export type IssueExplicitRequestAssessment =
  | Readonly<{
      status: "not_assessed";
    }>
  | Readonly<{
      status: "assessed";
      candidateSourceIds: readonly [SourceId, ...SourceId[]];
      verdict: "no_unanswered_request";
      confidence: number;
      sourceIds: readonly [SourceId, ...SourceId[]];
    }>
  | Readonly<{
      status: "assessed";
      candidateSourceIds: readonly [SourceId, ...SourceId[]];
      verdict: "unanswered_request";
      requestSourceId: SourceId;
      targets: readonly [IssueExplicitRequestTarget, ...IssueExplicitRequestTarget[]];
      confidence: number;
      sourceIds: readonly [SourceId, ...SourceId[]];
    }>;

/** Issue全体を進める実質担当者らしき候補。 */
export type IssueEffectiveAssigneeCandidate = Readonly<{
  candidateId: string;
  sourceIds: readonly [SourceId, ...SourceId[]];
  occurredAt: UtcIsoDateTime;
}>;

/** 実質担当者の候補として選ばれたuser。 */
export type IssueEffectiveAssigneeTarget = Readonly<{
  kind: "user";
  candidateId: string;
  sourceIds: readonly [SourceId, ...SourceId[]];
  confidence: number;
}>;

/** Issue全体の実質担当者に対する検証済みの外部判定。 */
export type IssueEffectiveAssigneeAssessment =
  | Readonly<{
      status: "not_assessed";
    }>
  | Readonly<{
      status: "assessed";
      candidateSourceIds: readonly [SourceId, ...SourceId[]];
      verdict: "no_effective_assignee";
      confidence: number;
      sourceIds: readonly [SourceId, ...SourceId[]];
    }>
  | Readonly<{
      status: "assessed";
      candidateSourceIds: readonly [SourceId, ...SourceId[]];
      verdict: "effective_assignee";
      targets: readonly [IssueEffectiveAssigneeTarget, ...IssueEffectiveAssigneeTarget[]];
      occurredAt: UtcIsoDateTime;
      confidence: number;
      sourceIds: readonly [SourceId, ...SourceId[]];
    }>;

/** Issueのローカル責務判定で実際に参照した外部assessment。 */
export type IssueResponsibilityAssessmentTrace = Readonly<
  | Readonly<{
      kind: "explicit_request";
      assessment: IssueExplicitRequestAssessment;
    }>
  | Readonly<{
      kind: "effective_assignee";
      assessment: IssueEffectiveAssigneeAssessment;
    }>
>;

/** Issue状態機械へ渡す設定解決済み入力。 */
export type IssueStateMachineInput = Readonly<{
  issue: FreshObservedGitHubIssue;
  blockers: readonly IssueBlocker[];
  explicitRequestCandidates: readonly IssueExplicitRequestCandidate[];
  explicitRequestAssessment: IssueExplicitRequestAssessment;
  effectiveAssigneeCandidates: readonly IssueEffectiveAssigneeCandidate[];
  effectiveAssigneeAssessment: IssueEffectiveAssigneeAssessment;
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
export type IssueTransitionBasis = Readonly<{
  sourceIds: readonly [SourceId, ...SourceId[]];
  occurredAt: UtcIsoDateTime;
  precision: "event" | "inferred";
}>;

/** primary waitingOnの選定結果。 */
export type IssuePrimaryWaitingOn = PrimaryWaitingOn;

/** 決定論的なIssue状態機械の判定結果。 */
export type IssueStateDecision = Readonly<{
  deterministicRulesVersion: typeof ISSUE_DETERMINISTIC_RULES_VERSION;
  evaluatedAt: UtcIsoDateTime;
  determination: "determined" | "codex_candidate";
  aiAnalysisElementNecessities: Readonly<{
    status: AiAnalysisElementNecessity;
    waitingOn: AiAnalysisElementNecessity;
    nextAction: AiAnalysisElementNecessity;
  }>;
  status: Status;
  waitingOn: readonly WaitingOn[];
  primaryWaitingOn: IssuePrimaryWaitingOn;
  nextAction: string;
  confidence: number;
  evidence: readonly Evidence[];
  uncertainties: readonly string[];
  statusBasis: IssueTransitionBasis;
  responsibilityBasis: IssueTransitionBasis;
  assessmentTrace: readonly IssueResponsibilityAssessmentTrace[];
  blockerDecisionTrace: BlockerDecisionTrace;
}>;

export type DecisionDraft = Readonly<{
  status: Status;
  waitingOn: readonly WaitingOn[];
  primarySelectionReason: string;
  nextAction: string;
  confidence: number;
  evidence: readonly Evidence[];
  statusBasis: IssueTransitionBasis;
  responsibilityBasis: IssueTransitionBasis;
}>;

export interface DecisionContext {
  uncertainties: string[];
  evidence: Evidence[];
  confidenceCap: number;
  uncertainStateElements: Set<"status" | "waitingOn" | "nextAction">;
  assessmentTrace: IssueResponsibilityAssessmentTrace[];
  blockerDecisionTrace: BlockerDecisionTrace;
}

export type ResolvedAssignee = Readonly<{
  waitingOn: WaitingOn;
  basis: IssueTransitionBasis;
}>;

export type AssigneeEvent = Extract<NormalizedEvent, { kind: "assignee" }>;

export type AssigneeEventReplay = Readonly<{
  activeAssignmentByAssigneeNodeId: ReadonlyMap<GitHubAccountActor["nodeId"], AssigneeEvent>;
  lastUnassignedEvent: AssigneeEvent | undefined;
}>;
