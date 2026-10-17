import type { PersonalReminderCauseDraft } from "../../../domain/personal-reminder-planning.js";
import type { GraphNodeId } from "../../../domain/types.js";
import { compareStrings, currentAiDependencyInput } from "./personal-reminder-runtime-common.js";
import { candidateEndpointItemByNodeId } from "./personal-reminder-runtime-context-values.js";
import type {
  PersonalReminderRuntimeCandidateEndpointItem,
  PersonalReminderRuntimeCandidateRelation,
  PersonalReminderRuntimeContext,
  PersonalReminderRuntimeContextItem,
  PersonalReminderRuntimeSubjectDependency,
} from "./personal-reminder-runtime-contracts.js";
import { endpointIsOpen } from "./personal-reminder-runtime-relations.js";

function candidateIsActualPositiveImplements(
  candidate: PersonalReminderRuntimeCandidateRelation,
  implementationNodeId: GraphNodeId,
  targetNodeId: GraphNodeId,
): boolean {
  const resolution = candidate.resolution;
  const canonicalRelation = candidate.canonicalRelation;
  return (
    resolution?.status === "active" &&
    canonicalRelation?.type === "implements" &&
    canonicalRelation.fromNodeId === implementationNodeId &&
    canonicalRelation.toNodeId === targetNodeId
  );
}

function candidateTargetNodeId(candidate: PersonalReminderRuntimeCandidateRelation): GraphNodeId {
  const [firstNodeId, secondNodeId] = candidate.endpointNodeIds;
  if (firstNodeId === secondNodeId) {
    throw new TypeError(`個人催促relation候補のendpointが同一です。対象: ${candidate.candidateId}`);
  }
  if (candidate.ownerNodeId === firstNodeId) {
    return secondNodeId;
  }
  if (candidate.ownerNodeId === secondNodeId) {
    return firstNodeId;
  }
  throw new TypeError(
    `個人催促relation候補のownerがendpointではありません。対象: ${candidate.candidateId}`,
  );
}

/** 未採用候補の作業責務に関わる端点を取得する。 */
export function negativeWorkCandidateEndpoints(
  context: PersonalReminderRuntimeContext,
  candidate: PersonalReminderRuntimeCandidateRelation,
):
  | Readonly<{
      implementation: PersonalReminderRuntimeCandidateEndpointItem;
      target: PersonalReminderRuntimeCandidateEndpointItem;
    }>
  | undefined {
  if (candidate.authority !== "inferred") {
    return undefined;
  }
  const resolution = candidate.resolution;
  if (
    resolution == null ||
    (resolution.status === "rejected" && resolution.reason === "blocker_not_open")
  ) {
    return undefined;
  }
  const implementation = candidateEndpointItemByNodeId(context, candidate.ownerNodeId);
  const target = candidateEndpointItemByNodeId(context, candidateTargetNodeId(candidate));
  if (implementation?.type !== "pull_request" || target?.type !== "issue") {
    return undefined;
  }
  if (implementation.author.status !== "identified" || implementation.author.type !== "human") {
    return undefined;
  }
  if (
    implementation.state !== "open" ||
    target.state !== "open" ||
    !endpointIsOpen(context.graph, {
      fromNodeId: implementation.nodeId,
      toNodeId: target.nodeId,
    }) ||
    candidateIsActualPositiveImplements(candidate, implementation.nodeId, target.nodeId)
  ) {
    return undefined;
  }
  return Object.freeze({ implementation, target });
}

/** 未採用候補から原因集合が変わり得るAI依存を集める。 */
export function negativeCandidateDependenciesForIssue(
  context: PersonalReminderRuntimeContext,
  item: PersonalReminderRuntimeContextItem,
  localDrafts: readonly PersonalReminderCauseDraft[],
  positiveDrafts: readonly PersonalReminderCauseDraft[],
): readonly PersonalReminderRuntimeSubjectDependency[] {
  if (
    item.item.type !== "issue" ||
    item.item.state !== "open" ||
    item.item.assignees.length !== 0
  ) {
    return Object.freeze([]);
  }
  const localWorkActors = new Set(
    localDrafts
      .filter((draft) => draft.action.kind === "work")
      .flatMap((draft) =>
        draft.responsible.map((responsible) => responsible.candidateId.toLowerCase()),
      ),
  );
  const positiveGraphActors = new Set(
    positiveDrafts
      .filter((draft) => draft.action.kind === "work")
      .flatMap((draft) =>
        draft.responsible.map((responsible) => responsible.candidateId.toLowerCase()),
      ),
  );
  const grouped = new Map<
    string,
    Readonly<{
      login: string;
      candidates: PersonalReminderRuntimeCandidateRelation[];
    }>
  >();
  for (const candidate of context.candidateRelationsByTargetNodeId.get(item.item.nodeId) ?? []) {
    const endpoints = negativeWorkCandidateEndpoints(context, candidate);
    if (endpoints?.target.nodeId !== item.item.nodeId) {
      continue;
    }
    const author = endpoints.implementation.author;
    if (author.status !== "identified" || author.type !== "human") {
      continue;
    }
    const login = author.login;
    const key = login.toLowerCase();
    if (localWorkActors.has(key) || positiveGraphActors.has(key)) {
      continue;
    }
    const existing = grouped.get(key);
    if (existing == null) {
      grouped.set(key, { login, candidates: [candidate] });
    } else {
      existing.candidates.push(candidate);
    }
  }
  return Object.freeze(
    [...grouped.values()]
      .sort((left, right) => compareStrings(left.login, right.login))
      .map((group) =>
        Object.freeze({
          subject: Object.freeze({ kind: "user", candidateId: group.login }),
          inputs: Object.freeze(
            group.candidates.map((candidate) => currentAiDependencyInput(candidate.aiDependency)),
          ),
        }),
      ),
  );
}
