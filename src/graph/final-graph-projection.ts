import type {
  DeadlineLevel,
  Relation,
  TrackedItem,
  TrackedItemState,
  UtcIsoDateTime,
} from "../domain/index.js";

/** 公開用blockerの現在性を確認できない理由。 */
export type FinalGraphBlockerUnverifiedReason =
  "relation_support" | "retained_waiting" | "waiting_value";

/** 確定graphから公開処理へ渡す最小の投影。 */
export type FinalGraphProjection = Readonly<{
  evaluatedAt: UtcIsoDateTime;
  timezone: string;
  nodes: readonly Readonly<{
    nodeId: string;
    effectiveState: TrackedItemState;
    downstreamImpact: Readonly<{ openNodeCount: number; repositoryCount: number }>;
  }>[];
  dependencyCycles: readonly Readonly<{
    id: string;
    nodeIds: readonly string[];
    edgeIds: readonly string[];
  }>[];
  frontierNodeIds: readonly string[];
  items: readonly Readonly<{
    nodeId: string;
    deadlineLevel: DeadlineLevel;
    blockerNodeIds: readonly string[];
    effectiveBlockerNodeIds: readonly string[];
    retainedOnlyBlockerNodeIds: readonly string[];
    blockerUnverifiedReasons: readonly Readonly<{
      nodeId: string;
      reasons: readonly FinalGraphBlockerUnverifiedReason[];
    }>[];
  }>[];
}>;

type ProjectionItem = Pick<
  TrackedItem,
  "nodeId" | "repositoryId" | "status" | "waitingOn" | "aiDependencies"
> &
  Readonly<{ deadlineLevel: DeadlineLevel }>;

type ProjectionRelation = Pick<
  Relation,
  "id" | "fromNodeId" | "toNodeId" | "type" | "active" | "provenance" | "aiDependency"
>;

/** 公開投影を確定するための最終graphと項目値。 */
export type FinalGraphProjectionInput = Readonly<{
  evaluatedAt: UtcIsoDateTime;
  timezone: string;
  items: readonly ProjectionItem[];
  staleRepositoryIds: ReadonlySet<string>;
  relations: readonly ProjectionRelation[];
  effectiveStateByNodeId: readonly (readonly [string, TrackedItemState])[];
  analysis: Readonly<{
    dependencyCycles: readonly Readonly<{
      id: string;
      nodeIds: readonly string[];
      edges: readonly Readonly<{ id: string }>[];
    }>[];
    actionableFrontier: readonly string[];
    downstreamImpacts: readonly Readonly<{
      nodeId: string;
      openNodeCount: number;
      repositoryCount: number;
    }>[];
  }>;
}>;

const UNVERIFIED_REASON_ORDER: readonly FinalGraphBlockerUnverifiedReason[] = [
  "relation_support",
  "retained_waiting",
  "waiting_value",
];

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function addReason(
  reasonsByBlocker: Map<string, Set<FinalGraphBlockerUnverifiedReason>>,
  blockerNodeId: string,
  reason: FinalGraphBlockerUnverifiedReason,
): void {
  const reasons = reasonsByBlocker.get(blockerNodeId);
  if (reasons == null) {
    reasonsByBlocker.set(blockerNodeId, new Set([reason]));
  } else {
    reasons.add(reason);
  }
}

function relationIsUnverified(relation: ProjectionRelation): boolean {
  if (relation.provenance === "native" && relation.aiDependency.status !== "not_dependent") {
    throw new TypeError(`native relation ${relation.id}のAI依存が不正です`);
  }
  return (
    relation.aiDependency.status === "unverified" || relation.aiDependency.status === "unknown"
  );
}

