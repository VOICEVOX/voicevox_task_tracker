import type { Sha256Hash } from "../../../../canonical-json/sha256.js";
import { serializeCanonicalJsonLine } from "../../../../canonical-json/value.js";
import type { DiscordNotificationItem } from "../../../../discord/index.js";
import {
  hasRecentMeaningfulProgress,
  isRecentDraft,
} from "../../../../discord/notification-selection-signals.js";
import type { UtcIsoDateTime } from "../../../../domain/index.js";
import type { StateSnapshot } from "../../../../persistence/index.js";
import { assertNonNullable } from "../../../../util/index.js";
import { hashCanonicalJson } from "../../content-digest.js";

export const SANDBOX_STRICT_ZERO_SOURCE_PROOF_PATH =
  "artifacts/workflow/sandbox-strict-zero-source-proof.json";

type SourceDigests = Readonly<{
  repositories: Sha256Hash;
  collectionItems: Sha256Hash;
  references: Sha256Hash;
  itemSources: Sha256Hash;
  notificationCurrent: Sha256Hash;
  timeConditions: Sha256Hash;
}>;

function sortedUnique<T>(values: readonly T[], key: (value: T) => string): readonly T[] {
  const sorted = [...values].sort((left, right) => {
    const leftKey = key(left);
    const rightKey = key(right);
    if (leftKey < rightKey) return -1;
    if (leftKey > rightKey) return 1;
    return 0;
  });
  for (let index = 1; index < sorted.length; index += 1) {
    const current = sorted.at(index);
    const previous = sorted.at(index - 1);
    assertNonNullable(current, "strict-zeroの現在項目がありません");
    assertNonNullable(previous, "strict-zeroの前項目がありません");
    if (key(current) === key(previous)) {
      throw new TypeError("strict-zeroのsource項目に重複があります");
    }
  }
  return sorted;
}

function severityReason(reason: DiscordNotificationItem["current"]["severityReason"]): unknown {
  if (reason.kind === "not_applicable") {
    return reason;
  }
  return {
    kind: reason.kind,
    waitClass: reason.waitClass,
    crossedThreshold: reason.crossedThreshold,
  };
}

function personalReminderInputs(item: DiscordNotificationItem): unknown {
  return sortedUnique(item.personalReminderCauses, (input) => input.cause.causeId).map(
    ({ cause, staleness }) => ({
      causeId: cause.causeId,
      responsibilityId: cause.responsibilityId,
      itemNodeId: cause.itemNodeId,
      responsible: cause.responsible,
      responsibility: cause.responsibility,
      action: cause.action,
      reasonCode: cause.reasonCode,
      obligationSince: cause.obligationSince,
      actionableClock: cause.actionableClock,
      currentInput: cause.currentInput,
      adoptedAssessment:
        cause.adoptedAssessment.status === "available"
          ? {
              status: cause.adoptedAssessment.status,
              inputFingerprint: cause.adoptedAssessment.inputFingerprint,
              rulesVersion: cause.adoptedAssessment.rulesVersion,
              result: cause.adoptedAssessment.result,
            }
          : cause.adoptedAssessment,
      staleness:
        staleness.status === "eligible"
          ? {
              status: staleness.status,
              waitClass: staleness.waitClass,
              severity: staleness.severity,
              crossedThreshold: staleness.severityReason.crossedThreshold,
              actionableSince: staleness.actionableSince,
              stallSince: staleness.stallSince,
            }
          : staleness,
    }),
  );
}

