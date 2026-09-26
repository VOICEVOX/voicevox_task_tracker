import {
  classifyTrackingNotification,
  createGitHubBotPredicate,
  createLabelEffectsResolver,
  determineMeaningfulProgress,
  determineTrackedItemWork,
  selectTrackingItems,
  type GitHubNodeId,
  type OrganizationTrackingCandidate,
  type TrackingCandidate,
  type TrackingConnection,
  type TrackedItemWorkDecision,
  type UtcIsoDateTime,
} from "../../../domain/index.js";
import {
  deduplicateByStableId,
  type EnumeratedGitHubItem,
  type FreshObservedGitHubItem,
} from "../../../github/index.js";
import type { RelationCandidate } from "../../../graph/index.js";
import { relationNodes } from "../../../graph/relation-candidate-endpoints.js";
import { assertNonNullable, UnreachableError } from "../../../util/index.js";
import { createTrackingBackfillRequest } from "../../backfill.js";
import type { DailyRunInvocation } from "../../daily-transaction.js";
import type { RepositoryInventory, RuntimeConfiguration, RuntimeState } from "../contracts.js";
import { normalizeLabelRules } from "../label-rules.js";
import { staleAiAnalysisElementsForLifecycle } from "../previous-state/analysis.js";
import { previousCollectionItemsByNodeId } from "../previous-state/collection.js";
import { previousSnapshot } from "../previous-state/snapshot.js";
import { findRepository, repositoryFullName } from "../repository-lookup.js";
import { trackingSelectionStartAt } from "../tracking-start-at.js";
import {
  enumeratedRetentionItemState,
  normalizeTrackingIdentifier,
  shouldKeepPreviousTrackedItemInActiveDataset,
} from "./incremental-plan.js";

export type RuntimeTrackingSelection = Readonly<{
  result: ReturnType<typeof selectTrackingItems>;
  workByNodeId: ReadonlyMap<GitHubNodeId, TrackedItemWorkDecision>;
  excludedCandidateCount: number;
}>;

function createTrackingConnections(
  candidates: readonly RelationCandidate[],
): readonly TrackingConnection[] {
  const connections: TrackingConnection[] = [];
  for (const candidate of candidates) {
    const sourceId = candidate.sourceIds[0];
    assertNonNullable(sourceId, `関係候補 ${candidate.id}のsource IDがありません`);
    switch (candidate.relation.type) {
      case "blocks":
        connections.push(
          Object.freeze({
            kind: "native_dependency",
            sourceId,
            blockerNodeId: candidate.relation.blocker.nodeId,
            blockedNodeId: candidate.relation.blocked.nodeId,
          }),
        );
        break;
      case "parent_of":
        if (candidate.authority === "authoritative") {
          connections.push(
            Object.freeze({
              kind: "native_sub_issue",
              sourceId,
              parentNodeId: candidate.relation.parent.nodeId,
              subIssueNodeId: candidate.relation.subtask.nodeId,
            }),
          );
          break;
        }
        connections.push(
          Object.freeze({
            kind: "reference",
            sourceId,
            referencingNodeId: candidate.relation.parent.nodeId,
            referencedNodeId: candidate.relation.subtask.nodeId,
            relation: Object.freeze({
              type: "non_blocking",
              relationType: "parent_of",
            }),
          }),
        );
        break;
      case "implements":
        connections.push(
          Object.freeze({
            kind: "reference",
            sourceId,
            referencingNodeId: candidate.relation.implementation.nodeId,
            referencedNodeId: candidate.relation.target.nodeId,
            relation: Object.freeze({
              type: "non_blocking",
              relationType: "implements",
            }),
          }),
        );
        break;
      case "unclassified":
        connections.push(
          Object.freeze({
            kind: "reference",
            sourceId,
            referencingNodeId: candidate.relation.referencing.nodeId,
            referencedNodeId: candidate.relation.referenced.nodeId,
            relation: Object.freeze({
              type: "non_blocking",
              relationType: "related_to",
            }),
          }),
        );
        break;
      default:
        throw new UnreachableError(candidate.relation);
    }
  }
  return Object.freeze(connections);
}

function enumeratedAuthorType(
  item: EnumeratedGitHubItem,
  isBot: ReturnType<typeof createGitHubBotPredicate>,
): "human" | "bot" | "unknown" {
  if (item.author.kind === "deleted_account") {
    return "unknown";
  }
  return item.author.account.apiType === "Bot" || isBot(item.author.account) ? "bot" : "human";
}

