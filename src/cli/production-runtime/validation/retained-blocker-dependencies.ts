import { hashCanonicalJson } from "../../../canonical-json/index.js";
import type { AiAnalysisDependency } from "../../../domain/ai-analysis-dependencies.js";
import type { GitHubNodeId, GraphNodeId } from "../../../domain/index.js";
import type { BlockerNodeAiDependency } from "../../../graph/index.js";
import { combineBlockerPrimitiveDependencies } from "../ai-dependencies/blocker-values.js";
import {
  combineSelectedAiDependencies,
  notDependentAiDependency,
  preferIndependentAiDependency,
  preferredAiDependencies,
} from "../ai-dependencies/selection.js";
import type { GraphResult, PendingTrackedItem } from "../contracts.js";
import { graphAiDependenciesByNodeId, graphAiDependencyForNode } from "../graph-result-indexes.js";
import {
  retainedBlockerDecision,
  retainedBlockersByBlockedNodeId,
  retainedConfirmedBlockers,
  type RetainedBlocker,
} from "./retained-blocker-topology.js";

/** 古いrepositoryのAI依存を作る。 */
export function staleRepositoryAiDependency(): AiAnalysisDependency {
  return Object.freeze({
    status: "unknown",
    reasons: Object.freeze(["stale_repository"]),
  } satisfies AiAnalysisDependency);
}

export type RetainedBlockerValueAiDependencies = Readonly<{
  statusCandidates: readonly AiAnalysisDependency[] | undefined;
  waitingOn: AiAnalysisDependency | undefined;
  primaryWaitingOn: AiAnalysisDependency | undefined;
  nextAction: AiAnalysisDependency | undefined;
  confidence: AiAnalysisDependency | undefined;
  evidence: AiAnalysisDependency | undefined;
  uncertainties: AiAnalysisDependency | undefined;
  blockerStateRetainedWithoutCurrentTopology: boolean;
}>;

function retainedBlockerPrimitiveDependency(
  blocker: RetainedBlocker,
  primitives: readonly (keyof Pick<
    BlockerNodeAiDependency,
    "presence" | "confidence" | "sourceIds" | "becameBlockingAt"
  >)[],
): AiAnalysisDependency {
  return combineBlockerPrimitiveDependencies(blocker.dependency, primitives);
}

function retainedBlockerStatusDependencyCandidates(
  blockers: readonly RetainedBlocker[],
  confirmedBlockers: readonly RetainedBlocker[] | undefined,
): readonly AiAnalysisDependency[] {
  const blockerGroups =
    confirmedBlockers == null
      ? [...new Set(blockers.map((blocker) => blocker.confidence))].map((threshold) =>
          blockers.filter((blocker) => blocker.confidence >= threshold),
        )
      : [confirmedBlockers];
  const dependenciesByHash = new Map<string, AiAnalysisDependency>();
  for (const group of blockerGroups) {
    const dependency = preferIndependentAiDependency(
      group.map((blocker) =>
        retainedBlockerPrimitiveDependency(blocker, ["presence", "confidence"]),
      ),
    );
    dependenciesByHash.set(hashCanonicalJson(dependency), dependency);
  }
  return Object.freeze([...dependenciesByHash.values()]);
}

function retainedBlockerValueAiDependenciesWithoutCurrentTopology(): RetainedBlockerValueAiDependencies {
  const dependency = staleRepositoryAiDependency();
  return Object.freeze({
    statusCandidates: Object.freeze([dependency]),
    waitingOn: dependency,
    primaryWaitingOn: dependency,
    nextAction: dependency,
    confidence: dependency,
    evidence: dependency,
    uncertainties: dependency,
    blockerStateRetainedWithoutCurrentTopology: true,
  });
}

