import type { AiAnalysisDependency } from "../../domain/ai-analysis-dependencies.js";
import type { GraphNodeId } from "../../domain/index.js";
import type { BlockerNodeAiDependency } from "../../graph/index.js";
import { assertNonNullable } from "../../util/index.js";
import type { GraphResult } from "./contracts.js";

/** downstream impactのAI依存をnode IDで索引する。 */
export function downstreamImpactAiDependenciesByNodeId(
  graph: GraphResult,
): ReadonlyMap<GraphNodeId, AiAnalysisDependency> {
  const dependenciesByNodeId = new Map<GraphNodeId, AiAnalysisDependency>();
  for (const entry of graph.downstreamImpactAiDependencies) {
    if (dependenciesByNodeId.has(entry.nodeId)) {
      throw new TypeError(`downstream impact AI依存が重複しています。対象: ${entry.nodeId}`);
    }
    dependenciesByNodeId.set(entry.nodeId, entry.dependency);
  }
  return dependenciesByNodeId;
}

/** blocker集合のAI依存をnode IDで索引する。 */
export function blockersAiDependenciesByNodeId(
  graph: GraphResult,
): ReadonlyMap<GraphNodeId, AiAnalysisDependency> {
  const dependenciesByNodeId = new Map<GraphNodeId, AiAnalysisDependency>();
  for (const entry of graph.blockerSetAiDependencies) {
    if (dependenciesByNodeId.has(entry.nodeId)) {
      throw new TypeError(`blocker AI依存のnodeが重複しています。対象: ${entry.nodeId}`);
    }
    dependenciesByNodeId.set(entry.nodeId, entry.dependency);
  }
  return dependenciesByNodeId;
}

export type BlockerNodeAiDependenciesByBlockedNodeId = ReadonlyMap<
  GraphNodeId,
  ReadonlyMap<string, BlockerNodeAiDependency>
>;

/** blocker nodeのAI依存を被block node IDで索引する。 */
export function blockerNodeAiDependenciesByBlockedNodeId(
  graph: GraphResult,
): BlockerNodeAiDependenciesByBlockedNodeId {
  const dependenciesByBlockedNodeId = new Map<GraphNodeId, Map<string, BlockerNodeAiDependency>>();
  for (const entry of graph.blockerNodeAiDependencies) {
    const dependenciesByBlockerNodeId = dependenciesByBlockedNodeId.get(entry.blockedNodeId);
    if (dependenciesByBlockerNodeId == null) {
      dependenciesByBlockedNodeId.set(entry.blockedNodeId, new Map([[entry.blockerNodeId, entry]]));
      continue;
    }
    if (dependenciesByBlockerNodeId.has(entry.blockerNodeId)) {
      throw new TypeError(
        `blocker node AI依存が重複しています。対象: ${entry.blockedNodeId} blocker: ${entry.blockerNodeId}`,
      );
    }
    dependenciesByBlockerNodeId.set(entry.blockerNodeId, entry);
  }
  return dependenciesByBlockedNodeId;
}

/** graphのAI依存をnode IDで索引する。 */
export function graphAiDependenciesByNodeId(
  entries: readonly Readonly<{
    nodeId: GraphNodeId;
    dependency: AiAnalysisDependency;
  }>[],
  description: string,
): ReadonlyMap<GraphNodeId, AiAnalysisDependency> {
  const dependenciesByNodeId = new Map<GraphNodeId, AiAnalysisDependency>();
  for (const entry of entries) {
    if (dependenciesByNodeId.has(entry.nodeId)) {
      throw new TypeError(`${description}が重複しています。対象: ${entry.nodeId}`);
    }
    dependenciesByNodeId.set(entry.nodeId, entry.dependency);
  }
  return dependenciesByNodeId;
}

/** 指定nodeのgraph AI依存を取得する。 */
export function graphAiDependencyForNode(
  dependenciesByNodeId: ReadonlyMap<GraphNodeId, AiAnalysisDependency> | undefined,
  nodeId: GraphNodeId,
  description: string,
): AiAnalysisDependency {
  assertNonNullable(dependenciesByNodeId, `${description}のAI依存indexがありません`);
  const dependency = dependenciesByNodeId.get(nodeId);
  assertNonNullable(dependency, `${description}のAI依存がありません。対象: ${nodeId}`);
  return dependency;
}
