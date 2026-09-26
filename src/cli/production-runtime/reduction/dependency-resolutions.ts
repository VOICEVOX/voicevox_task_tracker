import {
  aiAnalysisDependencyForRelation,
  combineAiAnalysisDependencies,
  type AiAnalysisDependency,
} from "../../../domain/ai-analysis-dependencies.js";
import type {
  DependencyResolutionProgress,
  Relation,
  SourceId,
  UtcIsoDateTime,
} from "../../../domain/index.js";
import type { NotificationDependencyCause } from "../../../discord/index.js";
import type { RelationCandidateAssessment } from "../../../graph/index.js";
import { assertNonNullable } from "../../../util/index.js";
import { latestUtcIsoDateTime } from "../../codex-input-projection.js";
import type { DeterministicItemAnalysis } from "../../initial-item-analysis.js";
import {
  combineSelectedAiDependencies,
  notDependentAiDependency,
  preferIndependentAiDependency,
} from "../ai-dependencies/selection.js";
import type { CollectedItems, GraphResult } from "../contracts.js";
import { nonEmptySourceIds } from "../source-ids.js";
import { dependencyCauseForBlockers } from "./dependency-resolution-causes.js";
import type {
  DependencyResolutionIndexes,
  DependencyResolutionStaticIndexes,
} from "./dependency-resolution-contracts.js";
import {
  createDependencyResolutionIndexes,
  enumeratedTerminalAt,
} from "./dependency-resolution-indexes.js";
import { relationMeaningKey } from "./dependency-resolution-keys.js";
import {
  latestRelationEventForProgress,
  relationResolutionOccurredAt,
} from "./dependency-resolution-time.js";

type DependencyResolutionResult = Readonly<{
  progress: readonly DependencyResolutionProgress[];
  cause: NotificationDependencyCause;
}>;

function dependencyResolutionSupport(
  indexes: DependencyResolutionIndexes,
  edge: Relation & Readonly<{ active: true }>,
  occurredAt: UtcIsoDateTime,
): AiAnalysisDependency {
  const resolutionDependencies: AiAnalysisDependency[] = [];
  resolutionDependencies.push(edge.aiDependency);
  const removalEvent = latestRelationEventForProgress(indexes, edge);
  if (removalEvent?.occurredAt === occurredAt) {
    resolutionDependencies.push(notDependentAiDependency());
  }
  const currentCandidate = indexes.candidatesById.get(edge.id);
  if (currentCandidate != null) {
    const candidateDependency = indexes.relationCandidateAiDependencies.get(currentCandidate.id);
    assertNonNullable(candidateDependency, `関係候補 ${currentCandidate.id}のAI依存がありません`);
    resolutionDependencies.push(aiAnalysisDependencyForRelation(edge.id, candidateDependency));
  } else {
    const currentEdge = indexes.currentEdgesById.get(edge.id);
    if (currentEdge != null) {
      resolutionDependencies.push(currentEdge.aiDependency);
    }
  }
  return combineAiAnalysisDependencies(resolutionDependencies);
}

type DependencyResolutionRelationGroup = Readonly<{
  occurredAt: UtcIsoDateTime;
  edges: readonly (Relation & Readonly<{ active: true }>)[];
  supportDependency: AiAnalysisDependency;
  dependency: AiAnalysisDependency;
}>;

function relationResolutionGroups(
  edges: readonly (Relation & Readonly<{ active: true }>)[],
): readonly (readonly (Relation & Readonly<{ active: true }>)[])[] {
  const groups = new Map<string, (Relation & Readonly<{ active: true }>)[]>();
  for (const edge of edges) {
    const key = relationMeaningKey(edge.type, edge.fromNodeId, edge.toNodeId);
    const group = groups.get(key);
    if (group == null) {
      groups.set(key, [edge]);
    } else {
      group.push(edge);
    }
  }
  return Object.freeze([...groups.values()].map((group) => Object.freeze(group)));
}

function dependencyResolutionRelationGroup(
  indexes: DependencyResolutionIndexes,
  sourceOccurredAtById: ReadonlyMap<SourceId, UtcIsoDateTime>,
  edges: readonly (Relation & Readonly<{ active: true }>)[],
): DependencyResolutionRelationGroup {
  const supportDependency = preferIndependentAiDependency(edges.map((edge) => edge.aiDependency));
  const occurredAts = edges.map((edge) =>
    relationResolutionOccurredAt(indexes, sourceOccurredAtById, edge),
  );
  const occurredAt = latestUtcIsoDateTime(occurredAts, "関係supportの解消");
  const dependencies = edges.map((edge) =>
    dependencyResolutionSupport(
      indexes,
      edge,
      relationResolutionOccurredAt(indexes, sourceOccurredAtById, edge),
    ),
  );
  if (dependencies.length === 0) {
    throw new TypeError("関係supportの解消依存がありません");
  }
  return Object.freeze({
    occurredAt,
    edges: Object.freeze(edges),
    supportDependency,
    dependency: combineAiAnalysisDependencies(dependencies),
  });
}

