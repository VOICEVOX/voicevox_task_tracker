import type { AiAnalysisDependency } from "./ai-analysis-dependencies.js";
import type {
  Evidence,
  GraphNodeId,
  RelationContradictionSummary,
  RelationProvenance,
  RelationType,
  UtcIsoDateTime,
} from "./types.js";

type RelationFields = Readonly<{
  id: string;
  fromNodeId: GraphNodeId;
  toNodeId: GraphNodeId;
  type: RelationType;
  provenance: RelationProvenance;
  confidence: number;
  evidence: readonly Evidence[];
  contradictions: readonly RelationContradictionSummary[];
  firstSeenAt: UtcIsoDateTime;
  lastConfirmedAt: UtcIsoDateTime;
  aiDependency: AiAnalysisDependency;
}>;

/** blocksではfromNodeIdをblocker、toNodeIdをblocked itemとするRelation。 */
export type Relation =
  | (RelationFields &
      Readonly<{
        active: true;
      }>)
  | (RelationFields &
      Readonly<{
        active: false;
        removedAt: UtcIsoDateTime;
      }>);