function projectItemBlockers(
  item: ProjectionItem,
  relations: readonly ProjectionRelation[],
  effectiveStates: ReadonlyMap<string, TrackedItemState>,
  staleRepositoryIds: ReadonlySet<string>,
): FinalGraphProjection["items"][number] {
  const supportsByBlocker = new Map<string, ProjectionRelation[]>();
  for (const relation of relations) {
    if (!relation.active || relation.type !== "blocks" || relation.toNodeId !== item.nodeId) {
      continue;
    }
    if (
      effectiveStates.get(relation.fromNodeId) !== "open" ||
      effectiveStates.get(item.nodeId) !== "open"
    ) {
      continue;
    }
    const supports = supportsByBlocker.get(relation.fromNodeId);
    if (supports == null) {
      supportsByBlocker.set(relation.fromNodeId, [relation]);
    } else {
      supports.push(relation);
    }
  }
  const effectiveBlockerNodeIds = [...supportsByBlocker.keys()].sort(compareStrings);
  const blockerNodeIds = new Set<string>(effectiveBlockerNodeIds);
  const retainedOnlyBlockerNodeIds = new Set<string>();
  const reasonsByBlocker = new Map<string, Set<FinalGraphBlockerUnverifiedReason>>();
  for (const [blockerNodeId, supports] of supportsByBlocker) {
    if (supports.every(relationIsUnverified)) {
      addReason(reasonsByBlocker, blockerNodeId, "relation_support");
    }
  }
  if (item.status === "waiting_for_unblock") {
    for (const waitingOn of item.waitingOn) {
      if (waitingOn.kind !== "item" || waitingOn.role !== "dependency") {
        continue;
      }
      if (!effectiveStates.has(waitingOn.candidateId)) {
        throw new TypeError(`waitingOn項目 ${waitingOn.candidateId}がgraphにありません`);
      }
      blockerNodeIds.add(waitingOn.candidateId);
      if (
        item.aiDependencies.waitingOn.status === "unverified" ||
        item.aiDependencies.waitingOn.status === "unknown"
      ) {
        addReason(reasonsByBlocker, waitingOn.candidateId, "waiting_value");
      }
      if (
        !supportsByBlocker.has(waitingOn.candidateId) &&
        staleRepositoryIds.has(item.repositoryId)
      ) {
        retainedOnlyBlockerNodeIds.add(waitingOn.candidateId);
        addReason(reasonsByBlocker, waitingOn.candidateId, "retained_waiting");
      }
    }
  }
  return Object.freeze({
    nodeId: item.nodeId,
    deadlineLevel: item.deadlineLevel,
    blockerNodeIds: Object.freeze([...blockerNodeIds].sort(compareStrings)),
    effectiveBlockerNodeIds: Object.freeze(effectiveBlockerNodeIds),
    retainedOnlyBlockerNodeIds: Object.freeze([...retainedOnlyBlockerNodeIds].sort(compareStrings)),
    blockerUnverifiedReasons: Object.freeze(
      [...reasonsByBlocker.entries()]
        .sort(([left], [right]) => compareStrings(left, right))
        .map(([nodeId, reasons]) =>
          Object.freeze({
            nodeId,
            reasons: Object.freeze(UNVERIFIED_REASON_ORDER.filter((reason) => reasons.has(reason))),
          }),
        ),
    ),
  });
}

/** 最終graphの解析結果から公開用投影を一度だけ作る。 */
export function createFinalGraphProjection(input: FinalGraphProjectionInput): FinalGraphProjection {
  const effectiveStates = new Map(input.effectiveStateByNodeId);
  if (effectiveStates.size !== input.effectiveStateByNodeId.length) {
    throw new TypeError("公開graphのeffective stateに重複があります");
  }
  const impactsByNodeId = new Map<
    string,
    FinalGraphProjectionInput["analysis"]["downstreamImpacts"][number]
  >(input.analysis.downstreamImpacts.map((impact) => [impact.nodeId, impact]));
  if (impactsByNodeId.size !== input.analysis.downstreamImpacts.length) {
    throw new TypeError("公開graphのdownstream impactに重複があります");
  }
  if (
    impactsByNodeId.size !== effectiveStates.size ||
    [...effectiveStates.keys()].some((nodeId) => !impactsByNodeId.has(nodeId))
  ) {
    throw new TypeError("公開graphのdownstream impactがnodeを網羅していません");
  }
  const relationsByBlockedNodeId = new Map<string, ProjectionRelation[]>();
  for (const relation of input.relations) {
    if (!relation.active || relation.type !== "blocks") {
      continue;
    }
    const relations = relationsByBlockedNodeId.get(relation.toNodeId);
    if (relations == null) {
      relationsByBlockedNodeId.set(relation.toNodeId, [relation]);
    } else {
      relations.push(relation);
    }
  }
  return Object.freeze({
    evaluatedAt: input.evaluatedAt,
    timezone: input.timezone,
    nodes: Object.freeze(
      [...effectiveStates.entries()]
        .sort(([left], [right]) => compareStrings(left, right))
        .map(([nodeId, effectiveState]) => {
          const impact = impactsByNodeId.get(nodeId);
          if (impact == null) {
            throw new TypeError(`node ${nodeId}のdownstream impactがありません`);
          }
          return Object.freeze({
            nodeId,
            effectiveState,
            downstreamImpact: Object.freeze({
              openNodeCount: impact.openNodeCount,
              repositoryCount: impact.repositoryCount,
            }),
          });
        }),
    ),
    dependencyCycles: Object.freeze(
      input.analysis.dependencyCycles
        .map((cycle) =>
          Object.freeze({
            id: cycle.id,
            nodeIds: Object.freeze([...cycle.nodeIds].sort(compareStrings)),
            edgeIds: Object.freeze(cycle.edges.map((edge) => edge.id).sort(compareStrings)),
          }),
        )
        .sort((left, right) => compareStrings(left.id, right.id)),
    ),
    frontierNodeIds: Object.freeze([...input.analysis.actionableFrontier].sort(compareStrings)),
    items: Object.freeze(
      input.items
        .map((item) =>
          projectItemBlockers(
            item,
            relationsByBlockedNodeId.get(item.nodeId) ?? [],
            effectiveStates,
            input.staleRepositoryIds,
          ),
        )
        .sort((left, right) => compareStrings(left.nodeId, right.nodeId)),
    ),
  });
}
