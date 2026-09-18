import {
  createUtcIsoDateTime,
  aiAnalysisDependencyForRelation,
  aiAnalysisDependencySchema,
  type AiAnalysisDependency,
  type Evidence,
  type EvidenceSupport,
  type GraphNodeId,
  type RelationProvenance,
  type SourceId,
  type UtcIsoDateTime,
} from "../domain/index.js";
import { assertNonNullable, UnreachableError } from "../util/index.js";
import {
  type CandidateRelation,
  type RelationCandidate,
  type RelationCandidateId,
  type RelationCandidateNode,
} from "./relation-candidate-types.js";
import { normalizeRelationCandidates } from "./normalize-relation-candidates.js";
import {
  type BlockedByEntry,
  type CanonicalRelation,
  type GraphEdgeChangedField,
  type GraphEdgeHistoryEvent,
  type ReconcileGraphInput,
  type ReconcileGraphResult,
  type ReconciledGraphEdge,
  type RelationCandidateAssessment,
  type RelationCandidateDecisionProof,
  type RelationCandidateResolution,
  type RelationContradiction,
} from "./reconcile-graph-types.js";

type GraphEdgeDraft = CanonicalRelation &
  Readonly<{
    id: RelationCandidateId;
    provenance: RelationProvenance;
    confidence: number;
    evidence: readonly Evidence[];
    authoritative: boolean;
    contradictions: readonly RelationContradiction[];
    aiDependency: AiAnalysisDependency;
    firstSeenAt: UtcIsoDateTime;
  }>;

type CandidateResolutionResult = Readonly<{
  edgeDraft: GraphEdgeDraft | null;
  resolution: RelationCandidateResolution;
  dependency: AiAnalysisDependency;
  canonicalRelation?: CanonicalRelation;
}>;

function compareStrings(left: string, right: string): -1 | 0 | 1 {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function validateConfidence(value: number, context: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError(`${context}は0以上1以下で指定してください`);
  }
}

function validateSourceIds(sourceIds: readonly SourceId[], context: string): void {
  if (sourceIds.length === 0) {
    throw new TypeError(`${context}にはsource IDが1件以上必要です`);
  }
  if (sourceIds.some((sourceId) => sourceId.length === 0)) {
    throw new TypeError(`${context}のsource IDは空にできません`);
  }
  if (new Set(sourceIds).size !== sourceIds.length) {
    throw new TypeError(`${context}のsource IDが重複しています`);
  }
}

function validateUtcIsoDateTime(value: UtcIsoDateTime, context: string): void {
  if (createUtcIsoDateTime(value) !== value) {
    throw new TypeError(`${context}はUTCへ正規化してください`);
  }
}

function validateSourceOccurredAtById(
  sourceOccurredAtById: ReadonlyMap<SourceId, UtcIsoDateTime>,
  reconciledAt: UtcIsoDateTime,
): void {
  for (const [sourceId, occurredAt] of sourceOccurredAtById) {
    validateUtcIsoDateTime(occurredAt, `source ${sourceId}の発生時刻`);
    if (occurredAt > reconciledAt) {
      throw new RangeError(`source ${sourceId}の発生時刻がreconcile時刻より後です`);
    }
  }
}

function resolveCandidateFirstSeenAt(
  candidate: RelationCandidate,
  sourceOccurredAtById: ReadonlyMap<SourceId, UtcIsoDateTime>,
): UtcIsoDateTime {
  const [firstSourceId, ...remainingSourceIds] = candidate.sourceIds;
  const firstOccurredAt = sourceOccurredAtById.get(firstSourceId);
  assertNonNullable(
    firstOccurredAt,
    `関係候補 ${candidate.id}のsource ${firstSourceId}に対応する発生時刻がありません`,
  );
  let earliestOccurredAt = firstOccurredAt;
  for (const sourceId of remainingSourceIds) {
    const occurredAt = sourceOccurredAtById.get(sourceId);
    assertNonNullable(
      occurredAt,
      `関係候補 ${candidate.id}のsource ${sourceId}に対応する発生時刻がありません`,
    );
    if (occurredAt < earliestOccurredAt) {
      earliestOccurredAt = occurredAt;
    }
  }
  return earliestOccurredAt;
}

