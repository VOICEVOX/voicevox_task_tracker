import type { EvidenceUse } from "../contracts/evidence-closure.js";
import type {
  MaterializedEvidenceReference,
  MaterializedReferenceValues,
} from "./run-validation-reference-contracts.js";
import { RunCompletenessError } from "./run-completeness-error.js";
import {
  causeScope,
  isRecord,
  itemEvidenceScope,
  notificationReasonScope,
  pendingNotificationScope,
  relationScope,
  valueAtPath,
} from "./run-validation-reference-scope.js";
import {
  previousPendingCauseScope,
  type PreviousPendingCauseContext,
} from "./run-validation-previous-ledger-history.js";

type Path = readonly (string | number)[];
export type ReferenceContext = Readonly<{
  purpose: string;
  currentness: EvidenceUse["requiredCurrentness"];
  ownerNodeIds: readonly string[];
  relationIds: readonly string[];
}>;

function aiPurpose(path: Path, element: string): string | undefined {
  if (path.includes("evidence")) return `ai_${element}_evidence`;
  if (element === "waitingOn" && path.includes("sourceIds")) return "ai_waiting_on_candidate";
  if (element === "relations" && path.includes("sourceIds")) return "ai_relation_candidate";
  if (element === "progress" && path.includes("latestMeaningfulSourceId")) return "ai_progress";
  if (element === "selfCommitment" && path.includes("sourceId")) return "ai_self_commitment";
  return undefined;
}

function evidencePurpose(
  reference: MaterializedEvidenceReference,
  values: MaterializedReferenceValues,
): string {
  const evidence = valueAtPath(values, reference.path.slice(0, -1));
  if (!isRecord(evidence) || typeof evidence["supports"] !== "string") {
    throw new RunCompletenessError(
      "invalid_reference",
      reference.sourceId,
      reference.path,
      undefined,
    );
  }
  return `evidence_${evidence["supports"]}`;
}

