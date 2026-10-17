import { isTerminalStatus, validateDeadlineDate } from "../domain/index.js";
import { StateSnapshotSemanticError } from "./errors.js";
import { assertAiAnalysisApplicationsMatchTrackedItemValues } from "./snapshot-ai-adoption.js";
import type {
  LegacyStateSnapshotFields,
  LegacyStateSnapshotFieldsWithoutAiDependencies,
  LegacyStateSnapshotFieldsWithPersonalReminder,
  LegacyStateSnapshotFieldsWithPersonalReminderVersion17,
  StateSnapshotFields,
} from "./snapshot-contracts.js";
import { assertAiAnalysisSemantics } from "./snapshot-graph-dependencies.js";
import { assertPersonalReminderCausePlanningSemantics } from "./snapshot-reminder-planning.js";
import {
  assertPersonalReminderCausesSemantics,
  isLegacyPersonalReminder,
} from "./snapshot-reminder-responsibility.js";
import type { ElementSchemaVersion } from "./snapshot-schema.js";
import { assertUnique, assertUtcDateTime } from "./snapshot-values.js";

/** snapshotの収集・項目・日時の意味を検証する。 */
export function assertSnapshotFieldsSemantics(
  snapshot:
    | StateSnapshotFields
    | LegacyStateSnapshotFieldsWithoutAiDependencies
    | LegacyStateSnapshotFields
    | LegacyStateSnapshotFieldsWithPersonalReminder
    | LegacyStateSnapshotFieldsWithPersonalReminderVersion17,
  elementSchemaVersion: ElementSchemaVersion,
  adoptedElementsFormat: "legacy" | "current",
  requireApplications: boolean,
): void {
  assertUtcDateTime(snapshot.generatedAt, "generatedAt");
  if (snapshot.trackingStartAt.status === "fixed") {
    assertUtcDateTime(snapshot.trackingStartAt.value, "trackingStartAt");
  }
  assertUnique(
    snapshot.repositories.map((repository) => repository.id),
    "repository ID",
  );
  assertUnique(
    snapshot.items.map((item) => item.nodeId),
    "item node ID",
  );
  assertUnique(
    snapshot.externalReferences.map((reference) => reference.nodeId),
    "外部参照node ID",
  );
  assertUnique(
    snapshot.relations.map((relation) => relation.id),
    "relation ID",
  );

  const repositoryIds = new Set(snapshot.repositories.map((repository) => repository.id));
  const personalReminderCauseIdValues = snapshot.items.flatMap((item) =>
    "personalReminderCauses" in item
      ? item.personalReminderCauses.map((cause) => cause.causeId)
      : [],
  );
  assertUnique(personalReminderCauseIdValues, "personal reminder cause ID");
  const personalReminderCauseIds = new Set(personalReminderCauseIdValues);
  const personalReminderResponsibilityIdValues = snapshot.items.flatMap((item) =>
    "personalReminderCauses" in item
      ? item.personalReminderCauses.map((cause) => cause.responsibilityId)
      : [],
  );
  assertUnique(personalReminderResponsibilityIdValues, "personal reminder responsibility ID");
  assertUnique(
    snapshot.collection.repositories.map((repository) => repository.repositoryId),
    "収集stateのrepository ID",
  );
  const collectionItemNodeIds = snapshot.collection.repositories.flatMap((repository) =>
    repository.items.map((item) => item.nodeId),
  );
  assertUnique(collectionItemNodeIds, "収集stateのitem node ID");
  const snapshotRepositoriesById = new Map(
    snapshot.repositories.map((repository) => [repository.id, repository]),
  );
  for (const collectionRepository of snapshot.collection.repositories) {
    const snapshotRepository = snapshotRepositoriesById.get(collectionRepository.repositoryId);
    if (snapshotRepository == null) {
      throw new StateSnapshotSemanticError(
        "収集stateのrepositoryIdがsnapshotのrepository一覧にありません",
      );
    }
    assertUtcDateTime(collectionRepository.successfulAt, "収集stateのrepository成功時刻");
    if (collectionRepository.successfulAt !== snapshotRepository.observedAt) {
      throw new StateSnapshotSemanticError(
        "収集stateのrepository成功時刻がsnapshotのrepository観測時刻と一致しません",
      );
    }
    for (const item of collectionRepository.items) {
      if (item.repositoryId !== collectionRepository.repositoryId) {
        throw new StateSnapshotSemanticError(
          "収集stateのitem repositoryIdが親repositoryと一致しません",
        );
      }
      assertUtcDateTime(item.observedAt, "収集stateのitem観測時刻");
      assertAiAnalysisSemantics(
        item.aiAnalysis,
        elementSchemaVersion,
        adoptedElementsFormat,
        requireApplications,
        true,
      );
      if (item.observedAt > collectionRepository.successfulAt) {
        throw new StateSnapshotSemanticError(
          "収集stateのitem観測時刻はrepository成功時刻以前にしてください",
        );
      }
      if (item.state === "closed") {
        assertUtcDateTime(item.terminalAt, "収集stateのterminal遷移時刻");
        if (item.terminalAt > collectionRepository.successfulAt) {
          throw new StateSnapshotSemanticError(
            "収集stateのterminal遷移時刻はrepository成功時刻以前にしてください",
          );
        }
      }
    }
  }
  for (const repository of snapshot.repositories) {
    assertUtcDateTime(repository.observedAt, "repository observedAt");
    if (repository.freshness === "stale") {
      assertUtcDateTime(repository.failedAt, "stale repository failedAt");
      if (repository.observedAt >= repository.failedAt) {
        throw new StateSnapshotSemanticError(
          "stale repositoryのobservedAtはfailedAtより前にしてください",
        );
      }
    }
    const latestRepositoryTime =
      repository.freshness === "stale" ? repository.failedAt : repository.observedAt;
    if (latestRepositoryTime > snapshot.generatedAt) {
      throw new StateSnapshotSemanticError(
        "repositoryの観測時刻はsnapshot generatedAt以前にしてください",
      );
    }
  }
  if ("graphNodeStateObservations" in snapshot) {
    assertUnique(
      snapshot.graphNodeStateObservations.map((observation) => observation.nodeId),
      "graph node状態観測のnode ID",
    );
    const itemsByNodeId = new Map(snapshot.items.map((item) => [item.nodeId, item]));
    for (const observation of snapshot.graphNodeStateObservations) {
      const item = itemsByNodeId.get(observation.nodeId);
      if (item == null) {
        throw new StateSnapshotSemanticError(
          `graph node状態観測のitemがありません。対象: ${observation.nodeId}`,
        );
      }
      const repository = snapshotRepositoriesById.get(item.repositoryId);
      if (repository?.freshness !== "stale") {
        throw new StateSnapshotSemanticError(
          `graph node状態観測のrepositoryはstaleでなければなりません。対象: ${observation.nodeId}`,
        );
      }
      assertUtcDateTime(observation.observedAt, "graph node状態観測時刻");
      if (observation.observedAt <= item.observedAt) {
        throw new StateSnapshotSemanticError(
          `graph node状態観測時刻はitem観測時刻より後にしてください。対象: ${observation.nodeId}`,
        );
      }
      if (observation.observedAt > snapshot.generatedAt) {
        throw new StateSnapshotSemanticError(
          `graph node状態観測時刻はsnapshot generatedAt以前にしてください。対象: ${observation.nodeId}`,
        );
      }
      if (observation.state === item.state) {
        throw new StateSnapshotSemanticError(
          `graph node状態観測はitem状態と異なる場合だけ保存してください。対象: ${observation.nodeId}`,
        );
      }
      if (item.type === "issue" && observation.state === "merged") {
        throw new StateSnapshotSemanticError(
          `Issueのgraph node状態観測をmergedにはできません。対象: ${observation.nodeId}`,
        );
      }
    }
  }
  for (const item of snapshot.items) {
    if (!repositoryIds.has(item.repositoryId)) {
      throw new StateSnapshotSemanticError(
        "itemのrepositoryIdがsnapshotのrepository一覧にありません",
      );
    }
    assertAiAnalysisSemantics(
      item.aiAnalysis,
      elementSchemaVersion,
      adoptedElementsFormat,
      requireApplications,
      false,
    );
    if ("aiDependencies" in item) {
      assertAiAnalysisApplicationsMatchTrackedItemValues(item);
    }
    if ("personalReminderCauses" in item) {
      const legacyPersonalReminder = isLegacyPersonalReminder(item);
      assertPersonalReminderCausesSemantics(item, personalReminderCauseIds, legacyPersonalReminder);
      assertPersonalReminderCausePlanningSemantics(item, legacyPersonalReminder);
    }
    if (isTerminalStatus(item.status) && item.waitingOn.length !== 0) {
      throw new StateSnapshotSemanticError("terminal itemにwaitingOnを保存できません");
    }
    if (isTerminalStatus(item.status) && item.severityContext.waitClass !== "notApplicable") {
      throw new StateSnapshotSemanticError(
        "terminal itemのseverity contextはnotApplicableにしてください",
      );
    }
    if (!isTerminalStatus(item.status) && item.severityContext.waitClass === "notApplicable") {
      throw new StateSnapshotSemanticError(
        "継続中itemのseverity contextをnotApplicableにはできません",
      );
    }
    if (
      item.status === "waiting_for_unblock" &&
      item.severityContext.waitClass !== "blockedParent"
    ) {
      throw new StateSnapshotSemanticError(
        "waiting_for_unblock itemのseverity contextはblockedParentにしてください",
      );
    }
    if (
      item.status !== "waiting_for_unblock" &&
      item.severityContext.waitClass === "blockedParent"
    ) {
      throw new StateSnapshotSemanticError(
        "waiting_for_unblock以外のitemのseverity contextをblockedParentにはできません",
      );
    }
    if (item.waitingOn.length === 0 && item.primaryWaitingOn.index !== "not_applicable") {
      throw new StateSnapshotSemanticError("waitingOnがないitemにprimaryを保存できません");
    }
    if (item.waitingOn.length > 0 && item.primaryWaitingOn.index !== 0) {
      throw new StateSnapshotSemanticError("waitingOnがあるitemにはprimaryが必要です");
    }
    assertUnique(
      item.assignees.map((assignee) => assignee.nodeId),
      "itemのassignee node ID",
    );
    assertUnique(
      item.inputEvents.map((event) => event.sourceId),
      "itemの入力イベントsource ID",
    );
    for (const dateTime of [
      item.createdAt,
      item.githubUpdatedAt,
      item.lastHumanActivityAt,
      item.lastProgressAt,
      item.statusSince,
      item.ownerSince,
      item.stallSince,
      item.observedAt,
    ]) {
      assertUtcDateTime(dateTime, "itemの日時");
    }
    assertUnique(
      item.importance.factors.map((factor) => factor.kind),
      "itemのimportance factor kind",
    );
    for (let index = 1; index < item.importance.factors.length; index += 1) {
      const previousFactor = item.importance.factors[index - 1];
      const factor = item.importance.factors[index];
      if (previousFactor == null || factor == null) {
        throw new StateSnapshotSemanticError("importance factorの順序を検証できません");
      }
      if (previousFactor.points < factor.points) {
        throw new StateSnapshotSemanticError("importance factorはpointsの降順にしてください");
      }
    }
    const importanceScore = Math.min(
      100,
      Math.max(
        0,
        Math.round(item.importance.factors.reduce((sum, factor) => sum + factor.points, 0)),
      ),
    );
    if (item.importance.score !== importanceScore) {
      throw new StateSnapshotSemanticError("importance scoreがfactorの合計と一致しません");
    }
    if (item.deadlineAssessment.status === "available") {
      try {
        validateDeadlineDate(item.deadlineAssessment.value.date, "itemの期限日");
      } catch (error: unknown) {
        if (!(error instanceof RangeError)) {
          throw error;
        }
        throw new StateSnapshotSemanticError("itemの期限日は実在する日付にしてください");
      }
    }
  }
}
