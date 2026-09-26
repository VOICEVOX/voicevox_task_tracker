import type { DailyRunInvocation, DailyTransactionDependencies } from "../../daily-transaction.js";
import type { ValidatedRun } from "../../run-publication/contracts.js";
import type {
  CodexAnalysis,
  CollectedItems,
  GraphResult,
  PersonalReminderAnalysis,
  ProductionTypes,
  ReducedAnalysis,
  RepositoryInventory,
  RuntimeConfiguration,
  RuntimeState,
} from "../contracts.js";
import { stateHistoryInputEvents } from "./history-events.js";
import {
  mergeSelectedNotificationLedger,
  selectValidationNotifications,
} from "./notification-selection.js";
import { createValidatedSnapshot } from "./snapshot-state.js";

function validateRunCompleteness(
  invocation: DailyRunInvocation,
  configuration: RuntimeConfiguration,
  state: RuntimeState,
  inventory: RepositoryInventory,
  collection: CollectedItems,
  codexAnalysis: CodexAnalysis,
  reduction: ReducedAnalysis,
  graph: GraphResult,
  personalReminderAnalysis: PersonalReminderAnalysis,
): ValidatedRun {
  const snapshot = createValidatedSnapshot(
    invocation,
    configuration,
    state,
    inventory,
    collection,
    codexAnalysis,
    reduction,
    graph,
    personalReminderAnalysis,
  );
  const notification = selectValidationNotifications(
    invocation,
    configuration,
    state,
    inventory,
    collection,
    reduction,
    graph,
    personalReminderAnalysis,
  );
  return Object.freeze({
    snapshot,
    historyInputEvents: stateHistoryInputEvents(reduction),
    notificationLedger: mergeSelectedNotificationLedger(state, notification),
    notificationSelection: notification.notificationSelection,
  });
}

/** 完全性検証段階を作る。 */
export function createValidateCompletenessStage(): DailyTransactionDependencies<ProductionTypes>["validateCompleteness"] {
  return ({
    invocation,
    configuration,
    state,
    repositoryInventory,
    collection,
    codexAnalysis,
    reduction,
    graph,
    personalReminderAnalysis,
  }) =>
    Promise.resolve(
      Object.freeze({
        status: "complete",
        value: validateRunCompleteness(
          invocation,
          configuration,
          state,
          repositoryInventory,
          collection,
          codexAnalysis,
          reduction,
          graph,
          personalReminderAnalysis,
        ),
        diagnostics: Object.freeze([]),
      }),
    );
}
