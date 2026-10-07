import type { PersonalReminderDuplicateOption } from "../../../codex/personal-reminder-input-contracts.js";
import type { AiAnalysisDependencyInput } from "../../../domain/ai-analysis-dependencies.js";
import type {
  PersonalReminderCauseId,
  PersonalReminderCauseSeed,
  PersonalReminderResponseMembershipAssessmentRequirement,
  PersonalReminderResponsible,
} from "../../../domain/personal-reminder-causes.js";
import type { SourceId } from "../../../domain/source-id.js";
import type { GraphNodeId } from "../../../domain/types.js";
import { assertNonNullable } from "../../../util/index.js";
import {
  compareStrings,
  createNonEmptySourceIds,
  currentAiDependencyInput,
  seedAiDependencyInput,
} from "./personal-reminder-runtime-common.js";
import { addRuntimeSource } from "./personal-reminder-runtime-source-projection.js";
import type {
  PersonalReminderRuntimeCandidateRelation,
  PersonalReminderRuntimeContext,
  PersonalReminderRuntimeCurrentSeed,
  PersonalReminderRuntimePlanningIndexes,
  PersonalReminderRuntimeSource,
} from "./personal-reminder-runtime-contracts.js";
import {
  activeRelationIsEffective,
  connectedSeedRelations,
  duplicateCanonicalSeed,
  relationEndpointsAllowPending,
  relationsIncidentToScope,
  scopeNodeIdsForSeed,
  targetScopeForSeed,
} from "./personal-reminder-runtime-relations.js";
import { relationSourceProjectionForEdges } from "./personal-reminder-runtime-relation-projection.js";
import { personalReminderCauseSeedAiDependencyInputs } from "./personal-reminder-runtime-seed.js";

/** 原因と重複する可能性のある候補を作る。 */
export function duplicateOptionsForCause(
  context: PersonalReminderRuntimeContext,
  globalSourcesById: ReadonlyMap<SourceId, PersonalReminderRuntimeSource>,
  current: PersonalReminderRuntimeCurrentSeed,
  indexes: PersonalReminderRuntimePlanningIndexes,
): Readonly<{
  options: readonly PersonalReminderDuplicateOption[];
  sources: readonly PersonalReminderRuntimeSource[];
  aiDependencyInputsByCanonicalCauseId: ReadonlyMap<string, readonly AiAnalysisDependencyInput[]>;
}> {
  const options: PersonalReminderDuplicateOption[] = [];
  const sources = new Map<SourceId, PersonalReminderRuntimeSource>();
  const aiDependencyInputsByCanonicalCauseId = new Map<
    string,
    readonly AiAnalysisDependencyInput[]
  >();
  const effectiveRelations = relationsIncidentToScope(
    indexes,
    scopeNodeIdsForSeed(current.seed),
  ).filter(
    (relation) =>
      relation.type !== "related_to" && activeRelationIsEffective(context.graph, relation),
  );
  const connected = connectedSeedRelations(indexes, current.seed, effectiveRelations, current);
  for (const { currentSeed: candidate, relations: directRelations } of connected.values()) {
    if (!seedCanBeDuplicateCandidate(current, candidate)) {
      continue;
    }
    const relationIds = directRelations.map((relation) => relation.id);
    const canonical =
      current.origin === "retained_without_draft"
        ? candidate
        : duplicateCanonicalSeed(context, current, candidate, directRelations);
    if (canonical.seed.causeId !== candidate.seed.causeId) {
      continue;
    }
    const relationSourceEntries = relationSourceProjectionForEdges(
      directRelations,
      globalSourcesById,
    );
    const relationSourceIds = directRelations.flatMap((relation) =>
      relation.evidence.map((evidence) => evidence.sourceId),
    );
    const evidenceSourceIds = createNonEmptySourceIds(
      [...candidate.seed.evidenceSourceIds, ...relationSourceIds],
      `duplicate option ${candidate.seed.causeId}`,
    );
    for (const source of candidate.item.sources) {
      if (evidenceSourceIds.includes(source.source.sourceId)) {
        addRuntimeSource(sources, source);
      }
    }
    for (const source of relationSourceEntries.sources) {
      addRuntimeSource(sources, source);
    }
    const option = Object.freeze({
      canonicalCauseId: candidate.seed.causeId,
      itemNodeId: candidate.seed.itemNodeId,
      targetScope: targetScopeForSeed(candidate.seed),
      responsible: [...candidate.seed.responsible],
      action: { ...candidate.seed.action },
      relationIds,
      evidenceSourceIds: [...evidenceSourceIds],
    });
    options.push(option);
    if (aiDependencyInputsByCanonicalCauseId.has(option.canonicalCauseId)) {
      throw new TypeError(
        `duplicate optionのcanonical cause IDが重複しています。対象: ${option.canonicalCauseId}`,
      );
    }
    aiDependencyInputsByCanonicalCauseId.set(
      option.canonicalCauseId,
      Object.freeze([
        ...personalReminderCauseSeedAiDependencyInputs(candidate),
        ...directRelations.map((relation) => currentAiDependencyInput(relation.aiDependency)),
      ]),
    );
  }
  return Object.freeze({
    options: Object.freeze(options),
    sources: Object.freeze([...sources.values()]),
    aiDependencyInputsByCanonicalCauseId,
  });
}

