import type {
  PersonalReminderCause,
  PersonalReminderTimeBasis,
} from "../../../domain/personal-reminder-causes.js";
import type { SourceId } from "../../../domain/source-id.js";
import { createGitHubNodeId, type Evidence } from "../../../domain/types.js";
import { type PendingNotification } from "../../../domain/pending-notification.js";
import type { ReconciledGraphEdge } from "../../../graph/reconcile-graph-types.js";
import type { EvidenceClosureOutward, EvidenceUse } from "../contracts/evidence-closure.js";
import {
  walkAiCacheResult,
  walkGenericAiAdoptions,
  walkTrackedItemAiAnalysis,
} from "./evidence-closure-walk-ai.js";
import { collectEvidenceUses, type EvidenceUseSink } from "./evidence-closure-walk-common.js";
import { personalReminderCauseEvidenceSourceIds } from "./personal-reminder-cause-references.js";
import { personalReminderCauseScope, relatedScope } from "./personal-reminder-related-scope.js";
import { RunCompletenessError } from "./run-completeness-error.js";

function walkEvidence(
  emit: EvidenceUseSink,
  evidence: readonly Evidence[],
  path: readonly (string | number)[],
  destination: EvidenceUse["destination"],
  ownerNodeIds: readonly string[],
  relationIds: readonly string[],
): void {
  for (const [index, record] of evidence.entries()) {
    emit(
      record.sourceId,
      [...path, index, "sourceId"],
      destination,
      `evidence_${record.supports}`,
      "historical_allowed",
      ownerNodeIds,
      relationIds,
    );
  }
}

function walkBasis(
  emit: EvidenceUseSink,
  basis: PersonalReminderTimeBasis,
  path: readonly (string | number)[],
  destination: EvidenceUse["destination"],
  ownerNodeIds: readonly string[],
  relationIds: readonly string[],
): void {
  if (basis.source !== "event") return;
  for (const [index, sourceId] of basis.sourceIds.entries()) {
    emit(
      sourceId,
      [...path, "sourceIds", index],
      destination,
      "personal_reminder_event_basis",
      "historical_allowed",
      ownerNodeIds,
      relationIds,
    );
  }
}

function walkRelation(
  emit: EvidenceUseSink,
  relation: ReconciledGraphEdge,
  path: readonly (string | number)[],
): void {
  const destination: EvidenceUse["destination"] = Object.freeze({
    kind: "relation",
    relationId: relation.id,
  });
  const nodeIds = [relation.fromNodeId, relation.toNodeId];
  walkEvidence(emit, relation.evidence, [...path, "evidence"], destination, nodeIds, [relation.id]);
  for (const [index, contradiction] of relation.contradictions.entries()) {
    walkEvidence(
      emit,
      contradiction.evidence,
      [...path, "contradictions", index, "evidence"],
      destination,
      nodeIds,
      [relation.id],
    );
  }
}

function causeOwnerNodeIds(cause: PersonalReminderCause): readonly string[] {
  return Object.freeze([
    cause.itemNodeId,
    ...(cause.responsibility.scope.kind === "item"
      ? []
      : cause.responsibility.scope.surfaces.map((surface) => surface.nodeId)),
  ]);
}

