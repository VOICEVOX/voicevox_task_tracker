import { hashCanonicalJson, serializeCanonicalJson } from "../canonical-json/index.js";
import {
  currentPersonalReminderAssessment,
  personalReminderCauseSchema,
  type CurrentPersonalReminderAssessment,
  type GraphNodeId,
  type PersonalReminderCause,
  type PersonalReminderCauseId,
  type Relation,
} from "../domain/index.js";
import {
  StatePersonalReminderAiDependencyMismatchError,
  StateSnapshotSemanticError,
  type PersonalReminderAiDependencyField,
} from "./errors.js";
import { expectedAiAnalysisDependencyForProducer } from "./snapshot-ai-adoption.js";
import { assertAiAnalysisDependencyIntegrity } from "./snapshot-ai-integrity.js";
import type {
  LegacyRelationWithoutAiDependency,
  SnapshotItemForRelationValidation,
  SnapshotTrackedItemPersonalReminderFields,
} from "./snapshot-contracts.js";
import { assertUnique, assertUtcDateTime, compareStrings } from "./snapshot-values.js";

export function personalReminderSubjectIdentity(subject: {
  kind: "user" | "team";
  candidateId: string;
}): string {
  return `${subject.kind}\u0000${subject.candidateId.toLowerCase()}`;
}

export function assertCanonicalPersonalReminderSubjects(
  subjects: readonly Readonly<{ kind: "user" | "team"; candidateId: string }>[],
  description: string,
): void {
  const identities = subjects.map(personalReminderSubjectIdentity);
  assertUnique(identities, description);
  for (let index = 1; index < identities.length; index += 1) {
    const previous = identities[index - 1];
    const current = identities[index];
    if (previous == null || current == null) {
      throw new StateSnapshotSemanticError(`${description}の並び順を検証できません`);
    }
    if (compareStrings(previous, current) > 0) {
      throw new StateSnapshotSemanticError(`${description}は正規順に並べてください`);
    }
  }
}

function assertPersonalReminderTimeBasis(
  value: PersonalReminderCause["obligationSince"],
  item: SnapshotTrackedItemPersonalReminderFields,
  description: string,
): void {
  assertUtcDateTime(value.at, description);
  if (value.at < item.createdAt || value.at > item.observedAt) {
    throw new StateSnapshotSemanticError(
      `${description}はitemの作成時刻以後かつ観測時刻以前にしてください`,
    );
  }
}

function assertPersonalReminderResponsibilitySemantics(
  cause: Pick<PersonalReminderCause, "responsibility">,
): void {
  if (cause.responsibility.authority === "fixed" && cause.responsibility.scope.kind !== "item") {
    throw new StateSnapshotSemanticError(
      "fixedなpersonal reminder責務はitem scopeでなければなりません",
    );
  }
  if (cause.responsibility.scope.kind === "item") {
    return;
  }
  const surfaceKeys = cause.responsibility.scope.surfaces.map(
    (surface) => `${surface.kind}:${surface.nodeId}`,
  );
  assertUnique(surfaceKeys, "personal reminder execution surface");
}

function assertPersonalReminderLastConfirmedActionability(
  cause: Pick<PersonalReminderCause, "lastConfirmedActionability">,
  assessment: CurrentPersonalReminderAssessment,
): void {
  if (assessment.status !== "available") {
    return;
  }
  if (assessment.result.verdict === "unknown") {
    return;
  }
  const last = cause.lastConfirmedActionability;
  if (assessment.result.verdict === "actionable") {
    if (last.status !== "confirmed" || last.verdict !== "actionable") {
      throw new StateSnapshotSemanticError(
        "有効なactionable判定がlastConfirmedActionabilityへ反映されていません",
      );
    }
    return;
  }
  if (assessment.result.verdict === "waiting") {
    if (
      last.status !== "confirmed" ||
      last.verdict !== "waiting" ||
      last.waitingFor.itemNodeId !== assessment.result.waitingFor.itemNodeId ||
      last.waitingFor.action !== assessment.result.waitingFor.action
    ) {
      throw new StateSnapshotSemanticError(
        "有効なwaiting判定がlastConfirmedActionabilityへ反映されていません",
      );
    }
    return;
  }
  if (last.status !== "confirmed" || last.verdict !== "not_actionable") {
    throw new StateSnapshotSemanticError(
      "有効なnot actionable判定がlastConfirmedActionabilityへ反映されていません",
    );
  }
  if (last.reason !== assessment.result.verdict) {
    throw new StateSnapshotSemanticError(
      "lastConfirmedActionabilityのnot actionable理由が一致しません",
    );
  }
}