function seedCanBeDuplicateCandidate(
  current: PersonalReminderRuntimeCurrentSeed,
  candidate: PersonalReminderRuntimeCurrentSeed,
): boolean {
  return (
    candidate.seed.causeId !== current.seed.causeId &&
    (current.draftIdentity == null || candidate.draftIdentity !== current.draftIdentity) &&
    candidate.origin === "current_draft" &&
    candidate.seed.action.kind === current.seed.action.kind &&
    sameResponsibleValues(candidate.seed.responsible, current.seed.responsible)
  );
}

function relationCandidateConnectsScopes(
  candidate: PersonalReminderRuntimeCandidateRelation,
  leftNodeIds: ReadonlySet<GraphNodeId>,
  rightNodeIds: ReadonlySet<GraphNodeId>,
): boolean {
  const [firstNodeId, secondNodeId] = candidate.endpointNodeIds;
  return (
    (leftNodeIds.has(firstNodeId) && rightNodeIds.has(secondNodeId)) ||
    (leftNodeIds.has(secondNodeId) && rightNodeIds.has(firstNodeId))
  );
}

function pendingRelationCanHideCauseAsDuplicate(
  current: PersonalReminderRuntimeCurrentSeed,
  candidateSeed: PersonalReminderRuntimeCurrentSeed,
  relationCandidate: PersonalReminderRuntimeCandidateRelation,
): boolean {
  if (
    !relationCandidateConnectsScopes(
      relationCandidate,
      scopeNodeIdsForSeed(current.seed),
      scopeNodeIdsForSeed(candidateSeed.seed),
    )
  ) {
    return false;
  }
  if (current.origin === "retained_without_draft") {
    return true;
  }
  if (compareStrings(candidateSeed.seed.causeId, current.seed.causeId) < 0) {
    return true;
  }
  const currentIsImplementation =
    current.item.item.type === "pull_request" &&
    relationCandidate.ownerNodeId === current.seed.itemNodeId;
  const candidateIsImplementation =
    candidateSeed.item.item.type === "pull_request" &&
    relationCandidate.ownerNodeId === candidateSeed.seed.itemNodeId;
  return candidateIsImplementation && !currentIsImplementation;
}

