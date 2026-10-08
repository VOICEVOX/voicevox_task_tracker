import {
  AI_ANALYSIS_ELEMENTS,
  aiAnalysisElementApplicationsSchema,
} from "../../../domain/ai-analysis-elements.js";
import {
  aiAnalysisDependencyForApplication,
  type TrackedItemAiAnalysis,
} from "../../../domain/index.js";
import {
  assertPersonalReminderEvidenceClosure,
  createStateSnapshot,
  type StateSnapshot,
} from "../../../persistence/index.js";
import {
  isExcludedPullRequestItem,
  isExcludedPullRequestIdentifier,
  isExcludedPullRequestNodeId,
  isExcludedPullRequestSourceId,
  referencesExcludedPullRequest,
} from "../excluded-pull-request.js";

function projectAiAnalysis(
  aiAnalysis: TrackedItemAiAnalysis,
  removedRelationIds: ReadonlySet<string>,
  removedSourceIds: ReadonlySet<string>,
): TrackedItemAiAnalysis {
  const elements = Object.fromEntries(
    Object.entries(aiAnalysis.elements).filter(
      ([, evaluated]) =>
        !(
          referencesExcludedPullRequest(evaluated.result, removedRelationIds, removedSourceIds) ||
          referencesExcludedPullRequest(
            evaluated.generation.result,
            removedRelationIds,
            removedSourceIds,
          )
        ),
    ),
  );
  const applications = { ...aiAnalysis.applications };
  for (const element of AI_ANALYSIS_ELEMENTS) {
    if (
      elements[element] == null &&
      applications[element].status === "retained_ai" &&
      applications[element].reason === "current_evaluation_not_adopted"
    ) {
      applications[element] = { status: "retained_ai", reason: "proof_unknown" };
    }
  }
  const status =
    aiAnalysis.status === "used" && Object.keys(elements).length === 0
      ? "not_recorded"
      : aiAnalysis.status;
  if (aiAnalysis.origin === "current") {
    const adoptedElements = Object.fromEntries(
      Object.entries(aiAnalysis.adoptedElements).filter(
        ([, adopted]) =>
          !(
            referencesExcludedPullRequest(adopted.result, removedRelationIds, removedSourceIds) ||
            referencesExcludedPullRequest(
              adopted.generation.result,
              removedRelationIds,
              removedSourceIds,
            )
          ),
      ),
    );
    for (const element of AI_ANALYSIS_ELEMENTS) {
      if (aiAnalysis.adoptedElements[element] != null && adoptedElements[element] == null) {
        if (
          applications[element].status === "current_ai" ||
          applications[element].status === "retained_ai" ||
          applications[element].status === "unknown"
        ) {
          applications[element] = { status: "unavailable", reason: "proof_unknown" };
        }
      }
    }
    return Object.freeze({
      ...aiAnalysis,
      status,
      elements: Object.freeze(elements),
      adoptedElements: Object.freeze(adoptedElements),
      applications: aiAnalysisElementApplicationsSchema.parse(applications),
    });
  }
  const adoptedElements = Object.fromEntries(
    Object.entries(aiAnalysis.adoptedElements).filter(
      ([, adopted]) =>
        !(
          referencesExcludedPullRequest(adopted.result, removedRelationIds, removedSourceIds) ||
          (adopted.origin === "current" &&
            referencesExcludedPullRequest(
              adopted.generation.result,
              removedRelationIds,
              removedSourceIds,
            ))
        ),
    ),
  );
  for (const element of AI_ANALYSIS_ELEMENTS) {
    if (aiAnalysis.adoptedElements[element] != null && adoptedElements[element] == null) {
      if (
        applications[element].status === "current_ai" ||
        applications[element].status === "retained_ai" ||
        applications[element].status === "unknown"
      ) {
        applications[element] = { status: "unavailable", reason: "proof_unknown" };
      }
    }
  }
  return Object.freeze({
    ...aiAnalysis,
    status,
    elements: Object.freeze(elements),
    adoptedElements: Object.freeze(adoptedElements),
    applications: aiAnalysisElementApplicationsSchema.parse(applications),
  });
}