/** 保存参照の位置から用途と許可される所有範囲を確定する。 */
export function referenceContext(
  reference: MaterializedEvidenceReference,
  values: MaterializedReferenceValues,
  previousPendingCauses: readonly PreviousPendingCauseContext[],
): ReferenceContext {
  const path = reference.path;
  const ownerNodeIds = [reference.owner.id];
  if (path[0] === "snapshot" && path[1] === "items") {
    if (path[3] === "evidence") {
      const scope = itemEvidenceScope(reference, values);
      return {
        purpose: evidencePurpose(reference, values),
        currentness: "historical_allowed",
        ownerNodeIds: scope.nodeIds,
        relationIds: scope.relationIds,
      };
    }
    if (path[3] === "waitingOn") {
      const waiting = valueAtPath(values, path.slice(0, 5));
      if (!isRecord(waiting))
        throw new RunCompletenessError("invalid_reference", reference.sourceId, path, undefined);
      const candidateId = waiting["candidateId"];
      const related = values.snapshot.relations.some((relation) => {
        const from = valueAtPath(relation, ["fromNodeId"]);
        const to = valueAtPath(relation, ["toNodeId"]);
        return (
          (from === reference.owner.id && to === candidateId) ||
          (to === reference.owner.id && from === candidateId)
        );
      });
      return {
        purpose: "waiting_on",
        currentness: "historical_allowed",
        ownerNodeIds:
          waiting["kind"] === "item" && related && typeof candidateId === "string"
            ? [reference.owner.id, candidateId]
            : ownerNodeIds,
        relationIds: [],
      };
    }
    if (path[3] === "inputEvents")
      return {
        purpose: "item_input_event",
        currentness: "historical_allowed",
        ownerNodeIds,
        relationIds: [],
      };
    if (path[3] === "aiAnalysis") {
      const element = path[5];
      const purpose = typeof element === "string" ? aiPurpose(path.slice(6), element) : undefined;
      if (purpose != null)
        return { purpose, currentness: "historical_allowed", ownerNodeIds, relationIds: [] };
    }
    if (path[3] === "personalReminderCauses") {
      const scope = causeScope(reference, values);
      if (path[5] === "evidenceSourceIds")
        return {
          purpose: "personal_reminder_cause",
          currentness: "historical_allowed",
          ownerNodeIds: scope.nodeIds,
          relationIds: scope.relationIds,
        };
      if (path[5] === "adoptedAssessment")
        return {
          purpose: "personal_reminder_assessment",
          currentness: "historical_allowed",
          ownerNodeIds: scope.nodeIds,
          relationIds: scope.relationIds,
        };
      if (path.includes("sourceIds"))
        return {
          purpose: "personal_reminder_event_basis",
          currentness: "historical_allowed",
          ownerNodeIds: scope.nodeIds,
          relationIds: scope.relationIds,
        };
    }
  }
  if (path[0] === "snapshot" && path[1] === "relations" && path[3] === "evidence") {
    const relationIndex = path[2];
    const relation =
      typeof relationIndex === "number" ? values.snapshot.relations[relationIndex] : undefined;
    const from = valueAtPath(relation, ["fromNodeId"]);
    const to = valueAtPath(relation, ["toNodeId"]);
    if (typeof from !== "string" || typeof to !== "string")
      throw new RunCompletenessError("invalid_reference", reference.sourceId, path, undefined);
    return {
      purpose: evidencePurpose(reference, values),
      currentness: "historical_allowed",
      ownerNodeIds: [from, to],
      relationIds: [reference.owner.id],
    };
  }
  if (
    path[0] === "snapshot" &&
    path[1] === "collection" &&
    path[2] === "repositories" &&
    path[4] === "items" &&
    path[6] === "aiAnalysis"
  ) {
    const element = path[8];
    const purpose = typeof element === "string" ? aiPurpose(path.slice(9), element) : undefined;
    if (purpose != null)
      return { purpose, currentness: "historical_allowed", ownerNodeIds, relationIds: [] };
  }
  if (path[0] === "historyInputEvents") {
    const event = valueAtPath(values, path.slice(0, 2));
    const kind = valueAtPath(event, ["kind"]);
    if (typeof kind === "string")
      return { purpose: `history_${kind}`, currentness: "current", ownerNodeIds, relationIds: [] };
  }
  if (path[0] === "aiCacheAdditions") {
    const element = valueAtPath(values, path.slice(0, 2).concat("element"));
    const purpose = typeof element === "string" ? aiPurpose(path.slice(4), element) : undefined;
    if (purpose != null) return { purpose, currentness: "current", ownerNodeIds, relationIds: [] };
  }
  if (path[0] === "personalReminderAiCacheAdditions") {
    const index = path[1];
    const addition =
      typeof index === "number" ? values.personalReminderAiCacheAdditions[index] : undefined;
    if (addition == null) {
      throw new RunCompletenessError("missing_value", reference.sourceId, path, undefined);
    }
    const scope = relationScope(
      values,
      reference.owner.id,
      addition.generation.result.references.relationIds,
      path,
    );
    return {
      purpose: "personal_reminder_cache",
      currentness: "current",
      ownerNodeIds: scope.nodeIds,
      relationIds: scope.relationIds,
    };
  }
  if (path[0] === "previousNotificationLedger" && path[1] === "pendingNotifications") {
    const pendingIndex = path[2];
    if (typeof pendingIndex !== "number")
      throw new RunCompletenessError("invalid_reference", reference.sourceId, path, undefined);
    const scope = previousPendingCauseScope(pendingIndex, previousPendingCauses);
    return {
      purpose: "previous_notification_pending",
      currentness: "historical_allowed",
      ownerNodeIds: scope.nodeIds,
      relationIds: scope.relationIds,
    };
  }
  if (
    (path[0] === "notificationLedger" || path[0] === "notificationSelection") &&
    path[1] === "pendingNotifications"
  ) {
    const scope = pendingNotificationScope(reference, values);
    return {
      purpose: "personal_reminder_event_basis",
      currentness: "historical_allowed",
      ownerNodeIds: scope.nodeIds,
      relationIds: scope.relationIds,
    };
  }
  if (
    path[0] === "notificationSelection" &&
    path[1] === "candidates" &&
    path[3] === "reasons" &&
    path[5] === "source" &&
    path[6] === "context" &&
    path.includes("sourceIds")
  ) {
    const scope = notificationReasonScope(reference, values);
    return {
      purpose: "personal_reminder_event_basis",
      currentness: "historical_allowed",
      ownerNodeIds: scope.nodeIds,
      relationIds: scope.relationIds,
    };
  }
  throw new RunCompletenessError("invalid_reference", reference.sourceId, path, undefined);
}

/** event起点のsource参照と今回時刻の整合を確認する。 */
export function assertEventBasisReference(
  reference: MaterializedEvidenceReference,
  values: MaterializedReferenceValues,
): void {
  const path = reference.path;
  if (path[path.length - 2] !== "sourceIds") return;
  const basis = valueAtPath(values, path.slice(0, -2));
  if (!isRecord(basis) || basis["source"] !== "event" || typeof basis["at"] !== "string") {
    if (path[0] === "snapshot" && path.includes("references")) return;
    if (path[0] === "snapshot" && path[3] === "waitingOn") return;
    if (path[0] === "snapshot" && path.includes("aiAnalysis")) return;
    if (path[0] === "aiCacheAdditions" || path[0] === "personalReminderAiCacheAdditions") return;
    throw new RunCompletenessError("invalid_reference", reference.sourceId, path, undefined);
  }
  const at = Date.parse(basis["at"]);
  if (!Number.isFinite(at) || at > Date.parse(values.snapshot.generatedAt)) {
    throw new RunCompletenessError("future_source", reference.sourceId, path, undefined);
  }
  if (
    path[0] === "previousNotificationLedger" ||
    path[0] === "notificationLedger" ||
    (path[0] === "notificationSelection" && path[1] === "pendingNotifications")
  ) {
    const pending = valueAtPath(values, path.slice(0, 3));
    const detectedAt = valueAtPath(pending, ["detectedAt"]);
    if (
      typeof detectedAt !== "string" ||
      !Number.isFinite(Date.parse(detectedAt)) ||
      Date.parse(detectedAt) > Date.parse(values.snapshot.generatedAt)
    ) {
      throw new RunCompletenessError("future_source", reference.sourceId, path, undefined);
    }
  }
}
