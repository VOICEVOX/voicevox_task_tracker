import { assertNonNullable } from "../util/index.js";
import { type FreshObservedGitHubIssue } from "./github-item-observation.js";
import type {
  AssigneeEventReplay,
  DecisionContext,
  IssueExplicitRequestTarget,
  IssueStateDecision,
  IssueStateMachineInput,
  IssueTransitionBasis,
  ResolvedAssignee,
} from "./issue-state-contracts.js";
import {
  addAssessmentTrace,
  addUncertainty,
  createBasis,
  createEvidence,
  createWaitingOn,
  finalizeDecision,
} from "./issue-state-decision.js";
import { compareCandidates, replayAssigneeEvents } from "./issue-state-sources.js";
import { type GitHubAccountActor, type Status } from "./types.js";

function compareRequestTargets(
  left: IssueExplicitRequestTarget,
  right: IssueExplicitRequestTarget,
): -1 | 0 | 1 {
  const leftKindOrder = getRequestTargetKindOrder(left.kind);
  const rightKindOrder = getRequestTargetKindOrder(right.kind);
  if (leftKindOrder !== rightKindOrder) {
    return leftKindOrder < rightKindOrder ? -1 : 1;
  }
  if (left.candidateId < right.candidateId) {
    return -1;
  }
  if (left.candidateId > right.candidateId) {
    return 1;
  }
  return 0;
}

function getRequestTargetKindOrder(kind: IssueExplicitRequestTarget["kind"]): number {
  switch (kind) {
    case "user":
      return 0;
    case "team":
      return 1;
    case "role":
      return 2;
  }
}

function getRequestDecisionStatus(targets: readonly IssueExplicitRequestTarget[]): Status {
  return targets.every((target) => target.kind === "role" && target.role === "maintainer")
    ? "waiting_for_decision"
    : "waiting_for_reply";
}

export function createExplicitRequestDecision(
  input: IssueStateMachineInput,
  context: DecisionContext,
): IssueStateDecision | undefined {
  const candidates = [...input.explicitRequestCandidates].sort(compareCandidates);
  if (candidates.length === 0) {
    return undefined;
  }

  const assessment = input.explicitRequestAssessment;
  addAssessmentTrace(context, {
    kind: "explicit_request",
    assessment,
  });
  if (assessment.status === "not_assessed") {
    addUncertainty(
      context,
      "未回答の明示依頼らしき候補を決定論的に確定できません",
      candidates.map((candidate) => candidate.sourceId),
      input.confidenceThresholds.medium,
      ["status", "waitingOn", "nextAction"],
    );
    return undefined;
  }

  if (assessment.verdict === "no_unanswered_request") {
    if (assessment.confidence < input.confidenceThresholds.high) {
      addUncertainty(
        context,
        "明示依頼候補に未回答の依頼がないという判定の信頼度が十分ではありません",
        assessment.sourceIds,
        Math.min(input.confidenceThresholds.medium, assessment.confidence),
        ["status", "waitingOn", "nextAction"],
      );
    } else {
      context.evidence.push(
        ...createEvidence(
          assessment.sourceIds,
          "waiting_on",
          "明示依頼候補に未回答の依頼はありません",
        ),
      );
    }
    return undefined;
  }

  const targets = [...assessment.targets].sort(compareRequestTargets);
  const targetConfidence = Math.min(...targets.map((target) => target.confidence));
  const confidence = Math.min(assessment.confidence, targetConfidence);
  if (confidence < input.confidenceThresholds.medium) {
    addUncertainty(
      context,
      "明示依頼の相手に関する外部判定の信頼度が低いため責務へ反映しません",
      assessment.sourceIds,
      confidence,
      ["status", "waitingOn", "nextAction"],
    );
    return undefined;
  }
  if (confidence < input.confidenceThresholds.high) {
    addUncertainty(
      context,
      "明示依頼の相手は外部判定による推定です",
      assessment.sourceIds,
      confidence,
      ["status", "waitingOn", "nextAction"],
    );
  }

  const requestCandidate = candidates.find(
    (candidate) => candidate.sourceId === assessment.requestSourceId,
  );
  assertNonNullable(requestCandidate, "選定済みの明示依頼候補を取得できませんでした");
  const waitingOn = targets.map((target) =>
    createWaitingOn({
      kind: target.kind,
      candidateId: target.candidateId,
      role: target.kind === "role" ? target.role : "respondent",
      reasonSummary: "最新の未回答な明示依頼があります",
      sourceIds: target.sourceIds,
      confidence: Math.min(target.confidence, assessment.confidence),
    }),
  );
  const primaryTarget = targets[0];
  assertNonNullable(primaryTarget, "primaryとなる明示依頼先を選定できませんでした");
  const basis = createBasis(assessment.sourceIds, requestCandidate.occurredAt, "inferred");

  return finalizeDecision(input, context, {
    status: getRequestDecisionStatus(targets),
    waitingOn,
    primarySelectionReason: "明示依頼先をuser、team、role、candidate IDの順で選定しました",
    nextAction: `${primaryTarget.candidateId}が明示依頼へ対応する`,
    confidence,
    evidence: [
      ...createEvidence(assessment.sourceIds, "status", "最新の未回答な明示依頼があります"),
      ...createEvidence(assessment.sourceIds, "waiting_on", "明示依頼先の対応待ちです"),
    ],
    statusBasis: basis,
    responsibilityBasis: basis,
  });
}

