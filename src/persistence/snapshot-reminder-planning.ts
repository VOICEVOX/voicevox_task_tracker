import { hashCanonicalJson } from "../canonical-json/index.js";
import { combineAiAnalysisDependencies } from "../domain/ai-analysis-dependencies.js";
import {
  isTerminalStatus,
  personalReminderCausePlanningSchema,
  type AiAnalysisDependency,
  type AiAnalysisDependencyProducer,
  type Relation,
} from "../domain/index.js";
import { personalReminderCauseSetSubjectChangesAreUnbounded } from "../domain/personal-reminder-causes.js";
import { StateSnapshotSemanticError, type PersonalReminderAiDependencyField } from "./errors.js";
import { expectedAiAnalysisDependencyForProducer } from "./snapshot-ai-adoption.js";
import type {
  LegacyRelationWithoutAiDependency,
  SnapshotItemForRelationValidation,
  SnapshotTrackedItemPersonalReminderFields,
} from "./snapshot-contracts.js";
import {
  aiAnalysisDependencyProducerSignature,
  assertAiAnalysisDependencyLowerBound,
} from "./snapshot-graph-dependencies.js";
import {
  assertCanonicalPersonalReminderSubjects,
  assertPersonalReminderAiDependencySemantics,
  personalReminderSubjectIdentity,
} from "./snapshot-reminder-responsibility.js";
import { assertUtcDateTime, compareStrings } from "./snapshot-values.js";

type SnapshotPersonalReminderSubject = Readonly<{
  kind: "user" | "team";
  candidateId: string;
}>;

function normalizeSnapshotPersonalReminderSubjects(
  subjects: readonly SnapshotPersonalReminderSubject[],
): readonly SnapshotPersonalReminderSubject[] {
  const subjectsByIdentity = new Map<string, SnapshotPersonalReminderSubject>();
  for (const subject of subjects) {
    const identity = personalReminderSubjectIdentity(subject);
    const current = subjectsByIdentity.get(identity);
    if (current == null || compareStrings(subject.candidateId, current.candidateId) < 0) {
      subjectsByIdentity.set(identity, subject);
    }
  }
  return Object.freeze(
    [...subjectsByIdentity.values()].sort((left, right) =>
      compareStrings(personalReminderSubjectIdentity(left), personalReminderSubjectIdentity(right)),
    ),
  );
}

function aiAnalysisDependencyIsUnverified(dependency: AiAnalysisDependency): boolean {
  return dependency.status === "unverified" || dependency.status === "unknown";
}

type SnapshotPersonalReminderCandidateSubject =
  | Readonly<{
      status: "grounded";
      subject: SnapshotPersonalReminderSubject;
      addable: boolean;
    }>
  | Readonly<{ status: "unbounded" }>
  | Readonly<{ status: "excluded" }>;

function expectedPersonalReminderCandidateSubject(
  producer: AiAnalysisDependencyProducer,
  parentItem: SnapshotItemForRelationValidation,
  itemsByNodeId: ReadonlyMap<string, SnapshotItemForRelationValidation>,
  relationsById: ReadonlyMap<string, Relation | LegacyRelationWithoutAiDependency>,
  causeSetDependency: AiAnalysisDependency,
): SnapshotPersonalReminderCandidateSubject {
  const producerDependency = expectedAiAnalysisDependencyForProducer(
    producer,
    "personal reminder cause setの追加producer",
    itemsByNodeId,
    relationsById,
    causeSetDependency,
  );
  if (producer.kind !== "relation_candidate") {
    if (aiAnalysisDependencyIsUnverified(producerDependency)) {
      return Object.freeze({ status: "unbounded" });
    }
    return Object.freeze({ status: "excluded" });
  }
  if (
    parentItem.type !== "issue" ||
    parentItem.state !== "open" ||
    parentItem.assignees.length !== 0
  ) {
    return Object.freeze({ status: "excluded" });
  }
  const owner = itemsByNodeId.get(producer.producer.nodeId);
  if (owner == null) {
    return Object.freeze({ status: "excluded" });
  }
  if (!producer.endpointNodeIds.includes(parentItem.nodeId)) {
    return Object.freeze({ status: "excluded" });
  }
  if (owner.type !== "pull_request" || owner.state !== "open") {
    return Object.freeze({ status: "excluded" });
  }
  if (owner.author.status === "unavailable") {
    return Object.freeze({ status: "excluded" });
  }
  if (owner.author.actor.type !== "human") {
    return Object.freeze({ status: "excluded" });
  }
  const persistedRelation = relationsById.get(producer.candidateId);
  if (
    persistedRelation?.active === true &&
    persistedRelation.type === "implements" &&
    persistedRelation.fromNodeId === owner.nodeId &&
    persistedRelation.toNodeId === parentItem.nodeId
  ) {
    return Object.freeze({ status: "excluded" });
  }
  return Object.freeze({
    status: "grounded",
    subject: Object.freeze({
      kind: "user",
      candidateId: owner.author.actor.login,
    }),
    addable: aiAnalysisDependencyIsUnverified(producerDependency),
  });
}

