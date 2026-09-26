import { serializeCanonicalJson } from "../../../canonical-json/index.js";
import type { ReducedCodexDecision } from "../../../codex/index.js";
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
import type { SnapshotTrackedItem } from "../../../persistence/index.js";
import { revalidatedHistoricalAiDependency } from "../ai-dependencies/history.js";
import {
  aiDependencyForElementApplication,
  combineSelectedAiDependencies,
  notDependentAiDependency,
  preferIndependentAiDependency,
} from "../ai-dependencies/selection.js";
import type { BlockerValueAiDependencies } from "../contracts.js";

const STATE_AI_ANALYSIS_ELEMENTS: readonly ["status", "waitingOn", "nextAction"] = Object.freeze([
  "status",
  "waitingOn",
  "nextAction",
]);

/** state値のAI依存を合成する。 */
export function stateAiDependencies(
  nodeId: GitHubNodeId,
  applications: TrackedItemAiAnalysisApplications,
  blockerDependencies: BlockerValueAiDependencies,
): Readonly<{
  status: AiAnalysisDependency;
  waitingOn: AiAnalysisDependency;
  primaryWaitingOn: AiAnalysisDependency;
  nextAction: AiAnalysisDependency;
}> {
  const stateApplicationDependency = (
    element: "status" | "waitingOn" | "nextAction",
  ): AiAnalysisDependency => aiDependencyForElementApplication(nodeId, applications, element);
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
  nodeId: GitHubNodeId,
  applications: TrackedItemAiAnalysisApplications,
  blockerDependencies: BlockerValueAiDependencies,
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
    dependencies.push(aiDependencyForElementApplication(nodeId, applications, element));
  }
  return combineSelectedAiDependencies(dependencies);
}

/** evidenceのAI依存を合成する。 */
export function evidenceAiDependency(
  nodeId: GitHubNodeId,
  decision: ReducedCodexDecision,
  deterministicDecision: IssueStateDecision | PullRequestStateDecision,
  applications: TrackedItemAiAnalysisApplications,
  blockerDependencies: BlockerValueAiDependencies,
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
      dependencies.push(aiDependencyForElementApplication(nodeId, applications, element));
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
  nodeId: GitHubNodeId,
  applications: TrackedItemAiAnalysisApplications,
  blockerDependency: AiAnalysisDependency,
): AiAnalysisDependency {
  return combineSelectedAiDependencies([
    ...STATE_AI_ANALYSIS_ELEMENTS.map((element) =>
      aiDependencyForElementApplication(nodeId, applications, element),
    ),
    blockerDependency,
  ]);
}

/** 最終進捗日時のAI依存を合成する。 */
export function lastProgressAiDependency(
  nodeId: GitHubNodeId,
  createdAt: UtcIsoDateTime,
  applications: TrackedItemAiAnalysisApplications,
  staleness: StalenessResult,
  previousItem: SnapshotTrackedItem | undefined,
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
    ? aiDependencyForElementApplication(nodeId, applications, "progress")
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
    ...(hasNewerNaturalLanguageCandidate
      ? [aiDependencyForElementApplication(nodeId, applications, "progress")]
      : []),
  ]);
}
