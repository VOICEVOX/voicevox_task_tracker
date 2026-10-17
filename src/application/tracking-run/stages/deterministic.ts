import { z } from "zod";

import { createLabelEffectsResolver } from "../../../domain/label-resolution.js";
import { resolveRepositoryMaintainers } from "../../../domain/maintainer-resolution.js";
import type { GitHubNodeId, GraphNodeId } from "../../../domain/types.js";
import type { SourceId } from "../../../domain/source-id.js";
import { buildRelationCandidateId } from "../../../graph/relation-candidate-id.js";
import {
  relationAssessmentOwnerNodeId,
  relationNodes,
} from "../../../graph/relation-candidate-endpoints.js";
import type { RelationCandidate } from "../../../graph/relation-candidate-types.js";
import { assertNonNullable } from "../../../util/index.js";
import { createDeterministicallyAnalyzedStageProof } from "../contracts/proofs.js";
import type { StageState } from "../contracts/run-core.js";
import type { CanonicalCollection, CollectedRun } from "./collection.js";
import type { CollectedItemObservations } from "./collection-production.js";
import {
  EMPTY_RELATION_CANDIDATES,
  indexRelationCandidatesByNodeId,
} from "./collection-relation-index.js";
import { normalizeLabelRules } from "./collection-label-rules.js";
import {
  analyzeInitialItem,
  createNativeBlockers,
  type DeterministicItemAnalysis,
} from "./deterministic-item.js";
import type { EffectiveAssigneeCollectionContext } from "./deterministic-responsibility.js";

const candidateIdSchema = z
  .string()
  .regex(/^rel:[0-9a-f]{64}$/u)
  .brand<"CandidateId">();

/** 項目・source・個人原因のIDと混同しない関係候補ID。 */
export type CandidateId = z.output<typeof candidateIdSchema>;

/** 関係候補の正規端点と判定担当。 */
export type DeterministicRelationFact = Readonly<{
  id: CandidateId;
  candidate: RelationCandidate;
  endpoints: readonly [GraphNodeId, GraphNodeId];
  decisionOwner: GraphNodeId;
  sourceIds: readonly SourceId[];
  authority: RelationCandidate["authority"];
  provenance: RelationCandidate["provenance"];
}>;

type CanonicalCollectedItems = CanonicalCollection<CollectedItemObservations>;
type DeterministicCollectedRun = CollectedRun<CanonicalCollectedItems>;
type DeterministicCollection = Omit<
  CanonicalCollectedItems,
  | "relationCandidates"
  | "trackedNodeIds"
  | "analysisNodeIds"
  | "unavailableConsumerNodeIds"
  | "changedNodeIds"
>;

/** 決定論的に確定した項目、収集集合、関係候補のfacts。 */
export type DeterministicFacts = Readonly<{
  items: readonly DeterministicItemAnalysis[];
  relations: readonly DeterministicRelationFact[];
  trackedNodeIds: readonly GitHubNodeId[];
  terminalNodeIds: readonly GitHubNodeId[];
  staleNodeIds: readonly GitHubNodeId[];
  refetchedNodeIds: readonly GitHubNodeId[];
  analysisNodeIds: readonly GitHubNodeId[];
  unavailableConsumerNodeIds: readonly GitHubNodeId[];
  changedNodeIds: readonly GitHubNodeId[];
}>;

/** 決定論的な初期判定と候補factsが確定したrun。 */
export type DeterministicallyAnalyzedRun = StageState<
  "deterministically_analyzed",
  {
    approvedRepositories: DeterministicCollectedRun["data"]["approvedRepositories"];
    allowlistDigest: DeterministicCollectedRun["data"]["allowlistDigest"];
    collection: DeterministicCollection;
    sourceCatalog: readonly SourceId[];
    facts: DeterministicFacts;
  }
>;

function relationFacts(
  candidates: readonly RelationCandidate[],
  sourceCatalog: readonly SourceId[],
): readonly DeterministicRelationFact[] {
  const sourceIds = new Set(sourceCatalog);
  const facts = candidates.map((candidate) => {
    if (candidate.id !== buildRelationCandidateId(candidate.provenance, candidate.relation)) {
      throw new TypeError("関係候補IDが正規関係と一致しません");
    }
    for (const sourceId of candidate.sourceIds) {
      if (!sourceIds.has(sourceId)) {
        throw new TypeError("関係候補のsourceが収集catalogにありません");
      }
    }
    const endpoints = relationNodes(candidate.relation);
    return Object.freeze({
      id: candidateIdSchema.parse(candidate.id),
      candidate,
      endpoints: Object.freeze([endpoints[0].nodeId, endpoints[1].nodeId] satisfies [
        GraphNodeId,
        GraphNodeId,
      ]),
      decisionOwner: relationAssessmentOwnerNodeId(candidate),
      sourceIds: candidate.sourceIds,
      authority: candidate.authority,
      provenance: candidate.provenance,
    });
  });
  if (new Set(facts.map((fact) => fact.id)).size !== facts.length) {
    throw new TypeError("関係候補IDが重複しています");
  }
  return Object.freeze(facts);
}