/** 未確定の人物所属に関するAI依存を集める。 */
export function pendingResponseMembershipDependencyInputs(
  context: PersonalReminderRuntimeContext,
  current: PersonalReminderRuntimeCurrentSeed,
  indexes: PersonalReminderRuntimePlanningIndexes,
): readonly AiAnalysisDependencyInput[] {
  const dependencies: AiAnalysisDependencyInput[] = [];
  for (const resolution of context.graph.candidateResolutions) {
    if (resolution.status !== "pending") {
      continue;
    }
    const candidate = indexes.candidateRelationById.get(resolution.candidateId);
    assertNonNullable(
      candidate,
      `pending relation candidateがありません。対象: ${resolution.candidateId}`,
    );
    if (
      candidate.authority !== "inferred" ||
      !relationEndpointsAllowPending(context.graph, candidate.endpointNodeIds)
    ) {
      continue;
    }
    const currentScopeNodeIds = scopeNodeIdsForSeed(current.seed);
    const [firstNodeId, secondNodeId] = candidate.endpointNodeIds;
    const duplicateCandidatesByCauseId = new Map<
      PersonalReminderCauseId,
      PersonalReminderRuntimeCurrentSeed
    >();
    if (currentScopeNodeIds.has(firstNodeId)) {
      for (const duplicateCandidate of indexes.currentSeedsByScopeNodeId.get(secondNodeId) ?? []) {
        duplicateCandidatesByCauseId.set(duplicateCandidate.seed.causeId, duplicateCandidate);
      }
    }
    if (currentScopeNodeIds.has(secondNodeId)) {
      for (const duplicateCandidate of indexes.currentSeedsByScopeNodeId.get(firstNodeId) ?? []) {
        duplicateCandidatesByCauseId.set(duplicateCandidate.seed.causeId, duplicateCandidate);
      }
    }
    const matchingDuplicateCandidates = [...duplicateCandidatesByCauseId.values()].filter(
      (duplicateCandidate) =>
        seedCanBeDuplicateCandidate(current, duplicateCandidate) &&
        pendingRelationCanHideCauseAsDuplicate(current, duplicateCandidate, candidate),
    );
    if (matchingDuplicateCandidates.length === 0) {
      continue;
    }
    if (candidate.aiDependency.status === "not_dependent") {
      throw new TypeError(
        `推定pending relation candidateのAI依存はnot_dependentにできません。対象: ${candidate.candidateId}`,
      );
    }
    dependencies.push(
      Object.freeze({
        origin: "current",
        dependency: candidate.aiDependency,
        relationCandidateAssessment: "missing",
      }),
      ...matchingDuplicateCandidates.flatMap((duplicateCandidate) => [
        seedAiDependencyInput(
          duplicateCandidate.seed.aiDependencies.presence,
          duplicateCandidate.origin,
        ),
        seedAiDependencyInput(
          duplicateCandidate.seed.aiDependencies.responsible,
          duplicateCandidate.origin,
        ),
      ]),
    );
  }
  return Object.freeze(dependencies);
}

/** 人物所属の意味評価が必要か判定する。 */
export function responseMembershipAssessmentRequirement(
  seed: PersonalReminderCauseSeed,
  duplicateOptions: readonly PersonalReminderDuplicateOption[],
): PersonalReminderResponseMembershipAssessmentRequirement {
  if (seed.responsibility.authority === "semantic" || duplicateOptions.length !== 0) {
    return Object.freeze({ status: "required" });
  }
  return Object.freeze({ status: "not_required" });
}

/** 二つの責任主体集合が同一か判定する。 */
export function sameResponsibleValues(
  left: readonly PersonalReminderResponsible[],
  right: readonly PersonalReminderResponsible[],
): boolean {
  if (left.length !== right.length) {
    return false;
  }
  const leftValues = left
    .map((value) => `${value.kind}\u0000${value.candidateId.toLowerCase()}\u0000${value.role}`)
    .sort(compareStrings);
  const rightValues = right
    .map((value) => `${value.kind}\u0000${value.candidateId.toLowerCase()}\u0000${value.role}`)
    .sort(compareStrings);
  return leftValues.every((value, index) => value === rightValues[index]);
}
