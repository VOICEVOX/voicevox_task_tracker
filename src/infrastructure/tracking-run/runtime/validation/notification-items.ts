import type { GraphFinalItem } from "../../../../application/tracking-run/contracts/graph-final-item.js";
import type {
  GraphReconciliationResult,
  GraphReducedItem,
  GraphTrackedItemStaleness,
} from "../../../../application/tracking-run/stages/graph-reconciliation-contracts.js";
import type { GraphReconciledRun } from "../../../../application/tracking-run/stages/graph-reconciliation.js";
import type { PersonalReminderFinalizedRun } from "../../../../application/tracking-run/stages/personal-reminder-finalization.js";
import {
  createNotificationCauses,
  type DiscordNotificationItem,
  type NotificationCauses,
} from "../../../../discord/index.js";
import {
  createLabelEffectsResolver,
  type GitHubNodeId,
  type GitHubRepositoryId,
  type NormalizedEvent,
  type TrackedItem,
  type UtcIsoDateTime,
} from "../../../../domain/index.js";
import type { EnumeratedGitHubItem, FreshObservedGitHubItem } from "../../../../github/index.js";
import type { SnapshotTrackedItem } from "../../../../persistence/index.js";
import { assertNonNullable } from "../../../../util/index.js";
import type { RuntimeConfiguration, RuntimeState } from "../contracts.js";
import { normalizeLabelRules } from "../label-rules.js";
import { previousTrackedItem } from "../previous-state/snapshot.js";
import { findRepository, repositoryFullName } from "../repository-lookup.js";
import { currentNotificationGraph } from "./notification-graph-currentness.js";

function notificationLatestChange(
  current: GraphReducedItem,
  previous: TrackedItem | undefined,
): DiscordNotificationItem["latestChange"] {
  if (previous == null || current.item.githubUpdatedAt === previous.githubUpdatedAt) {
    return "none";
  }
  return current.item.events.some(
    (event) => event.actor.type === "human" && event.occurredAt > previous.observedAt,
  )
    ? "human"
    : "bot_only";
}

type NotificationAnalysisState =
  | Readonly<{
      availability: "not_available";
    }>
  | Readonly<{
      availability: "available";
      value: GraphReducedItem;
    }>;

function notificationDecisionBasis(
  item: GraphFinalItem,
  staleness: GraphTrackedItemStaleness,
  analysisState: NotificationAnalysisState,
): DiscordNotificationItem["decisionBasis"] {
  if (analysisState.availability === "available") {
    return analysisState.value.decision.origin === "deterministic"
      ? Object.freeze({
          source: "deterministic",
        })
      : Object.freeze({
          source: "ai_only",
          confidence: analysisState.value.decision.confidence,
        });
  }
  return staleness.severityContext.decisionBasis === "deterministic"
    ? Object.freeze({
        source: "deterministic",
      })
    : Object.freeze({
        source: "ai_only",
        confidence: item.confidence,
      });
}

function notificationDraftState(
  item: GraphFinalItem,
  enumeratedItemsByNodeId: ReadonlyMap<GitHubNodeId, EnumeratedGitHubItem>,
  repositoryFreshness: DiscordNotificationItem["repositoryFreshness"],
): DiscordNotificationItem["draftState"] {
  const observed = enumeratedItemsByNodeId.get(item.nodeId);
  if (observed == null && repositoryFreshness === "stale") {
    return item.type === "issue" ? "not_applicable" : "ready_for_review";
  }
  assertNonNullable(observed, `通知対象 ${item.nodeId}の列挙値がありません`);
  if (observed.type !== item.type) {
    throw new TypeError(`通知対象 ${item.nodeId}の項目種別が前回値と一致しません`);
  }
  return observed.type === "issue"
    ? "not_applicable"
    : observed.draft
      ? "draft"
      : "ready_for_review";
}