export function assertPersonalReminderCausesSemantics(
  item: SnapshotTrackedItemPersonalReminderFields,
  causeIds: ReadonlySet<string>,
  legacyPersonalReminder: boolean,
): void {
  assertUnique(
    item.personalReminderCauses.map((cause) => cause.causeId),
    "itemのpersonal reminder cause ID",
  );
  assertUnique(
    item.personalReminderCauses.map((cause) => cause.responsibilityId),
    "itemのpersonal reminder responsibility ID",
  );
  for (const cause of item.personalReminderCauses) {
    if (!legacyPersonalReminder) {
      const parsedCause = personalReminderCauseSchema.safeParse(cause);
      if (!parsedCause.success) {
        throw new StateSnapshotSemanticError("personal reminder causeが不正です", {
          cause: parsedCause.error,
        });
      }
    }
    if (cause.itemNodeId !== item.nodeId) {
      throw new StateSnapshotSemanticError(
        "personal reminder causeのitemNodeIdが親itemと一致しません",
      );
    }
    assertPersonalReminderResponsibilitySemantics(cause);
    if (
      !legacyPersonalReminder &&
      "responseMembershipAssessmentRequirement" in cause &&
      cause.responsibility.authority === "semantic" &&
      cause.responseMembershipAssessmentRequirement.status !== "required"
    ) {
      throw new StateSnapshotSemanticError(
        "semanticなpersonal reminder責務の人物所属には意味判定が必要です",
      );
    }
    if (cause.latestAttempt.status === "completed" && cause.latestAttempt.origin.kind === "ai") {
      if (
        cause.latestAttempt.origin.metadata.inputFingerprint !==
        cause.latestAttempt.inputFingerprint
      ) {
        throw new StateSnapshotSemanticError(
          "personal reminder AIのlatest attemptとmetadataのinput fingerprintが一致しません",
        );
      }
    }
    if (
      cause.adoptedAssessment.status === "available" &&
      cause.adoptedAssessment.origin.kind === "ai"
    ) {
      if (
        cause.adoptedAssessment.origin.metadata.inputFingerprint !==
        cause.adoptedAssessment.inputFingerprint
      ) {
        throw new StateSnapshotSemanticError(
          "personal reminder AIの採用結果とmetadataのinput fingerprintが一致しません",
        );
      }
      if (
        cause.adoptedAssessment.origin.metadata.rulesVersion !==
        cause.adoptedAssessment.rulesVersion
      ) {
        throw new StateSnapshotSemanticError(
          "personal reminder AIの採用結果とmetadataのrules versionが一致しません",
        );
      }
      if (
        hashCanonicalJson(cause.adoptedAssessment.result) !==
        cause.adoptedAssessment.origin.metadata.outputHash
      ) {
        throw new StateSnapshotSemanticError(
          "personal reminder AIの採用結果とmetadataのoutput hashが一致しません",
        );
      }
    }
    if (
      cause.latestAttempt.status === "completed" &&
      cause.latestAttempt.origin.kind === "ai" &&
      cause.adoptedAssessment.status === "available"
    ) {
      if (cause.adoptedAssessment.origin.kind !== "ai") {
        throw new StateSnapshotSemanticError(
          "personal reminder AIのlatest attemptと採用結果のoriginが一致しません",
        );
      }
      if (
        cause.latestAttempt.origin.cacheEntryId !== cause.adoptedAssessment.origin.cacheEntryId ||
        serializeCanonicalJson(cause.latestAttempt.origin.metadata) !==
          serializeCanonicalJson(cause.adoptedAssessment.origin.metadata)
      ) {
        throw new StateSnapshotSemanticError(
          "personal reminder AIのlatest attemptと採用結果のmetadataが一致しません",
        );
      }
    }
    assertPersonalReminderTimeBasis(
      cause.obligationSince,
      item,
      "personal reminder obligationSince",
    );
    if (cause.actionableClock.status === "observed") {
      assertPersonalReminderTimeBasis(
        cause.actionableClock.actionableSince,
        item,
        "personal reminder actionableSince",
      );
      assertPersonalReminderTimeBasis(
        cause.actionableClock.stallSince,
        item,
        "personal reminder stallSince",
      );
    }
    const assessment = currentPersonalReminderAssessment(cause);
    if (
      assessment.status === "available" &&
      cause.responsibility.authority === "fixed" &&
      assessment.result.verdict === "not_required"
    ) {
      throw new StateSnapshotSemanticError(
        "fixedなpersonal reminder責務はnot_requiredへ変更できません",
      );
    }
    if (
      "responseMembershipAssessmentRequirement" in cause &&
      assessment.status === "available" &&
      (assessment.result.verdict === "duplicate" || assessment.result.verdict === "not_required") &&
      cause.responseMembershipAssessmentRequirement.status === "not_required"
    ) {
      throw new StateSnapshotSemanticError(
        "responseを除外するpersonal reminder判定には人物所属の意味判定が必要です",
      );
    }
    assertPersonalReminderLastConfirmedActionability(cause, assessment);
    if (assessment.status !== "available") {
      continue;
    }
    if (
      cause.currentInput.completeness.status === "incomplete" &&
      (assessment.result.verdict !== "unknown" || assessment.result.reason !== "incomplete_input")
    ) {
      throw new StateSnapshotSemanticError(
        "入力が不完全なpersonal reminder causeはincomplete_inputのunknownでなければなりません",
      );
    }
    if (cause.actionableClock.status === "observed") {
      if (cause.obligationSince.at > cause.actionableClock.actionableSince.at) {
        throw new StateSnapshotSemanticError(
          "personal reminder actionableSinceはobligationSince以後にしてください",
        );
      }
      if (cause.actionableClock.actionableSince.at > cause.actionableClock.stallSince.at) {
        throw new StateSnapshotSemanticError(
          "personal reminder stallSinceはactionableSince以後にしてください",
        );
      }
    }
    if (assessment.result.verdict === "actionable" && cause.actionableClock.status !== "observed") {
      throw new StateSnapshotSemanticError(
        "actionableなpersonal reminder causeにはactionable clockが必要です",
      );
    }
    if (assessment.result.verdict === "duplicate") {
      if (assessment.result.canonicalCauseId === cause.causeId) {
        throw new StateSnapshotSemanticError(
          "personal reminder causeが自分自身をduplicateの参照先にしています",
        );
      }
      if (!causeIds.has(assessment.result.canonicalCauseId)) {
        throw new StateSnapshotSemanticError(
          "personal reminder causeのduplicate参照先がsnapshotにありません",
        );
      }
    }
  }
}

