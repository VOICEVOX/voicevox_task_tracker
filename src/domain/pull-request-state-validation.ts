import { assertNonNullable } from "../util/index.js";
import type { PullRequestStateMachineInput } from "./pull-request-state-contracts.js";
import { confidenceSchema } from "./pull-request-state-contracts.js";
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

export function validateInput(input: PullRequestStateMachineInput): void {
  validateConfidence(input.confidenceThresholds.high, "high confidence閾値");
  validateConfidence(input.confidenceThresholds.medium, "medium confidence閾値");
  if (input.confidenceThresholds.high < input.confidenceThresholds.medium) {
    throw new RangeError("high confidence閾値はmedium confidence閾値以上にしてください");
  }
  if (input.evaluatedAt < input.pullRequest.observedAt) {
    throw new RangeError("判定時刻はPull Request観測時刻以後にしてください");
  }
  if (input.pullRequest.headSha !== input.pullRequest.headCommit.sha) {
    throw new TypeError("Pull Requestのhead SHAとhead commit SHAが一致しません");
  }

  for (const event of input.pullRequest.events) {
    if (event.itemNodeId !== input.pullRequest.nodeId) {
      throw new TypeError("Pull Requestと正規化イベントのitem node IDが一致しません");
    }
    if (event.occurredAt > input.evaluatedAt) {
      throw new RangeError("正規化イベントの発生時刻は判定時刻以前にしてください");
    }
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

  if (input.checkFailureAssessment.cause !== "not_assessed") {
    validateConfidence(input.checkFailureAssessment.confidence, "check失敗原因のconfidence");
    validateSourceIds(input.checkFailureAssessment.sourceIds, "check失敗原因の評価");
  }
  validateMaintainerLoginList(input.maintainers);
}

export function compareSourceIds(left: SourceId, right: SourceId): -1 | 0 | 1 {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

export function createSourceIds(
  sourceIds: readonly SourceId[],
): readonly [SourceId, ...SourceId[]] {
  const uniqueSourceIds = [...new Set(sourceIds)].sort(compareSourceIds);
  const [firstSourceId, ...remainingSourceIds] = uniqueSourceIds;
  assertNonNullable(firstSourceId, "source IDが1件もありません");
  return Object.freeze([firstSourceId, ...remainingSourceIds]);
}