function hasUnobservedPullRequestHeadChange(
  item: FreshObservedGitHubItem,
  previous: SnapshotTrackedItem | undefined,
  evaluatedAt: UtcIsoDateTime,
): boolean {
  if (item.type !== "pull_request" || previous == null) {
    return false;
  }
  if (previous.inputEvents.some((event) => event.sourceId === item.headCommit.sourceId)) {
    return item.githubUpdatedAt !== previous.githubUpdatedAt;
  }
  const headEvent = item.events.find(
    (event): event is Extract<NormalizedEvent, { kind: "push" }> =>
      event.kind === "push" &&
      event.sourceId === item.headCommit.sourceId &&
      event.headCommitSha === item.headCommit.sha &&
      !event.forcePush,
  );
  assertNonNullable(headEvent, `Pull Request ${item.nodeId}のhead commit eventがありません`);
  return headEvent.occurredAt <= previous.observedAt || headEvent.occurredAt > evaluatedAt;
}

function notificationItem(
  configuration: RuntimeConfiguration,
  state: RuntimeState,
  repositories: GraphReconciledRun["data"]["approvedRepositories"],
  enumeratedItemsByNodeId: ReadonlyMap<GitHubNodeId, EnumeratedGitHubItem>,
  graph: GraphReconciliationResult,
  currentGraph: ReturnType<typeof currentNotificationGraph>,
  evaluatedAt: UtcIsoDateTime,
  item: GraphFinalItem,
  staleness: GraphTrackedItemStaleness,
  analysisState: NotificationAnalysisState,
  finalized: PersonalReminderFinalizedRun,
  retainedNotificationRecommendation:
    DiscordNotificationItem["notificationRecommendation"] | undefined,
  repositoryFreshness: DiscordNotificationItem["repositoryFreshness"],
): DiscordNotificationItem {
  const repository = findRepository(repositories, item.repositoryId);
  const previous = previousTrackedItem(state, item.nodeId);
  const downstreamImpact = currentGraph.analysis.downstreamImpacts.find(
    (impact) => impact.nodeId === item.nodeId,
  );
  assertNonNullable(downstreamImpact, `通知対象 ${item.nodeId}のdownstream impactがありません`);
  const labelEffects = createLabelEffectsResolver(normalizeLabelRules(configuration.config))(
    repositoryFullName(repository),
    item.labels,
  );
  const cycleIds = currentGraph.analysis.dependencyCycles
    .filter((cycle) => cycle.nodeIds.includes(item.nodeId))
    .map((cycle) => cycle.id);
  const notificationRecommendation =
    analysisState.availability === "available"
      ? analysisState.value.notificationRecommendation
      : (retainedNotificationRecommendation ?? Object.freeze({ availability: "not_available" }));
  const previousDependencyCycles: DiscordNotificationItem["graph"]["previousDependencyCycles"] =
    currentGraph.previousAnalysis == null
      ? Object.freeze({
          availability: "not_available",
        })
      : Object.freeze({
          availability: "available",
          cycleIds: Object.freeze(
            currentGraph.previousAnalysis.dependencyCycles
              .filter((cycle) => cycle.nodeIds.includes(item.nodeId))
              .map((cycle) => cycle.id),
          ),
        });
  const causes: NotificationCauses =
    analysisState.availability === "available"
      ? createNotificationCauses({
          item: analysisState.value.item,
          currentWaitingOn: item.waitingOn,
          previous:
            previous == null
              ? Object.freeze({
                  availability: "not_available",
                })
              : Object.freeze({
                  availability: "available",
                  value: Object.freeze({
                    waitingOn: previous.waitingOn,
                    observedAt: previous.observedAt,
                  }),
                }),
          currentResponsibilityBasis: analysisState.value.responsibilityBasis,
          dependencyCause: analysisState.value.dependencyCause,
          selfCommitmentCause: analysisState.value.selfCommitmentCause,
          hasUnobservedHeadChange: hasUnobservedPullRequestHeadChange(
            analysisState.value.item,
            previous,
            evaluatedAt,
          ),
          evaluatedAt,
        })
      : Object.freeze({
          responsibility_changed: Object.freeze({ status: "indeterminate" }),
          newly_unblocked: Object.freeze({ status: "indeterminate" }),
        });
  const personalReminderItem = finalized.data.items.find(
    (value) => value.item.nodeId === item.nodeId,
  );
  assertNonNullable(personalReminderItem, `個人催促の確定項目がありません。対象: ${item.nodeId}`);
  const personalReminderCausePlanning = personalReminderItem.planning;
  const personalReminderCauses = personalReminderItem.causeResults;
  return Object.freeze({
    nodeId: item.nodeId,
    createdAt: item.createdAt,
    draftState: notificationDraftState(item, enumeratedItemsByNodeId, repositoryFreshness),
    repositoryFreshness,
    notificationClass: item.notificationClass,
    notificationsSuppressedByLabel: labelEffects.suppressNotifications,
    latestChange:
      analysisState.availability === "available"
        ? notificationLatestChange(analysisState.value, previous)
        : "none",
    decisionBasis: notificationDecisionBasis(item, staleness, analysisState),
    notificationRecommendation,
    priorityWeight: labelEffects.priorityWeight,
    current: {
      status: item.status,
      waitingOn: item.waitingOn,
      severity: staleness.severity,
      severityReason: staleness.severityReason,
      waitClass: staleness.waitClass,
      statusSince: item.statusSince,
      ownerSince: item.ownerSince,
      stallSince: item.stallSince,
      lastProgressAt: item.lastProgressAt,
    },
    previous:
      previous == null
        ? Object.freeze({
            availability: "not_available",
          })
        : Object.freeze({
            availability: "available",
            value: Object.freeze({
              status: previous.status,
              waitingOn: previous.waitingOn,
              severity: previous.severity,
              stallSince: previous.stallSince,
              observedAt: previous.observedAt,
            }),
          }),
    causes,
    personalReminderCauses,
    personalReminderCausePlanning,
    graph: Object.freeze({
      downstreamImpact,
      newlyUnblocked:
        currentGraph.analysis.newlyUnblockedNodeIds.includes(item.nodeId) &&
        !currentGraph.unverifiedOpenBlockerNodeIds.has(item.nodeId),
      hasOpenBlockers:
        graph.openNodeIds.includes(item.nodeId) &&
        !graph.analysis.actionableFrontier.includes(item.nodeId),
      currentDependencyCycleIds: cycleIds,
      previousDependencyCycles,
    }),
  });
}