/** 追跡対象と後続の処理対象を選ぶ。 */
export function collectTrackingCandidates(
  invocation: DailyRunInvocation,
  evaluatedAt: UtcIsoDateTime,
  configuration: RuntimeConfiguration,
  state: RuntimeState,
  inventory: RepositoryInventory,
  enumeratedItems: readonly EnumeratedGitHubItem[],
  observedItems: readonly FreshObservedGitHubItem[],
  relationCandidates: readonly RelationCandidate[],
): RuntimeTrackingSelection {
  const resolveLabelEffects = createLabelEffectsResolver(normalizeLabelRules(configuration.config));
  const previousItems = new Map(
    (previousSnapshot(state)?.items ?? []).map((item) => [item.nodeId, item]),
  );
  const observedItemsByNodeId = new Map(observedItems.map((item) => [item.nodeId, item]));
  const enumeratedItemsByNodeId = new Map(enumeratedItems.map((item) => [item.nodeId, item]));
  const isBot = createGitHubBotPredicate(configuration.config.actors.bots);
  let excludedCandidateCount = 0;
  const organizationCandidates: OrganizationTrackingCandidate[] = enumeratedItems.flatMap(
    (item): OrganizationTrackingCandidate[] => {
      const repository = findRepository(inventory, item.repositoryId);
      const fullName = repositoryFullName(repository);
      const previous = previousItems.get(item.nodeId);
      const observed = observedItemsByNodeId.get(item.nodeId);
      const activity =
        observed == null
          ? previous == null
            ? undefined
            : Object.freeze({
                lastHumanActivityAt: previous.lastHumanActivityAt,
                lastProgressAt: previous.lastProgressAt,
              })
          : determineMeaningfulProgress({
              createdAt: observed.createdAt,
              evaluatedAt,
              events: observed.events,
              dependencyResolutions: [],
              naturalLanguageAssessments: [],
              minimumAiConfidence: configuration.config.ai.confidence.medium,
              previousActivity:
                previous == null
                  ? {
                      status: "not_available",
                    }
                  : {
                      status: "available",
                      lastProgressAt: previous.lastProgressAt,
                      lastHumanActivityAt: previous.lastHumanActivityAt,
                    },
              repositoryFullName: fullName,
              resolveLabelEffects,
            });
      if (activity == null) {
        excludedCandidateCount += 1;
        return [];
      }
      const itemAuthorType = enumeratedAuthorType(item, isBot);
      const notificationClass = classifyTrackingNotification({
        authorType: itemAuthorType,
        title: item.title,
        automationNoiseTitles: configuration.config.notifications.automationNoiseTitles,
        notificationsSuppressedByLabel: resolveLabelEffects(fullName, item.labels)
          .suppressNotifications,
      });
      if (item.state === "open") {
        return [
          Object.freeze({
            scope: "organization",
            nodeId: item.nodeId,
            repositoryFullName: fullName,
            number: item.number,
            url: item.url,
            title: item.title,
            createdAt: item.createdAt,
            activity: Object.freeze({
              lastHumanActivityAt: activity.lastHumanActivityAt,
              lastProgressAt: activity.lastProgressAt,
            }),
            authorType: itemAuthorType,
            notificationClass,
            state: "open",
          }),
        ];
      }
      return [
        Object.freeze({
          scope: "organization",
          nodeId: item.nodeId,
          repositoryFullName: fullName,
          number: item.number,
          url: item.url,
          title: item.title,
          createdAt: item.createdAt,
          activity: Object.freeze({
            lastHumanActivityAt: activity.lastHumanActivityAt,
            lastProgressAt: activity.lastProgressAt,
          }),
          authorType: itemAuthorType,
          notificationClass,
          state: "closed",
          terminalAt: item.closedAt,
        }),
      ];
    },
  );
  const externalCandidates = deduplicateByStableId(
    relationCandidates.flatMap((candidate) =>
      relationNodes(candidate.relation).flatMap((node) =>
        node.scope === "external_public"
          ? [
              Object.freeze({
                scope: "external_public",
                nodeId: node.nodeId,
                repositoryFullName: `${node.repositoryOwner}/${node.repositoryName}`,
                number: node.number,
                url: node.url,
                title: `${node.repositoryOwner}/${node.repositoryName}#${node.number.toString()}`,
                state: node.state,
              } satisfies TrackingCandidate),
            ]
          : [],
      ),
    ),
    (candidate) => candidate.nodeId,
  );
  const candidates: readonly TrackingCandidate[] = Object.freeze([
    ...organizationCandidates,
    ...externalCandidates,
  ]);
  const result = selectTrackingItems({
    startAt: trackingSelectionStartAt(configuration, state, evaluatedAt),
    evaluatedAt,
    candidates,
    connections: createTrackingConnections(relationCandidates),
    previouslyTrackedNodeIds: Object.freeze(
      [...previousItems.keys()].filter((nodeId) => {
        const currentItem = enumeratedItemsByNodeId.get(nodeId);
        if (currentItem == null) {
          return false;
        }
        const itemState = enumeratedRetentionItemState(currentItem);
        return shouldKeepPreviousTrackedItemInActiveDataset(
          evaluatedAt,
          configuration,
          currentItem,
          itemState,
        );
      }),
    ),
    explicitIncludes: configuration.config.tracking.include
      .map(normalizeTrackingIdentifier)
      .filter((identifier) =>
        candidates.some(
          (candidate) => candidate.nodeId === identifier || candidate.url === identifier,
        ),
      ),
    autoInclude: configuration.config.tracking.autoInclude,
    backfill: createTrackingBackfillRequest(
      invocation.command,
      Object.freeze({
        status: "start",
      }),
    ),
    maxBackfillItemsPerRun: configuration.config.tracking.backfill.maxItemsPerRun,
  });
  const previousCollectionItems = previousCollectionItemsByNodeId(state);
  const workByNodeId = new Map<GitHubNodeId, TrackedItemWorkDecision>();
  for (const selected of result.trackedItems) {
    const item = enumeratedItemsByNodeId.get(selected.item.nodeId);
    assertNonNullable(item, `追跡対象の列挙値がありません。対象: ${selected.item.nodeId}`);
    const previousCollectionItem = previousCollectionItems.get(item.nodeId);
    const previousTrackedItem = previousItems.get(item.nodeId);
    workByNodeId.set(
      item.nodeId,
      determineTrackedItemWork({
        state: item.state,
        requiredAiAnalysisElements: staleAiAnalysisElementsForLifecycle(previousTrackedItem),
        previousAiAnalysisStatus:
          previousTrackedItem == null ? "not_available" : previousTrackedItem.aiAnalysis.status,
        previousObservation:
          previousCollectionItem == null
            ? Object.freeze({ status: "not_available" })
            : Object.freeze({
                status: "available",
                state: previousCollectionItem.state,
              }),
      }),
    );
  }
  return Object.freeze({
    result,
    workByNodeId,
    excludedCandidateCount,
  });
}

