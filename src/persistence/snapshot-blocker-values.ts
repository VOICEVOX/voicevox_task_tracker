import { hashCanonicalJson } from "../canonical-json/index.js";
import { aiAnalysisElementApplicationUsesAiValue } from "../domain/ai-analysis-elements.js";
import {
  type AiAnalysisDependency,
  type AiAnalysisDependencyElement,
  type TrackedItemState,
} from "../domain/index.js";
import { type BlockerNodeAiDependency } from "../graph/index.js";
import { StateSnapshotSemanticError } from "./errors.js";
import type {
  SnapshotBlocker,
  SnapshotBlockerAnalysis,
  SnapshotBlockerValueAiDependencies,
} from "./snapshot-blocker-analysis.js";
import {
  combineSnapshotAiDependencies,
  notDependentSnapshotAiDependency,
} from "./snapshot-blocker-analysis.js";
import type { SnapshotTrackedItem } from "./snapshot-contracts.js";
import {
  aiAnalysisDependencyContainsRecordedLowerBound,
  aiAnalysisDependencyStatusPriority,
} from "./snapshot-graph-dependencies.js";
import { preferredBlockerSupportDependency } from "./snapshot-relations.js";

function snapshotBlockerPrimitiveDependency(
  blocker: SnapshotBlocker,
  primitives: readonly (keyof Pick<
    BlockerNodeAiDependency,
    "presence" | "confidence" | "sourceIds" | "becameBlockingAt"
  >)[],
): AiAnalysisDependency {
  return combineSnapshotAiDependencies(
    primitives.map((primitive) => blocker.dependency[primitive]),
  );
}

function preferredSnapshotAiDependencies(
  dependencies: readonly AiAnalysisDependency[],
  count: number,
): readonly AiAnalysisDependency[] {
  return Object.freeze(
    dependencies
      .map((dependency, index) => Object.freeze({ dependency, index }))
      .sort((left, right) => {
        const priorityOrder =
          aiAnalysisDependencyStatusPriority(left.dependency.status) -
          aiAnalysisDependencyStatusPriority(right.dependency.status);
        return priorityOrder === 0 ? left.index - right.index : priorityOrder;
      })
      .slice(0, count)
      .map((entry) => entry.dependency),
  );
}

function deterministicBlockerDecisionIsBlocked(
  item: SnapshotTrackedItem,
  blockers: readonly SnapshotBlocker[],
  effectiveState: TrackedItemState,
): boolean | undefined {
  if (effectiveState !== "open") {
    return undefined;
  }
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
  const authoritativeBlockerExists = blockers.some(
    (blocker) => blocker.authority === "authoritative",
  );
  if (
    new Set(results).size > 1 ||
    (authoritativeBlockerExists && results.some((result) => !result))
  ) {
    throw new StateSnapshotSemanticError(
      `item ${item.nodeId}のblocker判定値が相互に矛盾しています`,
    );
  }
  const visibleDecision = results[0];
  if (visibleDecision != null) {
    return visibleDecision;
  }
  return authoritativeBlockerExists ? true : undefined;
}

function deterministicConfirmedBlockers(
  item: SnapshotTrackedItem,
  blockers: readonly SnapshotBlocker[],
  blocked: boolean,
): readonly SnapshotBlocker[] | undefined {
  if (aiAnalysisElementApplicationUsesAiValue(item.aiAnalysis.applications.waitingOn)) {
    return undefined;
  }
  if (!blocked) {
    return Object.freeze([]);
  }
  const blockersByNodeId = new Map<string, SnapshotBlocker>(
    blockers.map((blocker) => [blocker.blockerNodeId, blocker]),
  );
  const confirmed: SnapshotBlocker[] = [];
  for (const waitingOn of item.waitingOn) {
    if (waitingOn.kind !== "item" || waitingOn.role !== "dependency") {
      throw new StateSnapshotSemanticError(`item ${item.nodeId}のblocker waitingOnが不正です`);
    }
    const blocker = blockersByNodeId.get(waitingOn.candidateId);
    if (blocker == null) {
      throw new StateSnapshotSemanticError(
        `item ${item.nodeId}のblocker waitingOnに対応するactive relationがありません`,
      );
    }
    confirmed.push(blocker);
  }
  if (confirmed.length === 0) {
    throw new StateSnapshotSemanticError(`item ${item.nodeId}の確定blocker waitingOnがありません`);
  }
  return Object.freeze(confirmed);
}