function relationNodes(
  relation: CandidateRelation,
): readonly [RelationCandidateNode, RelationCandidateNode] {
  switch (relation.type) {
    case "blocks":
      return Object.freeze([relation.blocker, relation.blocked]);
    case "parent_of":
      return Object.freeze([relation.parent, relation.subtask]);
    case "implements":
      return Object.freeze([relation.implementation, relation.target]);
    case "unclassified":
      return Object.freeze([relation.referencing, relation.referenced]);
  }
}

function relationCandidateOwnerNodeId(candidate: RelationCandidate): GraphNodeId {
  switch (candidate.relation.type) {
    case "blocks":
      return candidate.relation.blocked.nodeId;
    case "parent_of":
      return candidate.relation.parent.nodeId;
    case "implements":
      return candidate.relation.implementation.nodeId;
    case "unclassified":
      return candidate.relation.referencing.nodeId;
  }
}

function relationCandidateNodeItemType(node: RelationCandidateNode): "issue" | "pull_request" {
  return node.scope === "organization" ? node.kind : node.githubItemType;
}

function validateImplementsEndpointTypes(
  implementation: RelationCandidateNode,
  target: RelationCandidateNode,
  context: string,
): void {
  if (
    relationCandidateNodeItemType(implementation) !== "pull_request" ||
    relationCandidateNodeItemType(target) !== "issue"
  ) {
    throw new TypeError(`${context}はPull RequestからIssueへ向けてください`);
  }
}

function validateCandidateRelationEndpointTypes(candidate: RelationCandidate): void {
  if (candidate.relation.type !== "implements") {
    return;
  }
  validateImplementsEndpointTypes(
    candidate.relation.implementation,
    candidate.relation.target,
    `implements候補 ${candidate.id}`,
  );
}

function canonicalCandidateRelation(relation: CandidateRelation): CanonicalRelation {
  switch (relation.type) {
    case "blocks":
      return Object.freeze({
        fromNodeId: relation.blocker.nodeId,
        toNodeId: relation.blocked.nodeId,
        type: "blocks",
      });
    case "parent_of":
      return Object.freeze({
        fromNodeId: relation.parent.nodeId,
        toNodeId: relation.subtask.nodeId,
        type: "parent_of",
      });
    case "implements":
      return Object.freeze({
        fromNodeId: relation.implementation.nodeId,
        toNodeId: relation.target.nodeId,
        type: "implements",
      });
    case "unclassified":
      return Object.freeze({
        fromNodeId: relation.referencing.nodeId,
        toNodeId: relation.referenced.nodeId,
        type: "related_to",
      });
  }
}

function otherCandidateNode(
  candidate: RelationCandidate,
  currentNodeId: GraphNodeId,
): RelationCandidateNode {
  const [firstNode, secondNode] = relationNodes(candidate.relation);
  if (firstNode.nodeId === currentNodeId) {
    return secondNode;
  }
  if (secondNode.nodeId === currentNodeId) {
    return firstNode;
  }
  throw new TypeError(`関係候補 ${candidate.id}に現在項目 ${currentNodeId}が含まれていません`);
}

function validateAssessments(
  candidates: readonly RelationCandidate[],
  assessments: readonly RelationCandidateAssessment[],
): ReadonlyMap<RelationCandidateId, RelationCandidateAssessment> {
  const candidatesById = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const assessmentsByCandidateId = new Map<RelationCandidateId, RelationCandidateAssessment>();

  for (const assessment of assessments) {
    const candidate = candidatesById.get(assessment.candidateId);
    if (candidate == null) {
      throw new TypeError(`存在しない関係候補 ${assessment.candidateId}のAI判定が指定されています`);
    }
    if (assessmentsByCandidateId.has(assessment.candidateId)) {
      throw new TypeError(`関係候補 ${assessment.candidateId}のAI判定が重複しています`);
    }
    if (assessment.reasonSummary.trim().length === 0) {
      throw new TypeError(`関係候補 ${assessment.candidateId}の判定理由は空にできません`);
    }
    validateConfidence(
      assessment.confidence,
      `関係候補 ${assessment.candidateId}のAI判定confidence`,
    );
    validateSourceIds(assessment.sourceIds, `関係候補 ${assessment.candidateId}のAI判定根拠`);
    otherCandidateNode(candidate, assessment.currentNodeId);
    assessmentsByCandidateId.set(assessment.candidateId, assessment);
  }

  return assessmentsByCandidateId;
}