function assertPersonalReminderCauseSetSemantics(
  item: SnapshotTrackedItemPersonalReminderFields,
  itemsByNodeId: ReadonlyMap<string, SnapshotItemForRelationValidation>,
  relationsById: ReadonlyMap<string, Relation | LegacyRelationWithoutAiDependency>,
): void {
  const planning = item.personalReminderCausePlanning;
  if (
    planning.status !== "completed" ||
    !("causeSetAiDependency" in planning) ||
    !("causeSetSubjectChanges" in planning)
  ) {
    return;
  }
  const presenceDependencies: AiAnalysisDependency[] = [];
  const removableSubjects: SnapshotPersonalReminderSubject[] = [];
  for (const cause of item.personalReminderCauses) {
    if (!("aiDependencies" in cause)) {
      throw new StateSnapshotSemanticError(
        "personal reminder cause setの検証に必要なcause AI依存がありません",
      );
    }
    const presenceDependency = cause.aiDependencies.presence;
    presenceDependencies.push(presenceDependency);
    if (!aiAnalysisDependencyIsUnverified(presenceDependency)) {
      continue;
    }
    for (const responsible of cause.responsible) {
      if (responsible.kind === "user" || responsible.kind === "team") {
        removableSubjects.push(
          Object.freeze({
            kind: responsible.kind,
            candidateId: responsible.candidateId,
          }),
        );
      }
    }
  }
  const expectedPresenceDependency = combineAiAnalysisDependencies(
    presenceDependencies.length === 0
      ? [Object.freeze({ status: "not_dependent" })]
      : presenceDependencies,
  );
  if (
    planning.causeSetAiDependency.status === "unknown" &&
    planning.causeSetAiDependency.reasons.length === 1 &&
    planning.causeSetAiDependency.reasons[0] === "migration" &&
    planning.causeSetAiDependency.producers == null &&
    expectedPresenceDependency.status !== "not_dependent" &&
    !(
      expectedPresenceDependency.status === "unknown" &&
      expectedPresenceDependency.reasons.length === 1 &&
      expectedPresenceDependency.reasons[0] === "migration" &&
      expectedPresenceDependency.producers == null
    )
  ) {
    throw new StateSnapshotSemanticError(
      `item ${item.nodeId}のpersonal reminder cause set AI依存がcauseのpresenceを含んでいません`,
    );
  }
  assertAiAnalysisDependencyLowerBound(
    expectedPresenceDependency,
    planning.causeSetAiDependency,
    `item ${item.nodeId}のpersonal reminder cause set AI依存`,
  );

  let subjectChangesInputUnbounded = false;
  const presenceProducerSignatures = new Set(
    expectedPresenceDependency.status === "not_dependent"
      ? []
      : (expectedPresenceDependency.producers ?? []).map(aiAnalysisDependencyProducerSignature),
  );
  const groundedCandidateSubjects: SnapshotPersonalReminderSubject[] = [];
  const groundedAddableSubjects: SnapshotPersonalReminderSubject[] = [];
  const parentItem = itemsByNodeId.get(item.nodeId);
  if (parentItem == null) {
    throw new StateSnapshotSemanticError(
      `personal reminder cause setの親itemがありません。対象: ${item.nodeId}`,
    );
  }
  for (const producer of planning.causeSetAiDependency.status === "not_dependent"
    ? []
    : (planning.causeSetAiDependency.producers ?? [])) {
    if (presenceProducerSignatures.has(aiAnalysisDependencyProducerSignature(producer))) {
      continue;
    }
    const candidateSubject = expectedPersonalReminderCandidateSubject(
      producer,
      parentItem,
      itemsByNodeId,
      relationsById,
      planning.causeSetAiDependency,
    );
    if (candidateSubject.status === "unbounded") {
      subjectChangesInputUnbounded = true;
    } else if (candidateSubject.status === "grounded") {
      groundedCandidateSubjects.push(candidateSubject.subject);
      if (candidateSubject.addable) {
        groundedAddableSubjects.push(candidateSubject.subject);
      }
    }
  }

  const normalizedGroundedCandidateSubjects =
    normalizeSnapshotPersonalReminderSubjects(groundedCandidateSubjects);
  const normalizedGroundedAddableSubjects =
    normalizeSnapshotPersonalReminderSubjects(groundedAddableSubjects);
  const expectedRemovableSubjects = normalizeSnapshotPersonalReminderSubjects(removableSubjects);
  const subjectChangesAreUnbounded = personalReminderCauseSetSubjectChangesAreUnbounded({
    causeSetDependency: planning.causeSetAiDependency,
    presenceDependency: expectedPresenceDependency,
    negativeCandidateSubjectCount: normalizedGroundedCandidateSubjects.length,
    inputUnbounded: subjectChangesInputUnbounded,
  });
  const subjectChanges = planning.causeSetSubjectChanges;
  if (subjectChangesAreUnbounded) {
    if (subjectChanges.scope !== "unbounded") {
      throw new StateSnapshotSemanticError(
        "personal reminder cause集合の主体変化を完全に復元できない場合はunboundedにしてください",
      );
    }
    return;
  }
  if (subjectChanges.scope !== "bounded") {
    throw new StateSnapshotSemanticError(
      "personal reminder cause集合の主体変化を復元できる場合はboundedにしてください",
    );
  }
  if (
    hashCanonicalJson(subjectChanges.addableSubjects) !==
      hashCanonicalJson(normalizedGroundedAddableSubjects) ||
    hashCanonicalJson(subjectChanges.removableSubjects) !==
      hashCanonicalJson(expectedRemovableSubjects)
  ) {
    throw new StateSnapshotSemanticError(
      "personal reminder cause集合の主体変化がAI依存とcauseに一致しません",
    );
  }
}

