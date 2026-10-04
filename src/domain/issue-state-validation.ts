import type {
  IssueEffectiveAssigneeCandidate,
  IssueExplicitRequestCandidate,
  IssueStateMachineInput,
} from "./issue-state-contracts.js";
import { confidenceSchema } from "./issue-state-contracts.js";
import { compareCandidates, createSourceIds, replayAssigneeEvents } from "./issue-state-sources.js";
import { type SourceId } from "./source-id.js";

function validateConfidence(value: number, context: string): void {
  const result = confidenceSchema.safeParse(value);
  if (!result.success) {
    throw new RangeError(`${context}は0以上1以下にしてください`, { cause: result.error });
  }
}

function validateSourceIds(sourceIds: readonly SourceId[], context: string): void {
  if (sourceIds.length === 0) {
    throw new TypeError(`${context}にはsource IDが1件以上必要です`);
  }
  if (new Set(sourceIds).size !== sourceIds.length) {
    throw new TypeError(`${context}のsource IDが重複しています`);
  }
}

function validateMaintainerLoginList(maintainers: readonly string[]): void {
  if (maintainers.length === 0) {
    throw new TypeError("メンテナのGitHub loginは1件以上必要です");
  }
  const normalizedLogins = maintainers.map((login) => login.toLowerCase());
  if (new Set(normalizedLogins).size !== normalizedLogins.length) {
    throw new TypeError("メンテナのGitHub loginが重複しています");
  }
}

function validateAssessment(
  input: IssueStateMachineInput,
  candidates: readonly IssueExplicitRequestCandidate[],
): void {
  const assessment = input.explicitRequestAssessment;
  if (assessment.status === "not_assessed") {
    return;
  }
  if (candidates.length === 0) {
    throw new TypeError("明示依頼候補がないため外部判定を適用できません");
  }

  validateConfidence(assessment.confidence, "明示依頼の外部判定confidence");
  validateSourceIds(assessment.candidateSourceIds, "明示依頼の外部判定対象");
  validateSourceIds(assessment.sourceIds, "明示依頼の外部判定根拠");

  const actualCandidateSourceIds = createSourceIds(
    candidates.map((candidate) => candidate.sourceId),
  );
  const assessedCandidateSourceIds = createSourceIds(assessment.candidateSourceIds);
  if (
    actualCandidateSourceIds.length !== assessedCandidateSourceIds.length ||
    actualCandidateSourceIds.some(
      (sourceId, index) => sourceId !== assessedCandidateSourceIds[index],
    )
  ) {
    throw new TypeError("明示依頼候補と外部判定の対象source IDが一致しません");
  }

  const knownSourceIds = new Set<SourceId>([
    input.issue.sourceId,
    ...input.issue.events.map((event) => event.sourceId),
    ...actualCandidateSourceIds,
  ]);
  for (const sourceId of assessment.sourceIds) {
    if (!knownSourceIds.has(sourceId)) {
      throw new TypeError(`明示依頼の外部判定が未知のsource IDを参照しています。対象: ${sourceId}`);
    }
  }

  if (assessment.verdict === "no_unanswered_request") {
    if (!assessment.sourceIds.some((sourceId) => actualCandidateSourceIds.includes(sourceId))) {
      throw new TypeError("明示依頼ではないという外部判定に候補のsource IDがありません");
    }
    return;
  }

  if (!actualCandidateSourceIds.includes(assessment.requestSourceId)) {
    throw new TypeError("外部判定が選んだ明示依頼は現在の候補に含まれていません");
  }
  if (!assessment.sourceIds.includes(assessment.requestSourceId)) {
    throw new TypeError("明示依頼の外部判定根拠に選定した依頼のsource IDがありません");
  }
  if (assessment.targets.length === 0) {
    throw new TypeError("未回答の明示依頼には依頼先が1件以上必要です");
  }

  const targetKeys = new Set<string>();
  for (const target of assessment.targets) {
    if (target.candidateId.length === 0) {
      throw new TypeError("明示依頼先のcandidate IDは空にできません");
    }
    validateConfidence(target.confidence, `明示依頼先 ${target.candidateId}のconfidence`);
    validateSourceIds(target.sourceIds, `明示依頼先 ${target.candidateId}`);
    for (const sourceId of target.sourceIds) {
      if (!assessment.sourceIds.includes(sourceId)) {
        throw new TypeError(
          `明示依頼先の根拠が外部判定の根拠に含まれていません。対象: ${sourceId}`,
        );
      }
    }
    if (!target.sourceIds.includes(assessment.requestSourceId)) {
      throw new TypeError(
        `明示依頼先の根拠に選定した依頼のsource IDがありません。対象: ${target.candidateId}`,
      );
    }
    const targetKey = `${target.kind}:${target.candidateId}`;
    if (targetKeys.has(targetKey)) {
      throw new TypeError(`明示依頼先が重複しています。対象: ${target.candidateId}`);
    }
    targetKeys.add(targetKey);
  }
}