function validateRelationAiDependencies(
  candidates: readonly RelationCandidate[],
  dependencies: ReadonlyMap<RelationCandidateId, AiAnalysisDependency>,
): void {
  const candidatesById = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  for (const [candidateId, dependency] of dependencies) {
    const candidate = candidatesById.get(candidateId);
    if (candidate == null) {
      throw new TypeError(`存在しない関係候補 ${candidateId}のAI依存が指定されています`);
    }
    const parsed = aiAnalysisDependencySchema.safeParse(dependency);
    if (!parsed.success) {
      throw new TypeError(`関係候補 ${candidateId}のAI依存が不正です`, {
        cause: parsed.error,
      });
    }
    if (candidate.authority === "authoritative" && dependency.status !== "not_dependent") {
      throw new TypeError(
        `authoritative relation ${candidateId}のAI依存はnot_dependentでなければなりません`,
      );
    }
  }
  for (const candidate of candidates) {
    if (candidate.authority !== "inferred") {
      continue;
    }
    const dependency = dependencies.get(candidate.id);
    if (dependency == null) {
      throw new TypeError(`推定relation ${candidate.id}のAI依存がありません`);
    }
    validateInferredRelationAiDependency(candidate, dependency, true);
  }
}

function canonicalAssessmentRelation(
  candidate: RelationCandidate,
  assessment: RelationCandidateAssessment,
): CanonicalRelation | null {
  const currentNodeId = assessment.currentNodeId;
  const targetNodeId = otherCandidateNode(candidate, currentNodeId).nodeId;

  switch (assessment.verdict) {
    case "current_is_blocked_by_target":
      return Object.freeze({
        fromNodeId: targetNodeId,
        toNodeId: currentNodeId,
        type: "blocks",
      });
    case "current_blocks_target":
      return Object.freeze({
        fromNodeId: currentNodeId,
        toNodeId: targetNodeId,
        type: "blocks",
      });
    case "current_implements_target":
      return Object.freeze({
        fromNodeId: currentNodeId,
        toNodeId: targetNodeId,
        type: "implements",
      });
    case "target_is_subtask_of_current":
      return Object.freeze({
        fromNodeId: currentNodeId,
        toNodeId: targetNodeId,
        type: "parent_of",
      });
    case "current_is_subtask_of_target":
      return Object.freeze({
        fromNodeId: targetNodeId,
        toNodeId: currentNodeId,
        type: "parent_of",
      });
    case "duplicates":
      return Object.freeze({
        fromNodeId: currentNodeId,
        toNodeId: targetNodeId,
        type: "duplicates",
      });
    case "related":
      return Object.freeze({
        fromNodeId: currentNodeId,
        toNodeId: targetNodeId,
        type: "related_to",
      });
    case "none":
      return null;
    default:
      throw new UnreachableError(assessment.verdict);
  }
}

function provenanceSummary(provenance: RelationCandidate["provenance"]): string {
  switch (provenance) {
    case "native":
      return "GitHub native relationから関係を確定しました";
    case "explicit_text":
      return "本文またはコメントの明示参照から関係候補を抽出しました";
    case "closing_keyword":
      return "closing keywordから実装関係候補を抽出しました";
    case "checklist":
      return "Markdown checklistから階層関係候補を抽出しました";
    case "cross_reference":
      return "GitHub cross-referenceから関係候補を抽出しました";
  }
}

function createEvidence(
  sourceIds: readonly SourceId[],
  supports: EvidenceSupport,
  summary: string,
): readonly Evidence[] {
  return Object.freeze(
    sourceIds.map((sourceId) =>
      Object.freeze({
        sourceId,
        supports,
        summary,
      }),
    ),
  );
}

function evidenceKey(evidence: Evidence): string {
  return JSON.stringify([evidence.sourceId, evidence.supports, evidence.summary]);
}