function setMinimumNativeDepth(
  nativeDepthByNodeId: Map<GitHubNodeId, number>,
  nodeId: GitHubNodeId,
  depth: number,
): void {
  const currentDepth = nativeDepthByNodeId.get(nodeId);
  if (currentDepth == null || depth < currentDepth) {
    nativeDepthByNodeId.set(nodeId, depth);
  }
}

/** 関係展開の起点とnative関係の深度を選ぶ。 */
export function relationExpansionTrackingState(tracking: RuntimeTrackingSelection): Readonly<{
  trackingRootNodeIds: ReadonlySet<GitHubNodeId>;
  nativeDepthByNodeId: ReadonlyMap<GitHubNodeId, number>;
}> {
  const trackingRootNodeIds = new Set<GitHubNodeId>();
  const nativeDepthByNodeId = new Map<GitHubNodeId, number>();
  for (const selected of tracking.result.trackedItems) {
    for (const reason of selected.reasons) {
      switch (reason.kind) {
        case "previously_tracked":
        case "created_after_start":
        case "changed_after_start":
        case "explicit_include":
          trackingRootNodeIds.add(selected.item.nodeId);
          setMinimumNativeDepth(nativeDepthByNodeId, selected.item.nodeId, 0);
          break;
        case "referenced_by_tracked":
        case "references_tracked":
          setMinimumNativeDepth(nativeDepthByNodeId, selected.item.nodeId, 0);
          break;
        case "native_relation":
          setMinimumNativeDepth(nativeDepthByNodeId, selected.item.nodeId, reason.depth);
          break;
        case "backfill":
          break;
        default:
          throw new UnreachableError(reason);
      }
    }
  }
  return Object.freeze({
    trackingRootNodeIds,
    nativeDepthByNodeId,
  });
}
