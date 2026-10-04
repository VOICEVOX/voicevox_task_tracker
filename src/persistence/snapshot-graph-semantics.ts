import { AI_ANALYSIS_DEPENDENCY_ELEMENTS } from "../domain/ai-analysis-dependencies.js";
import type { AiAnalysisDependency, ExternalGhostNode, GraphNodeId } from "../domain/index.js";
import { StateSnapshotSemanticError } from "./errors.js";
import { assertRelationCandidateProducerDefinitions } from "./snapshot-ai-integrity.js";
import { expectedSnapshotBlockerAnalysis } from "./snapshot-blocker-analysis.js";
import {
  assertAuthoritativeBlockerStateCompleteness,
  assertBlockerValueDependencyLowerBounds,
  expectedSnapshotBlockerValueAiDependencies,
} from "./snapshot-blocker-values.js";
import type {
  LegacyStateSnapshotFields,
  LegacyStateSnapshotFieldsWithoutAiDependencies,
  LegacyStateSnapshotFieldsWithPersonalReminder,
  LegacyStateSnapshotFieldsWithPersonalReminderVersion17,
  SnapshotItemForRelationValidation,
  StateSnapshotFields,
} from "./snapshot-contracts.js";
import {
  aiAnalysisDependencyContainsRecordedLowerBound,
  assertGraphDerivedAiDependencyLowerBounds,
  blockerDependencySatisfiesExpected,
  blocksArcKey,
  expectedRelationSetAiDependencies,
  relationSetDependencySatisfiesExpected,
} from "./snapshot-graph-dependencies.js";
import {
  assertImplementsRelationEndpointTypes,
  assertInferredRelationAiDependencySemantics,
  assertRelationAiDependencySemantics,
  expectedBlockersAiDependencies,
  expectedDownstreamImpactAiDependencies,
} from "./snapshot-relations.js";
import { assertPersonalReminderDependenciesSemantics } from "./snapshot-reminder-planning.js";
import {
  assertTrackedItemAiDependenciesSemantics,
  hasCanonicalStaleBlockerTopologyDependencies,
} from "./snapshot-state-dependencies.js";
import {
  assertUtcDateTime,
  effectiveGraphStateByNodeId,
  effectiveGraphStateForNode,
} from "./snapshot-values.js";

