import { aiAnalysisElementApplicationUsesAiValue } from "../../../domain/ai-analysis-elements.js";
import type { GitHubNodeId, GraphNodeId, UtcIsoDateTime } from "../../../domain/index.js";
import type { BlockerNodeAiDependency, ReconciledGraphEdge } from "../../../graph/index.js";
import { assertNonNullable } from "../../../util/index.js";
import type { GraphResult, PendingTrackedItem } from "../contracts.js";
import { blockerNodeAiDependenciesByBlockedNodeId } from "../graph-result-indexes.js";

export type RetainedBlocker = Readonly<{
  blockerNodeId: GraphNodeId;
  authority: "authoritative" | "inferred";
  confidence: number;
  becameBlockingAt: UtcIsoDateTime;
  dependency: BlockerNodeAiDependency;
}>;

function compareRetainedBlockers(left: RetainedBlocker, right: RetainedBlocker): number {
  if (left.authority !== right.authority) {
    return left.authority === "authoritative" ? -1 : 1;
  }
  if (left.confidence !== right.confidence) {
    return right.confidence - left.confidence;
  }
  if (left.becameBlockingAt !== right.becameBlockingAt) {
    return left.becameBlockingAt < right.becameBlockingAt ? -1 : 1;
  }
  if (left.blockerNodeId === right.blockerNodeId) {
    return 0;
  }
  return left.blockerNodeId < right.blockerNodeId ? -1 : 1;
}

/** nativeの未完了blockerを対象node別に索引する。 */
export function nativeOpenBlockerNodeIdsByTargetNodeId(
  graph: GraphResult,
): ReadonlyMap<GraphNodeId, ReadonlySet<GraphNodeId>> {
  const blockerNodeIdsByTargetNodeId = new Map<GraphNodeId, Set<GraphNodeId>>();
  for (const edge of graph.edges) {
    if (
      !edge.active ||
      edge.type !== "blocks" ||
      edge.provenance !== "native" ||
      edge.aiDependency.status !== "not_dependent" ||
      !graph.openNodeIds.has(edge.fromNodeId) ||
      !graph.openNodeIds.has(edge.toNodeId)
    ) {
      continue;
    }
    const blockerNodeIds = blockerNodeIdsByTargetNodeId.get(edge.toNodeId);
    if (blockerNodeIds == null) {
      blockerNodeIdsByTargetNodeId.set(edge.toNodeId, new Set([edge.fromNodeId]));
    } else {
      blockerNodeIds.add(edge.fromNodeId);
    }
  }
  return blockerNodeIdsByTargetNodeId;
}

/** 保持項目のblockerを対象node別に索引する。 */
export function retainedBlockersByBlockedNodeId(
  graph: GraphResult,
  itemsByNodeId: ReadonlyMap<GitHubNodeId, PendingTrackedItem>,
): ReadonlyMap<GraphNodeId, readonly RetainedBlocker[]> {
  const supportsByBlockedNodeId = new Map<GraphNodeId, Map<GraphNodeId, ReconciledGraphEdge[]>>();
  for (const edge of graph.edges) {
    if (
      !edge.active ||
      edge.type !== "blocks" ||
      !graph.openNodeIds.has(edge.fromNodeId) ||
      !graph.openNodeIds.has(edge.toNodeId)
    ) {
      continue;
    }
    const supportsByBlockerNodeId = supportsByBlockedNodeId.get(edge.toNodeId);
    if (supportsByBlockerNodeId == null) {
      supportsByBlockedNodeId.set(edge.toNodeId, new Map([[edge.fromNodeId, [edge]]]));
      continue;
    }
    const supports = supportsByBlockerNodeId.get(edge.fromNodeId);
    if (supports == null) {
      supportsByBlockerNodeId.set(edge.fromNodeId, [edge]);
    } else {
      supports.push(edge);
    }
  }
  const blockerDependenciesByNodeId = blockerNodeAiDependenciesByBlockedNodeId(graph);
  const blockersByBlockedNodeId = new Map<GraphNodeId, readonly RetainedBlocker[]>();
  for (const targetItem of itemsByNodeId.values()) {
    const blockedNodeId = targetItem.nodeId;
    const dependenciesByBlockerNodeId = blockerDependenciesByNodeId.get(blockedNodeId);
    const supportsByBlockerNodeId = supportsByBlockedNodeId.get(blockedNodeId);
    const blockers: RetainedBlocker[] = [];
    for (const [blockerNodeId, supports] of supportsByBlockerNodeId ?? []) {
      assertNonNullable(
        dependenciesByBlockerNodeId,
        `retained blockerのAI依存がありません。対象: ${blockedNodeId}`,
      );
      const dependency = dependenciesByBlockerNodeId.get(blockerNodeId);
      assertNonNullable(
        dependency,
        `retained blockerのAI依存がありません。対象: ${blockedNodeId} blocker: ${blockerNodeId}`,
      );
      const confidence = Math.max(...supports.map((support) => support.confidence));
      const becameBlockingAt = supports
        .map((support) =>
          support.provenance === "native" ? targetItem.createdAt : support.firstSeenAt,
        )
        .reduce((earliest, occurredAt) => (occurredAt < earliest ? occurredAt : earliest));
      blockers.push(
        Object.freeze({
          blockerNodeId,
          authority: supports.some((support) => support.provenance === "native")
            ? "authoritative"
            : "inferred",
          confidence,
          becameBlockingAt,
          dependency,
        }),
      );
    }
    blockersByBlockedNodeId.set(
      blockedNodeId,
      Object.freeze(blockers.sort(compareRetainedBlockers)),
    );
  }
  return blockersByBlockedNodeId;
}