export function assertAuthoritativeBlockerStateCompleteness(
  item: SnapshotTrackedItem,
  blockers: readonly SnapshotBlocker[],
): void {
  const authoritativeBlockerNodeIds = blockers
    .filter((blocker) => blocker.authority === "authoritative")
    .map((blocker) => blocker.blockerNodeId);
  if (authoritativeBlockerNodeIds.length === 0) {
    return;
  }
  const waitingOnNodeIds = item.waitingOn.map((waitingOn) => waitingOn.candidateId);
  if (
    authoritativeBlockerNodeIds.some((blockerNodeId) => !waitingOnNodeIds.includes(blockerNodeId))
  ) {
    throw new StateSnapshotSemanticError(
      `item ${item.nodeId}のwaitingOnに確定blockerが不足しています`,
    );
  }
  if (
    authoritativeBlockerNodeIds.some(
      (blockerNodeId, index) => waitingOnNodeIds[index] !== blockerNodeId,
    )
  ) {
    throw new StateSnapshotSemanticError(
      `item ${item.nodeId}のwaitingOn先頭が確定blockerの順序と一致しません`,
    );
  }
  const primaryAuthoritativeBlockerNodeId = authoritativeBlockerNodeIds[0];
  if (primaryAuthoritativeBlockerNodeId == null) {
    throw new StateSnapshotSemanticError(
      `item ${item.nodeId}のprimary確定blockerを再構成できません`,
    );
  }
  if (item.nextAction !== `${primaryAuthoritativeBlockerNodeId}の完了を待つ`) {
    throw new StateSnapshotSemanticError(
      `item ${item.nodeId}のnextActionがprimary確定blockerと一致しません`,
    );
  }
}

function blockerStatusDependencyCandidates(
  blockers: readonly SnapshotBlocker[],
  confirmedBlockers: readonly SnapshotBlocker[] | undefined,
): readonly AiAnalysisDependency[] {
  const blockerGroups =
    confirmedBlockers == null
      ? [...new Set(blockers.map((blocker) => blocker.confidenceValue))].map((threshold) =>
          blockers.filter((blocker) => blocker.confidenceValue >= threshold),
        )
      : [confirmedBlockers];
  const dependencies = new Map<string, AiAnalysisDependency>();
  for (const group of blockerGroups) {
    const dependency = preferredBlockerSupportDependency(
      group.map((blocker) =>
        snapshotBlockerPrimitiveDependency(blocker, ["presence", "confidence"]),
      ),
    );
    dependencies.set(hashCanonicalJson(dependency), dependency);
  }
  return Object.freeze([...dependencies.values()]);
}

