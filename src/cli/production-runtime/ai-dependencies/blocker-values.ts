import type { AiAnalysisDependency } from "../../../domain/ai-analysis-dependencies.js";
import type { BlockerDecisionTrace, GraphNodeId } from "../../../domain/index.js";
import type { BlockerNodeAiDependency } from "../../../graph/index.js";
import { assertNonNullable } from "../../../util/index.js";
import type { BlockerValueAiDependencies } from "../contracts.js";
import {
  graphAiDependencyForNode,
  type BlockerNodeAiDependenciesByBlockedNodeId,
} from "../graph-result-indexes.js";
import {
  combineSelectedAiDependencies,
  notDependentAiDependency,
  preferredAiDependencies,
  preferIndependentAiDependency,
  unrecordedAiDependency,
} from "./selection.js";

function notDependentBlockerValueAiDependencies(): BlockerValueAiDependencies {
  const dependency = notDependentAiDependency();
  return Object.freeze({
    stateSupport: "conditional",
    status: dependency,
    waitingOn: dependency,
    primaryWaitingOn: dependency,
    nextAction: dependency,
    confidence: dependency,
    evidence: dependency,
    uncertainties: dependency,
    transitionBasis: dependency,
  });
}

/** 未記録のblocker値AI依存を作る。 */
export function unknownBlockerValueAiDependencies(): BlockerValueAiDependencies {
  return Object.freeze({
    stateSupport: "conditional",
    status: unrecordedAiDependency(),
    waitingOn: unrecordedAiDependency(),
    primaryWaitingOn: unrecordedAiDependency(),
    nextAction: unrecordedAiDependency(),
    confidence: unrecordedAiDependency(),
    evidence: unrecordedAiDependency(),
    uncertainties: unrecordedAiDependency(),
    transitionBasis: unrecordedAiDependency(),
  });
}

function blockerNodeAiDependencyForTrace(
  dependenciesByBlockedNodeId: BlockerNodeAiDependenciesByBlockedNodeId,
  blockedNodeId: GraphNodeId,
  blockerNodeId: string,
): BlockerNodeAiDependency {
  const dependenciesByBlockerNodeId = dependenciesByBlockedNodeId.get(blockedNodeId);
  assertNonNullable(
    dependenciesByBlockerNodeId,
    `blocker node AI依存indexがありません。対象: ${blockedNodeId}`,
  );
  const dependency = dependenciesByBlockerNodeId.get(blockerNodeId);
  assertNonNullable(
    dependency,
    `blocker node AI依存がありません。対象: ${blockedNodeId} blocker: ${blockerNodeId}`,
  );
  return dependency;
}

/** blockerの基礎値に対するAI依存を結合する。 */
export function combineBlockerPrimitiveDependencies(
  dependency: BlockerNodeAiDependency,
  primitives: readonly (keyof Pick<
    BlockerNodeAiDependency,
    "presence" | "confidence" | "sourceIds" | "becameBlockingAt"
  >)[],
): AiAnalysisDependency {
  return combineSelectedAiDependencies(primitives.map((primitive) => dependency[primitive]));
}

