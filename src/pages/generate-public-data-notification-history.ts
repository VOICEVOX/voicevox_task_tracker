import type { UtcIsoDateTime } from "../domain/index.js";
import type { StateHistoryRecord } from "../persistence/index.js";
import { PublicDtoSemanticError } from "./errors.js";
import type { PublicNotificationHistoryDto } from "./public-dto-contracts.js";
import { createPublicNotificationHistoryDto } from "./public-dto.js";
import { comparePublicNotificationHistoryEntries } from "./public-history-dto-validation.js";
import type { PagesPublicSafetyInput } from "./public-safety.js";

/** 保存済み通知履歴を公開DTOへ写す。 */
export function createPublicNotificationHistory(
  records: readonly StateHistoryRecord[],
  repositoryAllowlist: PagesPublicSafetyInput["repositoryAllowlist"],
  repositoryInventory: readonly PagesPublicSafetyInput["repositoryInventory"][number][],
  runId: string,
  generatedAt: UtcIsoDateTime,
): PublicNotificationHistoryDto {
  const allowlistById = new Map<string, PagesPublicSafetyInput["repositoryAllowlist"][number]>(
    repositoryAllowlist.map((repository) => [repository.id, repository]),
  );
  if (allowlistById.size !== repositoryAllowlist.length) {
    throw new PublicDtoSemanticError("通知履歴の公開allowlistにrepository IDの重複があります");
  }
  const inventoryById = new Map<string, PagesPublicSafetyInput["repositoryInventory"][number]>(
    repositoryInventory.map((repository) => [repository.id, repository]),
  );
  if (inventoryById.size !== repositoryInventory.length) {
    throw new PublicDtoSemanticError("通知履歴のrepository inventoryにIDの重複があります");
  }
  const notifications: PublicNotificationHistoryDto["notifications"] = [];
  for (const record of records) {
    for (const event of record.events) {
      if (event.kind !== "notification_sent") {
        continue;
      }
      if (event.waitingOn.status === "not_recorded") {
        continue;
      }
      if (event.reasons.some((reason) => reason.threshold.status === "not_recorded")) {
        continue;
      }
      const repository = inventoryById.get(event.repositoryId);
      if (repository == null) {
        throw new PublicDtoSemanticError(
          `通知履歴のrepository ${event.repositoryId}をinventoryから解決できません`,
        );
      }
      if (repository.visibility !== "public" || repository.archived || repository.disabled) {
        throw new PublicDtoSemanticError(
          `通知履歴のrepository ${event.repositoryId}は公開対象ではありません`,
        );
      }
      const allowlistedRepository = allowlistById.get(event.repositoryId);
      if (allowlistedRepository == null) {
        throw new PublicDtoSemanticError(
          `通知履歴のrepository ${event.repositoryId}が公開allowlistにありません`,
        );
      }
      if (
        allowlistedRepository.owner !== repository.owner ||
        allowlistedRepository.name !== repository.name
      ) {
        throw new PublicDtoSemanticError(
          `通知履歴のrepository ${event.repositoryId}のidentityが一致しません`,
        );
      }
      notifications.push({
        item: {
          nodeId: event.itemNodeId,
          type: event.type,
          repositoryId: event.repositoryId,
          displayReference: event.displayReference,
          number: event.number,
          title: event.title,
          url: event.url,
        },
        waitingOn: event.waitingOn.values.map((waitingOn) => ({ ...waitingOn })),
        reasons: [...event.reasons],
        personalReminders: event.personalReminders.map((personalReminder) => ({
          ...personalReminder,
        })),
        sentAt: event.sentAt,
      });
    }
  }
  notifications.sort(comparePublicNotificationHistoryEntries);
  return createPublicNotificationHistoryDto({
    schemaVersion: "5",
    runId,
    generatedAt,
    notifications,
  });
}