function itemEvidenceScope(
  entry: EvidenceClosureOutward["items"][number],
  sourceId: SourceId,
  relationsById: ReadonlyMap<string, ReconciledGraphEdge>,
): Readonly<{ nodeIds: readonly string[]; relationIds: readonly string[] }> {
  const itemNodeId = entry.item.nodeId;
  const relationIds = new Set<string>();
  const ownerNodeIds = new Set<string>([itemNodeId]);
  for (const result of entry.causeResults) {
    const references =
      result.cause.adoptedAssessment.status === "available"
        ? result.cause.adoptedAssessment.result.references
        : undefined;
    if (personalReminderCauseEvidenceSourceIds(result.cause).includes(sourceId)) {
      for (const nodeId of causeOwnerNodeIds(result.cause)) ownerNodeIds.add(nodeId);
      for (const relationId of references?.relationIds ?? []) relationIds.add(relationId);
    }
  }
  for (const waiting of entry.item.waitingOn) {
    if (waiting.kind !== "item" || !waiting.sourceIds.includes(sourceId)) continue;
    for (const relation of relationsById.values()) {
      if (
        (relation.fromNodeId === itemNodeId && relation.toNodeId === waiting.candidateId) ||
        (relation.toNodeId === itemNodeId && relation.fromNodeId === waiting.candidateId)
      ) {
        relationIds.add(relation.id);
      }
    }
  }
  for (const relation of relationsById.values()) {
    if (relation.fromNodeId !== itemNodeId && relation.toNodeId !== itemNodeId) continue;
    if (
      relation.evidence.some((evidence) => evidence.sourceId === sourceId) ||
      relation.contradictions.some((contradiction) =>
        contradiction.evidence.some((evidence) => evidence.sourceId === sourceId),
      )
    ) {
      relationIds.add(relation.id);
    }
  }
  const related = relatedScope(itemNodeId, [...relationIds], relationsById, [
    "items",
    itemNodeId,
    "evidence",
    sourceId,
  ]);
  return Object.freeze({
    nodeIds: Object.freeze([...new Set([...related.nodeIds, ...ownerNodeIds])].sort()),
    relationIds: related.relationIds,
  });
}

function walkItemEvidence(
  emit: EvidenceUseSink,
  entry: EvidenceClosureOutward["items"][number],
  path: readonly (string | number)[],
  evidence: readonly Evidence[],
  relationsById: ReadonlyMap<string, ReconciledGraphEdge>,
): void {
  const destination: EvidenceUse["destination"] = Object.freeze({
    kind: "item",
    itemNodeId: entry.item.nodeId,
  });
  for (const [index, record] of evidence.entries()) {
    const scope = itemEvidenceScope(entry, record.sourceId, relationsById);
    emit(
      record.sourceId,
      [...path, index, "sourceId"],
      destination,
      `evidence_${record.supports}`,
      "historical_allowed",
      scope.nodeIds,
      scope.relationIds,
    );
  }
}