type RetainedBlockerDecision =
  | Readonly<{ status: "consistent"; blocked: boolean | undefined }>
  | Readonly<{ status: "inconsistent" }>;

/** 保持項目のblocker判定を照合する。 */
export function retainedBlockerDecision(
  item: PendingTrackedItem,
  blockers: readonly RetainedBlocker[],
  minimumInferredConfidence: number,
): RetainedBlockerDecision {
  const blockerNodeIds = new Set<string>(blockers.map((blocker) => blocker.blockerNodeId));
  const results: boolean[] = [];
  const applications = item.aiAnalysis.applications;
  if (!aiAnalysisElementApplicationUsesAiValue(applications.status)) {
    results.push(item.status === "waiting_for_unblock");
  }
  if (!aiAnalysisElementApplicationUsesAiValue(applications.waitingOn)) {
    results.push(
      item.waitingOn.some(
        (waitingOn) =>
          waitingOn.kind === "item" &&
          waitingOn.role === "dependency" &&
          blockerNodeIds.has(waitingOn.candidateId),
      ),
    );
  }
  if (!aiAnalysisElementApplicationUsesAiValue(applications.nextAction)) {
    results.push(
      blockers.some((blocker) => item.nextAction === `${blocker.blockerNodeId}の完了を待つ`),
    );
  }
  const confirmedBlockerExists = blockers.some(
    (blocker) =>
      blocker.authority === "authoritative" || blocker.confidence >= minimumInferredConfidence,
  );
  if (new Set(results).size > 1 || (confirmedBlockerExists && results.some((result) => !result))) {
    return Object.freeze({ status: "inconsistent" });
  }
  const visibleDecision = results[0];
  if (visibleDecision != null) {
    return Object.freeze({ status: "consistent", blocked: visibleDecision });
  }
  return Object.freeze({
    status: "consistent",
    blocked: confirmedBlockerExists ? true : undefined,
  });
}

type RetainedConfirmedBlockers =
  | Readonly<{ status: "not_evaluated" }>
  | Readonly<{ status: "consistent"; blockers: readonly RetainedBlocker[] }>
  | Readonly<{ status: "inconsistent" }>;

/** 保持項目の確認済みblockerを照合する。 */
export function retainedConfirmedBlockers(
  item: PendingTrackedItem,
  blockers: readonly RetainedBlocker[],
): RetainedConfirmedBlockers {
  if (aiAnalysisElementApplicationUsesAiValue(item.aiAnalysis.applications.waitingOn)) {
    return Object.freeze({ status: "not_evaluated" });
  }
  const blockersByNodeId = new Map<string, RetainedBlocker>(
    blockers.map((blocker) => [blocker.blockerNodeId, blocker]),
  );
  const confirmed: RetainedBlocker[] = [];
  for (const waitingOn of item.waitingOn) {
    if (waitingOn.kind !== "item" || waitingOn.role !== "dependency") {
      return Object.freeze({ status: "inconsistent" });
    }
    const blocker = blockersByNodeId.get(waitingOn.candidateId);
    if (blocker == null) {
      return Object.freeze({ status: "inconsistent" });
    }
    confirmed.push(blocker);
  }
  if (confirmed.length === 0) {
    return Object.freeze({ status: "inconsistent" });
  }
  return Object.freeze({
    status: "consistent",
    blockers: Object.freeze(confirmed),
  });
}