function compareEffectiveAssigneeCandidates(
  left: IssueEffectiveAssigneeCandidate,
  right: IssueEffectiveAssigneeCandidate,
): -1 | 0 | 1 {
  if (left.occurredAt < right.occurredAt) {
    return -1;
  }
  if (left.occurredAt > right.occurredAt) {
    return 1;
  }
  const leftCandidateId = left.candidateId.toLowerCase();
  const rightCandidateId = right.candidateId.toLowerCase();
  if (leftCandidateId < rightCandidateId) {
    return -1;
  }
  if (leftCandidateId > rightCandidateId) {
    return 1;
  }
  return 0;
}

function sourceIdsMatch(left: readonly SourceId[], right: readonly SourceId[]): boolean {
  const leftSourceIds = createSourceIds(left);
  const rightSourceIds = createSourceIds(right);
  return (
    leftSourceIds.length === rightSourceIds.length &&
    leftSourceIds.every((sourceId, index) => sourceId === rightSourceIds[index])
  );
}

function validateEffectiveAssigneeTargetKind(kind: string): void {
  if (kind !== "user") {
    throw new TypeError("実質担当者にはuserだけを指定できます");
  }
}

function validateEffectiveAssigneeAssessment(
  input: IssueStateMachineInput,
  candidates: readonly IssueEffectiveAssigneeCandidate[],
): void {
  const assessment = input.effectiveAssigneeAssessment;
  if (assessment.status === "not_assessed") {
    return;
  }
  if (candidates.length === 0) {
    throw new TypeError("実質担当候補がないため外部判定を適用できません");
  }

  validateConfidence(assessment.confidence, "実質担当の外部判定confidence");
  validateSourceIds(assessment.candidateSourceIds, "実質担当の外部判定対象");
  validateSourceIds(assessment.sourceIds, "実質担当の外部判定根拠");
  if (assessment.verdict === "effective_assignee" && assessment.occurredAt > input.evaluatedAt) {
    throw new RangeError("実質担当の根拠時刻は判定時刻以前にしてください");
  }

  const actualCandidateSourceIds = createSourceIds(
    candidates.flatMap((candidate) => candidate.sourceIds),
  );
  if (!sourceIdsMatch(actualCandidateSourceIds, assessment.candidateSourceIds)) {
    throw new TypeError("実質担当候補と外部判定の対象source IDが一致しません");
  }

  const knownSourceIds = new Set<SourceId>([
    input.issue.sourceId,
    ...input.issue.events.map((event) => event.sourceId),
    ...actualCandidateSourceIds,
  ]);
  for (const sourceId of assessment.sourceIds) {
    if (!knownSourceIds.has(sourceId)) {
      throw new TypeError(`実質担当の外部判定が未知のsource IDを参照しています。対象: ${sourceId}`);
    }
  }

  if (assessment.verdict === "no_effective_assignee") {
    if (!assessment.sourceIds.some((sourceId) => actualCandidateSourceIds.includes(sourceId))) {
      throw new TypeError("実質担当者がいないという外部判定に候補のsource IDがありません");
    }
    return;
  }

  if (assessment.targets.length === 0) {
    throw new TypeError("実質担当者の外部判定には対象userが1件以上必要です");
  }

  const candidatesById = new Map(
    candidates.map((candidate) => [candidate.candidateId.toLowerCase(), candidate]),
  );
  const lastUnassignedEvent = replayAssigneeEvents(input.issue.events).lastUnassignedEvent;
  const targetIds = new Set<string>();
  for (const target of assessment.targets) {
    validateEffectiveAssigneeTargetKind(target.kind);
    if (target.candidateId.length === 0) {
      throw new TypeError("実質担当者のcandidate IDは空にできません");
    }
    const normalizedCandidateId = target.candidateId.toLowerCase();
    if (targetIds.has(normalizedCandidateId)) {
      throw new TypeError(`実質担当者が重複しています。対象: ${target.candidateId}`);
    }
    targetIds.add(normalizedCandidateId);
    validateConfidence(target.confidence, `実質担当者 ${target.candidateId}のconfidence`);
    validateSourceIds(target.sourceIds, `実質担当者 ${target.candidateId}`);

    const candidate = candidatesById.get(normalizedCandidateId);
    if (candidate?.candidateId !== target.candidateId) {
      throw new TypeError(`実質担当者が現在の候補に含まれていません。対象: ${target.candidateId}`);
    }
    if (lastUnassignedEvent != null && candidate.occurredAt <= lastUnassignedEvent.occurredAt) {
      throw new RangeError(
        `正式assignee解除前の実質担当候補は選択できません。対象: ${target.candidateId}`,
      );
    }
    if (!sourceIdsMatch(candidate.sourceIds, target.sourceIds)) {
      throw new TypeError(
        `実質担当者の根拠source IDが候補と一致しません。対象: ${target.candidateId}`,
      );
    }
    for (const sourceId of target.sourceIds) {
      if (!assessment.sourceIds.includes(sourceId)) {
        throw new TypeError(
          `実質担当者の根拠が外部判定の根拠に含まれていません。対象: ${target.candidateId}`,
        );
      }
    }
  }
}

