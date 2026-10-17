import type { GraphReducedDecision } from "./graph-reconciliation-contracts.js";
import type {
  AiAnalysisDependency,
  TrackedItemAiDependencies,
} from "../../../domain/ai-analysis-dependencies.js";
import type { StalenessResult } from "../../../domain/index.js";
import { combineSelectedAiDependencies } from "./graph-reconciliation-ai-selection.js";
import { stateDependenciesForWaitClass } from "./graph-reconciliation-stall-time.js";

/** 停滞重大度に対するAI依存を得る。 */
export function severityAiDependency(
  decision: Readonly<
    Pick<GraphReducedDecision, "status" | "waitingOn" | "confidence" | "evidence">
  >,
  staleness: Readonly<Pick<StalenessResult, "waitClass">>,
  criticalRequested: boolean,
  itemDependencies: TrackedItemAiDependencies,
): AiAnalysisDependency {
  if (staleness.waitClass === "notApplicable" || staleness.waitClass === "blockedParent") {
    return itemDependencies.status;
  }
  const stateDependencies = stateDependenciesForWaitClass(
    decision,
    staleness.waitClass,
    itemDependencies,
  );
  const dependencies = [itemDependencies.stallSince, ...stateDependencies];
  if (criticalRequested) {
    dependencies.push(itemDependencies.confidence);
  }
  return combineSelectedAiDependencies(dependencies);
}

/** 重大度criticalが要求されたか判定する。 */
export function criticalSeverityWasRequested(reason: StalenessResult["severityReason"]): boolean {
  if (reason.kind !== "elapsed_threshold") {
    return false;
  }
  return (
    reason.baseSeverity === "critical" ||
    (reason.baseSeverity === "urgent" && reason.labelLiftRequested === 1)
  );
}