function walkItems(
  emit: EvidenceUseSink,
  outward: EvidenceClosureOutward,
  relationsById: ReadonlyMap<string, ReconciledGraphEdge>,
): void {
  for (const [itemIndex, entry] of outward.items.entries()) {
    const item = entry.item;
    const destination: EvidenceUse["destination"] = Object.freeze({
      kind: "item",
      itemNodeId: item.nodeId,
    });
    const base = ["items", itemIndex];
    walkItemEvidence(emit, entry, [...base, "item", "evidence"], item.evidence, relationsById);
    walkItemEvidence(emit, entry, [...base, "evidence"], entry.evidence, relationsById);
    for (const [index, waiting] of item.waitingOn.entries()) {
      const related =
        waiting.kind === "item" &&
        [...relationsById.values()].some(
          (relation) =>
            (relation.fromNodeId === item.nodeId && relation.toNodeId === waiting.candidateId) ||
            (relation.toNodeId === item.nodeId && relation.fromNodeId === waiting.candidateId),
        );
      for (const [sourceIndex, sourceId] of waiting.sourceIds.entries()) {
        emit(
          sourceId,
          [...base, "item", "waitingOn", index, "sourceIds", sourceIndex],
          destination,
          "waiting_on",
          "historical_allowed",
          related ? [item.nodeId, waiting.candidateId] : [item.nodeId],
          [],
        );
      }
    }
    for (const [index, event] of item.inputEvents.entries()) {
      emit(
        event.sourceId,
        [...base, "item", "inputEvents", index, "sourceId"],
        destination,
        "item_input_event",
        "historical_allowed",
        [item.nodeId],
        [],
      );
    }
    walkTrackedItemAiAnalysis(
      emit,
      item.aiAnalysis,
      [...base, "item", "aiAnalysis"],
      destination,
      item.nodeId,
    );
    for (const [causeIndex, result] of entry.causeResults.entries()) {
      const cause = result.cause;
      const causePath = [...base, "causeResults", causeIndex, "cause"];
      const references =
        cause.adoptedAssessment.status === "available"
          ? cause.adoptedAssessment.result.references
          : undefined;
      const scope = personalReminderCauseScope(cause, relationsById, [
        ...causePath,
        "adoptedAssessment",
        "result",
        "references",
        "relationIds",
      ]);
      for (const [index, sourceId] of cause.evidenceSourceIds.entries()) {
        emit(
          sourceId,
          [...causePath, "evidenceSourceIds", index],
          destination,
          "personal_reminder_cause",
          "historical_allowed",
          scope.nodeIds,
          scope.relationIds,
        );
      }
      if (references != null) {
        for (const [index, sourceId] of references.sourceIds.entries()) {
          emit(
            sourceId,
            [...causePath, "adoptedAssessment", "result", "references", "sourceIds", index],
            destination,
            "personal_reminder_assessment",
            "historical_allowed",
            scope.nodeIds,
            scope.relationIds,
          );
        }
      }
      walkBasis(
        emit,
        cause.obligationSince,
        [...causePath, "obligationSince"],
        destination,
        scope.nodeIds,
        scope.relationIds,
      );
      if (cause.actionableClock.status === "observed") {
        walkBasis(
          emit,
          cause.actionableClock.actionableSince,
          [...causePath, "actionableClock", "actionableSince"],
          destination,
          scope.nodeIds,
          scope.relationIds,
        );
        walkBasis(
          emit,
          cause.actionableClock.stallSince,
          [...causePath, "actionableClock", "stallSince"],
          destination,
          scope.nodeIds,
          scope.relationIds,
        );
      }
      if (result.staleness.status === "eligible") {
        walkBasis(
          emit,
          result.staleness.stallSince,
          [...base, "causeResults", causeIndex, "staleness", "stallSince"],
          destination,
          scope.nodeIds,
          scope.relationIds,
        );
      }
    }
  }
}

function walkNotifications(emit: EvidenceUseSink, outward: EvidenceClosureOutward): void {
  const reasons: readonly ("responsibility_changed" | "newly_unblocked")[] = [
    "responsibility_changed",
    "newly_unblocked",
  ];
  for (const [index, value] of outward.notificationCauses.entries()) {
    const destination: EvidenceUse["destination"] = Object.freeze({
      kind: "item",
      itemNodeId: value.itemNodeId,
    });
    const ownerNodeIds = Object.freeze([
      value.itemNodeId,
      ...outward.relations
        .filter((relation) => relation.type === "blocks" && relation.toNodeId === value.itemNodeId)
        .map((relation) => relation.fromNodeId),
    ]);
    for (const reason of reasons) {
      const cause = value.causes[reason];
      if (cause.status !== "complete") continue;
      for (const [evidenceIndex, evidence] of cause.evidence.entries()) {
        emit(
          evidence.sourceId,
          ["notificationCauses", index, "causes", reason, "evidence", evidenceIndex, "sourceId"],
          destination,
          "notification_cause",
          "current",
          ownerNodeIds,
          [],
        );
      }
    }
    if (value.dependencyCause.status === "complete") {
      for (const [evidenceIndex, evidence] of value.dependencyCause.evidence.entries()) {
        emit(
          evidence.sourceId,
          ["notificationCauses", index, "dependencyCause", "evidence", evidenceIndex, "sourceId"],
          destination,
          "notification_dependency_cause",
          "current",
          ownerNodeIds,
          [],
        );
      }
    }
  }
}

