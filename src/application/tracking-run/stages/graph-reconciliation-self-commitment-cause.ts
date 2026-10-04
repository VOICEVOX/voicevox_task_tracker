import { effectiveElementConfidence } from "../../../codex/analysis-element-confidence.js";
import type { AiAnalysisElementMigrationResult } from "../../../domain/ai-analysis-elements.js";
import type { SourceId, UtcIsoDateTime } from "../../../domain/index.js";
import { assertNonNullable } from "../../../util/index.js";
import type { DeterministicItemAnalysis } from "./deterministic-item.js";
import type { GraphSelfCommitmentCause } from "./graph-reconciliation-contracts.js";

type SelfCommitmentPreviousObservation =
  | Readonly<{ availability: "not_available" }>
  | Readonly<{ availability: "available"; observedAt: UtcIsoDateTime }>;

type SelfCommitmentCauseInput = Readonly<{
  analysis: DeterministicItemAnalysis;
  selfCommitmentResult: AiAnalysisElementMigrationResult<"selfCommitment"> | undefined;
  previous: SelfCommitmentPreviousObservation;
  evaluatedAt: UtcIsoDateTime;
  highConfidence: number;
}>;

type SelfCommitmentCauseEvidence = Extract<
  GraphSelfCommitmentCause,
  { status: "complete" }
>["evidence"][number];

function commentSources(
  detail: DeterministicItemAnalysis["detail"],
): readonly DeterministicItemAnalysis["detail"]["comments"][number][] {
  if (detail.type === "issue") {
    return detail.comments;
  }
  return Object.freeze([
    ...detail.comments,
    ...detail.reviewThreads.flatMap((thread) => thread.comments),
  ]);
}

/** 自己コミットメントの原因を採用値と現在のGitHub観測から確定する。 */
export function createSelfCommitmentCause(
  input: SelfCommitmentCauseInput,
): GraphSelfCommitmentCause {
  const result = input.selfCommitmentResult;
  if (
    result == null ||
    effectiveElementConfidence("selfCommitment", result) < input.highConfidence ||
    input.previous.availability !== "available" ||
    result.value.length === 0 ||
    result.evidence.length === 0
  ) {
    return Object.freeze({ status: "indeterminate" });
  }
  const comments = commentSources(input.analysis.detail);
  const valueSourceIds = new Set<string>();
  const evidenceBySourceId = new Map<SourceId, SelfCommitmentCauseEvidence>();
  for (const commitment of result.value) {
    if (valueSourceIds.has(commitment.sourceId)) {
      return Object.freeze({ status: "indeterminate" });
    }
    valueSourceIds.add(commitment.sourceId);
    const sourceEvidence = result.evidence.filter(
      (evidence) =>
        evidence.sourceId === commitment.sourceId && evidence.supports === "self_commitment",
    );
    if (sourceEvidence.length !== 1) {
      return Object.freeze({ status: "indeterminate" });
    }
    const comment = comments.find((candidate) => candidate.sourceId === commitment.sourceId);
    if (comment?.author.status !== "identified" || comment.updatedAt !== comment.createdAt) {
      return Object.freeze({ status: "indeterminate" });
    }
    const event = input.analysis.item.events.find(
      (candidate) => candidate.sourceId === comment.sourceId,
    );
    if (
      event?.kind !== "comment" ||
      event.actor.type !== "human" ||
      event.actor.nodeId !== comment.author.account.nodeId ||
      event.occurredAt !== comment.createdAt ||
      event.occurredAt <= input.previous.observedAt ||
      event.occurredAt > input.evaluatedAt
    ) {
      return Object.freeze({ status: "indeterminate" });
    }
    const actor: SelfCommitmentCauseEvidence["actor"] = Object.freeze({
      type: "human",
      nodeId: event.actor.nodeId,
      login: comment.author.account.login,
    });
    evidenceBySourceId.set(
      event.sourceId,
      Object.freeze({
        sourceId: event.sourceId,
        occurredAt: event.occurredAt,
        actor,
      }),
    );
  }
  if (evidenceBySourceId.size !== result.evidence.length) {
    return Object.freeze({ status: "indeterminate" });
  }
  const evidence = [...evidenceBySourceId.values()].sort((left, right) => {
    if (left.occurredAt < right.occurredAt) {
      return -1;
    }
    if (left.occurredAt > right.occurredAt) {
      return 1;
    }
    return left.sourceId.localeCompare(right.sourceId);
  });
  const firstEvidence = evidence[0];
  assertNonNullable(
    firstEvidence,
    `self_commitmentの根拠がありません。対象: ${input.analysis.item.nodeId}`,
  );
  if (evidence.some((candidate) => candidate.actor.nodeId !== firstEvidence.actor.nodeId)) {
    return Object.freeze({ status: "indeterminate" });
  }
  return Object.freeze({
    status: "complete",
    responsible: firstEvidence.actor,
    evidence: Object.freeze([firstEvidence, ...evidence.slice(1)] satisfies [
      SelfCommitmentCauseEvidence,
      ...SelfCommitmentCauseEvidence[],
    ]),
  });
}
