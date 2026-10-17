import type {
  PersonalReminderTargetScope,
  PersonalReminderWaitingOption,
} from "../../../codex/personal-reminder-input-contracts.js";
import type { AiAnalysisDependencyInput } from "../../../domain/ai-analysis-dependencies.js";
import type {
  PersonalReminderCauseId,
  PersonalReminderCauseSeed,
  PersonalReminderMissingInput,
} from "../../../domain/personal-reminder-causes.js";
import type { SourceId } from "../../../domain/source-id.js";
import type { GraphNodeId, NormalizedEvent } from "../../../domain/types.js";
import type { GitHubItemDetail } from "../../../github/item-detail-types.js";
import type { ReconciledGraphEdge } from "../../../graph/index.js";
import {
  compareStrings,
  createNonEmptySourceIds,
  currentAiDependencyInput,
} from "./personal-reminder-runtime-common.js";
import { contextItemByNodeId } from "./personal-reminder-runtime-context-values.js";
import type {
  PersonalReminderRuntimeContext,
  PersonalReminderRuntimeContextItem,
  PersonalReminderRuntimeCurrentSeed,
  PersonalReminderRuntimeOptionProjection,
  PersonalReminderRuntimePlanningIndexes,
  PersonalReminderRuntimeSource,
} from "./personal-reminder-runtime-contracts.js";
import { compareEventOccurrence } from "./personal-reminder-runtime-event-order.js";
import { relationSourceProjectionForEdges } from "./personal-reminder-runtime-relation-projection.js";
import {
  connectedSeedRelations,
  scopeNodeIdsForSeed,
  targetScopeForSeed,
} from "./personal-reminder-runtime-relations.js";
import { personalReminderCauseSeedAiDependencyInputs } from "./personal-reminder-runtime-seed.js";
import { addRuntimeSource } from "./personal-reminder-runtime-source-projection.js";

type PersonalReminderAuthorReplyProjection = Readonly<{
  option: PersonalReminderWaitingOption | undefined;
  sources: readonly PersonalReminderRuntimeSource[];
  missing: readonly PersonalReminderMissingInput[];
}>;

function hasNonEmptyDetailConversationSource(
  detail: GitHubItemDetail,
  sourceId: SourceId,
): boolean {
  if (
    detail.comments.some((comment) => comment.sourceId === sourceId && comment.body.length !== 0)
  ) {
    return true;
  }
  if (detail.type !== "pull_request") {
    return false;
  }
  if (detail.reviews.some((review) => review.sourceId === sourceId && review.body.length !== 0)) {
    return true;
  }
  return detail.reviewThreads.some((thread) =>
    thread.comments.some((comment) => comment.sourceId === sourceId && comment.body.length !== 0),
  );
}