function getAssigneeBasis(
  issue: FreshObservedGitHubIssue,
  assignee: GitHubAccountActor,
  replay: AssigneeEventReplay,
): IssueTransitionBasis {
  const assignmentEvent = replay.activeAssignmentByAssigneeNodeId.get(assignee.nodeId);
  if (assignmentEvent == null) {
    return createBasis([issue.sourceId], issue.createdAt, "inferred");
  }
  return createBasis([assignmentEvent.sourceId], assignmentEvent.occurredAt, "event");
}

function compareResolvedAssignees(left: ResolvedAssignee, right: ResolvedAssignee): -1 | 0 | 1 {
  if (left.basis.occurredAt < right.basis.occurredAt) {
    return -1;
  }
  if (left.basis.occurredAt > right.basis.occurredAt) {
    return 1;
  }
  if (left.waitingOn.candidateId < right.waitingOn.candidateId) {
    return -1;
  }
  if (left.waitingOn.candidateId > right.waitingOn.candidateId) {
    return 1;
  }
  return 0;
}

export function createAssigneeDecision(
  input: IssueStateMachineInput,
  context: DecisionContext,
): IssueStateDecision | undefined {
  if (input.issue.assignees.length === 0) {
    return undefined;
  }

  const replay = replayAssigneeEvents(input.issue.events);
  const assignees = input.issue.assignees
    .map((assignee) => {
      const basis = getAssigneeBasis(input.issue, assignee, replay);
      return Object.freeze({
        waitingOn: createWaitingOn({
          kind: "user",
          candidateId: assignee.login,
          role: "assignee",
          reasonSummary: "Issueへassignされています",
          sourceIds: basis.sourceIds,
          confidence: 1,
        }),
        basis,
      });
    })
    .sort(compareResolvedAssignees);
  const primaryAssignee = assignees[0];
  assertNonNullable(primaryAssignee, "primary assigneeを選定できませんでした");
  const sourceIds = assignees.flatMap((assignee) => assignee.waitingOn.sourceIds);

  return finalizeDecision(input, context, {
    status: "waiting_for_work",
    waitingOn: assignees.map((assignee) => assignee.waitingOn),
    primarySelectionReason: "assign時刻とcandidate IDの順でassigneeを選定しました",
    nextAction: `${primaryAssignee.waitingOn.candidateId}がIssueを進める`,
    confidence: 1,
    evidence: [
      ...createEvidence(sourceIds, "status", "Issueにassigneeが設定されています"),
      ...createEvidence(sourceIds, "waiting_on", "assigneeの対応待ちです"),
    ],
    statusBasis: primaryAssignee.basis,
    responsibilityBasis: primaryAssignee.basis,
  });
}

