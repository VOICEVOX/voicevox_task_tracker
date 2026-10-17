import {
  type AiAnalysisDependency,
  type Evidence,
  type RelationProvenance,
  type UtcIsoDateTime,
} from "../domain/index.js";
import {
  type CanonicalRelation,
  type RelationCandidateResolution,
  type RelationContradiction,
} from "./reconcile-graph-types.js";
import { type RelationCandidateId } from "./relation-candidate-types.js";

export type GraphEdgeDraft = CanonicalRelation &
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

export type CandidateResolutionResult = Readonly<{
  edgeDraft: GraphEdgeDraft | null;
  resolution: RelationCandidateResolution;
  dependency: AiAnalysisDependency;
  canonicalRelation?: CanonicalRelation;
}>;
