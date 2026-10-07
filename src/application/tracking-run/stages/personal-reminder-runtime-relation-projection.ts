import type {
  PersonalReminderAiRelationContext,
  PersonalReminderPendingRelation,
} from "../../../codex/personal-reminder-input-contracts.js";
import type {
  PersonalReminderItem,
  PersonalReminderReviewRequestTarget,
} from "../../../domain/personal-reminder-planning.js";
import type { SourceId } from "../../../domain/source-id.js";
import type { GraphNodeId } from "../../../domain/types.js";
import type {
  PendingRelationCandidateResolution,
  ReconciledGraphEdge,
} from "../../../graph/index.js";
import { assertNonNullable } from "../../../util/index.js";
import { compareStrings, createNonEmptySourceIds } from "./personal-reminder-runtime-common.js";
import {
  addRuntimeSource,
  createRuntimeSourceRoles,
} from "./personal-reminder-runtime-source-projection.js";
import type {
  PersonalReminderRuntimeCandidateRelation,
  PersonalReminderRuntimeContextItem,
  PersonalReminderRuntimeSource,
  PersonalReminderRuntimeSourceProjection,
} from "./personal-reminder-runtime-contracts.js";
import type {
  PersonalReminderInputCompleteness,
  PersonalReminderMissingInput,
} from "../../../domain/personal-reminder-causes.js";

/** 確定edgeをAI入力用のrelationへ変換する。 */
export function relationContextFromEdge(
  relation: ReconciledGraphEdge & Readonly<{ active: true }>,
): PersonalReminderAiRelationContext {
  const evidenceSourceIds = createNonEmptySourceIds(
    relation.evidence.map((evidence) => evidence.sourceId),
    `relation ${relation.id}`,
  );
  return Object.freeze({
    id: relation.id,
    fromNodeId: relation.fromNodeId,
    toNodeId: relation.toNodeId,
    type: relation.type,
    provenance: relation.provenance,
    confidence: relation.confidence,
    authoritative: relation.authoritative,
    evidenceSourceIds: [...evidenceSourceIds],
  });
}

function relationSourcesFromEdge(
  relation: ReconciledGraphEdge & Readonly<{ active: true }>,
  canonicalSourcesById: ReadonlyMap<SourceId, PersonalReminderRuntimeSource>,
): PersonalReminderRuntimeSourceProjection {
  const sources = new Map<SourceId, PersonalReminderRuntimeSource>();
  const missingSourceIds = new Set<SourceId>();
  for (const evidence of relation.evidence) {
    const canonicalSource = canonicalSourcesById.get(evidence.sourceId);
    if (canonicalSource == null) {
      missingSourceIds.add(evidence.sourceId);
      continue;
    }
    addRuntimeSource(
      sources,
      Object.freeze({
        source: canonicalSource.source,
        roles: createRuntimeSourceRoles([...canonicalSource.roles, "relation"]),
        evidence: Object.freeze([evidence]),
        causalPush: canonicalSource.causalPush,
      }),
    );
  }
  return Object.freeze({
    sources: Object.freeze([...sources.values()]),
    missingSourceIds: Object.freeze([...missingSourceIds].sort(compareStrings)),
  });
}

/** 確定edgeの根拠sourceを収集する。 */
export function relationSourceProjectionForEdges(
  relations: readonly (ReconciledGraphEdge & Readonly<{ active: true }>)[],
  canonicalSourcesById: ReadonlyMap<SourceId, PersonalReminderRuntimeSource>,
): PersonalReminderRuntimeSourceProjection {
  const sources = new Map<SourceId, PersonalReminderRuntimeSource>();
  const missingSourceIds = new Set<SourceId>();
  for (const relation of relations) {
    const projection = relationSourcesFromEdge(relation, canonicalSourcesById);
    for (const source of projection.sources) {
      addRuntimeSource(sources, source);
    }
    for (const sourceId of projection.missingSourceIds) {
      missingSourceIds.add(sourceId);
    }
  }
  return Object.freeze({
    sources: Object.freeze([...sources.values()]),
    missingSourceIds: Object.freeze([...missingSourceIds].sort(compareStrings)),
  });
}

/** 未確定候補を原因入力用のrelationへ変換する。 */
export function pendingRelationContext(
  candidate: PersonalReminderRuntimeCandidateRelation,
  resolution: PendingRelationCandidateResolution,
): PersonalReminderPendingRelation {
  const endpointNodeIds: [GraphNodeId, GraphNodeId] = [
    candidate.endpointNodeIds[0],
    candidate.endpointNodeIds[1],
  ];
  return Object.freeze({
    candidateId: candidate.candidateId,
    endpointNodeIds,
    status: "pending",
    reason: resolution.reason,
    evidenceSourceIds: [...candidate.evidenceSourceIds],
  });
}

/** 現在のreview依頼先を項目から取得する。 */
export function currentReviewTargetFromItem(
  item: PersonalReminderItem,
): readonly PersonalReminderReviewRequestTarget[] {
  if (item.type !== "pull_request") {
    return Object.freeze([]);
  }
  return Object.freeze(
    item.reviewRequests.map((request) =>
      request.target.type === "user"
        ? Object.freeze({ kind: "user", candidateId: request.target.actor.login })
        : Object.freeze({
            kind: "team",
            candidateId: `${request.target.organizationLogin}/${request.target.slug}`,
          }),
    ),
  );
}

/** 確定relationが参照するsource IDを集める。 */
export function sourceIdsForRelationContexts(
  relations: readonly PersonalReminderAiRelationContext[],
): readonly SourceId[] {
  return relations.flatMap((relation) => relation.evidenceSourceIds);
}

/** 未確定relationが参照するsource IDを集める。 */
export function sourceIdsForPendingRelations(
  relations: readonly PersonalReminderPendingRelation[],
): readonly SourceId[] {
  return relations.flatMap((relation) => relation.evidenceSourceIds);
}

/** 原因入力に不足する項目を確定する。 */
export function completenessForCause(
  item: PersonalReminderRuntimeContextItem,
  pendingRelations: readonly PersonalReminderPendingRelation[],
  additionalMissing: readonly PersonalReminderMissingInput[],
): PersonalReminderInputCompleteness {
  if (
    item.completeness.status === "complete" &&
    pendingRelations.length === 0 &&
    additionalMissing.length === 0
  ) {
    return Object.freeze({ status: "complete" });
  }
  const missing = item.completeness.status === "incomplete" ? [...item.completeness.missing] : [];
  if (pendingRelations.length !== 0 && !missing.includes("relation_evidence")) {
    missing.push("relation_evidence");
  }
  for (const value of additionalMissing) {
    if (!missing.includes(value)) {
      missing.push(value);
    }
  }
  const first = missing[0];
  assertNonNullable(first, "不完全cause入力の不足項目がありません");
  return Object.freeze({
    status: "incomplete",
    missing: [first, ...missing.slice(1)],
  });
}