function normalizeEvidence(evidence: readonly Evidence[]): readonly Evidence[] {
  const evidenceByKey = new Map<string, Evidence>();
  for (const item of evidence) {
    if (item.summary.trim().length === 0) {
      throw new TypeError("edgeのevidence summaryは空にできません");
    }
    evidenceByKey.set(
      evidenceKey(item),
      Object.freeze({
        sourceId: item.sourceId,
        supports: item.supports,
        summary: item.summary,
      }),
    );
  }
  return Object.freeze(
    [...evidenceByKey.values()].sort((left, right) =>
      compareStrings(evidenceKey(left), evidenceKey(right)),
    ),
  );
}

function sameCanonicalRelation(left: CanonicalRelation, right: CanonicalRelation): boolean {
  return (
    left.fromNodeId === right.fromNodeId &&
    left.toNodeId === right.toNodeId &&
    left.type === right.type
  );
}

function createContradiction(
  candidate: RelationCandidate,
  assessment: RelationCandidateAssessment | undefined,
): readonly RelationContradiction[] {
  if (assessment == null) {
    return Object.freeze([]);
  }
  const authoritativeRelation = canonicalCandidateRelation(candidate.relation);
  const assessedRelation = canonicalAssessmentRelation(candidate, assessment);
  if (assessedRelation != null && sameCanonicalRelation(authoritativeRelation, assessedRelation)) {
    return Object.freeze([]);
  }
  const evidence = createEvidence(
    assessment.sourceIds,
    "uncertainty",
    `Codex判定はauthoritativeな関係と矛盾しています。${assessment.reasonSummary}`,
  );
  return Object.freeze([
    Object.freeze({
      verdict: assessment.verdict,
      confidence: assessment.confidence,
      evidence,
    }),
  ]);
}

function createCandidateEvidence(candidate: RelationCandidate): readonly Evidence[] {
  return createEvidence(candidate.sourceIds, "relation", provenanceSummary(candidate.provenance));
}

function createInferredEvidence(
  candidate: RelationCandidate,
  assessment: RelationCandidateAssessment,
): readonly Evidence[] {
  return normalizeEvidence([
    ...createCandidateEvidence(candidate),
    ...createEvidence(assessment.sourceIds, "relation", assessment.reasonSummary),
  ]);
}

function candidateNodeById(
  candidate: RelationCandidate,
  nodeId: GraphNodeId,
): RelationCandidateNode {
  const [firstNode, secondNode] = relationNodes(candidate.relation);
  if (firstNode.nodeId === nodeId) {
    return firstNode;
  }
  if (secondNode.nodeId === nodeId) {
    return secondNode;
  }
  throw new TypeError(`関係候補 ${candidate.id}にnode ${nodeId}が含まれていません`);
}

function validateCanonicalRelationEndpointTypes(
  candidate: RelationCandidate,
  relation: CanonicalRelation,
): void {
  if (relation.type !== "implements") {
    return;
  }
  validateImplementsEndpointTypes(
    candidateNodeById(candidate, relation.fromNodeId),
    candidateNodeById(candidate, relation.toNodeId),
    `implements判定 ${candidate.id}`,
  );
}

function validateInferredRelationAiDependency(
  candidate: RelationCandidate,
  dependency: AiAnalysisDependency,
  allowProducerlessNotRecorded: boolean,
): void {
  if (dependency.status === "not_dependent") {
    throw new TypeError(`推定relation ${candidate.id}のAI依存はnot_dependentにできません`);
  }
  if (dependency.status === "unknown" && dependency.reasons.includes("stale_repository")) {
    throw new TypeError(`推定relation ${candidate.id}にstale repository AI依存は指定できません`);
  }
  const producers = dependency.producers;
  if (producers == null) {
    if (
      allowProducerlessNotRecorded &&
      dependency.status === "unknown" &&
      dependency.reasons.length === 1 &&
      dependency.reasons[0] === "not_recorded"
    ) {
      return;
    }
    throw new TypeError(`推定relation ${candidate.id}のAI依存producerがありません`);
  }
  const endpointNodeIds = new Set(relationNodes(candidate.relation).map((node) => node.nodeId));
  const ownerNodeId = relationCandidateOwnerNodeId(candidate);
  for (const producer of producers) {
    if (producer.kind !== "item_element" || producer.element !== "relations") {
      throw new TypeError(`推定relation ${candidate.id}のAI依存producer elementが不正です`);
    }
    if (!endpointNodeIds.has(producer.nodeId)) {
      throw new TypeError(
        `推定relation ${candidate.id}のAI依存producer nodeがendpointではありません`,
      );
    }
    if (producer.nodeId !== ownerNodeId) {
      throw new TypeError(`推定relation ${candidate.id}のAI依存producer nodeがownerではありません`);
    }
  }
}

