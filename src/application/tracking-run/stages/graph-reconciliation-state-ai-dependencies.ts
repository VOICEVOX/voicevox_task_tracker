import { serializeCanonicalJson } from "../../../canonical-json/value.js";
import type { GraphReducedDecision } from "./graph-reconciliation-contracts.js";
import type { GenericAiItemAdoption } from "./generic-ai-adoption-contracts.js";
import { aiAnalysisElementApplicationUsesAiValue } from "../../../domain/ai-analysis-elements.js";
import type { AiAnalysisDependency } from "../../../domain/ai-analysis-dependencies.js";
import type {
  GitHubNodeId,
  IssueStateDecision,
  PullRequestStateDecision,
  StalenessResult,
  TrackedItemAiAnalysisApplications,
  UtcIsoDateTime,
} from "../../../domain/index.js";
import type { PreviousTrackedItem } from "../contracts/previous-state.js";
import { revalidatedHistoricalAiDependency } from "./graph-reconciliation-ai-history.js";
import {
  combineSelectedAiDependencies,
  notDependentAiDependency,
  preferIndependentAiDependency,
} from "./graph-reconciliation-ai-selection.js";
import type { GraphBlockerValueAiDependencies } from "./graph-reconciliation-contracts.js";

const STATE_AI_ANALYSIS_ELEMENTS: readonly ["status", "waitingOn", "nextAction"] = Object.freeze([
  "status",
  "waitingOn",
  "nextAction",
]);

type AdoptedElements = GenericAiItemAdoption["elements"];

/** state値のAI依存を合成する。 */
export function stateAiDependencies(
  adopted: AdoptedElements,
  applications: TrackedItemAiAnalysisApplications,
  blockerDependencies: GraphBlockerValueAiDependencies,
): Readonly<{
  status: AiAnalysisDependency;
  waitingOn: AiAnalysisDependency;
  primaryWaitingOn: AiAnalysisDependency;
  nextAction: AiAnalysisDependency;
}> {
  const stateApplicationDependency = (
    element: "status" | "waitingOn" | "nextAction",
  ): AiAnalysisDependency => adopted[element].aiDependency;
  const stateValueDependency = (
    element: "status" | "waitingOn" | "nextAction",
    blockerDependency: AiAnalysisDependency,
  ): AiAnalysisDependency => {
    const application = applications[element];
    const dependency = stateApplicationDependency(element);
    if (aiAnalysisElementApplicationUsesAiValue(application)) {
      return dependency;
    }
    if (
      blockerDependencies.stateSupport === "authoritative_blocker" &&
      (element === "status" || element === "nextAction")
    ) {
      return blockerDependency;
    }
    return combineSelectedAiDependencies([dependency, blockerDependency]);
  };
  const waitingOn = stateValueDependency("waitingOn", blockerDependencies.waitingOn);
  const primaryWaitingOn = (() => {
    if (aiAnalysisElementApplicationUsesAiValue(applications.waitingOn)) {
      return stateApplicationDependency("waitingOn");
    }
    if (blockerDependencies.stateSupport === "authoritative_blocker") {
      return blockerDependencies.primaryWaitingOn;
    }
    return combineSelectedAiDependencies([
      stateApplicationDependency("waitingOn"),
      blockerDependencies.primaryWaitingOn,
    ]);
  })();
  return Object.freeze({
    status: stateValueDependency("status", blockerDependencies.status),
    waitingOn,
    primaryWaitingOn,
    nextAction: stateValueDependency("nextAction", blockerDependencies.nextAction),
  });
}

/** confidenceのAI依存を合成する。 */
export function confidenceAiDependency(
  adopted: AdoptedElements,
  applications: TrackedItemAiAnalysisApplications,
  blockerDependencies: GraphBlockerValueAiDependencies,
): AiAnalysisDependency {
  if (blockerDependencies.stateSupport === "authoritative_blocker") {
    return blockerDependencies.confidence;
  }
  const dependencies: AiAnalysisDependency[] = [];
  const allStateValuesUseAi = STATE_AI_ANALYSIS_ELEMENTS.every((element) =>
    aiAnalysisElementApplicationUsesAiValue(applications[element]),
  );
  if (!allStateValuesUseAi) {
    dependencies.push(blockerDependencies.confidence);
  }
  for (const element of STATE_AI_ANALYSIS_ELEMENTS) {
    if (
      !aiAnalysisElementApplicationUsesAiValue(applications[element]) &&
      applications[element].status !== "unavailable"
    ) {
      continue;
    }
    dependencies.push(adopted[element].aiDependency);
  }
  return combineSelectedAiDependencies(dependencies);
}