function authorReplyWaitingProjection(
  item: PersonalReminderRuntimeContextItem,
  seed: PersonalReminderCauseSeed,
  currentSeed: PersonalReminderRuntimeCurrentSeed,
): PersonalReminderAuthorReplyProjection | undefined {
  if (
    currentSeed.origin !== "current_draft" ||
    seed.responsibility.authority !== "fixed" ||
    seed.action.kind !== "revision" ||
    item.item.type !== "pull_request" ||
    item.localDecision.status !== "waiting_for_revision" ||
    (item.localDecision.aiAnalysisElementNecessities.status !== "required" &&
      item.localDecision.aiAnalysisElementNecessities.waitingOn !== "required" &&
      item.localDecision.aiAnalysisElementNecessities.nextAction !== "required")
  ) {
    return undefined;
  }
  const responsibilitySourceIds = new Set(item.localDecision.responsibilityBasis.sourceIds);
  const changesRequested = item.item.events
    .filter(
      (event): event is Extract<NormalizedEvent, { kind: "review" }> =>
        event.kind === "review" &&
        event.state === "changes_requested" &&
        responsibilitySourceIds.has(event.sourceId),
    )
    .sort(compareEventOccurrence);
  const latestChangesRequested = changesRequested.at(-1);
  if (latestChangesRequested == null) {
    return undefined;
  }
  const uncertaintyEvidence = item.localDecision.evidence.filter(
    (evidence) => evidence.supports === "uncertainty",
  );
  const uncertaintySourceIds = new Set(uncertaintyEvidence.map((evidence) => evidence.sourceId));
  const possibleAuthorSpeech = item.item.events.filter(
    (event): event is Extract<NormalizedEvent, { kind: "comment" | "review" }> =>
      (event.kind === "comment" || event.kind === "review") &&
      event.actor.type === "human" &&
      !event.bodyEmpty &&
      event.occurredAt > latestChangesRequested.occurredAt &&
      uncertaintySourceIds.has(latestChangesRequested.sourceId) &&
      uncertaintySourceIds.has(event.sourceId),
  );
  if (possibleAuthorSpeech.length === 0) {
    return undefined;
  }
  const author = item.item.author;
  const authorActor = author.status === "identified" ? author.actor : undefined;
  if (authorActor == null) {
    return Object.freeze({
      option: undefined,
      sources: Object.freeze([]),
      missing: Object.freeze([
        "item_conversation",
      ] satisfies readonly PersonalReminderMissingInput[]),
    });
  }
  if (authorActor.type !== "human") {
    return undefined;
  }
  const authorSpeech = possibleAuthorSpeech.filter(
    (event) => event.actor.type === "human" && event.actor.nodeId === authorActor.nodeId,
  );
  if (authorSpeech.length === 0) {
    return undefined;
  }
  const sourceById = new Map(
    item.sources
      .filter(
        (source) =>
          (source.source.kind === "comment" ||
            source.source.kind === "review" ||
            source.source.kind === "review_comment") &&
          source.source.actorType === "human" &&
          source.source.actorCandidateId?.toLowerCase() === authorActor.login.toLowerCase(),
      )
      .map((source) => [source.source.sourceId, source]),
  );
  const rawAuthorSpeech = authorSpeech.filter(
    (event) =>
      sourceById.has(event.sourceId) &&
      hasNonEmptyDetailConversationSource(item.detail, event.sourceId),
  );
  if (rawAuthorSpeech.length !== authorSpeech.length) {
    return Object.freeze({
      option: undefined,
      sources: Object.freeze([]),
      missing: Object.freeze([
        "item_conversation",
      ] satisfies readonly PersonalReminderMissingInput[]),
    });
  }
  const evidenceSourceIds = createNonEmptySourceIds(
    [latestChangesRequested.sourceId, ...rawAuthorSpeech.map((event) => event.sourceId)],
    `author reply waiting option ${seed.causeId}`,
  );
  const optionSources: PersonalReminderRuntimeSource[] = [];
  for (const sourceId of evidenceSourceIds) {
    const source =
      sourceById.get(sourceId) ?? item.sources.find((value) => value.source.sourceId === sourceId);
    if (source == null) {
      return Object.freeze({
        option: undefined,
        sources: Object.freeze([]),
        missing: Object.freeze([
          "item_conversation",
        ] satisfies readonly PersonalReminderMissingInput[]),
      });
    }
    optionSources.push(source);
  }
  return Object.freeze({
    option: Object.freeze({
      optionId: `${seed.causeId}:waiting:author-reply`,
      itemNodeId: seed.itemNodeId,
      targetScope: { kind: "item" } satisfies PersonalReminderTargetScope,
      action: Object.freeze({ kind: "reply", summary: "PR作者の質問や反論へ回答する" }),
      relationIds: [],
      evidenceSourceIds: [...evidenceSourceIds],
    }),
    sources: Object.freeze(optionSources),
    missing: Object.freeze([]),
  });
}