function projectTrackedItem(
  item: StateSnapshot["items"][number],
  removedRelationIds: ReadonlySet<string>,
  removedSourceIds: ReadonlySet<string>,
): unknown {
  const aiAnalysis = projectAiAnalysis(item.aiAnalysis, removedRelationIds, removedSourceIds);
  const aiDependencies =
    aiAnalysis.applications.progress.status === item.aiAnalysis.applications.progress.status
      ? item.aiDependencies
      : Object.freeze({
          ...item.aiDependencies,
          lastProgressAt: aiAnalysisDependencyForApplication(
            item.nodeId,
            "progress",
            aiAnalysis.applications.progress,
          ),
        });
  const evidence = Object.freeze(
    item.evidence.filter(
      (value) =>
        !isExcludedPullRequestSourceId(value.sourceId) && !removedSourceIds.has(value.sourceId),
    ),
  );
  const inputEvents = Object.freeze(
    item.inputEvents.filter(
      (value) =>
        !isExcludedPullRequestSourceId(value.sourceId) &&
        !removedSourceIds.has(value.sourceId) &&
        !isExcludedPullRequestIdentifier(value.url),
    ),
  );
  const personalReminderCauses = Object.freeze(
    item.personalReminderCauses.filter(
      (cause) => !referencesExcludedPullRequest(cause, removedRelationIds, removedSourceIds),
    ),
  );
  if (
    item.status === "terminal_merged" ||
    item.status === "terminal_completed" ||
    item.status === "terminal_not_planned"
  ) {
    return Object.freeze({
      ...item,
      aiAnalysis,
      aiDependencies,
      evidence,
      inputEvents,
      personalReminderCauses,
    });
  }
  const waitingOn = item.waitingOn.filter(
    (value) => !referencesExcludedPullRequest(value, removedRelationIds, removedSourceIds),
  );
  return Object.freeze({
    ...item,
    aiAnalysis,
    aiDependencies,
    evidence,
    inputEvents,
    personalReminderCauses,
    waitingOn: Object.freeze(waitingOn),
    primaryWaitingOn:
      waitingOn.length === 0 && item.waitingOn.length !== 0
        ? Object.freeze({
            index: "not_applicable",
            selectionReason: "待ち相手の根拠が現在の追跡対象にありません",
          })
        : item.primaryWaitingOn,
  });
}

/** 前回snapshotから個別除外対象のPull Requestとその構造参照を除く。 */
export function projectExcludedPullRequestSnapshot(snapshot: StateSnapshot): StateSnapshot {
  const repositoriesById = new Map(
    snapshot.repositories.map((repository) => [repository.id, repository]),
  );
  const excludedNodeIds = new Set<string>(
    snapshot.items
      .filter((item) => {
        const repository = repositoriesById.get(item.repositoryId);
        if (repository == null) {
          throw new TypeError(`前回追跡項目のrepositoryがありません。対象: ${item.nodeId}`);
        }
        return isExcludedPullRequestItem(item, repository);
      })
      .map((item) => item.nodeId),
  );
  const removedRelations = snapshot.relations.filter(
    (relation) =>
      excludedNodeIds.has(relation.fromNodeId) ||
      excludedNodeIds.has(relation.toNodeId) ||
      isExcludedPullRequestNodeId(relation.fromNodeId) ||
      isExcludedPullRequestNodeId(relation.toNodeId) ||
      relation.evidence.some((evidence) => isExcludedPullRequestSourceId(evidence.sourceId)),
  );
  const removedRelationIds = new Set(removedRelations.map((relation) => relation.id));
  const retainedRelations = snapshot.relations.filter(
    (relation) => !removedRelationIds.has(relation.id),
  );
  const retainedSourceIds = new Set(
    retainedRelations.flatMap((relation) => relation.evidence.map((evidence) => evidence.sourceId)),
  );
  const removedSourceIds = new Set(
    removedRelations
      .flatMap((relation) => relation.evidence.map((evidence) => evidence.sourceId))
      .filter((sourceId) => !retainedSourceIds.has(sourceId)),
  );
  const hasExcludedCollectionItem = snapshot.collection.repositories.some((repository) =>
    repository.items.some(
      (item) => excludedNodeIds.has(item.nodeId) || isExcludedPullRequestNodeId(item.nodeId),
    ),
  );
  const hasExcludedReference =
    snapshot.items.some((item) =>
      referencesExcludedPullRequest(item, removedRelationIds, removedSourceIds),
    ) ||
    snapshot.collection.repositories.some((repository) =>
      repository.items.some((item) =>
        referencesExcludedPullRequest(item, removedRelationIds, removedSourceIds),
      ),
    ) ||
    snapshot.graphNodeStateObservations.some((observation) =>
      isExcludedPullRequestNodeId(observation.nodeId),
    ) ||
    snapshot.externalReferences.some((reference) =>
      referencesExcludedPullRequest(reference, removedRelationIds, removedSourceIds),
    );
  if (
    excludedNodeIds.size === 0 &&
    removedRelationIds.size === 0 &&
    !hasExcludedCollectionItem &&
    !hasExcludedReference
  ) {
    return snapshot;
  }
  const projected = createStateSnapshot({
    ...snapshot,
    collection: {
      repositories: snapshot.collection.repositories.map((repository) => ({
        ...repository,
        items: repository.items
          .filter(
            (item) =>
              !excludedNodeIds.has(item.nodeId) && !isExcludedPullRequestNodeId(item.nodeId),
          )
          .map((item) => ({
            ...item,
            aiAnalysis: projectAiAnalysis(item.aiAnalysis, removedRelationIds, removedSourceIds),
          })),
      })),
    },
    items: snapshot.items
      .filter((item) => !excludedNodeIds.has(item.nodeId))
      .map((item) => projectTrackedItem(item, removedRelationIds, removedSourceIds)),
    graphNodeStateObservations: snapshot.graphNodeStateObservations.filter(
      (observation) =>
        !excludedNodeIds.has(observation.nodeId) &&
        !isExcludedPullRequestNodeId(observation.nodeId),
    ),
    externalReferences: snapshot.externalReferences.filter(
      (reference) =>
        !referencesExcludedPullRequest(reference, removedRelationIds, removedSourceIds),
    ),
    relations: retainedRelations,
  });
  assertPersonalReminderEvidenceClosure(projected);
  return projected;
}
