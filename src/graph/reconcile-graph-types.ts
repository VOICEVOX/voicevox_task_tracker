import {
  type Evidence,
  type GraphNodeId,
  type Relation,
  type RelationContradictionSummary,
  type RelationContradictionVerdict,
  type SourceId,
  type UtcIsoDateTime,
} from "../domain/index.js";
import { type RelationCandidate, type RelationCandidateId } from "./relation-candidate-types.js";

/** Codexが現在項目と候補先の関係を表す判定値。 */
export type RelationAssessmentVerdict = RelationContradictionVerdict;

/** 関係候補に対する検証済みのCodex判定。 */
export type RelationCandidateAssessment = Readonly<{
  candidateId: RelationCandidateId;
  currentNodeId: GraphNodeId;
  verdict: RelationAssessmentVerdict;
  reasonSummary: string;
  sourceIds: readonly [SourceId, ...SourceId[]];
  confidence: number;
}>;

/** authoritativeな関係とCodex判定の矛盾。 */
export type RelationContradiction = RelationContradictionSummary &
  Readonly<{
    evidence: readonly Evidence[];
  }>;

type RelationWithoutContradictions<T> = T extends Relation ? Omit<T, "contradictions"> : never;

/** 候補IDを維持しauthoritative情報と矛盾を加えたgraph edge。 */
export type ReconciledGraphEdge = RelationWithoutContradictions<Relation> &
  Readonly<{
    id: RelationCandidateId;
    authoritative: boolean;
    contradictions: readonly RelationContradiction[];
  }>;

/** edge変更イベントで確認できる変更箇所。 */
export type GraphEdgeChangedField =
  | "endpoints"
  | "type"
  | "provenance"
  | "confidence"
  | "evidence"
  | "authoritative"
  | "contradictions";

type GraphEdgeHistoryEventFields = Readonly<{
  edgeId: RelationCandidateId;
  occurredAt: UtcIsoDateTime;
}>;

/** edgeが新規作成または再active化された履歴。 */
export type GraphEdgeAddedEvent = GraphEdgeHistoryEventFields &
  Readonly<{
    kind: "added";
    after: ReconciledGraphEdge & Readonly<{ active: true }>;
  }>;

/** activeなedgeの内容が変わった履歴。 */
export type GraphEdgeChangedEvent = GraphEdgeHistoryEventFields &
  Readonly<{
    kind: "changed";
    changedFields: readonly [GraphEdgeChangedField, ...GraphEdgeChangedField[]];
    before: ReconciledGraphEdge & Readonly<{ active: true }>;
    after: ReconciledGraphEdge & Readonly<{ active: true }>;
  }>;

/** edgeが非active化された履歴。 */
export type GraphEdgeRemovedEvent = GraphEdgeHistoryEventFields &
  Readonly<{
    kind: "removed";
    before: ReconciledGraphEdge & Readonly<{ active: true }>;
    after: ReconciledGraphEdge & Readonly<{ active: false }>;
  }>;

/** edgeの追加、変更、削除を表す履歴イベント。 */
export type GraphEdgeHistoryEvent =
  GraphEdgeAddedEvent | GraphEdgeChangedEvent | GraphEdgeRemovedEvent;

/** 永続化層から受け渡すreconcile済みgraph state。 */
export type ReconciledGraphState = Readonly<{
  edges: readonly ReconciledGraphEdge[];
  historyEvents: readonly GraphEdgeHistoryEvent[];
}>;

/** activeなblocks edgeから導出した項目別のblocker一覧。 */
export type BlockedByEntry = Readonly<{
  nodeId: GraphNodeId;
  blockedBy: readonly GraphNodeId[];
}>;

/** 今回の関係候補がactive edgeになった状態。 */
export type ActiveRelationCandidateResolution = Readonly<{
  candidateId: RelationCandidateId;
  status: "active";
  edgeId: RelationCandidateId;
}>;

/** 今回の関係候補を断定できない状態。 */
export type PendingRelationCandidateResolution =
  | Readonly<{
      candidateId: RelationCandidateId;
      status: "pending";
      reason: "assessment_missing";
    }>
  | Readonly<{
      candidateId: RelationCandidateId;
      status: "pending";
      reason: "confidence_below_threshold";
      confidence: number;
    }>;

/** 今回の関係候補をactive graphへ採用しない状態。 */
export type RejectedRelationCandidateResolution =
  | Readonly<{
      candidateId: RelationCandidateId;
      status: "rejected";
      reason: "verdict_none";
      confidence: number;
    }>
  | Readonly<{
      candidateId: RelationCandidateId;
      status: "rejected";
      reason: "blocker_not_open";
      confidence: number;
    }>;

/** 今回の関係候補に対するreconcile結果。 */
export type RelationCandidateResolution =
  | ActiveRelationCandidateResolution
  | PendingRelationCandidateResolution
  | RejectedRelationCandidateResolution;

/** 前回graphと今回の候補をreconcileする入力。 */
export type ReconcileGraphInput = Readonly<{
  previousGraph: ReconciledGraphState;
  candidates: readonly RelationCandidate[];
  assessments: readonly RelationCandidateAssessment[];
  sourceOccurredAtById: ReadonlyMap<SourceId, UtcIsoDateTime>;
  minimumInferredConfidence: number;
  reconciledAt: UtcIsoDateTime;
}>;

/** reconcile後の全edge、active edge、履歴、候補状態。 */
export type ReconcileGraphResult = ReconciledGraphState &
  Readonly<{
    activeEdges: readonly (ReconciledGraphEdge & Readonly<{ active: true }>)[];
    emittedHistoryEvents: readonly GraphEdgeHistoryEvent[];
    candidateResolutions: readonly RelationCandidateResolution[];
    blockedBy: readonly BlockedByEntry[];
  }>;
