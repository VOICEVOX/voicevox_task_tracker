import { classifyCodexConfidence } from "../../../codex/confidence.js";
import {
  createAiAnalysisMigrationElementResultSchema,
  type AiAnalysisElementMigrationResult,
} from "../../../domain/ai-analysis-elements.js";
import {
  buildSourceId,
  parseSourceId,
  type GitHubNodeId,
  type SourceId,
} from "../../../domain/index.js";
import type { RelationCandidateAssessment, RelationCandidateId } from "../../../graph/index.js";
import { assertNonNullable } from "../../../util/index.js";
import type { GraphAdoptedOutput } from "./graph-reconciliation-adopted-output.js";
import type { GraphNotificationRecommendation } from "./graph-reconciliation-contracts.js";

function candidateId(value: string): RelationCandidateId {
  if (!/^rel:[0-9a-f]{64}$/u.test(value)) {
    throw new TypeError(`関係候補IDの形式が不正です。対象: ${value}`);
  }
  return `rel:${value.slice(4)}`;
}

function sourceIds(values: readonly string[]): readonly [SourceId, ...SourceId[]] {
  const normalized = values.map((value) => {
    const parsed = parseSourceId(value);
    return buildSourceId(parsed.kind, parsed.originalId);
  });
  const [first, ...rest] = normalized;
  assertNonNullable(first, "関係判定のsource IDがありません");
  return Object.freeze([first, ...rest]);
}

/** 採用済みの関係要素から候補ごとの判定を投影する。 */
export function relationAssessmentsFromAdoption(
  nodeId: GitHubNodeId,
  output: GraphAdoptedOutput,
): readonly RelationCandidateAssessment[] {
  const result = output.relations;
  if (result == null) {
    return Object.freeze([]);
  }
  return Object.freeze(
    result.value.map((relation) =>
      Object.freeze({
        candidateId: candidateId(relation.candidateId),
        currentNodeId: nodeId,
        verdict: relation.verdict,
        reasonSummary: relation.reasonSummary,
        sourceIds: sourceIds(relation.sourceIds),
        confidence: Math.min(result.confidence, relation.confidence),
      }),
    ),
  );
}

/** 採用済みの通知要素から提案の優先度を投影する。 */
export function notificationRecommendationFromAdoption(
  output: GraphAdoptedOutput,
  thresholds: Readonly<{ high: number; medium: number }>,
): GraphNotificationRecommendation {
  return notificationRecommendationFromResult(output.notification, thresholds);
}

/** 保持項目の通知要素を採用済みの値から投影する。 */
export function notificationRecommendationFromResult(
  adoptedResult: AiAnalysisElementMigrationResult<"notification"> | undefined,
  thresholds: Readonly<{ high: number; medium: number }>,
): GraphNotificationRecommendation {
  const result =
    adoptedResult == null
      ? undefined
      : createAiAnalysisMigrationElementResultSchema("notification").parse(adoptedResult);
  if (result == null) {
    return Object.freeze({ availability: "not_available" });
  }
  const classification = classifyCodexConfidence(result.confidence, thresholds);
  return Object.freeze({
    availability: "available",
    value: Object.freeze({
      recommended: result.value.recommended,
      reasonCode: result.value.reasonCode,
      reasonSummary: result.value.reasonSummary,
      policy: classification.notificationPolicy,
      highPriorityEligible:
        result.value.recommended && classification.notificationPolicy === "eligible",
    }),
  });
}