export function validateInput(input: IssueStateMachineInput): void {
  validateConfidence(input.confidenceThresholds.high, "high confidence閾値");
  validateConfidence(input.confidenceThresholds.medium, "medium confidence閾値");
  if (input.confidenceThresholds.high < input.confidenceThresholds.medium) {
    throw new RangeError("high confidence閾値はmedium confidence閾値以上にしてください");
  }
  if (input.evaluatedAt < input.issue.observedAt) {
    throw new RangeError("判定時刻はIssue観測時刻以後にしてください");
  }

  for (const event of input.issue.events) {
    if (event.itemNodeId !== input.issue.nodeId) {
      throw new TypeError("Issueと正規化イベントのitem node IDが一致しません");
    }
    if (event.occurredAt > input.evaluatedAt) {
      throw new RangeError("正規化イベントの発生時刻は判定時刻以前にしてください");
    }
  }

  const assigneeNodeIds = new Set<string>();
  const assigneeLogins = new Set<string>();
  for (const assignee of input.issue.assignees) {
    if (assignee.login.length === 0) {
      throw new TypeError("Issueのassignee loginは空にできません");
    }
    const normalizedLogin = assignee.login.toLowerCase();
    if (assigneeNodeIds.has(assignee.nodeId) || assigneeLogins.has(normalizedLogin)) {
      throw new TypeError(`Issueのassigneeが重複しています。対象: ${assignee.login}`);
    }
    assigneeNodeIds.add(assignee.nodeId);
    assigneeLogins.add(normalizedLogin);
  }

  const blockerCandidateIds = new Set<string>();
  for (const blocker of input.blockers) {
    if (blocker.candidateId.length === 0) {
      throw new TypeError("blockerのcandidate IDは空にできません");
    }
    if (blockerCandidateIds.has(blocker.candidateId)) {
      throw new TypeError(`blockerが重複しています。対象: ${blocker.candidateId}`);
    }
    blockerCandidateIds.add(blocker.candidateId);
    validateConfidence(blocker.confidence, `blocker ${blocker.candidateId}のconfidence`);
    validateSourceIds(blocker.sourceIds, `blocker ${blocker.candidateId}`);
    if (blocker.becameBlockingAt > input.evaluatedAt) {
      throw new RangeError("blockerになった時刻は判定時刻以前にしてください");
    }
  }

  const candidateSourceIds = new Set<SourceId>();
  const candidates = [...input.explicitRequestCandidates].sort(compareCandidates);
  for (const candidate of candidates) {
    if (candidateSourceIds.has(candidate.sourceId)) {
      throw new TypeError(`明示依頼候補が重複しています。対象: ${candidate.sourceId}`);
    }
    candidateSourceIds.add(candidate.sourceId);
    if (candidate.occurredAt > input.evaluatedAt) {
      throw new RangeError("明示依頼候補の発生時刻は判定時刻以前にしてください");
    }
  }
  validateAssessment(input, candidates);

  const effectiveAssigneeCandidates = [...input.effectiveAssigneeCandidates].sort(
    compareEffectiveAssigneeCandidates,
  );
  const effectiveCandidateIds = new Set<string>();
  for (const candidate of effectiveAssigneeCandidates) {
    if (candidate.candidateId.length === 0) {
      throw new TypeError("実質担当候補のcandidate IDは空にできません");
    }
    const normalizedCandidateId = candidate.candidateId.toLowerCase();
    if (effectiveCandidateIds.has(normalizedCandidateId)) {
      throw new TypeError(`実質担当候補が重複しています。対象: ${candidate.candidateId}`);
    }
    effectiveCandidateIds.add(normalizedCandidateId);
    validateSourceIds(candidate.sourceIds, `実質担当候補 ${candidate.candidateId}`);
    if (candidate.occurredAt > input.evaluatedAt) {
      throw new RangeError("実質担当候補の発生時刻は判定時刻以前にしてください");
    }
  }
  if (effectiveAssigneeCandidates.length > 0 && input.issue.state !== "open") {
    throw new TypeError("openでないIssueには実質担当候補を指定できません");
  }
  if (effectiveAssigneeCandidates.length > 0 && input.issue.assignees.length > 0) {
    throw new TypeError("正式assigneeがあるIssueには実質担当候補を指定できません");
  }
  validateEffectiveAssigneeAssessment(input, effectiveAssigneeCandidates);
  validateMaintainerLoginList(input.maintainers);
}