export function isLegacyPersonalReminder(item: SnapshotTrackedItemPersonalReminderFields): boolean {
  return (
    item.personalReminderCauses.some((cause) => !("aiDependencies" in cause)) ||
    (item.personalReminderCausePlanning.status === "completed" &&
      (!("causeSetAiDependency" in item.personalReminderCausePlanning) ||
        !("causeSetSubjectChanges" in item.personalReminderCausePlanning)))
  );
}

export function assertPersonalReminderAiDependencySemantics(
  dependency: unknown,
  description: string,
  itemNodeId: GraphNodeId,
  itemsByNodeId: ReadonlyMap<string, SnapshotItemForRelationValidation>,
  relationsById: ReadonlyMap<string, Relation | LegacyRelationWithoutAiDependency>,
  restrictItemProducer: boolean,
  allowHiddenProducerlessSentinels: boolean,
  mismatchDetails?: Readonly<{
    causeId: PersonalReminderCauseId;
    field: PersonalReminderAiDependencyField;
  }>,
): void {
  const dependencyValue = assertAiAnalysisDependencyIntegrity(dependency, description, {
    allowStaleRepository: false,
    allowProducerlessNotRecorded: true,
    allowProducerlessMigration: true,
    allowProducerlessStaleRepository: false,
    allowHiddenProducerlessNotRecorded: allowHiddenProducerlessSentinels,
    allowHiddenProducerlessMigration: allowHiddenProducerlessSentinels,
    allowHiddenProducerlessStaleRepository: false,
    dependencyForProducer: (producer, producerDescription, containingDependency) =>
      expectedAiAnalysisDependencyForProducer(
        producer,
        producerDescription,
        itemsByNodeId,
        relationsById,
        containingDependency,
      ),
    onMismatch:
      mismatchDetails == null
        ? undefined
        : (actualDependency, resolvedProducerDependencies, expectedDependency) =>
            new StatePersonalReminderAiDependencyMismatchError({
              itemNodeId,
              causeId: mismatchDetails.causeId,
              field: mismatchDetails.field,
              actualDependency,
              resolvedProducerDependencies,
              expectedDependency,
            }),
  });
  if (dependencyValue.status === "not_dependent") {
    return;
  }
  for (const producer of dependencyValue.producers ?? []) {
    if (
      restrictItemProducer &&
      producer.kind === "relation_candidate" &&
      !producer.endpointNodeIds.includes(itemNodeId)
    ) {
      throw new StateSnapshotSemanticError(
        `${description}のrelation candidate endpointが親itemと一致しません`,
      );
    }
    if (
      restrictItemProducer &&
      producer.kind === "item_element" &&
      producer.nodeId !== itemNodeId
    ) {
      throw new StateSnapshotSemanticError(`${description}のitem producerが親itemと一致しません`);
    }
    if (restrictItemProducer && producer.kind === "relation") {
      const relation = relationsById.get(producer.relationId);
      if (
        relation == null ||
        (relation.fromNodeId !== itemNodeId && relation.toNodeId !== itemNodeId)
      ) {
        throw new StateSnapshotSemanticError(
          `${description}のrelation producer endpointが親itemと一致しません`,
        );
      }
    }
  }
}
