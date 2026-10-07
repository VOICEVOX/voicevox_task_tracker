import { closeFinalizedRunEvidence } from "../../../../application/tracking-run/stages/evidence-closure.js";
import { buildFinalSnapshot } from "../../../../application/tracking-run/stages/final-snapshot.js";
import type { GenericAiAdoptedRun } from "../../../../application/tracking-run/stages/generic-ai-adoption.js";
import type { GenericAiExecutedRun } from "../../../../application/tracking-run/stages/generic-ai-execution.js";
import type { GraphReconciledRun } from "../../../../application/tracking-run/stages/graph-reconciliation.js";
import type { PersonalReminderFinalizedRun } from "../../../../application/tracking-run/stages/personal-reminder-finalization.js";
import { validateRun } from "../../../../application/tracking-run/stages/validate-run.js";
import { assertStatePublicSafety, createStateSnapshot } from "../../../../persistence/index.js";
import type { PublicationValidatedRun } from "../../../../publication/publication-plan-contracts.js";
import { nodeContentDigestPort } from "../../content-digest.js";
import type { GitHubRunSessions } from "../../github-port.js";
import type { AnalysisProgress, AnalysisRuntimeContext } from "../analysis-contracts.js";
import { createEvidenceClosureAdditions } from "./evidence-additions.js";
import { stateHistoryInputEvents } from "./history-events.js";
import {
  mergeSelectedNotificationLedger,
  selectValidationNotifications,
} from "./notification-selection.js";
import { projectPublicationInputs } from "./publication-inputs.js";

/** canonical stageの系譜と実保存値を検証する。 */
export async function validateRunCompleteness(
  context: AnalysisRuntimeContext,
  genericAiExecuted: GenericAiExecutedRun,
  genericAiAdopted: GenericAiAdoptedRun,
  graphReconciled: GraphReconciledRun,
  finalized: PersonalReminderFinalizedRun,
  progress: AnalysisProgress,
  sessions: GitHubRunSessions,
): Promise<PublicationValidatedRun> {
  const { invocation, configuration, state } = context;
  const collection = graphReconciled.data.collection;
  const metrics = progress.readMetrics();
  const diagnostics = progress.readDiagnostics();
  const notification = selectValidationNotifications(
    invocation,
    configuration,
    state,
    graphReconciled.data.approvedRepositories,
    collection,
    graphReconciled,
    finalized,
  );
  const historyInputEvents = stateHistoryInputEvents(graphReconciled.data.reduction);
  const initialAiCacheEntries = state.session.pendingAiCacheEntries();
  const initialPersonalReminderAiCacheEntries =
    state.session.pendingPersonalReminderAiCacheEntries();
  const initialAdditions = createEvidenceClosureAdditions(
    initialAiCacheEntries,
    initialPersonalReminderAiCacheEntries,
    genericAiExecuted,
    graphReconciled,
    finalized,
    historyInputEvents,
    notification.notificationItems,
    notification.pendingNotifications,
  );
  const closure = closeFinalizedRunEvidence(finalized, initialAdditions, nodeContentDigestPort);
  const candidate = buildFinalSnapshot(finalized, closure, nodeContentDigestPort);
  const completeSnapshot = createStateSnapshot({
    ...candidate,
    run: Object.freeze({ ...candidate.run, complete: true }),
  });
  const publicationInputs = projectPublicationInputs(
    configuration,
    await state.session.initialPublicationBaseState(
      completeSnapshot,
      graphReconciled.data.approvedRepositories,
      historyInputEvents,
    ),
  );
  const notificationLedger = mergeSelectedNotificationLedger(state, notification);
  const aiCacheAdditions = state.session.pendingAiCacheEntries();
  const personalReminderAiCacheAdditions = state.session.pendingPersonalReminderAiCacheEntries();
  const actualOutwardAdditions = createEvidenceClosureAdditions(
    aiCacheAdditions,
    personalReminderAiCacheAdditions,
    genericAiExecuted,
    graphReconciled,
    finalized,
    historyInputEvents,
    notification.notificationItems,
    notificationLedger.pendingNotifications,
  );
  return validateRun({
    expectedCore: Object.freeze({
      identity: Object.freeze({
        runId: invocation.runId,
        invocationId: invocation.invocationId,
        scheduledFor: invocation.scheduledFor,
        startedAt: invocation.startedAt,
      }),
      executionPolicy: invocation.executionPolicy,
      baseRevision: configuration.baseStateHead,
      configDigest: configuration.configDigest,
      allowlistDigest: graphReconciled.data.allowlistDigest,
      evaluatedAt: collection.evaluatedAt,
    }),
    genericAiAdopted,
    graphReconciled,
    finalized,
    candidate,
    closure,
    actualOutwardAdditions,
    historyInputEvents,
    aiCacheAdditions,
    personalReminderAiCacheAdditions,
    previousNotificationLedger: state.notificationLedger,
    notificationLedger,
    notificationSelection: notification.notificationSelection,
    notificationPreview: notification.notificationPreview,
    publicationInputs,
    ledgerEntriesToMerge: notification.ledgerEntriesToMerge,
    repositoryAllowlist: graphReconciled.data.approvedRepositories,
    metrics,
    diagnostics,
    digest: nodeContentDigestPort,
    createCompleteSnapshot: () => completeSnapshot,
    assertPublicSafety: (snapshot, values) => {
      assertStatePublicSafety({
        snapshot,
        repositoryInventory: graphReconciled.data.approvedRepositories,
        repositoryAllowlist: graphReconciled.data.approvedRepositories,
        additionalValues: values.slice(1),
        knownSecrets: configuration.credentials.knownSecrets,
      });
      sessions.assertPublicBoundary(invocation.runId, values);
    },
  });
}
