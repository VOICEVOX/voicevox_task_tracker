import type { EvidenceClosureAdditions } from "../../../../application/tracking-run/stages/evidence-closure.js";
import type { GenericAiExecutedRun } from "../../../../application/tracking-run/stages/generic-ai-execution.js";
import type { GraphReconciledRun } from "../../../../application/tracking-run/stages/graph-reconciliation.js";
import type { PersonalReminderFinalizedRun } from "../../../../application/tracking-run/stages/personal-reminder-finalization.js";
import { serializeCanonicalJson } from "../../../../canonical-json/value.js";
import type { AiCacheEntry } from "../../../../codex/cache.js";
import type { PersonalReminderAiCacheEntry } from "../../../../codex/personal-reminder-cache.js";
import type { DiscordNotificationItem } from "../../../../discord/notification-selection-contracts.js";
import { createGitHubNodeId } from "../../../../domain/types.js";
import { assertNonNullable } from "../../../../util/index.js";

type NotificationCause = EvidenceClosureAdditions["notificationCauses"][number];

function genericAiCacheAdditions(
  entries: readonly AiCacheEntry[],
  genericAiExecuted: GenericAiExecutedRun,
  finalized: PersonalReminderFinalizedRun,
): EvidenceClosureAdditions["aiCacheAdditions"] {
  const results = new Map<
    string,
    Readonly<{ itemNodeId: string; element: string; generation: string }>
  >();
  for (const item of genericAiExecuted.data.run?.results ?? []) {
    const nodeId = createGitHubNodeId(item.candidateId);
    if (!finalized.data.items.some((entry) => entry.item.nodeId === nodeId)) {
      throw new TypeError(`AI cacheの対象項目が最終runにありません。対象: ${nodeId}`);
    }
    for (const element of item.elements) {
      const existing = results.get(element.cacheKey);
      const result = Object.freeze({
        itemNodeId: nodeId,
        element: element.element,
        generation: serializeCanonicalJson(element.generation),
      });
      if (existing != null && serializeCanonicalJson(existing) !== serializeCanonicalJson(result)) {
        throw new TypeError(`AI cache keyの所有者が競合しています。対象: ${element.cacheKey}`);
      }
      results.set(element.cacheKey, result);
    }
  }
  return Object.freeze(
    entries.map((entry) => {
      const result = results.get(entry.cacheKey);
      assertNonNullable(
        result,
        `保存予定のAI cacheに今回の結果がありません。対象: ${entry.cacheKey}`,
      );
      if (
        result.element !== entry.element ||
        result.generation !== serializeCanonicalJson(entry.generation)
      ) {
        throw new TypeError(
          `保存予定のAI cacheと今回の結果が一致しません。対象: ${entry.cacheKey}`,
        );
      }
      return Object.freeze({
        itemNodeId: createGitHubNodeId(result.itemNodeId),
        element: entry.element,
        result: entry.generation.result,
      });
    }),
  );
}

function personalReminderAiCacheAdditions(
  entries: readonly PersonalReminderAiCacheEntry[],
  finalized: PersonalReminderFinalizedRun,
): EvidenceClosureAdditions["personalReminderAiCacheAdditions"] {
  const owners = new Map(
    finalized.data.items.flatMap((item) =>
      item.causeResults.map((result) => [result.cause.causeId, item.item.nodeId] as const),
    ),
  );
  return Object.freeze(
    entries.map((entry) => {
      const itemNodeId = owners.get(entry.causeId);
      assertNonNullable(
        itemNodeId,
        `保存予定の個人催促AI cacheの原因がありません。対象: ${entry.causeId}`,
      );
      return Object.freeze({ itemNodeId, result: entry.generation.result });
    }),
  );
}

function notificationCauses(
  graphReconciled: GraphReconciledRun,
  items: readonly DiscordNotificationItem[],
): EvidenceClosureAdditions["notificationCauses"] {
  const current = new Map(
    graphReconciled.data.reduction.currentItems.map((entry) => [entry.item.nodeId, entry]),
  );
  return Object.freeze(
    items.map((item): NotificationCause => {
      const analysis = current.get(item.nodeId);
      return Object.freeze({
        itemNodeId: item.nodeId,
        causes: item.causes,
        dependencyCause:
          analysis == null ? Object.freeze({ status: "indeterminate" }) : analysis.dependencyCause,
      });
    }),
  );
}

/** 保存と通知へ進む実値から閉包の追加参照を作る。 */
export function createEvidenceClosureAdditions(
  aiCacheEntries: readonly AiCacheEntry[],
  personalReminderAiCacheEntries: readonly PersonalReminderAiCacheEntry[],
  genericAiExecuted: GenericAiExecutedRun,
  graphReconciled: GraphReconciledRun,
  finalized: PersonalReminderFinalizedRun,
  historyInputEvents: EvidenceClosureAdditions["historyInputEvents"],
  notificationItems: readonly DiscordNotificationItem[],
  pendingNotifications: EvidenceClosureAdditions["pendingNotifications"],
): EvidenceClosureAdditions {
  return Object.freeze({
    historyInputEvents,
    aiCacheAdditions: genericAiCacheAdditions(aiCacheEntries, genericAiExecuted, finalized),
    personalReminderAiCacheAdditions: personalReminderAiCacheAdditions(
      personalReminderAiCacheEntries,
      finalized,
    ),
    notificationCauses: notificationCauses(graphReconciled, notificationItems),
    pendingNotifications,
  });
}