function validatePreviousEdgeCandidateIdentity(
  candidate: RelationCandidate,
  previousEdge: ReconciledGraphEdge,
): void {
  const endpointNodeIds = new Set(relationNodes(candidate.relation).map((node) => node.nodeId));
  if (
    !endpointNodeIds.has(previousEdge.fromNodeId) ||
    !endpointNodeIds.has(previousEdge.toNodeId)
  ) {
    throw new TypeError(`関係候補 ${candidate.id}のendpointが前回edgeと一致しません`);
  }
  if (candidate.authority === "authoritative" || previousEdge.provenance === "native") {
    if (candidate.authority !== "authoritative" || previousEdge.provenance !== "native") {
      throw new TypeError(`関係候補 ${candidate.id}がnative edge IDと衝突しています`);
    }
    const relation = canonicalCandidateRelation(candidate.relation);
    if (
      previousEdge.fromNodeId !== relation.fromNodeId ||
      previousEdge.toNodeId !== relation.toNodeId ||
      previousEdge.type !== relation.type
    ) {
      throw new TypeError(`native relation ${candidate.id}の内容が前回edgeと一致しません`);
    }
    return;
  }
  const dependency = previousEdge.aiDependency;
  if (
    dependency.status === "unknown" &&
    dependency.reasons.length === 1 &&
    dependency.reasons[0] === "migration" &&
    dependency.producers == null
  ) {
    return;
  }
  if (dependency.status === "not_dependent" || dependency.producers == null) {
    throw new TypeError(`前回の推定edge ${candidate.id}にowner producerがありません`);
  }
  const ownerNodeId = relationCandidateOwnerNodeId(candidate);
  if (
    dependency.producers.some(
      (producer) =>
        producer.kind !== "relation" ||
        producer.relationId !== candidate.id ||
        producer.producer.nodeId !== ownerNodeId,
    )
  ) {
    throw new TypeError(`関係候補 ${candidate.id}のownerが前回edgeと一致しません`);
  }
}

function resolveCandidate(
  candidate: RelationCandidate,
  assessment: RelationCandidateAssessment | undefined,
  sourceOccurredAtById: ReadonlyMap<SourceId, UtcIsoDateTime>,
  minimumInferredConfidence: number,
  relationAiDependencies: ReadonlyMap<RelationCandidateId, AiAnalysisDependency>,
): CandidateResolutionResult {
  if (candidate.authority === "authoritative") {
    const relation = canonicalCandidateRelation(candidate.relation);
    validateCanonicalRelationEndpointTypes(candidate, relation);
    const contradictions = createContradiction(candidate, assessment);
    const evidence = normalizeEvidence([
      ...createCandidateEvidence(candidate),
      ...contradictions.flatMap((contradiction) => contradiction.evidence),
    ]);
    return Object.freeze({
      edgeDraft: Object.freeze({
        id: candidate.id,
        ...relation,
        provenance: candidate.provenance,
        confidence: 1,
        evidence,
        authoritative: true,
        contradictions,
        aiDependency: Object.freeze({ status: "not_dependent" }),
        firstSeenAt: resolveCandidateFirstSeenAt(candidate, sourceOccurredAtById),
      }),
      resolution: Object.freeze({
        candidateId: candidate.id,
        status: "active",
        edgeId: candidate.id,
      }),
      dependency: Object.freeze({ status: "not_dependent" }),
      canonicalRelation: relation,
    });
  }

  const sourceAiDependency = relationAiDependencies.get(candidate.id);
  assertNonNullable(sourceAiDependency, `推定relation ${candidate.id}のAI依存がありません`);
  validateInferredRelationAiDependency(candidate, sourceAiDependency, true);

  if (assessment == null) {
    return Object.freeze({
      edgeDraft: null,
      resolution: Object.freeze({
        candidateId: candidate.id,
        status: "pending",
        reason: "assessment_missing",
      }),
      dependency: sourceAiDependency,
    });
  }
  if (assessment.confidence < minimumInferredConfidence) {
    return Object.freeze({
      edgeDraft: null,
      resolution: Object.freeze({
        candidateId: candidate.id,
        status: "pending",
        reason: "confidence_below_threshold",
        confidence: assessment.confidence,
      }),
      dependency: sourceAiDependency,
    });
  }

  const relation = canonicalAssessmentRelation(candidate, assessment);
  if (relation == null) {
    return Object.freeze({
      edgeDraft: null,
      resolution: Object.freeze({
        candidateId: candidate.id,
        status: "rejected",
        reason: "verdict_none",
        confidence: assessment.confidence,
      }),
      dependency: sourceAiDependency,
    });
  }
  validateCanonicalRelationEndpointTypes(candidate, relation);
  if (
    relation.type === "blocks" &&
    candidateNodeById(candidate, relation.fromNodeId).state !== "open"
  ) {
    return Object.freeze({
      edgeDraft: null,
      resolution: Object.freeze({
        candidateId: candidate.id,
        status: "rejected",
        reason: "blocker_not_open",
        confidence: assessment.confidence,
      }),
      dependency: sourceAiDependency,
    });
  }

  validateInferredRelationAiDependency(candidate, sourceAiDependency, false);
  const aiDependency = aiAnalysisDependencyForRelation(candidate.id, sourceAiDependency);

  return Object.freeze({
    edgeDraft: Object.freeze({
      id: candidate.id,
      ...relation,
      provenance: candidate.provenance,
      confidence: assessment.confidence,
      evidence: createInferredEvidence(candidate, assessment),
      authoritative: false,
      contradictions: Object.freeze([]),
      aiDependency,
      firstSeenAt: resolveCandidateFirstSeenAt(candidate, sourceOccurredAtById),
    }),
    resolution: Object.freeze({
      candidateId: candidate.id,
      status: "active",
      edgeId: candidate.id,
    }),
    dependency: sourceAiDependency,
    canonicalRelation: relation,
  });
}

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