/** evidenceのAI依存を合成する。 */
export function evidenceAiDependency(
  adopted: AdoptedElements,
  decision: GraphReducedDecision,
  deterministicDecision: IssueStateDecision | PullRequestStateDecision,
  applications: TrackedItemAiAnalysisApplications,
  blockerDependencies: GraphBlockerValueAiDependencies,
): AiAnalysisDependency {
  if (blockerDependencies.stateSupport === "authoritative_blocker") {
    return blockerDependencies.evidence;
  }
  const dependencies: AiAnalysisDependency[] = [];
  for (const element of STATE_AI_ANALYSIS_ELEMENTS) {
    if (
      aiAnalysisElementApplicationUsesAiValue(applications[element]) ||
      applications[element].status === "unavailable"
    ) {
      dependencies.push(adopted[element].aiDependency);
    }
  }
  const deterministicEvidence = new Set(
    deterministicDecision.evidence.map((evidence) => serializeCanonicalJson(evidence)),
  );
  if (
    decision.evidence.some((evidence) =>
      deterministicEvidence.has(serializeCanonicalJson(evidence)),
    )
  ) {
    dependencies.push(blockerDependencies.evidence);
  }
  return combineSelectedAiDependencies(dependencies);
}

/** uncertaintiesのAI依存を合成する。 */
export function uncertaintiesAiDependency(
  adopted: AdoptedElements,
  blockerDependency: AiAnalysisDependency,
): AiAnalysisDependency {
  return combineSelectedAiDependencies([
    ...STATE_AI_ANALYSIS_ELEMENTS.map((element) => adopted[element].aiDependency),
    blockerDependency,
  ]);
}

/** 最終進捗日時のAI依存を合成する。 */
export function lastProgressAiDependency(
  nodeId: GitHubNodeId,
  createdAt: UtcIsoDateTime,
  progressDependency: AiAnalysisDependency,
  applications: TrackedItemAiAnalysisApplications,
  staleness: StalenessResult,
  previousItem: PreviousTrackedItem | undefined,
): AiAnalysisDependency {
  const deterministicAtLatest = staleness.meaningfulProgress.some(
    (progress) =>
      progress.occurredAt === staleness.lastProgressAt &&
      progress.determination === "deterministic" &&
      (progress.kind !== "dependency_resolved" || progress.aiDependency.status === "not_dependent"),
  );
  const currentProgressDependency = staleness.meaningfulProgress.some(
    (progress) =>
      progress.occurredAt === staleness.lastProgressAt && progress.determination === "ai",
  )
    ? progressDependency
    : undefined;
  const previousProgressDependency =
    previousItem?.lastProgressAt === staleness.lastProgressAt
      ? revalidatedHistoricalAiDependency(
          nodeId,
          applications,
          previousItem.aiDependencies.lastProgressAt,
        )
      : undefined;
  const selectedDependencies = [
    ...(createdAt === staleness.lastProgressAt ? [notDependentAiDependency()] : []),
    ...staleness.meaningfulProgress.flatMap((progress) => {
      if (
        progress.occurredAt !== staleness.lastProgressAt ||
        progress.kind !== "dependency_resolved"
      ) {
        return [];
      }
      return [progress.aiDependency];
    }),
    ...(deterministicAtLatest ? [notDependentAiDependency()] : []),
    ...(currentProgressDependency == null ? [] : [currentProgressDependency]),
    ...(previousProgressDependency == null ? [] : [previousProgressDependency]),
  ];
  const selectedDependency = preferIndependentAiDependency(
    selectedDependencies.length === 0 ? [notDependentAiDependency()] : selectedDependencies,
  );
  const hasNewerNaturalLanguageCandidate = staleness.naturalLanguageProgressCandidates.some(
    (candidate) => candidate.occurredAt > staleness.lastProgressAt,
  );
  return combineSelectedAiDependencies([
    selectedDependency,
    ...(hasNewerNaturalLanguageCandidate ? [progressDependency] : []),
  ]);
}
