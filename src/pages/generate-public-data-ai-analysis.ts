import type { AiAnalysisDependency } from "../domain/index.js";
import type { StateSnapshot } from "../persistence/index.js";
import { UnreachableError } from "../util/index.js";
import type { PublicItemSummaryDto } from "./public-dto-contracts.js";

type PublicAiAnalysis = PublicItemSummaryDto["aiAnalysis"];
type PublicUnverifiedValue = PublicAiAnalysis["unverifiedValues"][number];

/** AI依存が未検証かを判定する。 */
export function isUnverifiedAiDependency(dependency: AiAnalysisDependency): boolean {
  switch (dependency.status) {
    case "not_dependent":
    case "current":
      return false;
    case "unverified":
    case "unknown":
      return true;
    default:
      throw new UnreachableError(dependency);
  }
}

/** AI依存に未検証があるかを判定する。 */
export function hasUnverifiedAiDependency(dependencies: readonly AiAnalysisDependency[]): boolean {
  let unverified = false;
  for (const dependency of dependencies) {
    if (isUnverifiedAiDependency(dependency)) {
      unverified = true;
    }
  }
  return unverified;
}

export function createPublicAiAnalysis(
  item: StateSnapshot["items"][number],
  effectiveBlockerNodeIds: readonly string[],
  retainedOnlyBlockerNodeIds: readonly string[],
): PublicAiAnalysis {
  const applications = [
    item.aiAnalysis.applications.status,
    item.aiAnalysis.applications.waitingOn,
    item.aiAnalysis.applications.nextAction,
    item.aiAnalysis.applications.relations,
    item.aiAnalysis.applications.progress,
    item.aiAnalysis.applications.importance,
    item.aiAnalysis.applications.deadline,
    item.aiAnalysis.applications.notification,
    item.aiAnalysis.applications.selfCommitment,
  ];
  const notRequiredApplicationCount = applications.filter(
    (application) => application.status === "not_required",
  ).length;
  let omission: PublicAiAnalysis["omission"];
  if (notRequiredApplicationCount === 0) {
    omission = "none";
  } else if (notRequiredApplicationCount === applications.length) {
    omission = "all";
  } else {
    omission = "partial";
  }

  const unverifiedValues: PublicUnverifiedValue[] = [];
  const dependencies = item.aiDependencies;
  const primaryWaitingOn = item.waitingOn[0];
  const primaryBlockerRetainedOnly =
    item.status === "waiting_for_unblock" &&
    primaryWaitingOn?.kind === "item" &&
    primaryWaitingOn.role === "dependency" &&
    retainedOnlyBlockerNodeIds.includes(primaryWaitingOn.candidateId);
  if (
    hasUnverifiedAiDependency([dependencies.status]) ||
    (retainedOnlyBlockerNodeIds.length > 0 && effectiveBlockerNodeIds.length === 0)
  ) {
    unverifiedValues.push("status");
  }
  if (
    hasUnverifiedAiDependency([dependencies.waitingOn]) ||
    retainedOnlyBlockerNodeIds.length > 0
  ) {
    unverifiedValues.push("waitingOn");
  }
  if (hasUnverifiedAiDependency([dependencies.primaryWaitingOn]) || primaryBlockerRetainedOnly) {
    unverifiedValues.push("primaryWaitingOn");
  }
  if (hasUnverifiedAiDependency([dependencies.nextAction]) || primaryBlockerRetainedOnly) {
    unverifiedValues.push("nextAction");
  }
  if (hasUnverifiedAiDependency([dependencies.confidence])) {
    unverifiedValues.push("confidence");
  }
  if (hasUnverifiedAiDependency([dependencies.evidence])) {
    unverifiedValues.push("evidence");
  }
  if (hasUnverifiedAiDependency([dependencies.uncertainties])) {
    unverifiedValues.push("uncertainties");
  }
  if (hasUnverifiedAiDependency([dependencies.deadline, dependencies.deadlineLevel])) {
    unverifiedValues.push("deadline");
  }
  if (hasUnverifiedAiDependency([dependencies.stallSince])) {
    unverifiedValues.push("staleness");
  }
  if (hasUnverifiedAiDependency([dependencies.downstreamImpact])) {
    unverifiedValues.push("downstreamImpact");
  }
  if (hasUnverifiedAiDependency([dependencies.importance])) {
    unverifiedValues.push("importance");
  }
  if (hasUnverifiedAiDependency([dependencies.attention])) {
    unverifiedValues.push("attention");
  }
  if (hasUnverifiedAiDependency([dependencies.blockers])) {
    unverifiedValues.push("blockers");
  }
  if (hasUnverifiedAiDependency([dependencies.relationSet])) {
    unverifiedValues.push("relations");
  }
  return {
    runStatus: item.aiAnalysis.status,
    omission,
    unverifiedValues,
  };
}