function orderedNodeIds(nodeIds: Iterable<GitHubNodeId>): readonly GitHubNodeId[] {
  return Object.freeze([...new Set(nodeIds)].sort());
}

function analyzeInitialItems(
  collected: DeterministicCollectedRun,
): readonly DeterministicItemAnalysis[] {
  const collection = collected.data.collection;
  const resolveLabelEffects = createLabelEffectsResolver(
    normalizeLabelRules(collected.core.config),
  );
  const repositoriesById = new Map(
    collected.data.approvedRepositories.map((repository) => [repository.id, repository]),
  );
  const observedItemsByNodeId = new Map(
    collection.observedItems.map((item) => [item.nodeId, item]),
  );
  const detailsByNodeId = new Map(collection.details.map((detail) => [detail.nodeId, detail]));
  const relationCandidatesByNodeId = indexRelationCandidatesByNodeId(collection.relationCandidates);
  const effectiveAssigneeCollectionContext = Object.freeze({
    observedItemsByNodeId,
    detailsByNodeId,
    trackedNodeIds: new Set(collection.trackedNodeIds),
  }) satisfies EffectiveAssigneeCollectionContext;
  const analysisNodeIds = new Set(collection.analysisNodeIds);
  const notificationClassByNodeId = new Map(collection.trackingNotificationClassByNodeId);
  const items: DeterministicItemAnalysis[] = [];
  for (const item of collection.observedItems) {
    if (!analysisNodeIds.has(item.nodeId)) {
      continue;
    }
    const repository = repositoriesById.get(item.repositoryId);
    assertNonNullable(repository, `公開repositoryがありません。対象: ${item.repositoryId}`);
    const repositoryFullName = `${repository.owner}/${repository.name}`;
    const maintainers = resolveRepositoryMaintainers(
      collected.core.config.maintainers,
      repositoryFullName,
    );
    const detail = detailsByNodeId.get(item.nodeId);
    assertNonNullable(detail, `GitHub詳細取得結果がありません。対象: ${item.nodeId}`);
    const notificationClass = notificationClassByNodeId.get(item.nodeId);
    assertNonNullable(notificationClass, `追跡項目の通知分類がありません。対象: ${item.nodeId}`);
    const relationCandidates =
      relationCandidatesByNodeId.get(item.nodeId) ?? EMPTY_RELATION_CANDIDATES;
    items.push(
      analyzeInitialItem({
        item,
        detail,
        blockers: createNativeBlockers(item, relationCandidates),
        maintainers,
        labelEffects: resolveLabelEffects(repositoryFullName, item.labels),
        confidenceThresholds: collected.core.config.ai.confidence,
        evaluatedAt: collection.evaluatedAt,
        notificationClass,
        relationCandidates,
        effectiveAssigneeCollectionContext,
      }),
    );
  }
  return Object.freeze(items);
}

/** 収集済み入力から初期判定と関係候補factsを一度だけ確定する。 */
export function analyzeDeterministically(
  collected: DeterministicCollectedRun,
): DeterministicallyAnalyzedRun {
  const source = collected.data.collection;
  const items = analyzeInitialItems(collected);
  const analyzedNodeIds = items.map((item) => item.item.nodeId);
  if (
    new Set(analyzedNodeIds).size !== analyzedNodeIds.length ||
    analyzedNodeIds.length !== source.analysisNodeIds.length ||
    analyzedNodeIds.some((nodeId) => !source.analysisNodeIds.includes(nodeId))
  ) {
    throw new TypeError("決定論的分析対象が収集済み分析集合と一致しません");
  }
  const {
    relationCandidates,
    trackedNodeIds,
    analysisNodeIds,
    unavailableConsumerNodeIds,
    changedNodeIds,
    ...collection
  } = source;
  const facts = Object.freeze({
    items,
    relations: relationFacts(relationCandidates, collected.data.sourceCatalog),
    trackedNodeIds,
    terminalNodeIds: orderedNodeIds([
      ...collection.observedItems
        .filter((item) => item.state === "closed")
        .map((item) => item.nodeId),
      ...collection.staleItems
        .filter((item) => item.previousObservation.state === "closed")
        .map((item) => item.nodeId),
    ]),
    staleNodeIds: orderedNodeIds(collection.staleItems.map((item) => item.nodeId)),
    refetchedNodeIds: orderedNodeIds(collection.details.map((detail) => detail.nodeId)),
    analysisNodeIds,
    unavailableConsumerNodeIds,
    changedNodeIds,
  }) satisfies DeterministicFacts;
  return Object.freeze({
    stage: "deterministically_analyzed",
    core: collected.core,
    data: Object.freeze({
      approvedRepositories: collected.data.approvedRepositories,
      allowlistDigest: collected.data.allowlistDigest,
      collection,
      sourceCatalog: collected.data.sourceCatalog,
      facts,
    }),
    proof: createDeterministicallyAnalyzedStageProof(),
  });
}