/** 新たに解消した依存の進捗と通知原因を返す。 */
export function dependencyResolutions(
  collection: CollectedItems,
  graph: GraphResult | undefined,
  staticIndexes: DependencyResolutionStaticIndexes | undefined,
  relationAssessments: readonly RelationCandidateAssessment[],
  analysis: DeterministicItemAnalysis,
): DependencyResolutionResult {
  if (graph?.analysis.newlyUnblockedNodeIds.includes(analysis.item.nodeId) !== true) {
    return Object.freeze({
      progress: Object.freeze([]),
      cause: Object.freeze({ status: "not_applicable" }),
    });
  }
  assertNonNullable(staticIndexes, "newly unblocked項目の依存解消indexがありません");
  const edgesByBlockerNodeId = staticIndexes.previousBlockerEdgesByTargetNodeId.get(
    analysis.item.nodeId,
  );
  assertNonNullable(
    edgesByBlockerNodeId,
    `newly unblocked項目 ${analysis.item.nodeId}の前回blockerがありません`,
  );
  if (edgesByBlockerNodeId.size === 0) {
    throw new TypeError(`newly unblocked項目 ${analysis.item.nodeId}の前回blockerがありません`);
  }
  const previousObservedAt = staticIndexes.previousObservedAtByNodeId.get(analysis.item.nodeId);
  const enumeratedItemsByNodeId = staticIndexes.enumeratedItemsByNodeId;
  const cause: NotificationDependencyCause =
    previousObservedAt == null
      ? Object.freeze({ status: "indeterminate" })
      : dependencyCauseForBlockers(
          collection,
          enumeratedItemsByNodeId,
          staticIndexes.observedItemsByNodeId,
          staticIndexes.relationEventsByKey,
          edgesByBlockerNodeId,
          previousObservedAt,
        );
  const sourceOccurredAtById = staticIndexes.sourceOccurredAtById;
  const indexes = createDependencyResolutionIndexes(staticIndexes, relationAssessments);
  const blockerResolutions = [...edgesByBlockerNodeId].map(([blockerNodeId, edges]) => {
    const exactTerminalAt = enumeratedTerminalAt(enumeratedItemsByNodeId.get(blockerNodeId));
    const previousEffectiveState = staticIndexes.previousEffectiveStateByNodeId.get(blockerNodeId);
    const stateObservation =
      staticIndexes.currentNativeStateObservationsByNodeId.get(blockerNodeId);
    const indirectTerminalObservedAt =
      previousEffectiveState !== "open" ||
      stateObservation == null ||
      stateObservation.state === "open"
        ? undefined
        : stateObservation.observedAt;
    const terminalResolutionOccurredAt = exactTerminalAt ?? indirectTerminalObservedAt;
    const groups = relationResolutionGroups(edges).map((group) =>
      dependencyResolutionRelationGroup(indexes, sourceOccurredAtById, group),
    );
    const occurredAt =
      terminalResolutionOccurredAt ??
      latestUtcIsoDateTime(
        groups.map((group) => group.occurredAt),
        `blocker ${blockerNodeId}の関係解消`,
      );
    const selectedGroups = groups.filter((group) => group.occurredAt === occurredAt);
    const selectedEdges =
      terminalResolutionOccurredAt == null ? selectedGroups.flatMap((group) => group.edges) : [];
    const dependencies =
      terminalResolutionOccurredAt != null
        ? groups.map((group) =>
            combineSelectedAiDependencies([group.supportDependency, notDependentAiDependency()]),
          )
        : groups.map((group) => group.dependency);
    if (dependencies.length === 0) {
      throw new TypeError(`blocker ${blockerNodeId}の関係解消依存がありません`);
    }
    return Object.freeze({
      blockerNodeId,
      occurredAt,
      edges: Object.freeze(selectedEdges),
      dependencies: Object.freeze([combineAiAnalysisDependencies(dependencies)]),
    });
  });
  const resolutionOccurredAt = latestUtcIsoDateTime(
    [analysis.item.createdAt, ...blockerResolutions.map((resolution) => resolution.occurredAt)],
    `newly unblocked項目 ${analysis.item.nodeId}`,
  );
  const resolutionDependencies = blockerResolutions.flatMap(
    (resolution) => resolution.dependencies,
  );
  if (resolutionDependencies.length === 0) {
    throw new TypeError(`newly unblocked項目 ${analysis.item.nodeId}の依存解消根拠がありません`);
  }
  const sourceIds = [...edgesByBlockerNodeId.values()]
    .flat()
    .flatMap((edge) => edge.evidence.map((evidence) => evidence.sourceId));
  return Object.freeze({
    progress: Object.freeze([
      Object.freeze({
        occurredAt: resolutionOccurredAt,
        sourceIds: nonEmptySourceIds(sourceIds, `newly unblocked項目 ${analysis.item.nodeId}`),
        aiDependency: combineAiAnalysisDependencies(resolutionDependencies),
      }),
    ]),
    cause,
  });
}