/** blocker判定から各値のAI依存を得る。 */
export function blockerValueAiDependencies(
  nodeId: GraphNodeId,
  trace: BlockerDecisionTrace,
  dependenciesByBlockedNodeId: BlockerNodeAiDependenciesByBlockedNodeId,
  negativeDependenciesByNodeId: ReadonlyMap<GraphNodeId, AiAnalysisDependency>,
): BlockerValueAiDependencies {
  if (trace.status === "not_evaluated") {
    return notDependentBlockerValueAiDependencies();
  }
  const negativeDependency = graphAiDependencyForNode(
    negativeDependenciesByNodeId,
    nodeId,
    "negative blocker",
  );
  const uncertainDependencies = trace.uncertainBlockerIds.map((blockerNodeId) =>
    blockerNodeAiDependencyForTrace(dependenciesByBlockedNodeId, nodeId, blockerNodeId),
  );
  const uncertainConditions = uncertainDependencies.map((dependency) =>
    combineBlockerPrimitiveDependencies(dependency, ["presence", "confidence"]),
  );
  const uncertainEvidence = uncertainDependencies.map((dependency) =>
    combineBlockerPrimitiveDependencies(dependency, ["presence", "confidence", "sourceIds"]),
  );
  if (trace.result === "fallthrough") {
    const stateDependency = combineSelectedAiDependencies([
      ...uncertainConditions,
      negativeDependency,
    ]);
    const evidenceDependency = combineSelectedAiDependencies([
      ...uncertainEvidence,
      negativeDependency,
    ]);
    return Object.freeze({
      stateSupport: "conditional",
      status: stateDependency,
      waitingOn: stateDependency,
      primaryWaitingOn: stateDependency,
      nextAction: stateDependency,
      confidence: stateDependency,
      evidence: evidenceDependency,
      uncertainties: stateDependency,
      transitionBasis: stateDependency,
    });
  }

  const confirmedDependencies = trace.confirmedBlockers.map((blocker) =>
    Object.freeze({
      ...blocker,
      dependency: blockerNodeAiDependencyForTrace(
        dependenciesByBlockedNodeId,
        nodeId,
        blocker.candidateId,
      ),
    }),
  );
  const primaryBlocker = confirmedDependencies.find(
    (blocker) => blocker.candidateId === trace.primaryBlockerId,
  );
  assertNonNullable(primaryBlocker, `primary blockerのAI依存がありません。対象: ${nodeId}`);
  const confirmedConditions = confirmedDependencies.map((blocker) =>
    combineBlockerPrimitiveDependencies(blocker.dependency, ["presence", "confidence"]),
  );
  const confirmedEvidence = confirmedDependencies.map((blocker) =>
    combineBlockerPrimitiveDependencies(blocker.dependency, [
      "presence",
      "confidence",
      "sourceIds",
    ]),
  );
  const confirmedWaitingOn = confirmedDependencies.map((blocker) =>
    combineBlockerPrimitiveDependencies(blocker.dependency, [
      "presence",
      "confidence",
      "sourceIds",
      "becameBlockingAt",
    ]),
  );
  const selectionConditions = [
    ...confirmedDependencies.map((blocker) =>
      combineBlockerPrimitiveDependencies(blocker.dependency, [
        "presence",
        "confidence",
        "becameBlockingAt",
      ]),
    ),
    ...uncertainDependencies.map((dependency) =>
      combineBlockerPrimitiveDependencies(dependency, [
        "presence",
        "confidence",
        "becameBlockingAt",
      ]),
    ),
    negativeDependency,
  ];
  const primarySelectionDependency =
    primaryBlocker.authority === "authoritative"
      ? notDependentAiDependency()
      : combineSelectedAiDependencies(selectionConditions);
  const authoritativeConfirmedDependencies = confirmedDependencies.filter(
    (blocker) => blocker.authority === "authoritative",
  );
  const inferredConfirmedConditions = confirmedDependencies.flatMap((blocker) =>
    blocker.authority === "inferred"
      ? [combineBlockerPrimitiveDependencies(blocker.dependency, ["presence", "confidence"])]
      : [],
  );
  const requiredInferredBlockersForMultiplicity = Math.max(
    0,
    2 - authoritativeConfirmedDependencies.length,
  );
  const multiplicityDependency =
    confirmedDependencies.length === 1
      ? combineSelectedAiDependencies([...uncertainConditions, negativeDependency])
      : combineSelectedAiDependencies(
          preferredAiDependencies(
            inferredConfirmedConditions,
            requiredInferredBlockersForMultiplicity,
          ),
        );
  const primaryWaitingOnDependency = combineSelectedAiDependencies([
    primarySelectionDependency,
    multiplicityDependency,
  ]);
  const confidenceConditions =
    primaryBlocker.authority === "authoritative"
      ? confirmedDependencies
          .filter(
            (blocker) =>
              blocker.candidateId !== primaryBlocker.candidateId &&
              blocker.authority === "inferred",
          )
          .map((blocker) =>
            combineBlockerPrimitiveDependencies(blocker.dependency, ["presence", "confidence"]),
          )
          .concat(uncertainConditions, [negativeDependency])
      : selectionConditions;
  return Object.freeze({
    stateSupport:
      primaryBlocker.authority === "authoritative" ? "authoritative_blocker" : "conditional",
    status: preferIndependentAiDependency(confirmedConditions),
    waitingOn: combineSelectedAiDependencies([
      ...confirmedWaitingOn,
      ...uncertainConditions,
      negativeDependency,
    ]),
    primaryWaitingOn: primaryWaitingOnDependency,
    nextAction: primarySelectionDependency,
    confidence: combineSelectedAiDependencies([
      primaryBlocker.dependency.confidence,
      ...confidenceConditions,
    ]),
    evidence: combineSelectedAiDependencies([
      ...confirmedEvidence,
      ...uncertainEvidence,
      negativeDependency,
    ]),
    uncertainties: combineSelectedAiDependencies([
      ...confirmedConditions,
      ...uncertainConditions,
      negativeDependency,
    ]),
    transitionBasis: combineSelectedAiDependencies([
      primarySelectionDependency,
      primaryBlocker.dependency.becameBlockingAt,
    ]),
  });
}
