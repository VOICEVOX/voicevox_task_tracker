import { aiAnalysisDependencySchema, type UtcIsoDateTime } from "../domain/index.js";
import { normalizeEvidence } from "./reconcile-graph-candidates.js";
import { validateConfidence, validateUtcIsoDateTime } from "./reconcile-graph-sources.js";
import { type GraphEdgeHistoryEvent, type ReconciledGraphEdge } from "./reconcile-graph-types.js";
import { type RelationCandidateId } from "./relation-candidate-types.js";

function validatePreviousEdge(edge: ReconciledGraphEdge, reconciledAt: UtcIsoDateTime): void {
  if (edge.id.length === 0) {
    throw new TypeError("前回graphのedge IDは空にできません");
  }
  if (edge.fromNodeId === edge.toNodeId) {
    throw new TypeError(`前回graphのedge ${edge.id}は同じnodeを接続できません`);
  }
  if (edge.authoritative !== (edge.provenance === "native")) {
    throw new TypeError(`前回graphのedge ${edge.id}のauthoritative情報が不整合です`);
  }
  validateConfidence(edge.confidence, `前回graphのedge ${edge.id}のconfidence`);
  validateUtcIsoDateTime(edge.firstSeenAt, `前回graphのedge ${edge.id}のfirstSeenAt`);
  validateUtcIsoDateTime(edge.lastConfirmedAt, `前回graphのedge ${edge.id}のlastConfirmedAt`);
  if (edge.firstSeenAt > edge.lastConfirmedAt) {
    throw new RangeError(`前回graphのedge ${edge.id}の確認時刻が初回検出時刻より前です`);
  }
  if (edge.lastConfirmedAt > reconciledAt) {
    throw new RangeError(`reconcile時刻がedge ${edge.id}の最終確認時刻より前です`);
  }
  normalizeEvidence(edge.evidence);
  const aiDependencyResult = aiAnalysisDependencySchema.safeParse(edge.aiDependency);
  if (!aiDependencyResult.success) {
    throw new TypeError(`前回graphのedge ${edge.id}のAI依存が不正です`, {
      cause: aiDependencyResult.error,
    });
  }
  if (edge.provenance === "native" && edge.aiDependency.status !== "not_dependent") {
    throw new TypeError(`native edge ${edge.id}のAI依存はnot_dependentでなければなりません`);
  }
  if (edge.provenance !== "native" && edge.aiDependency.status === "not_dependent") {
    throw new TypeError(`inferred edge ${edge.id}のAI依存はnot_dependentにできません`);
  }
  if (
    edge.active &&
    edge.provenance !== "native" &&
    edge.aiDependency.status !== "not_dependent" &&
    edge.aiDependency.producers == null &&
    !(
      edge.aiDependency.status === "unknown" &&
      edge.aiDependency.reasons.length === 1 &&
      edge.aiDependency.reasons[0] === "migration"
    )
  ) {
    throw new TypeError(`active inferred edge ${edge.id}のAI依存producerがありません`);
  }
  for (const contradiction of edge.contradictions) {
    validateConfidence(contradiction.confidence, `前回graphのedge ${edge.id}の矛盾confidence`);
    normalizeEvidence(contradiction.evidence);
  }
  if (!edge.active) {
    validateUtcIsoDateTime(edge.removedAt, `前回graphのedge ${edge.id}のremovedAt`);
    if (edge.lastConfirmedAt > edge.removedAt) {
      throw new RangeError(`前回graphのedge ${edge.id}の削除時刻が最終確認時刻より前です`);
    }
    if (edge.removedAt > reconciledAt) {
      throw new RangeError(`reconcile時刻がedge ${edge.id}の削除時刻より前です`);
    }
  }
}

export function indexPreviousEdges(
  edges: readonly ReconciledGraphEdge[],
  reconciledAt: UtcIsoDateTime,
): ReadonlyMap<RelationCandidateId, ReconciledGraphEdge> {
  const edgesById = new Map<RelationCandidateId, ReconciledGraphEdge>();
  for (const edge of edges) {
    validatePreviousEdge(edge, reconciledAt);
    if (edgesById.has(edge.id)) {
      throw new TypeError(`前回graphのedge ID ${edge.id}が重複しています`);
    }
    edgesById.set(edge.id, edge);
  }
  return edgesById;
}

export function validatePreviousHistoryEvents(
  events: readonly GraphEdgeHistoryEvent[],
  reconciledAt: UtcIsoDateTime,
): void {
  let previousOccurredAt: UtcIsoDateTime | null = null;
  for (const event of events) {
    validateUtcIsoDateTime(event.occurredAt, `edge ${event.edgeId}の履歴時刻`);
    if (event.occurredAt > reconciledAt) {
      throw new RangeError(`reconcile時刻がedge ${event.edgeId}の履歴時刻より前です`);
    }
    if (previousOccurredAt != null && previousOccurredAt > event.occurredAt) {
      throw new RangeError("前回graphの履歴イベントは発生時刻順に指定してください");
    }
    previousOccurredAt = event.occurredAt;
  }
}