function indexPreviousEdges(
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

function validatePreviousHistoryEvents(
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

function createActiveEdge(
  draft: GraphEdgeDraft,
  firstSeenAt: UtcIsoDateTime,
  lastConfirmedAt: UtcIsoDateTime,
): ReconciledGraphEdge & Readonly<{ active: true }> {
  return Object.freeze({
    id: draft.id,
    fromNodeId: draft.fromNodeId,
    toNodeId: draft.toNodeId,
    type: draft.type,
    provenance: draft.provenance,
    confidence: draft.confidence,
    evidence: draft.evidence,
    authoritative: draft.authoritative,
    contradictions: draft.contradictions,
    aiDependency: draft.aiDependency,
    firstSeenAt,
    lastConfirmedAt,
    active: true,
  });
}

function createInactiveEdge(
  edge: ReconciledGraphEdge & Readonly<{ active: true }>,
  removedAt: UtcIsoDateTime,
): ReconciledGraphEdge & Readonly<{ active: false }> {
  return Object.freeze({
    id: edge.id,
    fromNodeId: edge.fromNodeId,
    toNodeId: edge.toNodeId,
    type: edge.type,
    provenance: edge.provenance,
    confidence: edge.confidence,
    evidence: edge.evidence,
    authoritative: edge.authoritative,
    contradictions: edge.contradictions,
    aiDependency: edge.aiDependency,
    firstSeenAt: edge.firstSeenAt,
    lastConfirmedAt: edge.lastConfirmedAt,
    active: false,
    removedAt,
  });
}

function evidenceSignatures(evidence: readonly Evidence[]): readonly string[] {
  return evidence.map(evidenceKey).sort(compareStrings);
}

function sameEvidence(left: readonly Evidence[], right: readonly Evidence[]): boolean {
  const leftSignatures = evidenceSignatures(left);
  const rightSignatures = evidenceSignatures(right);
  return (
    leftSignatures.length === rightSignatures.length &&
    leftSignatures.every((signature, index) => signature === rightSignatures[index])
  );
}

function contradictionSignature(contradiction: RelationContradiction): string {
  return JSON.stringify([contradiction.verdict, contradiction.confidence]);
}

function sameContradictions(
  left: readonly RelationContradiction[],
  right: readonly RelationContradiction[],
): boolean {
  const leftSignatures = left.map(contradictionSignature).sort(compareStrings);
  const rightSignatures = right.map(contradictionSignature).sort(compareStrings);
  return (
    leftSignatures.length === rightSignatures.length &&
    leftSignatures.every((signature, index) => signature === rightSignatures[index])
  );
}

function changedFields(
  before: ReconciledGraphEdge,
  after: ReconciledGraphEdge,
): readonly GraphEdgeChangedField[] {
  const fields: GraphEdgeChangedField[] = [];
  if (before.fromNodeId !== after.fromNodeId || before.toNodeId !== after.toNodeId) {
    fields.push("endpoints");
  }
  if (before.type !== after.type) {
    fields.push("type");
  }
  if (before.provenance !== after.provenance) {
    fields.push("provenance");
  }
  if (before.confidence !== after.confidence) {
    fields.push("confidence");
  }
  if (!sameEvidence(before.evidence, after.evidence)) {
    fields.push("evidence");
  }
  if (before.authoritative !== after.authoritative) {
    fields.push("authoritative");
  }
  if (!sameContradictions(before.contradictions, after.contradictions)) {
    fields.push("contradictions");
  }
  return Object.freeze(fields);
}

function createChangedFieldTuple(
  fields: readonly GraphEdgeChangedField[],
): readonly [GraphEdgeChangedField, ...GraphEdgeChangedField[]] {
  const [firstField, ...remainingFields] = fields;
  assertNonNullable(firstField, "edge変更イベントには変更箇所が1件以上必要です");
  return Object.freeze([firstField, ...remainingFields]);
}

function isActiveEdge(
  edge: ReconciledGraphEdge,
): edge is ReconciledGraphEdge & Readonly<{ active: true }> {
  return edge.active;
}

function reconcileEdges(
  previousEdges: ReadonlyMap<RelationCandidateId, ReconciledGraphEdge>,
  edgeDrafts: ReadonlyMap<RelationCandidateId, GraphEdgeDraft>,
  reconciledAt: UtcIsoDateTime,
): Readonly<{
  edges: readonly ReconciledGraphEdge[];
  events: readonly GraphEdgeHistoryEvent[];
}> {
  const edgeIds = [...new Set([...previousEdges.keys(), ...edgeDrafts.keys()])].sort(
    compareStrings,
  );
  const edges: ReconciledGraphEdge[] = [];
  const events: GraphEdgeHistoryEvent[] = [];

  for (const edgeId of edgeIds) {
    const previousEdge = previousEdges.get(edgeId);
    const edgeDraft = edgeDrafts.get(edgeId);

    if (edgeDraft != null) {
      const activeEdge = createActiveEdge(
        edgeDraft,
        previousEdge?.firstSeenAt ?? edgeDraft.firstSeenAt,
        reconciledAt,
      );
      edges.push(activeEdge);
      if (previousEdge?.active !== true) {
        events.push(
          Object.freeze({
            kind: "added",
            edgeId,
            occurredAt: reconciledAt,
            after: activeEdge,
          }),
        );
        continue;
      }
      const fields = changedFields(previousEdge, activeEdge);
      if (fields.length > 0) {
        events.push(
          Object.freeze({
            kind: "changed",
            edgeId,
            occurredAt: reconciledAt,
            changedFields: createChangedFieldTuple(fields),
            before: previousEdge,
            after: activeEdge,
          }),
        );
      }
      continue;
    }

    assertNonNullable(previousEdge, `edge ${edgeId}の前回値がありません`);
    if (!previousEdge.active) {
      edges.push(previousEdge);
      continue;
    }
    const inactiveEdge = createInactiveEdge(previousEdge, reconciledAt);
    edges.push(inactiveEdge);
    events.push(
      Object.freeze({
        kind: "removed",
        edgeId,
        occurredAt: reconciledAt,
        before: previousEdge,
        after: inactiveEdge,
      }),
    );
  }

  return Object.freeze({
    edges: Object.freeze(edges),
    events: Object.freeze(events),
  });
}

function candidateEndpointNodeIds(
  candidate: RelationCandidate,
): readonly [GraphNodeId, GraphNodeId] {
  const [firstNode, secondNode] = relationNodes(candidate.relation);
  return Object.freeze([firstNode.nodeId, secondNode.nodeId]);
}

function candidateDecisionProof(
  candidate: RelationCandidate,
  result: CandidateResolutionResult,
): RelationCandidateDecisionProof {
  const proof = {
    candidateId: candidate.id,
    endpointNodeIds: candidateEndpointNodeIds(candidate),
    authority: candidate.authority,
    resolution: result.resolution,
    dependency: result.dependency,
  };
  if (result.canonicalRelation == null) {
    return Object.freeze(proof);
  }
  return Object.freeze({
    ...proof,
    canonicalRelation: result.canonicalRelation,
  });
}

/** activeなblocks edgeから項目ごとのblockedByを導出する。 */
export function deriveBlockedBy(edges: readonly ReconciledGraphEdge[]): readonly BlockedByEntry[] {
  const blockersByBlockedNodeId = new Map<GraphNodeId, Set<GraphNodeId>>();

  for (const edge of edges) {
    if (!edge.active || edge.type !== "blocks") {
      continue;
    }
    const blockers = blockersByBlockedNodeId.get(edge.toNodeId);
    if (blockers == null) {
      blockersByBlockedNodeId.set(edge.toNodeId, new Set([edge.fromNodeId]));
      continue;
    }
    blockers.add(edge.fromNodeId);
  }

  return Object.freeze(
    [...blockersByBlockedNodeId.entries()]
      .sort(([leftNodeId], [rightNodeId]) => compareStrings(leftNodeId, rightNodeId))
      .map(([nodeId, blockers]) =>
        Object.freeze({
          nodeId,
          blockedBy: Object.freeze([...blockers].sort(compareStrings)),
        }),
      ),
  );
}

/** 前回graphと今回の候補およびAI判定をreconcileする。 */
export function reconcileGraph(input: ReconcileGraphInput): ReconcileGraphResult {
  validateConfidence(input.minimumInferredConfidence, "推定edgeの最低confidence");
  validateUtcIsoDateTime(input.reconciledAt, "reconcile時刻");
  validateSourceOccurredAtById(input.sourceOccurredAtById, input.reconciledAt);

  const candidates = normalizeRelationCandidates(input.candidates);
  for (const candidate of candidates) {
    validateCandidateRelationEndpointTypes(candidate);
  }
  const assessmentsByCandidateId = validateAssessments(candidates, input.assessments);
  validateRelationAiDependencies(candidates, input.relationAiDependencies);
  const previousEdges = indexPreviousEdges(input.previousGraph.edges, input.reconciledAt);
  validatePreviousHistoryEvents(input.previousGraph.historyEvents, input.reconciledAt);
  for (const candidate of candidates) {
    const previousEdge = previousEdges.get(candidate.id);
    if (previousEdge != null) {
      validatePreviousEdgeCandidateIdentity(candidate, previousEdge);
    }
  }

  const edgeDrafts = new Map<RelationCandidateId, GraphEdgeDraft>();
  const candidateResolutions: RelationCandidateResolution[] = [];
  const candidateDecisionProofs: RelationCandidateDecisionProof[] = [];
  for (const candidate of candidates) {
    const result = resolveCandidate(
      candidate,
      assessmentsByCandidateId.get(candidate.id),
      input.sourceOccurredAtById,
      input.minimumInferredConfidence,
      input.relationAiDependencies,
    );
    candidateResolutions.push(result.resolution);
    candidateDecisionProofs.push(candidateDecisionProof(candidate, result));
    if (result.edgeDraft != null) {
      edgeDrafts.set(candidate.id, result.edgeDraft);
    }
  }

  const reconciled = reconcileEdges(previousEdges, edgeDrafts, input.reconciledAt);
  const activeEdges = Object.freeze(reconciled.edges.filter(isActiveEdge));
  const emittedHistoryEvents = reconciled.events;
  const historyEvents = Object.freeze([
    ...input.previousGraph.historyEvents,
    ...emittedHistoryEvents,
  ]);

  return Object.freeze({
    edges: reconciled.edges,
    activeEdges,
    historyEvents,
    emittedHistoryEvents,
    candidateResolutions: Object.freeze(candidateResolutions),
    candidateDecisionProofs: Object.freeze(candidateDecisionProofs),
    blockedBy: deriveBlockedBy(activeEdges),
  });
}