function retainedBlockerValueAiDependencies(
  item: PendingTrackedItem,
  blockers: readonly RetainedBlocker[],
  negativeDependency: AiAnalysisDependency,
  minimumInferredConfidence: number,
  itemIsStale: boolean,
  blockerTopologyChangedWhileStale: boolean,
): RetainedBlockerValueAiDependencies {
  if (item.state !== "open") {
    const dependency = notDependentAiDependency();
    return Object.freeze({
      statusCandidates: Object.freeze([dependency]),
      waitingOn: dependency,
      primaryWaitingOn: dependency,
      nextAction: dependency,
      confidence: dependency,
      evidence: dependency,
      uncertainties: dependency,
      blockerStateRetainedWithoutCurrentTopology: false,
    });
  }
  if (blockerTopologyChangedWhileStale) {
    if (!itemIsStale) {
      throw new TypeError(
        `fresh item ${item.nodeId}をstale blocker topology保持対象にはできません`,
      );
    }
    return retainedBlockerValueAiDependenciesWithoutCurrentTopology();
  }
  const conditions = blockers.map((blocker) =>
    retainedBlockerPrimitiveDependency(blocker, ["presence", "confidence"]),
  );
  const evidenceDependencies = blockers.map((blocker) =>
    retainedBlockerPrimitiveDependency(blocker, ["presence", "confidence", "sourceIds"]),
  );
  const selectionConditions = blockers.map((blocker) =>
    retainedBlockerPrimitiveDependency(blocker, ["presence", "confidence", "becameBlockingAt"]),
  );
  const evidence = combineSelectedAiDependencies([...evidenceDependencies, negativeDependency]);
  const decision = retainedBlockerDecision(item, blockers, minimumInferredConfidence);
  if (decision.status === "inconsistent") {
    if (itemIsStale) {
      return retainedBlockerValueAiDependenciesWithoutCurrentTopology();
    }
    throw new TypeError(`retained item ${item.nodeId}のblocker判定値が相互に矛盾しています`);
  }
  const blocked = decision.blocked;
  if (blocked == null) {
    return Object.freeze({
      statusCandidates: undefined,
      waitingOn: undefined,
      primaryWaitingOn: undefined,
      nextAction: undefined,
      confidence: undefined,
      evidence: undefined,
      uncertainties: undefined,
      blockerStateRetainedWithoutCurrentTopology: false,
    });
  }
  if (!blocked) {
    const dependency = combineSelectedAiDependencies([...conditions, negativeDependency]);
    return Object.freeze({
      statusCandidates: Object.freeze([dependency]),
      waitingOn: dependency,
      primaryWaitingOn: dependency,
      nextAction: dependency,
      confidence: dependency,
      evidence,
      uncertainties: dependency,
      blockerStateRetainedWithoutCurrentTopology: false,
    });
  }
  const primaryBlocker = blockers[0];
  if (primaryBlocker == null) {
    if (itemIsStale) {
      return retainedBlockerValueAiDependenciesWithoutCurrentTopology();
    }
    throw new TypeError(`retained item ${item.nodeId}のprimary blockerを再構成できません`);
  }
  const confirmedBlockerResult = retainedConfirmedBlockers(item, blockers);
  if (confirmedBlockerResult.status === "inconsistent") {
    if (itemIsStale) {
      return retainedBlockerValueAiDependenciesWithoutCurrentTopology();
    }
    throw new TypeError(`retained item ${item.nodeId}のblocker waitingOnが不正です`);
  }
  const confirmedBlockers =
    confirmedBlockerResult.status === "consistent" ? confirmedBlockerResult.blockers : undefined;
  const statusCandidates =
    primaryBlocker.authority === "authoritative"
      ? Object.freeze([notDependentAiDependency()])
      : retainedBlockerStatusDependencyCandidates(blockers, confirmedBlockers);
  let waitingOn: AiAnalysisDependency | undefined;
  let primaryWaitingOn: AiAnalysisDependency | undefined;
  if (confirmedBlockers != null) {
    const confirmedNodeIds = new Set(confirmedBlockers.map((blocker) => blocker.blockerNodeId));
    const uncertainBlockers = blockers.filter(
      (blocker) => !confirmedNodeIds.has(blocker.blockerNodeId),
    );
    waitingOn = combineSelectedAiDependencies([
      ...confirmedBlockers.map((blocker) =>
        retainedBlockerPrimitiveDependency(blocker, [
          "presence",
          "confidence",
          "sourceIds",
          "becameBlockingAt",
        ]),
      ),
      ...uncertainBlockers.map((blocker) =>
        retainedBlockerPrimitiveDependency(blocker, ["presence", "confidence"]),
      ),
      negativeDependency,
    ]);
    const primarySelectionDependency =
      primaryBlocker.authority === "authoritative"
        ? notDependentAiDependency()
        : combineSelectedAiDependencies([...selectionConditions, negativeDependency]);
    const authoritativeConfirmedCount = confirmedBlockers.filter(
      (blocker) => blocker.authority === "authoritative",
    ).length;
    const inferredConfirmedConditions = confirmedBlockers.flatMap((blocker) =>
      blocker.authority === "inferred"
        ? [retainedBlockerPrimitiveDependency(blocker, ["presence", "confidence"])]
        : [],
    );
    const multiplicityDependency =
      confirmedBlockers.length === 1
        ? combineSelectedAiDependencies([
            ...uncertainBlockers.map((blocker) =>
              retainedBlockerPrimitiveDependency(blocker, ["presence", "confidence"]),
            ),
            negativeDependency,
          ])
        : combineSelectedAiDependencies(
            preferredAiDependencies(
              inferredConfirmedConditions,
              Math.max(0, 2 - authoritativeConfirmedCount),
            ),
          );
    primaryWaitingOn = combineSelectedAiDependencies([
      primarySelectionDependency,
      multiplicityDependency,
    ]);
  }
  const nextAction =
    primaryBlocker.authority === "authoritative"
      ? notDependentAiDependency()
      : combineSelectedAiDependencies([...selectionConditions, negativeDependency]);
  const confidence =
    primaryBlocker.authority === "authoritative"
      ? combineSelectedAiDependencies([
          primaryBlocker.dependency.confidence,
          ...blockers
            .filter((blocker) => blocker.authority === "inferred")
            .map((blocker) =>
              retainedBlockerPrimitiveDependency(blocker, ["presence", "confidence"]),
            ),
          negativeDependency,
        ])
      : combineSelectedAiDependencies([
          primaryBlocker.dependency.confidence,
          ...selectionConditions,
          negativeDependency,
        ]);
  return Object.freeze({
    statusCandidates,
    waitingOn,
    primaryWaitingOn,
    nextAction,
    confidence,
    evidence,
    uncertainties: combineSelectedAiDependencies([...conditions, negativeDependency]),
    blockerStateRetainedWithoutCurrentTopology: false,
  });
}