export function expectedSnapshotBlockerValueAiDependencies(
  item: SnapshotTrackedItem,
  analysis: SnapshotBlockerAnalysis,
  effectiveState: TrackedItemState,
): SnapshotBlockerValueAiDependencies {
  if (effectiveState !== "open") {
    const dependency = notDependentSnapshotAiDependency();
    return Object.freeze({
      stateSupport: "conditional",
      statusCandidates: Object.freeze([dependency]),
      waitingOn: dependency,
      primaryWaitingOn: dependency,
      nextAction: dependency,
      confidence: dependency,
      evidence: dependency,
      uncertainties: dependency,
    });
  }
  const blockers = analysis.blockersByBlockedNodeId.get(item.nodeId) ?? [];
  const negativeDependency =
    analysis.negativeDependenciesByNodeId.get(item.nodeId) ?? notDependentSnapshotAiDependency();
  const conditions = blockers.map((blocker) =>
    snapshotBlockerPrimitiveDependency(blocker, ["presence", "confidence"]),
  );
  const evidence = blockers.map((blocker) =>
    snapshotBlockerPrimitiveDependency(blocker, ["presence", "confidence", "sourceIds"]),
  );
  const selectionConditions = blockers.map((blocker) =>
    snapshotBlockerPrimitiveDependency(blocker, ["presence", "confidence", "becameBlockingAt"]),
  );
  const blocked = deterministicBlockerDecisionIsBlocked(item, blockers, effectiveState);
  if (blocked == null) {
    return Object.freeze({
      stateSupport: "conditional",
      statusCandidates: undefined,
      waitingOn: undefined,
      primaryWaitingOn: undefined,
      nextAction: undefined,
      confidence: undefined,
      evidence: combineSnapshotAiDependencies([...evidence, negativeDependency]),
      uncertainties: undefined,
    });
  }
  if (!blocked) {
    const stateDependency = combineSnapshotAiDependencies([...conditions, negativeDependency]);
    return Object.freeze({
      stateSupport: "conditional",
      statusCandidates: Object.freeze([stateDependency]),
      waitingOn: stateDependency,
      primaryWaitingOn: stateDependency,
      nextAction: stateDependency,
      confidence: stateDependency,
      evidence: combineSnapshotAiDependencies([...evidence, negativeDependency]),
      uncertainties: stateDependency,
    });
  }
  const primaryBlocker = blockers[0];
  if (primaryBlocker == null) {
    throw new StateSnapshotSemanticError(`item ${item.nodeId}のprimary blockerを再構成できません`);
  }
  const confirmedBlockers = deterministicConfirmedBlockers(item, blockers, blocked);
  const stateSupport =
    primaryBlocker.authority === "authoritative" ? "authoritative_blocker" : "conditional";
  const statusCandidates =
    stateSupport === "authoritative_blocker"
      ? Object.freeze([notDependentSnapshotAiDependency()])
      : blockerStatusDependencyCandidates(blockers, confirmedBlockers);
  let waitingOn: AiAnalysisDependency | undefined;
  let primaryWaitingOn: AiAnalysisDependency | undefined;
  if (confirmedBlockers != null) {
    const confirmedNodeIds = new Set(confirmedBlockers.map((blocker) => blocker.blockerNodeId));
    const uncertainBlockers = blockers.filter(
      (blocker) => !confirmedNodeIds.has(blocker.blockerNodeId),
    );
    waitingOn = combineSnapshotAiDependencies([
      ...confirmedBlockers.map((blocker) =>
        snapshotBlockerPrimitiveDependency(blocker, [
          "presence",
          "confidence",
          "sourceIds",
          "becameBlockingAt",
        ]),
      ),
      ...uncertainBlockers.map((blocker) =>
        snapshotBlockerPrimitiveDependency(blocker, ["presence", "confidence"]),
      ),
      negativeDependency,
    ]);
    const primarySelectionDependency =
      primaryBlocker.authority === "authoritative"
        ? notDependentSnapshotAiDependency()
        : combineSnapshotAiDependencies([...selectionConditions, negativeDependency]);
    const authoritativeConfirmedCount = confirmedBlockers.filter(
      (blocker) => blocker.authority === "authoritative",
    ).length;
    const inferredConfirmedConditions = confirmedBlockers.flatMap((blocker) =>
      blocker.authority === "inferred"
        ? [snapshotBlockerPrimitiveDependency(blocker, ["presence", "confidence"])]
        : [],
    );
    const multiplicityDependency =
      confirmedBlockers.length === 1
        ? combineSnapshotAiDependencies([
            ...uncertainBlockers.map((blocker) =>
              snapshotBlockerPrimitiveDependency(blocker, ["presence", "confidence"]),
            ),
            negativeDependency,
          ])
        : combineSnapshotAiDependencies(
            preferredSnapshotAiDependencies(
              inferredConfirmedConditions,
              Math.max(0, 2 - authoritativeConfirmedCount),
            ),
          );
    primaryWaitingOn = combineSnapshotAiDependencies([
      primarySelectionDependency,
      multiplicityDependency,
    ]);
  }
  const nextAction =
    stateSupport === "authoritative_blocker"
      ? notDependentSnapshotAiDependency()
      : combineSnapshotAiDependencies([...selectionConditions, negativeDependency]);
  const confidence =
    stateSupport === "authoritative_blocker"
      ? combineSnapshotAiDependencies([
          primaryBlocker.dependency.confidence,
          ...blockers
            .filter((blocker) => blocker.authority === "inferred")
            .map((blocker) =>
              snapshotBlockerPrimitiveDependency(blocker, ["presence", "confidence"]),
            ),
          negativeDependency,
        ])
      : combineSnapshotAiDependencies([
          primaryBlocker.dependency.confidence,
          ...selectionConditions,
          negativeDependency,
        ]);
  return Object.freeze({
    stateSupport,
    statusCandidates,
    waitingOn,
    primaryWaitingOn,
    nextAction,
    confidence,
    evidence: combineSnapshotAiDependencies([...evidence, negativeDependency]),
    uncertainties: combineSnapshotAiDependencies([...conditions, negativeDependency]),
  });
}