export function createEffectiveAssigneeDecision(
  input: IssueStateMachineInput,
  context: DecisionContext,
): IssueStateDecision | undefined {
  if (input.issue.state !== "open" || input.issue.assignees.length !== 0) {
    return undefined;
  }
  if (context.uncertainties.length !== 0) {
    return undefined;
  }

  const assessment = input.effectiveAssigneeAssessment;
  if (input.effectiveAssigneeCandidates.length !== 0) {
    addAssessmentTrace(context, {
      kind: "effective_assignee",
      assessment,
    });
  }
  if (assessment.status !== "assessed" || assessment.verdict !== "effective_assignee") {
    return undefined;
  }

  const candidatesById = new Map(
    input.effectiveAssigneeCandidates.map((candidate) => [
      candidate.candidateId.toLowerCase(),
      candidate,
    ]),
  );
  const basis = createBasis(assessment.sourceIds, assessment.occurredAt, "inferred");
  const targets = assessment.targets
    .map((target) => {
      const candidate = candidatesById.get(target.candidateId.toLowerCase());
      assertNonNullable(candidate, `実質担当候補を取得できません。対象: ${target.candidateId}`);
      return Object.freeze({
        waitingOn: createWaitingOn({
          kind: "user",
          candidateId: target.candidateId,
          role: "assignee",
          reasonSummary: "GitHub assigneeではなくIssue全体の作業から実質担当者を推定しました",
          sourceIds: target.sourceIds,
          confidence: Math.min(target.confidence, assessment.confidence),
        }),
        basis,
      });
    })
    .sort(compareResolvedAssignees);
  const primaryTarget = targets[0];
  assertNonNullable(primaryTarget, "実質担当者のprimaryを選定できませんでした");
  const confidence = Math.min(
    assessment.confidence,
    ...assessment.targets.map((target) => target.confidence),
  );
  if (confidence < input.confidenceThresholds.high) {
    return undefined;
  }

  const candidateIds = targets.map((target) => target.waitingOn.candidateId);
  const responsibilitySummary =
    targets.length === 1
      ? "Issue全体を進める実質担当者を推定しました"
      : "Issue全体を共同で進める実質担当者を推定しました";
  const nextAction =
    targets.length === 1
      ? `${primaryTarget.waitingOn.candidateId}がIssueを進める`
      : `${candidateIds.join("、")}がIssueを共同で進める`;

  return finalizeDecision(input, context, {
    status: "waiting_for_work",
    waitingOn: targets.map((target) => target.waitingOn),
    primarySelectionReason: responsibilitySummary,
    nextAction,
    confidence,
    evidence: [
      ...createEvidence(
        assessment.sourceIds,
        "status",
        "GitHub assigneeではなくIssue全体の作業から実質担当者を推定しました",
      ),
      ...createEvidence(
        targets.flatMap((target) => target.waitingOn.sourceIds),
        "waiting_on",
        "Issue全体の実質担当者の作業を待っています",
      ),
    ],
    statusBasis: basis,
    responsibilityBasis: basis,
  });
}

function determineUnassignedNextAction(
  assessmentCompleted: boolean,
  hasUncertainty: boolean,
): string {
  if (assessmentCompleted && hasUncertainty) {
    return "maintainerが不確実な点を確認して担当を決める";
  }
  if (assessmentCompleted) {
    return "maintainerがIssueの担当を決める";
  }
  if (hasUncertainty) {
    return "maintainerが不確実な点を確認してIssueの内容を確認する";
  }
  return "maintainerがIssueの内容を確認する";
}

export function createUnassignedDecision(
  input: IssueStateMachineInput,
  context: DecisionContext,
): IssueStateDecision {
  const lastUnassignedEvent = replayAssigneeEvents(input.issue.events).lastUnassignedEvent;
  const basis =
    lastUnassignedEvent == null
      ? createBasis([input.issue.sourceId], input.issue.createdAt, "inferred")
      : createBasis([lastUnassignedEvent.sourceId], lastUnassignedEvent.occurredAt, "event");
  const assessmentEvidenceSourceIds = input.issue.events.flatMap((event) => {
    if (event.kind === "assignee" && event.action === "added") {
      return [event.sourceId];
    }
    if (event.kind !== "comment" || event.actor.type !== "human") {
      return [];
    }
    if (
      input.issue.author.status === "identified" &&
      event.actor.nodeId === input.issue.author.actor.nodeId
    ) {
      return [];
    }
    return [event.sourceId];
  });
  if (input.issue.labels.length > 0) {
    assessmentEvidenceSourceIds.push(input.issue.sourceId);
  }
  const assessmentCompleted = assessmentEvidenceSourceIds.length > 0;
  const nextAction = determineUnassignedNextAction(
    assessmentCompleted,
    context.uncertainties.length > 0,
  );
  const waitingOn = createWaitingOn({
    kind: "role",
    candidateId: "maintainer",
    role: "maintainer",
    reasonSummary: assessmentCompleted
      ? "内容確認済みの未アサインIssueで担当決定が必要です"
      : "未アサインIssueの内容確認が必要です",
    sourceIds: basis.sourceIds,
    confidence: 1,
  });
  return finalizeDecision(input, context, {
    status: assessmentCompleted ? "waiting_for_owner" : "waiting_for_assessment",
    waitingOn: [waitingOn],
    primarySelectionReason: "未アサインIssueの既定責務としてmaintainerを選定しました",
    nextAction,
    confidence: 1,
    evidence: [
      ...createEvidence(
        assessmentCompleted ? assessmentEvidenceSourceIds : [input.issue.sourceId],
        "status",
        assessmentCompleted
          ? "Issueの内容が確認された根拠があり、assigneeは設定されていません"
          : "Issueにassigneeがなく、内容確認済みの根拠もありません",
      ),
      ...createEvidence(
        basis.sourceIds,
        "waiting_on",
        assessmentCompleted
          ? "未アサインIssueの担当決定はmaintainerの責務です"
          : "未アサインIssueの内容確認はmaintainerの責務です",
      ),
    ],
    statusBasis: basis,
    responsibilityBasis: basis,
  });
}
