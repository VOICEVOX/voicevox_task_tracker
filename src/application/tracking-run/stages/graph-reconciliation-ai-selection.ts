import type { AiAnalysisElement } from "../../../domain/ai-analysis-elements.js";
import {
  aiAnalysisDependencyForApplication,
  combineAiAnalysisDependencies,
  type AiAnalysisDependency,
} from "../../../domain/ai-analysis-dependencies.js";
import type { GitHubNodeId, TrackedItemAiAnalysisApplications } from "../../../domain/index.js";
import { assertNonNullable, UnreachableError } from "../../../util/index.js";

/** AIに依存しない状態を作る。 */
export function notDependentAiDependency(): AiAnalysisDependency {
  return Object.freeze({ status: "not_dependent" });
}

/** 記録がないAI依存を作る。 */
export function unrecordedAiDependency(): AiAnalysisDependency {
  return Object.freeze({
    status: "unknown",
    reasons: Object.freeze(["not_recorded"]),
  } satisfies AiAnalysisDependency);
}

/** 要素へのAI適用結果から依存を得る。 */
export function aiDependencyForElementApplication(
  nodeId: GitHubNodeId,
  applications: TrackedItemAiAnalysisApplications,
  element: AiAnalysisElement,
): AiAnalysisDependency {
  const application = applications[element];
  assertNonNullable(application, `AI適用元がありません。対象: ${nodeId} element: ${element}`);
  return aiAnalysisDependencyForApplication(nodeId, element, application);
}

/** 選択したAI依存を結合する。 */
export function combineSelectedAiDependencies(
  dependencies: readonly AiAnalysisDependency[],
): AiAnalysisDependency {
  if (dependencies.length === 0) {
    return notDependentAiDependency();
  }
  return combineAiAnalysisDependencies(dependencies);
}

/** AI依存の独立性に応じた優先度を返す。 */
export function aiDependencyIndependencePriority(dependency: AiAnalysisDependency): number {
  switch (dependency.status) {
    case "not_dependent":
      return 0;
    case "current":
      return 1;
    case "unverified":
      return 2;
    case "unknown":
      return 3;
    default:
      throw new UnreachableError(dependency);
  }
}

/** 最も独立したAI依存を選ぶ。 */
export function preferIndependentAiDependency(
  dependencies: readonly AiAnalysisDependency[],
): AiAnalysisDependency {
  if (dependencies.length === 0) {
    return notDependentAiDependency();
  }
  const preferredPriority = Math.min(...dependencies.map(aiDependencyIndependencePriority));
  const preferred = dependencies.filter(
    (dependency) => aiDependencyIndependencePriority(dependency) === preferredPriority,
  );
  return combineSelectedAiDependencies(preferred);
}

/** 指定件数の優先AI依存を選ぶ。 */
export function preferredAiDependencies(
  dependencies: readonly AiAnalysisDependency[],
  count: number,
): readonly AiAnalysisDependency[] {
  if (count < 0 || !Number.isInteger(count)) {
    throw new TypeError("選択するAI依存数は0以上の整数でなければなりません");
  }
  if (count > dependencies.length) {
    throw new TypeError("選択するAI依存数が候補数を超えています");
  }
  return Object.freeze(
    dependencies
      .map((dependency, index) => Object.freeze({ dependency, index }))
      .sort((left, right) => {
        const priorityOrder =
          aiDependencyIndependencePriority(left.dependency) -
          aiDependencyIndependencePriority(right.dependency);
        return priorityOrder === 0 ? left.index - right.index : priorityOrder;
      })
      .slice(0, count)
      .map((entry) => entry.dependency),
  );
}
