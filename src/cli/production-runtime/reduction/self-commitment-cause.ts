import { effectiveElementConfidence, type CodexAnalysisInput } from "../../../codex/index.js";
import {
  createAiAnalysisMigrationElementResultSchema,
  type AiAnalysisElementMigrationResult,
} from "../../../domain/ai-analysis-elements.js";
import type { SourceId, UtcIsoDateTime } from "../../../domain/index.js";
import type { NotificationCause } from "../../../discord/index.js";
import { assertNonNullable } from "../../../util/index.js";
import { codexCommentSources } from "../../codex-input-projection.js";
import type { DeterministicItemAnalysis } from "../../initial-item-analysis.js";

type SelfCommitmentPreviousObservation =
  | Readonly<{
      availability: "not_available";
    }>
  | Readonly<{
      availability: "available";
      observedAt: UtcIsoDateTime;
    }>;

type SelfCommitmentCauseInput = Readonly<{
  analysis: DeterministicItemAnalysis;
  selfCommitmentResult: AiAnalysisElementMigrationResult<"selfCommitment"> | undefined;
  analysisInput: CodexAnalysisInput | undefined;
  previous: SelfCommitmentPreviousObservation;
  evaluatedAt: UtcIsoDateTime;
  highConfidence: number;
}>;

type SelfCommitmentCauseEvidence = Extract<
  NotificationCause,
  Readonly<{ status: "complete" }>
>["evidence"][number];

/** 自己コミットメントの通知原因を確定する。 */
export function createSelfCommitmentCause(input: SelfCommitmentCauseInput): NotificationCause {
  if (
    input.selfCommitmentResult == null ||
    effectiveElementConfidence("selfCommitment", input.selfCommitmentResult) <
      input.highConfidence ||
    input.analysisInput == null ||
    input.previous.availability !== "available"
  ) {
    return Object.freeze({ status: "indeterminate" });
  }
  const result = createAiAnalysisMigrationElementResultSchema("selfCommitment").parse(
    input.selfCommitmentResult,
  );
  if (result.value.length === 0 || result.evidence.length === 0) {
    return Object.freeze({ status: "indeterminate" });
  }
  const candidateSourceIds = new Set(
    input.analysisInput.selfCommitmentCandidates.flatMap((candidate) => candidate.sourceIds),
  );
  const valueSourceIds = new Set<string>();
  const evidenceBySourceId = new Map<SourceId, SelfCommitmentCauseEvidence>();
  for (const commitment of result.value) {
    if (valueSourceIds.has(commitment.sourceId) || !candidateSourceIds.has(commitment.sourceId)) {
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
    const sourceEvidenceEntry = sourceEvidence[0];
    assertNonNullable(sourceEvidenceEntry, "self_commitmentの根拠がありません");
    const source = input.analysisInput.sources.find(
      (candidate) => candidate.id === sourceEvidenceEntry.sourceId,
    );
    if (source?.kind !== "comment") {
      return Object.freeze({ status: "indeterminate" });
    }
    if (source.actorType !== "human") {
      return Object.freeze({ status: "indeterminate" });
    }
    if (source.author.status !== "identified") {
      return Object.freeze({ status: "indeterminate" });
    }
    const sourceAuthor = source.author;
    if (
      !input.analysisInput.selfCommitmentCandidates.some(
        (candidate) =>
          candidate.id === sourceAuthor.candidateId && candidate.sourceIds.includes(source.id),
      )
    ) {
      return Object.freeze({ status: "indeterminate" });
    }
    const comment = codexCommentSources(input.analysis.detail).find(
      (candidate) => candidate.sourceId === source.id,
    );
    if (
      comment?.author.status !== "identified" ||
      comment.author.account.login !== source.author.candidateId ||
      comment.author.account.nodeId !== source.author.nodeId ||
      comment.updatedAt !== comment.createdAt ||
      source.createdAt !== comment.createdAt
    ) {
      return Object.freeze({ status: "indeterminate" });
    }
    const event = input.analysis.item.events.find((candidate) => candidate.sourceId === source.id);
    if (
      event?.kind !== "comment" ||
      event.actor.type !== "human" ||
      event.actor.nodeId !== source.author.nodeId ||
      event.occurredAt !== source.createdAt ||
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
  const causeEvidence = Object.freeze([firstEvidence, ...evidence.slice(1)] satisfies [
    SelfCommitmentCauseEvidence,
    ...SelfCommitmentCauseEvidence[],
  ]);
  return Object.freeze({
    status: "complete",
    responsible: firstEvidence.actor,
    evidence: causeEvidence,
  });
}