export function assertBlockerValueDependencyLowerBounds(
  item: SnapshotTrackedItem,
  expected: SnapshotBlockerValueAiDependencies,
): void {
  const applications = item.aiAnalysis.applications;
  const statusUsesAi = aiAnalysisElementApplicationUsesAiValue(applications.status);
  const waitingOnUsesAi = aiAnalysisElementApplicationUsesAiValue(applications.waitingOn);
  const nextActionUsesAi = aiAnalysisElementApplicationUsesAiValue(applications.nextAction);
  const assertLowerBound = (
    element: AiAnalysisDependencyElement,
    dependency: AiAnalysisDependency | undefined,
  ): void => {
    if (dependency == null) {
      throw new StateSnapshotSemanticError(
        `item ${item.nodeId}の${element} blocker AI依存を再構成できません`,
      );
    }
    if (!aiAnalysisDependencyContainsRecordedLowerBound(dependency, item.aiDependencies[element])) {
      throw new StateSnapshotSemanticError(
        `item ${item.nodeId}の${element} AI依存がblocker判定の導出元を含んでいません`,
      );
    }
  };
  if (!statusUsesAi) {
    const candidates = expected.statusCandidates;
    if (
      candidates?.some((candidate) =>
        aiAnalysisDependencyContainsRecordedLowerBound(candidate, item.aiDependencies.status),
      ) !== true
    ) {
      throw new StateSnapshotSemanticError(
        `item ${item.nodeId}のstatus AI依存がblocker判定の導出元を含んでいません`,
      );
    }
  }
  if (!waitingOnUsesAi) {
    assertLowerBound("waitingOn", expected.waitingOn);
    assertLowerBound("primaryWaitingOn", expected.primaryWaitingOn);
  }
  if (!nextActionUsesAi) {
    assertLowerBound("nextAction", expected.nextAction);
  }
  if (
    !statusUsesAi ||
    !waitingOnUsesAi ||
    !nextActionUsesAi ||
    expected.stateSupport === "authoritative_blocker"
  ) {
    assertLowerBound("confidence", expected.confidence);
    assertLowerBound("evidence", expected.evidence);
  }
  if (expected.uncertainties != null) {
    assertLowerBound("uncertainties", expected.uncertainties);
  }
}
