import { hashCanonicalJson } from "../canonical-json/index.js";
import {
  aiAnalysisDependencyForApplication,
  aiAnalysisDependencyForMissingRelationCandidateAssessment,
  combineAiAnalysisDependencies,
  type AiAnalysisDependency,
  type AiAnalysisDependencyProducer,
} from "../domain/ai-analysis-dependencies.js";
import {
  personalReminderCauseSetSubjectChangesAreUnbounded,
  type PersonalReminderCauseSetSubjectChanges,
  type PersonalReminderSubject,
} from "../domain/personal-reminder-causes.js";
import { StateSnapshotSemanticError } from "./errors.js";
import type { StateSnapshot as StateSnapshotVersion20 } from "./snapshot-v20-contracts.js";

type SnapshotItem = StateSnapshotVersion20["items"][number];
type SnapshotRelation = StateSnapshotVersion20["relations"][number];

function isUnverified(dependency: AiAnalysisDependency): boolean {
  return dependency.status === "unverified" || dependency.status === "unknown";
}

function normalizeSubjects(
  subjects: readonly PersonalReminderSubject[],
): PersonalReminderSubject[] {
  const byIdentity = new Map<string, PersonalReminderSubject>();
  for (const subject of subjects) {
    const identity = `${subject.kind}\u0000${subject.candidateId.toLowerCase()}`;
    const previous = byIdentity.get(identity);
    if (previous == null || subject.candidateId < previous.candidateId) {
      byIdentity.set(identity, subject);
    }
  }
  return [...byIdentity]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([, subject]) => subject);
}

function producerDependency(
  producer: AiAnalysisDependencyProducer,
  causeSetDependency: AiAnalysisDependency,
  itemsByNodeId: ReadonlyMap<string, SnapshotItem>,
  relationsById: ReadonlyMap<string, SnapshotRelation>,
): AiAnalysisDependency {
  if (producer.kind === "relation") {
    const relation = relationsById.get(producer.relationId);
    if (relation == null) {
      throw new StateSnapshotSemanticError("旧snapshotのpersonal reminder relationがありません");
    }
    return relation.aiDependency;
  }
  const ownerId = producer.kind === "item_element" ? producer.nodeId : producer.producer.nodeId;
  const element = producer.kind === "item_element" ? producer.element : producer.producer.element;
  const owner = itemsByNodeId.get(ownerId);
  if (owner == null) {
    throw new StateSnapshotSemanticError("旧snapshotのpersonal reminder producer itemがありません");
  }
  const application = owner.aiAnalysis.applications[element];
  if (
    producer.kind === "relation_candidate" &&
    causeSetDependency.status === "unknown" &&
    causeSetDependency.reasons.includes("proof_unknown")
  ) {
    return aiAnalysisDependencyForMissingRelationCandidateAssessment(owner.nodeId, application);
  }
  return aiAnalysisDependencyForApplication(owner.nodeId, element, application);
}

function candidateSubject(
  producer: Extract<AiAnalysisDependencyProducer, { kind: "relation_candidate" }>,
  item: SnapshotItem,
  itemsByNodeId: ReadonlyMap<string, SnapshotItem>,
  relationsById: ReadonlyMap<string, SnapshotRelation>,
): PersonalReminderSubject | undefined {
  if (item.type !== "issue" || item.state !== "open" || item.assignees.length !== 0) {
    return undefined;
  }
  const owner = itemsByNodeId.get(producer.producer.nodeId);
  if (
    owner == null ||
    !producer.endpointNodeIds.includes(item.nodeId) ||
    owner.type !== "pull_request" ||
    owner.state !== "open" ||
    owner.author.status === "unavailable" ||
    owner.author.actor.type !== "human"
  ) {
    return undefined;
  }
  const relation = relationsById.get(producer.candidateId);
  if (
    relation?.active === true &&
    relation.type === "implements" &&
    relation.fromNodeId === owner.nodeId &&
    relation.toNodeId === item.nodeId
  ) {
    return undefined;
  }
  return { kind: "user", candidateId: owner.author.actor.login };
}

function subjectChanges(
  item: SnapshotItem,
  itemsByNodeId: ReadonlyMap<string, SnapshotItem>,
  relationsById: ReadonlyMap<string, SnapshotRelation>,
): PersonalReminderCauseSetSubjectChanges {
  const planning = item.personalReminderCausePlanning;
  if (planning.status !== "completed") {
    throw new StateSnapshotSemanticError("完了していないpersonal reminder計画は再分類できません");
  }
  const presenceDependencies = item.personalReminderCauses.map(
    (cause) => cause.aiDependencies.presence,
  );
  const presenceDependency = combineAiAnalysisDependencies(
    presenceDependencies.length === 0 ? [{ status: "not_dependent" }] : presenceDependencies,
  );
  const presenceProducers = new Set(
    presenceDependency.status === "not_dependent"
      ? []
      : (presenceDependency.producers ?? []).map(hashCanonicalJson),
  );
  const removableSubjects = item.personalReminderCauses.flatMap((cause) =>
    isUnverified(cause.aiDependencies.presence)
      ? cause.responsible.flatMap((responsible): PersonalReminderSubject[] =>
          responsible.kind === "user" || responsible.kind === "team"
            ? [{ kind: responsible.kind, candidateId: responsible.candidateId }]
            : [],
        )
      : [],
  );
  const groundedSubjects: PersonalReminderSubject[] = [];
  const addableSubjects: PersonalReminderSubject[] = [];
  let inputUnbounded = false;
  for (const producer of planning.causeSetAiDependency.status === "not_dependent"
    ? []
    : (planning.causeSetAiDependency.producers ?? [])) {
    if (presenceProducers.has(hashCanonicalJson(producer))) {
      continue;
    }
    const dependency = producerDependency(
      producer,
      planning.causeSetAiDependency,
      itemsByNodeId,
      relationsById,
    );
    if (producer.kind !== "relation_candidate") {
      inputUnbounded ||= isUnverified(dependency);
      continue;
    }
    const subject = candidateSubject(producer, item, itemsByNodeId, relationsById);
    if (subject == null) {
      continue;
    }
    groundedSubjects.push(subject);
    if (isUnverified(dependency)) {
      addableSubjects.push(subject);
    }
  }
  if (
    personalReminderCauseSetSubjectChangesAreUnbounded({
      causeSetDependency: planning.causeSetAiDependency,
      presenceDependency,
      negativeCandidateSubjectCount: normalizeSubjects(groundedSubjects).length,
      inputUnbounded,
    })
  ) {
    return { scope: "unbounded" };
  }
  return {
    scope: "bounded",
    addableSubjects: normalizeSubjects(addableSubjects),
    removableSubjects: normalizeSubjects(removableSubjects),
  };
}

/** 旧AI証明の降格後にpersonal reminderの主体変化を再分類する。 */
export function migratePersonalReminderSubjectChanges(
  snapshot: StateSnapshotVersion20,
): StateSnapshotVersion20 {
  const itemsByNodeId = new Map(snapshot.items.map((item) => [item.nodeId, item]));
  const relationsById = new Map(snapshot.relations.map((relation) => [relation.id, relation]));
  return {
    ...snapshot,
    items: snapshot.items.map((item) =>
      item.personalReminderCausePlanning.status === "completed"
        ? {
            ...item,
            personalReminderCausePlanning: {
              ...item.personalReminderCausePlanning,
              causeSetSubjectChanges: subjectChanges(item, itemsByNodeId, relationsById),
            },
          }
        : item,
    ),
  };
}
