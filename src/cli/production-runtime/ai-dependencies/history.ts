import { hashCanonicalJson } from "../../../canonical-json/index.js";
import {
  combineAiAnalysisDependencies,
  normalizeAiAnalysisDependency,
  reconcileRetainedAiAnalysisDependency,
  type AiAnalysisDependency,
} from "../../../domain/ai-analysis-dependencies.js";
import type { GitHubNodeId, TrackedItemAiAnalysisApplications } from "../../../domain/index.js";
import { unrecordedAiDependency } from "./selection.js";

/** 過去のAI依存に残す未確定理由を取り出す。 */
export function historicalAiDependencyHistory(
  dependency: AiAnalysisDependency,
): readonly AiAnalysisDependency[] {
  const reasons =
    dependency.status === "unknown"
      ? dependency.reasons.filter((reason) => reason === "migration" || reason === "not_recorded")
      : [];
  const [firstReason, ...remainingReasons] = reasons;
  return firstReason == null
    ? []
    : [
        normalizeAiAnalysisDependency({
          status: "unknown",
          reasons: [firstReason, ...remainingReasons],
        }),
      ];
}

/** 過去のAI依存が再検証できない場合の依存を作る。 */
export function historicalAiDependencyFallback(
  dependency: AiAnalysisDependency,
): AiAnalysisDependency {
  const history = historicalAiDependencyHistory(dependency);
  return history.length === 0 ? unrecordedAiDependency() : combineAiAnalysisDependencies(history);
}

/** 期待する依存に対して過去のAI依存を再検証する。 */
export function revalidatedHistoricalAiDependencyForExpected(
  dependency: AiAnalysisDependency,
  expectedDependency: AiAnalysisDependency,
): AiAnalysisDependency {
  const normalizedDependency = normalizeAiAnalysisDependency(dependency);
  if (normalizedDependency.status === "not_dependent") {
    return normalizedDependency;
  }
  if (normalizedDependency.producers == null) {
    return historicalAiDependencyFallback(normalizedDependency);
  }
  if (
    expectedDependency.status === "not_dependent" ||
    expectedDependency.producers == null ||
    hashCanonicalJson(normalizedDependency.producers) !==
      hashCanonicalJson(expectedDependency.producers)
  ) {
    return combineAiAnalysisDependencies([
      ...historicalAiDependencyHistory(normalizedDependency),
      unrecordedAiDependency(),
    ]);
  }
  return combineAiAnalysisDependencies([
    expectedDependency,
    ...historicalAiDependencyHistory(normalizedDependency),
  ]);
}

/** 現在の適用結果に対して過去のAI依存を再検証する。 */
export function revalidatedHistoricalAiDependency(
  nodeId: GitHubNodeId,
  applications: TrackedItemAiAnalysisApplications,
  dependency: AiAnalysisDependency,
): AiAnalysisDependency {
  return reconcileRetainedAiAnalysisDependency(dependency, {
    applicationsByNodeId: new Map([[nodeId, applications]]),
    relationsById: new Map(),
    candidatesById: new Map(),
  });
}