/** 保持項目のblocker値AI依存をnode別に索引する。 */
export function retainedBlockerValueAiDependenciesByNodeId(
  graph: GraphResult,
  items: readonly PendingTrackedItem[],
  minimumInferredConfidence: number,
  staleNodeIds: ReadonlySet<string>,
  staleBlockerTopologyNodeIds: ReadonlySet<GitHubNodeId>,
): ReadonlyMap<GraphNodeId, RetainedBlockerValueAiDependencies> {
  const itemsByNodeId = new Map(items.map((item) => [item.nodeId, item]));
  const blockersByBlockedNodeId = retainedBlockersByBlockedNodeId(graph, itemsByNodeId);
  const negativeDependenciesByNodeId = graphAiDependenciesByNodeId(
    graph.negativeBlockerAiDependencies,
    "negative blocker AI依存",
  );
  const dependenciesByNodeId = new Map<GraphNodeId, RetainedBlockerValueAiDependencies>();
  for (const item of items) {
    if (dependenciesByNodeId.has(item.nodeId)) {
      throw new TypeError(`retained blocker値AI依存のnodeが重複しています。対象: ${item.nodeId}`);
    }
    const negativeDependency = graphAiDependencyForNode(
      negativeDependenciesByNodeId,
      item.nodeId,
      "negative blocker AI依存",
    );
    dependenciesByNodeId.set(
      item.nodeId,
      retainedBlockerValueAiDependencies(
        item,
        blockersByBlockedNodeId.get(item.nodeId) ?? Object.freeze([]),
        negativeDependency,
        minimumInferredConfidence,
        staleNodeIds.has(item.nodeId),
        staleBlockerTopologyNodeIds.has(item.nodeId),
      ),
    );
  }
  return dependenciesByNodeId;
}