/** 原因が待つ可能性のある候補を作る。 */
export function waitingOptionsForCause(
  context: PersonalReminderRuntimeContext,
  item: PersonalReminderRuntimeContextItem,
  globalSourcesById: ReadonlyMap<SourceId, PersonalReminderRuntimeSource>,
  seed: PersonalReminderCauseSeed,
  relationEdges: readonly (ReconciledGraphEdge & Readonly<{ active: true }>)[],
  currentSeed: PersonalReminderRuntimeCurrentSeed,
  indexes: PersonalReminderRuntimePlanningIndexes,
): PersonalReminderRuntimeOptionProjection {
  const options: PersonalReminderWaitingOption[] = [];
  const sources = new Map<SourceId, PersonalReminderRuntimeSource>();
  const missing = new Set<PersonalReminderMissingInput>();
  const aiDependencyInputsByOptionId = new Map<string, readonly AiAnalysisDependencyInput[]>();
  const connected = connectedSeedRelations(indexes, seed, relationEdges, currentSeed);
  const candidateSeedsByCauseId = new Map<
    PersonalReminderCauseId,
    PersonalReminderRuntimeCurrentSeed
  >([...connected].map(([causeId, value]) => [causeId, value.currentSeed]));
  if (currentSeed.origin === "retained_without_draft") {
    for (const candidate of indexes.currentSeedsByItemNodeId.get(seed.itemNodeId) ?? []) {
      candidateSeedsByCauseId.set(candidate.seed.causeId, candidate);
    }
  }
  const candidateSeeds = [...candidateSeedsByCauseId.values()].sort((left, right) =>
    compareStrings(left.seed.causeId, right.seed.causeId),
  );
  for (const candidate of candidateSeeds) {
    if (
      candidate.origin !== "current_draft" ||
      candidate.seed.causeId === seed.causeId ||
      (currentSeed.draftIdentity != null && candidate.draftIdentity === currentSeed.draftIdentity)
    ) {
      continue;
    }
    const matchingRelations = connected.get(candidate.seed.causeId)?.relations ?? [];
    if (candidate.seed.itemNodeId === seed.itemNodeId) {
      if (
        currentSeed.origin !== "retained_without_draft" ||
        candidate.seed.action.kind === seed.action.kind
      ) {
        continue;
      }
    } else if (matchingRelations.length === 0) {
      continue;
    }
    const relationIds = matchingRelations.map((relation) => relation.id);
    const relationSources = relationSourceProjectionForEdges(matchingRelations, globalSourcesById);
    const relationSourceIds = matchingRelations.flatMap((relation) =>
      relation.evidence.map((evidence) => evidence.sourceId),
    );
    if (relationSources.missingSourceIds.length !== 0) {
      missing.add("relation_evidence");
    }
    const sourceIds = createNonEmptySourceIds(
      [...candidate.seed.evidenceSourceIds, ...relationSourceIds],
      `waiting option ${candidate.seed.causeId}`,
    );
    for (const source of candidate.item.sources) {
      if (sourceIds.includes(source.source.sourceId)) {
        addRuntimeSource(sources, source);
      }
    }
    for (const source of relationSources.sources) {
      addRuntimeSource(sources, source);
    }
    const option = Object.freeze({
      optionId: `${seed.causeId}:waiting:${candidate.seed.causeId}`,
      itemNodeId: candidate.seed.itemNodeId,
      targetScope: targetScopeForSeed(candidate.seed),
      action: { kind: candidate.seed.action.kind, summary: candidate.seed.action.summary },
      relationIds,
      evidenceSourceIds: [...sourceIds],
    });
    options.push(option);
    aiDependencyInputsByOptionId.set(
      option.optionId,
      Object.freeze([
        ...personalReminderCauseSeedAiDependencyInputs(candidate),
        ...matchingRelations.map((relation) => currentAiDependencyInput(relation.aiDependency)),
      ]),
    );
  }
  const representedRelationIds = new Set(
    [...connected]
      .filter(([causeId]) => causeId !== seed.causeId)
      .flatMap(([, value]) => value.relations.map((relation) => relation.id)),
  );
  const subjectScope = scopeNodeIdsForSeed(seed);
  for (const relation of relationEdges) {
    if (representedRelationIds.has(relation.id)) {
      continue;
    }
    let endpoint: GraphNodeId | undefined;
    if (subjectScope.has(relation.fromNodeId)) {
      endpoint = relation.toNodeId;
    } else if (subjectScope.has(relation.toNodeId)) {
      endpoint = relation.fromNodeId;
    }
    if (endpoint == null) {
      continue;
    }
    const endpointSeeds = indexes.currentSeedsByScopeNodeId.get(endpoint) ?? [];
    if (
      endpointSeeds.some(
        (candidate) =>
          candidate.seed.causeId === seed.causeId ||
          (currentSeed.draftIdentity != null &&
            candidate.draftIdentity === currentSeed.draftIdentity),
      )
    ) {
      continue;
    }
    const endpointItem = contextItemByNodeId(context, endpoint);
    if (endpointItem == null) {
      missing.add("related_item");
      continue;
    }
    const relatedContext = item.relatedContexts.find((value) => value.item.nodeId === endpoint);
    if (relatedContext?.localDecision == null) {
      missing.add("related_timeline");
    }
  }
  const authorReply = authorReplyWaitingProjection(item, seed, currentSeed);
  if (authorReply != null) {
    for (const source of authorReply.sources) {
      addRuntimeSource(sources, source);
    }
    for (const value of authorReply.missing) {
      missing.add(value);
    }
    if (authorReply.option != null) {
      options.push(authorReply.option);
      aiDependencyInputsByOptionId.set(
        authorReply.option.optionId,
        Object.freeze([currentAiDependencyInput(Object.freeze({ status: "not_dependent" }))]),
      );
    }
  }
  return Object.freeze({
    options: Object.freeze(
      options.sort((left, right) => compareStrings(left.optionId, right.optionId)),
    ),
    sources: Object.freeze([...sources.values()]),
    missing: Object.freeze([...missing]),
    aiDependencyInputsByOptionId,
  });
}