function personalReminderResponseMembershipProducerIsAllowed(
  producer: AiAnalysisDependencyProducer,
): boolean {
  if (producer.kind === "item_element") {
    return (
      producer.element === "status" ||
      producer.element === "waitingOn" ||
      producer.element === "nextAction"
    );
  }
  if (producer.kind === "relation") {
    return producer.producer.element === "relations";
  }
  return true;
}

export function assertPersonalReminderDependenciesSemantics(
  item: SnapshotTrackedItemPersonalReminderFields,
  itemsByNodeId: ReadonlyMap<string, SnapshotItemForRelationValidation>,
  relationsById: ReadonlyMap<string, Relation | LegacyRelationWithoutAiDependency>,
): void {
  for (const cause of item.personalReminderCauses) {
    if (!("aiDependencies" in cause)) {
      continue;
    }
    if (
      cause.aiDependencies.presence.status !== "not_dependent" &&
      (cause.aiDependencies.presence.producers ?? []).some(
        (producer) => producer.kind === "relation_candidate",
      )
    ) {
      throw new StateSnapshotSemanticError(
        "personal reminder causeのpresence AI依存にrelation candidate producerは指定できません",
      );
    }
    if (
      cause.aiDependencies.responseMembership.status !== "not_dependent" &&
      (cause.aiDependencies.responseMembership.producers ?? []).some(
        (producer) => !personalReminderResponseMembershipProducerIsAllowed(producer),
      )
    ) {
      throw new StateSnapshotSemanticError(
        "personal reminder causeのresponse membership AI依存に人物所属の判定入力以外のproducerは指定できません",
      );
    }
    if (!("aiDependency" in cause.currentInput)) {
      continue;
    }
    const descriptions = [
      ["presence", cause.aiDependencies.presence],
      ["responsible", cause.aiDependencies.responsible],
      ["action", cause.aiDependencies.action],
      ["evidence", cause.aiDependencies.evidence],
    ] satisfies readonly (readonly [PersonalReminderAiDependencyField, unknown])[];
    for (const [field, dependency] of descriptions) {
      assertPersonalReminderAiDependencySemantics(
        dependency,
        `personal reminder causeの${field} AI依存`,
        item.nodeId,
        itemsByNodeId,
        relationsById,
        false,
        true,
        { causeId: cause.causeId, field },
      );
    }
    assertPersonalReminderAiDependencySemantics(
      cause.aiDependencies.responseMembership,
      "personal reminder causeのresponse membership AI依存",
      item.nodeId,
      itemsByNodeId,
      relationsById,
      false,
      true,
    );
    assertPersonalReminderAiDependencySemantics(
      cause.currentInput.aiDependency,
      "personal reminder causeのcurrent input AI依存",
      item.nodeId,
      itemsByNodeId,
      relationsById,
      false,
      true,
    );
  }
  if (
    item.personalReminderCausePlanning.status === "completed" &&
    "causeSetAiDependency" in item.personalReminderCausePlanning
  ) {
    assertPersonalReminderAiDependencySemantics(
      item.personalReminderCausePlanning.causeSetAiDependency,
      "personal reminder cause setのAI依存",
      item.nodeId,
      itemsByNodeId,
      relationsById,
      true,
      true,
    );
    assertPersonalReminderCauseSetSemantics(item, itemsByNodeId, relationsById);
  }
}

