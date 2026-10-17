import { hashCanonicalJson } from "../canonical-json/index.js";
import {
  determineDeadlineLevel,
  type GraphNodeId,
  type Relation,
  type TrackedItemState,
} from "../domain/index.js";
import { createFinalGraphProjection } from "../graph/final-graph-projection.js";
import {
  analyzeGraph,
  type GraphAnalysisNode,
  type ReconciledGraphEdge,
  type RelationCandidateId,
} from "../graph/index.js";
import { assertNonNullable } from "../util/index.js";
import { StateSnapshotSemanticError } from "./errors.js";
import type { StateSnapshot as StateSnapshotVersion19 } from "./snapshot-contracts.js";
import type { StateSnapshot as StateSnapshotVersion20 } from "./snapshot-v20-contracts.js";

type SnapshotFinalGraphInput = Readonly<{
  generatedAt: StateSnapshotVersion19["generatedAt"];
  items: readonly Pick<
    StateSnapshotVersion19["items"][number],
    | "nodeId"
    | "type"
    | "repositoryId"
    | "state"
    | "deadlineAssessment"
    | "status"
    | "waitingOn"
    | "aiDependencies"
  >[];
  externalReferences: StateSnapshotVersion19["externalReferences"];
  graphNodeStateObservations: StateSnapshotVersion19["graphNodeStateObservations"];
  relations: StateSnapshotVersion19["relations"];
  repositories: StateSnapshotVersion19["repositories"];
}>;

function snapshotGraphEdge(relation: Relation): ReconciledGraphEdge {
  if (!relation.id.startsWith("rel:") || relation.id.length === "rel:".length) {
    throw new StateSnapshotSemanticError(`relation IDの形式が不正です。対象: ${relation.id}`);
  }
  const id: RelationCandidateId = `rel:${relation.id.slice("rel:".length)}`;
  const fields = {
    ...relation,
    id,
    authoritative: relation.provenance === "native",
    contradictions: relation.contradictions.map((contradiction) => ({
      ...contradiction,
      evidence: [],
    })),
  };
  if (relation.active) {
    return { ...fields, active: true };
  }
  return { ...fields, active: false, removedAt: relation.removedAt };
}

/** snapshotの保存値だけから公開graph投影とdigestを再生成する。 */
export function projectSnapshotFinalGraph(
  snapshot: SnapshotFinalGraphInput,
  timezone: string,
): Pick<StateSnapshotVersion20, "finalGraphProjection" | "finalGraphProjectionDigest"> {
  const effectiveStates = new Map<GraphNodeId, TrackedItemState>([
    ...snapshot.items.map((item): [GraphNodeId, TrackedItemState] => [item.nodeId, item.state]),
    ...snapshot.externalReferences.map((reference): [GraphNodeId, TrackedItemState] => [
      reference.nodeId,
      reference.state,
    ]),
    ...snapshot.graphNodeStateObservations.map((observation): [GraphNodeId, TrackedItemState] => [
      observation.nodeId,
      observation.state,
    ]),
  ]);
  const nodes: GraphAnalysisNode[] = [
    ...snapshot.items.map((item): GraphAnalysisNode => {
      const state = effectiveStates.get(item.nodeId);
      assertNonNullable(state, `snapshotのgraph node状態がありません。対象: ${item.nodeId}`);
      return {
        kind: item.type,
        nodeId: item.nodeId,
        repositoryId: item.repositoryId,
        state,
        directNotification: "eligible",
      };
    }),
    ...snapshot.externalReferences.map((reference): GraphAnalysisNode => ({
      kind: reference.kind,
      nodeId: reference.nodeId,
      repositoryFullName: reference.repositoryFullName,
      state: reference.state,
      directNotification: "not_eligible",
    })),
  ];
  const analysis = analyzeGraph({
    current: {
      nodes,
      edges: snapshot.relations.map(snapshotGraphEdge),
    },
    previous: { availability: "unavailable" },
  });
  const finalGraphProjection = createFinalGraphProjection({
    evaluatedAt: snapshot.generatedAt,
    timezone,
    items: snapshot.items.map((item) => ({
      ...item,
      deadlineLevel:
        item.deadlineAssessment.status === "not_available"
          ? "none"
          : determineDeadlineLevel({
              deadlineDate: item.deadlineAssessment.value.date,
              evaluatedAt: snapshot.generatedAt,
              timezone,
            }),
    })),
    staleRepositoryIds: new Set(
      snapshot.repositories
        .filter((repository) => repository.freshness === "stale")
        .map((repository) => repository.id),
    ),
    relations: snapshot.relations,
    effectiveStateByNodeId: [...effectiveStates],
    analysis,
  });
  return Object.freeze({
    finalGraphProjection,
    finalGraphProjectionDigest: hashCanonicalJson(finalGraphProjection),
  });
}
