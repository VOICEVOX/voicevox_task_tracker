import type { AiAnalysisDependency } from "../../../domain/ai-analysis-dependencies.js";
import type {
  GitHubNodeId,
  GraphNodeId,
  NormalizedEvent,
  Relation,
  SourceId,
  TrackedItemState,
  UtcIsoDateTime,
} from "../../../domain/index.js";
import type { EnumeratedGitHubItem, FreshObservedGitHubItem } from "../../../github/index.js";
import type {
  ReconciledGraphEdge,
  RelationCandidate,
  RelationCandidateAssessment,
  RelationCandidateId,
} from "../../../graph/index.js";
import type { SnapshotGraphNodeStateObservation } from "../../../persistence/index.js";

export type ActiveRelation = Relation & Readonly<{ active: true }>;

export type PreviousBlockerEdgesByTargetNodeId = ReadonlyMap<
  GraphNodeId,
  ReadonlyMap<GraphNodeId, readonly ActiveRelation[]>
>;

export type RelationProgressEvent = Extract<NormalizedEvent, { kind: "relation" }>;

export type DependencyResolutionIndexes = Readonly<{
  previousBlockerEdgesByTargetNodeId: PreviousBlockerEdgesByTargetNodeId;
  previousObservedAtByNodeId: ReadonlyMap<GitHubNodeId, UtcIsoDateTime>;
  previousEffectiveStateByNodeId: ReadonlyMap<GraphNodeId, TrackedItemState>;
  enumeratedItemsByNodeId: ReadonlyMap<GraphNodeId, EnumeratedGitHubItem>;
  observedItemsByNodeId: ReadonlyMap<GraphNodeId, FreshObservedGitHubItem>;
  currentNativeStateObservationsByNodeId: ReadonlyMap<
    GraphNodeId,
    SnapshotGraphNodeStateObservation
  >;
  relationEventsByKey: ReadonlyMap<string, readonly RelationProgressEvent[]>;
  sourceOccurredAtById: ReadonlyMap<SourceId, UtcIsoDateTime>;
  relationRemovalEventsByKey: ReadonlyMap<string, RelationProgressEvent>;
  editedRelationSourceOccurredAtById: ReadonlyMap<SourceId, UtcIsoDateTime>;
  candidatesById: ReadonlyMap<string, RelationCandidate>;
  relationCandidateAiDependencies: ReadonlyMap<RelationCandidateId, AiAnalysisDependency>;
  assessmentsById: ReadonlyMap<string, RelationCandidateAssessment>;
  currentEdgesById: ReadonlyMap<string, ReconciledGraphEdge>;
}>;

export type DependencyResolutionStaticIndexes = Omit<
  DependencyResolutionIndexes,
  "assessmentsById"
>;