export function assertPersonalReminderCausePlanningSemantics(
  item: SnapshotTrackedItemPersonalReminderFields,
  legacyPersonalReminder: boolean,
): void {
  if (legacyPersonalReminder) {
    const planning = item.personalReminderCausePlanning;
    if (planning.status === "completed") {
      assertUtcDateTime(planning.observedAt, "personal reminder planningの観測時刻");
      if (planning.observedAt > item.observedAt) {
        throw new StateSnapshotSemanticError(
          "personal reminder planningの観測時刻はitemの観測時刻以前にしてください",
        );
      }
      return;
    }
    if (
      planning.status === "excluded" &&
      (!isTerminalStatus(item.status) || item.personalReminderCauses.length !== 0)
    ) {
      throw new StateSnapshotSemanticError(
        "causeがある、または継続中のitemをpersonal reminder planningから除外できません",
      );
    }
    return;
  }
  const parsedPlanning = personalReminderCausePlanningSchema.safeParse(
    item.personalReminderCausePlanning,
  );
  if (!parsedPlanning.success) {
    throw new StateSnapshotSemanticError("personal reminder causeのplanningが不正です", {
      cause: parsedPlanning.error,
    });
  }
  if (parsedPlanning.data.status === "completed") {
    assertUtcDateTime(parsedPlanning.data.observedAt, "personal reminder planningの観測時刻");
    if (parsedPlanning.data.observedAt > item.observedAt) {
      throw new StateSnapshotSemanticError(
        "personal reminder planningの観測時刻はitemの観測時刻以前にしてください",
      );
    }
    const subjectChanges = parsedPlanning.data.causeSetSubjectChanges;
    if (subjectChanges.scope === "bounded") {
      assertCanonicalPersonalReminderSubjects(
        subjectChanges.addableSubjects,
        "personal reminderで追加され得る主体",
      );
      assertCanonicalPersonalReminderSubjects(
        subjectChanges.removableSubjects,
        "personal reminderで削除され得る主体",
      );
    }
    return;
  }
  if (
    parsedPlanning.data.status === "excluded" &&
    (!isTerminalStatus(item.status) || item.personalReminderCauses.length !== 0)
  ) {
    throw new StateSnapshotSemanticError(
      "causeがある、または継続中のitemをpersonal reminder planningから除外できません",
    );
  }
}