function walkPendingNotification(
  emit: EvidenceUseSink,
  pending: PendingNotification,
  index: number,
  outward: EvidenceClosureOutward,
  relationsById: ReadonlyMap<string, ReconciledGraphEdge>,
): void {
  const target = pending.target;
  if (target.kind !== "personal_reminder") return;
  const cause = outward.items
    .find((entry) => entry.item.nodeId === pending.itemNodeId)
    ?.causeResults.find((result) => result.cause.causeId === target.causeId)?.cause;
  const scope =
    cause == null
      ? { nodeIds: [pending.itemNodeId], relationIds: [] }
      : personalReminderCauseScope(cause, relationsById, [
          "pendingNotifications",
          index,
          "target",
          "causeId",
        ]);
  const destination: EvidenceUse["destination"] = Object.freeze({
    kind: "item",
    itemNodeId: pending.itemNodeId,
  });
  walkBasis(
    emit,
    target.actionableSince,
    ["pendingNotifications", index, "target", "actionableSince"],
    destination,
    scope.nodeIds,
    scope.relationIds,
  );
  walkBasis(
    emit,
    target.stallSince,
    ["pendingNotifications", index, "target", "stallSince"],
    destination,
    scope.nodeIds,
    scope.relationIds,
  );
}

/** 現存するoutward型のsource参照を用途と所有範囲付きで列挙する。 */
export function walkOutwardEvidenceUses(outward: EvidenceClosureOutward): readonly EvidenceUse[] {
  return collectEvidenceUses((emit) => {
    const relationsById = new Map(outward.relations.map((relation) => [relation.id, relation]));
    if (relationsById.size !== outward.relations.length) {
      throw new RunCompletenessError("source_id_conflict", "relation", ["relations"], undefined);
    }
    walkItems(emit, outward, relationsById);
    for (const [index, item] of outward.collectionAiItems.entries()) {
      walkTrackedItemAiAnalysis(
        emit,
        item.aiAnalysis,
        ["collectionAiItems", index, "aiAnalysis"],
        Object.freeze({ kind: "item", itemNodeId: item.nodeId }),
        item.nodeId,
      );
    }
    for (const [index, relation] of outward.relations.entries()) {
      walkRelation(emit, relation, ["relations", index]);
    }
    walkGenericAiAdoptions(emit, outward.aiItems);
    for (const [index, event] of outward.historyInputEvents.entries()) {
      emit(
        event.sourceId,
        ["historyInputEvents", index, "sourceId"],
        Object.freeze({ kind: "item", itemNodeId: createGitHubNodeId(event.itemNodeId) }),
        `history_${event.kind}`,
        "current",
        [event.itemNodeId],
        [],
      );
    }
    for (const [index, addition] of outward.aiCacheAdditions.entries()) {
      walkAiCacheResult(
        emit,
        addition.element,
        addition.result,
        ["aiCacheAdditions", index, "result"],
        addition.itemNodeId,
      );
    }
    for (const [index, addition] of outward.personalReminderAiCacheAdditions.entries()) {
      const scope = relatedScope(
        addition.itemNodeId,
        addition.result.references.relationIds,
        relationsById,
        ["personalReminderAiCacheAdditions", index, "result", "references", "relationIds"],
      );
      for (const [sourceIndex, sourceId] of addition.result.references.sourceIds.entries()) {
        emit(
          sourceId,
          [
            "personalReminderAiCacheAdditions",
            index,
            "result",
            "references",
            "sourceIds",
            sourceIndex,
          ],
          Object.freeze({ kind: "item", itemNodeId: addition.itemNodeId }),
          "personal_reminder_cache",
          "current",
          scope.nodeIds,
          scope.relationIds,
        );
      }
    }
    walkNotifications(emit, outward);
    for (const [index, pending] of outward.pendingNotifications.entries()) {
      walkPendingNotification(emit, pending, index, outward, relationsById);
    }
  });
}