/** snapshotのgraph・AI依存の意味を検証する。 */
export function assertSnapshotGraphSemantics(
  snapshot:
    | StateSnapshotFields
    | LegacyStateSnapshotFieldsWithoutAiDependencies
    | LegacyStateSnapshotFields
    | LegacyStateSnapshotFieldsWithPersonalReminder
    | LegacyStateSnapshotFieldsWithPersonalReminderVersion17,
  requireImplementsEndpointTypes: boolean,
): void {
  const graphNodeIds = new Set([
    ...snapshot.items.map((item) => item.nodeId),
    ...snapshot.externalReferences.map((reference) => reference.nodeId),
  ]);
  const effectiveGraphStates = effectiveGraphStateByNodeId(snapshot);
  const openGraphNodeIds = new Set<GraphNodeId>([
    ...snapshot.items
      .filter((item) => effectiveGraphStateForNode(effectiveGraphStates, item.nodeId) === "open")
      .map((item) => item.nodeId),
    ...snapshot.externalReferences
      .filter((reference) => reference.state === "open")
      .map((reference) => reference.nodeId),
  ]);
  const itemsByNodeId = new Map<string, SnapshotItemForRelationValidation>(
    snapshot.items.map((item) => [item.nodeId, item]),
  );
  const externalReferencesByNodeId = new Map<string, ExternalGhostNode>(
    snapshot.externalReferences.map((reference) => [reference.nodeId, reference]),
  );
  const staleRepositoryIds = new Set(
    snapshot.repositories
      .filter((repository) => repository.freshness === "stale")
      .map((repository) => repository.id),
  );
  const staleGraphNodeIds = new Set<GraphNodeId>(
    snapshot.items
      .filter((item) => staleRepositoryIds.has(item.repositoryId))
      .map((item) => item.nodeId),
  );
  const relationsById = new Map(snapshot.relations.map((relation) => [relation.id, relation]));
  const activeBlocksArcKeys = new Set(
    snapshot.relations
      .filter((relation) => relation.active && relation.type === "blocks")
      .map((relation) => blocksArcKey(relation.fromNodeId, relation.toNodeId)),
  );
  const notDependentOpenBlockerNodeIdsByTargetNodeId = new Map<GraphNodeId, Set<GraphNodeId>>();
  for (const relation of snapshot.relations) {
    if (
      !relation.active ||
      relation.type !== "blocks" ||
      relation.provenance !== "native" ||
      !openGraphNodeIds.has(relation.fromNodeId) ||
      !openGraphNodeIds.has(relation.toNodeId) ||
      !("aiDependency" in relation) ||
      typeof relation.aiDependency !== "object" ||
      !("status" in relation.aiDependency) ||
      relation.aiDependency.status !== "not_dependent"
    ) {
      continue;
    }
    const blockerNodeIds = notDependentOpenBlockerNodeIdsByTargetNodeId.get(relation.toNodeId);
    if (blockerNodeIds == null) {
      notDependentOpenBlockerNodeIdsByTargetNodeId.set(
        relation.toNodeId,
        new Set([relation.fromNodeId]),
      );
    } else {
      blockerNodeIds.add(relation.fromNodeId);
    }
  }
  for (const relation of snapshot.relations) {
    if (!graphNodeIds.has(relation.fromNodeId) || !graphNodeIds.has(relation.toNodeId)) {
      throw new StateSnapshotSemanticError("relationがsnapshotにないnodeを参照しています");
    }
    if (requireImplementsEndpointTypes) {
      assertImplementsRelationEndpointTypes(relation, itemsByNodeId, externalReferencesByNodeId);
    }
    assertUtcDateTime(relation.firstSeenAt, "relation firstSeenAt");
    assertUtcDateTime(relation.lastConfirmedAt, "relation lastConfirmedAt");
    if ("aiDependency" in relation) {
      assertRelationAiDependencySemantics(relation.aiDependency, "relationのAI依存");
      if (relation.provenance === "native" && relation.aiDependency.status !== "not_dependent") {
        throw new StateSnapshotSemanticError(
          "native relationのAI依存はnot_dependentでなければなりません",
        );
      }
      assertInferredRelationAiDependencySemantics(
        relation,
        itemsByNodeId,
        !relation.active ||
          staleGraphNodeIds.has(relation.fromNodeId) ||
          staleGraphNodeIds.has(relation.toNodeId),
      );
    }
    if (!relation.active) {
      if (!("removedAt" in relation)) {
        throw new StateSnapshotSemanticError("inactive relationのremovedAtがありません");
      }
      assertUtcDateTime(relation.removedAt, "relation removedAt");
    }
  }
  const relationCandidateDependencies: {
    description: string;
    dependency: AiAnalysisDependency;
    targetNodeId?: GraphNodeId;
  }[] = [];
  for (const item of snapshot.items) {
    if ("aiDependencies" in item) {
      for (const element of AI_ANALYSIS_DEPENDENCY_ELEMENTS) {
        relationCandidateDependencies.push({
          description: `item ${item.nodeId}の${element} AI依存`,
          dependency: item.aiDependencies[element],
          ...(element === "blockers" ? { targetNodeId: item.nodeId } : {}),
        });
      }
    }
    if ("personalReminderCauses" in item) {
      for (const cause of item.personalReminderCauses) {
        if (!("aiDependencies" in cause) || !("aiDependency" in cause.currentInput)) {
          continue;
        }
        relationCandidateDependencies.push(
          {
            description: `personal reminder cause ${cause.causeId}のpresence AI依存`,
            dependency: cause.aiDependencies.presence,
          },
          {
            description: `personal reminder cause ${cause.causeId}のresponse membership AI依存`,
            dependency: cause.aiDependencies.responseMembership,
          },
          {
            description: `personal reminder cause ${cause.causeId}のresponsible AI依存`,
            dependency: cause.aiDependencies.responsible,
          },
          {
            description: `personal reminder cause ${cause.causeId}のaction AI依存`,
            dependency: cause.aiDependencies.action,
          },
          {
            description: `personal reminder cause ${cause.causeId}のevidence AI依存`,
            dependency: cause.aiDependencies.evidence,
          },
          {
            description: `personal reminder cause ${cause.causeId}のcurrent input AI依存`,
            dependency: cause.currentInput.aiDependency,
          },
        );
      }
      if (
        item.personalReminderCausePlanning.status === "completed" &&
        "causeSetAiDependency" in item.personalReminderCausePlanning
      ) {
        relationCandidateDependencies.push({
          description: `item ${item.nodeId}のpersonal reminder cause set AI依存`,
          dependency: item.personalReminderCausePlanning.causeSetAiDependency,
          targetNodeId: item.nodeId,
        });
      }
    }
  }
  for (const relation of snapshot.relations) {
    if ("aiDependency" in relation) {
      relationCandidateDependencies.push({
        description: `relation ${relation.id}のAI依存`,
        dependency: relation.aiDependency,
      });
    }
  }
  assertRelationCandidateProducerDefinitions(
    relationCandidateDependencies,
    itemsByNodeId,
    relationsById,
  );
  for (const item of snapshot.items) {
    if ("personalReminderCauses" in item) {
      assertPersonalReminderDependenciesSemantics(item, itemsByNodeId, relationsById);
    }
  }
  const expectedBlockerDependenciesByNodeId = expectedBlockersAiDependencies(snapshot);
  const expectedBlockerAnalysis = expectedSnapshotBlockerAnalysis(snapshot);
  const expectedRelationSetDependenciesByNodeId = expectedRelationSetAiDependencies(snapshot);
  const expectedDownstreamImpactDependenciesByNodeId =
    expectedDownstreamImpactAiDependencies(snapshot);
  for (const item of snapshot.items) {
    if (!("aiDependencies" in item)) {
      continue;
    }
    assertTrackedItemAiDependenciesSemantics(
      item.aiDependencies,
      "itemのAI依存",
      item,
      itemsByNodeId,
      relationsById,
      activeBlocksArcKeys,
      notDependentOpenBlockerNodeIdsByTargetNodeId,
      staleGraphNodeIds.has(item.nodeId),
    );
    if (expectedDownstreamImpactDependenciesByNodeId != null) {
      const expectedDownstreamImpact = expectedDownstreamImpactDependenciesByNodeId.get(
        item.nodeId,
      );
      if (expectedDownstreamImpact == null) {
        throw new StateSnapshotSemanticError(
          `item ${item.nodeId}のdownstream impact AI依存の検証対象がありません`,
        );
      }
      assertGraphDerivedAiDependencyLowerBounds(item, expectedDownstreamImpact);
    }
    const relationSetIsProducerlessMigration =
      item.aiDependencies.relationSet.status === "unknown" &&
      item.aiDependencies.relationSet.reasons.length === 1 &&
      item.aiDependencies.relationSet.reasons[0] === "migration" &&
      item.aiDependencies.relationSet.producers == null;
    if (!relationSetIsProducerlessMigration) {
      const expectedRelationSet = expectedRelationSetDependenciesByNodeId.get(item.nodeId);
      if (expectedRelationSet == null) {
        throw new StateSnapshotSemanticError(
          `item ${item.nodeId}のrelation set AI依存の検証対象がありません`,
        );
      }
      if (
        !relationSetDependencySatisfiesExpected(
          expectedRelationSet,
          item.aiDependencies.relationSet,
          relationsById,
        )
      ) {
        throw new StateSnapshotSemanticError(
          `item ${item.nodeId}のrelation set AI依存がactive incident relation supportと一致しません`,
        );
      }
    }
    const expectedBlockers = expectedBlockerDependenciesByNodeId.get(item.nodeId);
    if (expectedBlockers == null) {
      throw new StateSnapshotSemanticError(
        `item ${item.nodeId}のblockers AI依存の検証対象がありません`,
      );
    }
    if (
      !blockerDependencySatisfiesExpected(
        expectedBlockers,
        item.aiDependencies.blockers,
        item.nodeId,
        itemsByNodeId,
        relationsById,
        activeBlocksArcKeys,
      )
    ) {
      throw new StateSnapshotSemanticError(
        `item ${item.nodeId}のblockers AI依存がactive/open relation supportと一致しません`,
      );
    }
    if (expectedBlockerAnalysis != null) {
      const expectedBlockerSetDependency =
        expectedBlockerAnalysis.blockerSetDependenciesByNodeId.get(item.nodeId);
      if (expectedBlockerSetDependency == null) {
        throw new StateSnapshotSemanticError(
          `item ${item.nodeId}のblocker set AI依存を再構成できません`,
        );
      }
      if (
        !aiAnalysisDependencyContainsRecordedLowerBound(
          expectedBlockerSetDependency,
          item.aiDependencies.blockers,
        )
      ) {
        throw new StateSnapshotSemanticError(
          `item ${item.nodeId}のblockers AI依存がblocker setの導出元を含んでいません`,
        );
      }
      const staleBlockerTopologyFallback =
        staleGraphNodeIds.has(item.nodeId) && hasCanonicalStaleBlockerTopologyDependencies(item);
      if (!staleBlockerTopologyFallback) {
        assertAuthoritativeBlockerStateCompleteness(
          item,
          expectedBlockerAnalysis.blockersByBlockedNodeId.get(item.nodeId) ?? [],
        );
        assertBlockerValueDependencyLowerBounds(
          item,
          expectedSnapshotBlockerValueAiDependencies(
            item,
            expectedBlockerAnalysis,
            effectiveGraphStateForNode(effectiveGraphStates, item.nodeId),
          ),
        );
      }
    }
  }
}