/** strict-zeroで比較する保存済みGitHub sourceのdigestを作る。 */
export function strictZeroSnapshotSourceDigests(
  snapshot: StateSnapshot,
): Pick<SourceDigests, "repositories" | "collectionItems" | "references" | "itemSources"> {
  return {
    repositories: hashCanonicalJson(
      sortedUnique(snapshot.repositories, (repository) => repository.id).map((repository) => ({
        id: repository.id,
        owner: repository.owner,
        name: repository.name,
        visibility: repository.visibility,
        archived: repository.archived,
        disabled: repository.disabled,
        freshness: repository.freshness,
      })),
    ),
    collectionItems: hashCanonicalJson(
      sortedUnique(snapshot.collection.repositories, (repository) => repository.repositoryId).map(
        (repository) => ({
          repositoryId: repository.repositoryId,
          items: sortedUnique(repository.items, (item) => item.nodeId).map((item) => ({
            nodeId: item.nodeId,
            repositoryId: item.repositoryId,
            itemFingerprint: item.itemFingerprint,
            state: item.state,
            terminalAt: item.terminalAt,
          })),
        }),
      ),
    ),
    references: hashCanonicalJson({
      verifiedExternalReferences: sortedUnique(
        snapshot.verifiedExternalReferences,
        (reference) => reference.url,
      ),
      externalReferences: sortedUnique(
        snapshot.externalReferences,
        (reference) => reference.nodeId,
      ),
      relations: sortedUnique(snapshot.relations, (relation) => relation.id).map((relation) => ({
        id: relation.id,
        fromNodeId: relation.fromNodeId,
        toNodeId: relation.toNodeId,
        type: relation.type,
        active: relation.active,
        evidence: relation.evidence,
      })),
    }),
    itemSources: hashCanonicalJson(
      sortedUnique(snapshot.items, (item) => item.nodeId).map((item) => ({
        nodeId: item.nodeId,
        repositoryId: item.repositoryId,
        type: item.type,
        state: item.state,
        title: item.title,
        githubUpdatedAt: item.githubUpdatedAt,
        createdAt: item.createdAt,
        author: item.author,
        labels: item.labels,
        assignees: item.assignees,
        inputEvents: item.inputEvents,
        evidence: item.evidence,
        reviewState: item.reviewState,
        checkState: item.checkState,
      })),
    ),
  };
}

/** strict-zeroの通知実効入力からcheckpoint artifactの内容を作る。 */
export function createSandboxStrictZeroSourceProof(
  input: Readonly<{
    runId: string;
    configDigest: Sha256Hash;
    evaluatedAt: UtcIsoDateTime;
    graceHours: number;
    snapshot: StateSnapshot;
    items: readonly DiscordNotificationItem[];
  }>,
): string {
  const evaluatedTimestamp = Date.parse(input.evaluatedAt);
  if (!Number.isFinite(evaluatedTimestamp)) {
    throw new TypeError("strict-zeroの評価時刻が不正です");
  }
  const items = sortedUnique(input.items, (item) => item.nodeId);
  const notificationCurrent = items.map((item) => ({
    nodeId: item.nodeId,
    createdAt: item.createdAt,
    draftState: item.draftState,
    repositoryFreshness: item.repositoryFreshness,
    notificationClass: item.notificationClass,
    notificationsSuppressedByLabel: item.notificationsSuppressedByLabel,
    latestChange: item.latestChange,
    decisionBasis: item.decisionBasis,
    notificationRecommendation: item.notificationRecommendation,
    priorityWeight: item.priorityWeight,
    current: {
      status: item.current.status,
      waitingOn: item.current.waitingOn,
      severity: item.current.severity,
      severityReason: severityReason(item.current.severityReason),
      waitClass: item.current.waitClass,
      statusSince: item.current.statusSince,
      ownerSince: item.current.ownerSince,
      stallSince: item.current.stallSince,
      lastProgressAt: item.current.lastProgressAt,
    },
    personalReminderCauses: personalReminderInputs(item),
    personalReminderCausePlanning: {
      status: item.personalReminderCausePlanning.status,
      planningVersion: item.personalReminderCausePlanning.planningVersion,
    },
    graph: {
      downstreamImpact: item.graph.downstreamImpact,
      hasOpenBlockers: item.graph.hasOpenBlockers,
      currentDependencyCycleIds: item.graph.currentDependencyCycleIds,
    },
  }));
  const timeConditions = items.map((item) => ({
    nodeId: item.nodeId,
    recentDraft: isRecentDraft(item, evaluatedTimestamp, input.graceHours),
    recentMeaningfulProgress: hasRecentMeaningfulProgress(
      item,
      evaluatedTimestamp,
      input.graceHours,
    ),
    severity: item.current.severity,
    severityReason: severityReason(item.current.severityReason),
    personalReminder: sortedUnique(item.personalReminderCauses, (value) => value.cause.causeId).map(
      ({ cause, staleness }) => ({
        causeId: cause.causeId,
        status: staleness.status,
        severity: staleness.status === "eligible" ? staleness.severity : null,
        threshold:
          staleness.status === "eligible" ? staleness.severityReason.crossedThreshold : null,
      }),
    ),
  }));
  const digests: SourceDigests = {
    ...strictZeroSnapshotSourceDigests(input.snapshot),
    notificationCurrent: hashCanonicalJson(notificationCurrent),
    timeConditions: hashCanonicalJson(timeConditions),
  };
  return serializeCanonicalJsonLine({
    schemaVersion: 1,
    runId: input.runId,
    configDigest: input.configDigest,
    evaluatedAt: input.evaluatedAt,
    notificationItemCount: items.length,
    sourceDigests: digests,
  });
}