/** 追跡項目から通知選別用の項目を作る。 */
export function notificationItems(
  configuration: RuntimeConfiguration,
  state: RuntimeState,
  repositories: GraphReconciledRun["data"]["approvedRepositories"],
  collection: GraphReconciledRun["data"]["collection"],
  reconciled: GraphReconciledRun,
  finalized: PersonalReminderFinalizedRun,
): readonly DiscordNotificationItem[] {
  const { reduction, graph, finalItems } = reconciled.data;
  const currentGraph = currentNotificationGraph(state, finalItems, graph);
  const staleRepositoryIds = new Set<GitHubRepositoryId>(
    collection.repositoryResults
      .filter((result) => result.freshness === "stale")
      .map((result) => result.repository.id),
  );
  const currentItemsByNodeId = new Map(
    reduction.currentItems.map((current) => [current.item.nodeId, current]),
  );
  const stalenessByNodeId = new Map(reduction.stalenessByNodeId);
  const retainedNotificationRecommendations = new Map(
    reduction.retainedNotificationRecommendations,
  );
  const enumeratedItemsByNodeId = new Map(
    collection.enumeratedItems.map((item) => [item.nodeId, item]),
  );
  return Object.freeze(
    finalItems.flatMap((item) => {
      const repositoryFreshness = staleRepositoryIds.has(item.repositoryId) ? "stale" : "fresh";
      const staleness = stalenessByNodeId.get(item.nodeId);
      assertNonNullable(staleness, `通知対象 ${item.nodeId}のseverity再計算結果がありません`);
      const current = currentItemsByNodeId.get(item.nodeId);
      return [
        notificationItem(
          configuration,
          state,
          repositories,
          enumeratedItemsByNodeId,
          graph,
          currentGraph,
          collection.evaluatedAt,
          item,
          staleness,
          current == null
            ? Object.freeze({
                availability: "not_available",
              })
            : Object.freeze({
                availability: "available",
                value: current,
              }),
          finalized,
          retainedNotificationRecommendations.get(item.nodeId),
          repositoryFreshness,
        ),
      ];
    }),
  );
}
