import type { GenericAiAdoptedRun } from "./generic-ai-adoption.js";
import type { GraphReconciledRun } from "./graph-reconciliation.js";
import type { PersonalReminderFinalizedRun } from "./personal-reminder-finalization.js";
import { RunCompletenessError } from "./run-completeness-error.js";
import {
  assertRunValueMatches,
  assertRunValuesMatch,
  runValuesById,
} from "./run-validation-compare.js";

/** 汎用AI、graph、個人催促の確定値と共有ledgerの連続性を照合する。 */
export function assertRunStageLineage(
  adopted: GenericAiAdoptedRun,
  graph: GraphReconciledRun,
  finalized: PersonalReminderFinalizedRun,
): void {
  assertRunValueMatches(adopted.core.identity, graph.core.identity, ["core", "identity"], "run");
  assertRunValueMatches(graph.core.identity, finalized.core.identity, ["core", "identity"], "run");
  assertRunValueMatches(
    adopted.core.personalReminderInput.previousBaseSnapshot,
    graph.core.personalReminderInput.previousBaseSnapshot,
    ["core", "personalReminderInput", "previousBaseSnapshot"],
    "run",
  );
  assertRunValueMatches(
    adopted.core.personalReminderInput.previousAiSnapshot,
    graph.core.personalReminderInput.previousAiSnapshot,
    ["core", "personalReminderInput", "previousAiSnapshot"],
    "run",
  );
  assertRunValueMatches(
    adopted.core.executionPolicy,
    finalized.core.executionPolicy,
    ["core", "executionPolicy"],
    "run",
  );
  assertRunValueMatches(
    adopted.core.baseRevision,
    finalized.core.baseRevision,
    ["core", "baseRevision"],
    "run",
  );
  assertRunValueMatches(
    adopted.core.configDigest,
    finalized.core.configDigest,
    ["core", "configDigest"],
    "run",
  );
  assertRunValueMatches(
    adopted.data.allowlistDigest,
    finalized.data.allowlistDigest,
    ["allowlistDigest"],
    "run",
  );
  assertRunValuesMatch(
    adopted.data.approvedRepositories,
    finalized.data.approvedRepositories,
    (repository) => repository.id,
    (repository) => repository.id,
    ["approvedRepositories"],
  );
  assertRunValuesMatch(
    adopted.data.items,
    graph.data.aiItems,
    (item) => item.nodeId,
    (item) => item.nodeId,
    ["aiItems"],
  );
  assertRunValueMatches(adopted.data.facts, graph.data.facts, ["facts"], "run");
  assertRunValuesMatch(
    graph.data.aiItems,
    finalized.data.aiItems,
    (item) => item.nodeId,
    (item) => item.nodeId,
    ["aiItems"],
  );
  assertRunValueMatches(graph.data.graph, finalized.data.graph, ["graph"], "graph");
  assertRunValueMatches(
    graph.data.finalGraphProjection,
    finalized.data.finalGraphProjection,
    ["finalGraphProjection"],
    "graph",
  );
  assertRunValueMatches(
    graph.data.snapshotProjection,
    finalized.data.snapshotProjection,
    ["snapshotProjection"],
    "run",
  );
  const finalItems = runValuesById(finalized.data.items, (entry) => entry.item.nodeId, ["items"]);
  for (const item of graph.data.finalItems) {
    const actual = finalItems.get(item.nodeId);
    if (actual == null) {
      throw new RunCompletenessError("missing_value", item.nodeId, ["items"], undefined);
    }
    const { personalReminderCauses, personalReminderCausePlanning, ...expected } = item;
    void personalReminderCauses;
    void personalReminderCausePlanning;
    assertRunValueMatches(expected, actual.item, ["items", item.nodeId, "item"], item.nodeId);
  }
  if (graph.data.finalItems.length !== finalItems.size) {
    throw new RunCompletenessError("missing_value", "items", ["items"], undefined);
  }
  if (
    adopted.core.aiBudget.ledgerId !== graph.core.aiBudget.ledgerId ||
    graph.core.aiBudget.ledgerId !== finalized.core.aiBudget.ledgerId ||
    adopted.core.aiBudget.sequence > graph.core.aiBudget.sequence ||
    graph.core.aiBudget.sequence > finalized.core.aiBudget.sequence
  ) {
    throw new RunCompletenessError("ledger_mismatch", "aiBudget", ["core", "aiBudget"], undefined);
  }
  assertRunValueMatches(
    adopted.core.aiBudget.events,
    graph.core.aiBudget.events.slice(0, adopted.core.aiBudget.events.length),
    ["core", "aiBudget", "events"],
    "aiBudget",
  );
  assertRunValueMatches(
    graph.core.aiBudget.events,
    finalized.core.aiBudget.events.slice(0, graph.core.aiBudget.events.length),
    ["core", "aiBudget", "events"],
    "aiBudget",
  );
}
