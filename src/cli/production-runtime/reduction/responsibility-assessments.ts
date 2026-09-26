import {
  buildSourceId,
  parseSourceId,
  type IssueEffectiveAssigneeAssessment,
  type IssueEffectiveAssigneeTarget,
  type IssueExplicitRequestAssessment,
  type IssueExplicitRequestTarget,
  type SourceId,
  type UtcIsoDateTime,
} from "../../../domain/index.js";
import type { FreshObservedGitHubItem, GitHubItemDetail } from "../../../github/index.js";
import { assertNonNullable } from "../../../util/index.js";
import type { DeterministicItemAnalysis } from "../../initial-item-analysis.js";
import {
  createIssueRequestCandidates,
  createMentionedWaitingOnCandidates,
} from "../../issue-responsibility-candidates.js";
import type { RuntimeConfiguration } from "../contracts.js";
import { nonEmptySourceIds } from "../source-ids.js";
import type { ConsumerCodexElementOutput } from "./consumer-output.js";

function sourceIdSetsMatch(left: readonly SourceId[], right: readonly SourceId[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  const leftSourceIds = new Set(left);
  const rightSourceIds = new Set(right);
  return (
    leftSourceIds.size === left.length &&
    rightSourceIds.size === right.length &&
    leftSourceIds.size === rightSourceIds.size &&
    [...leftSourceIds].every((id) => rightSourceIds.has(id))
  );
}

function outputSourceIds(
  sourceIds: readonly string[],
  context: string,
): readonly [SourceId, ...SourceId[]] {
  return nonEmptySourceIds(
    sourceIds.map((sourceId) => {
      const parts = parseSourceId(sourceId);
      return buildSourceId(parts.kind, parts.originalId);
    }),
    context,
  );
}

export function createEffectiveAssigneeAssessment(
  configuration: RuntimeConfiguration,
  evaluatedAt: UtcIsoDateTime,
  analysis: DeterministicItemAnalysis,
  output: ConsumerCodexElementOutput | undefined,
): IssueEffectiveAssigneeAssessment {
  if (
    analysis.item.type !== "issue" ||
    analysis.item.state !== "open" ||
    analysis.item.assignees.length !== 0 ||
    analysis.effectiveAssigneeCandidates.length === 0 ||
    output?.status == null ||
    output.waitingOn == null ||
    output.status.value !== "waiting_for_work" ||
    output.waitingOn.value.length === 0 ||
    output.status.confidence < configuration.config.ai.confidence.high ||
    output.waitingOn.confidence < configuration.config.ai.confidence.high
  ) {
    return Object.freeze({
      status: "not_assessed",
    });
  }

  const candidatesById = new Map(
    analysis.effectiveAssigneeCandidates.map((context) => [
      context.candidate.candidateId.toLowerCase(),
      context.candidate,
    ]),
  );
  const targets: IssueEffectiveAssigneeTarget[] = [];
  const targetIds = new Set<string>();
  for (const waitingOn of output.waitingOn.value) {
    if (
      waitingOn.kind !== "user" ||
      waitingOn.role !== "assignee" ||
      waitingOn.confidence < configuration.config.ai.confidence.high
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
    if (candidate == null) {
      return Object.freeze({
        status: "not_assessed",
      });
    }
    if (candidate.candidateId !== waitingOn.candidateId) {
      return Object.freeze({
        status: "not_assessed",
      });
    }
    const sourceIds = outputSourceIds(
      waitingOn.sourceIds,
      `実質担当判定 ${waitingOn.candidateId}のsource ID`,
    );
    if (!sourceIdSetsMatch(sourceIds, candidate.sourceIds)) {
      return Object.freeze({
        status: "not_assessed",
      });
    }
    targets.push(
      Object.freeze({
        kind: "user",
        candidateId: waitingOn.candidateId,
        sourceIds,
        confidence: waitingOn.confidence,
      }),
    );
  }
  const selectedCandidateSourceIds = nonEmptySourceIds(
    targets.flatMap((target) => target.sourceIds),
    "実質担当判定対象",
  );
  const candidateSourceIds = nonEmptySourceIds(
    analysis.effectiveAssigneeCandidates.flatMap(({ candidate }) => candidate.sourceIds),
    "実質担当候補",
  );
  const selectedCandidates = targets.map((target) => {
    const candidate = candidatesById.get(target.candidateId.toLowerCase());
    assertNonNullable(candidate, `実質担当候補を取得できません。対象: ${target.candidateId}`);
    return candidate;
  });
  const firstCandidate = selectedCandidates[0];
  assertNonNullable(firstCandidate, "実質担当判定の候補がありません");
  const occurredAt = selectedCandidates.reduce(
    (latest, candidate) => (latest < candidate.occurredAt ? candidate.occurredAt : latest),
    firstCandidate.occurredAt,
  );
  if (occurredAt > evaluatedAt) {
    throw new RangeError("実質担当判定の根拠時刻は判定時刻以前にしてください");
  }
  const confidence = Math.min(
    output.status.confidence,
    output.waitingOn.confidence,
    ...targets.map((target) => target.confidence),
  );
  if (confidence < configuration.config.ai.confidence.high) {
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

export function explicitRequestAssessment(
  item: Extract<FreshObservedGitHubItem, Readonly<{ type: "issue" }>>,
  detail: Extract<GitHubItemDetail, Readonly<{ type: "issue" }>>,
  output: ConsumerCodexElementOutput | undefined,
): IssueExplicitRequestAssessment {
  const candidates = createIssueRequestCandidates(item, detail);
  const waitingOnResult = output?.waitingOn;
  if (waitingOnResult == null || candidates.length === 0) {
    return Object.freeze({
      status: "not_assessed",
    });
  }
  const candidateSourceIds = nonEmptySourceIds(
    candidates.map((candidate) => candidate.sourceId),
    "明示依頼候補",
  );
  const mentionedCandidates = createMentionedWaitingOnCandidates(detail);
  const mentionedByKey = new Map(
    mentionedCandidates.map((candidate) => [
      `${candidate.kind}:${candidate.id.toLowerCase()}`,
      candidate,
    ]),
  );
  const targets: IssueExplicitRequestTarget[] = waitingOnResult.value.flatMap((waitingOn) => {
    const sourceIds = outputSourceIds(
      waitingOn.sourceIds,
      `明示依頼 ${waitingOn.candidateId}のsource ID`,
    );
    if (waitingOn.kind !== "user" && waitingOn.kind !== "team") {
      return [];
    }
    const mentioned = mentionedByKey.get(
      `${waitingOn.kind}:${waitingOn.candidateId.toLowerCase()}`,
    );
    if (
      mentioned == null ||
      !sourceIds.some((sourceId) => mentioned.sourceIds.includes(sourceId))
    ) {
      return [];
    }
    const role =
      waitingOn.role === "dependency" ||
      waitingOn.role === "merge_decider" ||
      waitingOn.role === "ci"
        ? "unknown"
        : waitingOn.role;
    return [
      Object.freeze({
        kind: waitingOn.kind,
        candidateId: waitingOn.candidateId,
        role,
        sourceIds,
        confidence: Math.min(waitingOnResult.confidence, waitingOn.confidence),
      }),
    ];
  });
  if (targets.length === 0) {
    return Object.freeze({
      status: "assessed",
      candidateSourceIds,
      verdict: "no_unanswered_request",
      confidence: waitingOnResult.confidence,
      sourceIds: candidateSourceIds,
    });
  }
  const requestCandidate = [...candidates]
    .filter((candidate) => targets.some((target) => target.sourceIds.includes(candidate.sourceId)))
    .sort((left, right) => {
      if (left.occurredAt !== right.occurredAt) {
        return left.occurredAt > right.occurredAt ? -1 : 1;
      }
      return left.sourceId.localeCompare(right.sourceId);
    })[0];
  assertNonNullable(requestCandidate, "未回答の明示依頼に対応する候補がありません");
  const latestTargets = targets.filter((target) =>
    target.sourceIds.includes(requestCandidate.sourceId),
  );
  const firstTarget = latestTargets[0];
  assertNonNullable(firstTarget, "最新の明示依頼先がありません");
  return Object.freeze({
    status: "assessed",
    candidateSourceIds,
    verdict: "unanswered_request",
    requestSourceId: requestCandidate.sourceId,
    targets: Object.freeze([firstTarget, ...latestTargets.slice(1)] satisfies [
      IssueExplicitRequestTarget,
      ...IssueExplicitRequestTarget[],
    ]),
    confidence: Math.min(
      waitingOnResult.confidence,
      ...latestTargets.map((target) => target.confidence),
    ),
    sourceIds: nonEmptySourceIds(
      latestTargets.flatMap((target) => target.sourceIds),
      "未回答の明示依頼判定",
    ),
  });
}
