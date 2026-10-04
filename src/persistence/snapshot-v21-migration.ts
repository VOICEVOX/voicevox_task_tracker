import { z } from "zod";

import type { AiCacheKey } from "../codex/cache.js";
import {
  AI_ANALYSIS_DEPENDENCY_ELEMENTS,
  type AiAnalysisDependency,
  type TrackedItemAiDependencies,
} from "../domain/ai-analysis-dependencies.js";
import {
  AI_ANALYSIS_ELEMENTS,
  aiAnalysisElementApplicationsSchema,
} from "../domain/ai-analysis-elements.js";
import type { LegacyAiCacheEntry } from "./ai-cache-migration.js";
import { StateFormatError } from "./errors.js";
import { migrateVersion19FinalGraphProjection } from "./snapshot-final-graph-migration.js";
import { migrateStateSnapshot as migrateVersion20Snapshot } from "./snapshot-v20-migration.js";
import type { StateSnapshot as StateSnapshotVersion20 } from "./snapshot-v20-contracts.js";
import { version19SnapshotFields } from "./snapshot-v20.js";
import {
  collectLegacyProofsForMigration,
  type LegacyProofKeys,
} from "./snapshot-v21-legacy-proof.js";
import { migratePersonalReminderSubjectChanges } from "./snapshot-v21-personal-reminder-migration.js";
import { createStateSnapshot, parseStateSnapshot, type StateSnapshot } from "./snapshot-v21.js";

const snapshotVersionSchema = z.object({ schemaVersion: z.string() });

type LegacyAiMigrationContext = Readonly<{
  legacyElementKeys: ReadonlySet<string>;
  remainingCurrentElementKeys: ReadonlySet<string>;
}>;

function migrateAiDependency(
  dependency: AiAnalysisDependency,
  context: LegacyAiMigrationContext,
): AiAnalysisDependency {
  if (dependency.status === "unknown" && dependency.reasons.includes("proof_unknown")) {
    const producers = dependency.producers;
    const candidates = producers?.filter((producer) => producer.kind === "relation_candidate");
    if (
      producers != null &&
      candidates != null &&
      candidates.length !== 0 &&
      candidates.some((candidate) =>
        context.legacyElementKeys.has(
          JSON.stringify([candidate.producer.nodeId, candidate.producer.element]),
        ),
      ) &&
      candidates.every(
        (candidate) =>
          !context.remainingCurrentElementKeys.has(
            JSON.stringify([candidate.producer.nodeId, candidate.producer.element]),
          ),
      )
    ) {
      const reasons = dependency.reasons.filter((reason) => reason !== "proof_unknown");
      const first = reasons[0];
      if (first == null) {
        return Object.freeze({ status: "unverified", producers });
      }
      const retainedReasons: Extract<AiAnalysisDependency, { status: "unknown" }>["reasons"] = [
        first,
        ...reasons.slice(1),
      ];
      return Object.freeze({
        status: "unknown",
        reasons: Object.freeze(retainedReasons),
        producers,
      });
    }
  }
  if (
    dependency.status !== "current" ||
    !dependency.producers.some((producer) => {
      const owner = producer.kind === "item_element" ? producer : producer.producer;
      return context.legacyElementKeys.has(JSON.stringify([owner.nodeId, owner.element]));
    })
  ) {
    return dependency;
  }
  return Object.freeze({ status: "unverified", producers: dependency.producers });
}

function migrateItemAiDependencies(
  dependencies: TrackedItemAiDependencies,
  context: LegacyAiMigrationContext,
): TrackedItemAiDependencies {
  const migrate = (
    element: (typeof AI_ANALYSIS_DEPENDENCY_ELEMENTS)[number],
  ): AiAnalysisDependency => migrateAiDependency(dependencies[element], context);
  return Object.freeze({
    status: migrate("status"),
    waitingOn: migrate("waitingOn"),
    nextAction: migrate("nextAction"),
    primaryWaitingOn: migrate("primaryWaitingOn"),
    confidence: migrate("confidence"),
    evidence: migrate("evidence"),
    uncertainties: migrate("uncertainties"),
    deadline: migrate("deadline"),
    deadlineLevel: migrate("deadlineLevel"),
    lastProgressAt: migrate("lastProgressAt"),
    stallSince: migrate("stallSince"),
    severity: migrate("severity"),
    downstreamImpact: migrate("downstreamImpact"),
    importance: migrate("importance"),
    attention: migrate("attention"),
    blockers: migrate("blockers"),
    relationSet: migrate("relationSet"),
  });
}

function migrateLegacyCurrentAi(
  snapshot: StateSnapshotVersion20,
  keys: LegacyProofKeys,
): StateSnapshotVersion20 {
  const legacyElementKeys = keys.tracked;
  const remainingCurrentElementKeys = new Set<string>();
  for (const item of snapshot.items) {
    for (const element of AI_ANALYSIS_ELEMENTS) {
      const key = JSON.stringify([item.nodeId, element]);
      if (
        item.aiAnalysis.applications[element].status === "current_ai" &&
        !legacyElementKeys.has(key)
      ) {
        remainingCurrentElementKeys.add(key);
      }
    }
  }
  const context = { legacyElementKeys, remainingCurrentElementKeys };
  if (legacyElementKeys.size === 0 && keys.collection.size === 0) {
    return snapshot;
  }
  return {
    ...snapshot,
    items: snapshot.items.map((item) => ({
      ...item,
      aiAnalysis: retainedLegacyCurrentAi(item.aiAnalysis, item.nodeId, keys.tracked),
      aiDependencies: migrateItemAiDependencies(item.aiDependencies, context),
      personalReminderCauses: item.personalReminderCauses.map((cause) => ({
        ...cause,
        aiDependencies: {
          presence: migrateAiDependency(cause.aiDependencies.presence, context),
          responseMembership: migrateAiDependency(cause.aiDependencies.responseMembership, context),
          responsible: migrateAiDependency(cause.aiDependencies.responsible, context),
          action: migrateAiDependency(cause.aiDependencies.action, context),
          evidence: migrateAiDependency(cause.aiDependencies.evidence, context),
        },
        currentInput: {
          ...cause.currentInput,
          aiDependency: migrateAiDependency(cause.currentInput.aiDependency, context),
        },
      })),
      personalReminderCausePlanning:
        item.personalReminderCausePlanning.status === "completed"
          ? {
              ...item.personalReminderCausePlanning,
              causeSetAiDependency: migrateAiDependency(
                item.personalReminderCausePlanning.causeSetAiDependency,
                context,
              ),
            }
          : item.personalReminderCausePlanning,
    })),
    collection: {
      repositories: snapshot.collection.repositories.map((repository) => ({
        ...repository,
        items: repository.items.map((item) => ({
          ...item,
          aiAnalysis: retainedLegacyCurrentAi(item.aiAnalysis, item.nodeId, keys.collection),
        })),
      })),
    },
    relations: snapshot.relations.map((relation) => ({
      ...relation,
      aiDependency: migrateAiDependency(relation.aiDependency, context),
    })),
  };
}

function retainedLegacyCurrentAi(
  analysis: StateSnapshotVersion20["items"][number]["aiAnalysis"],
  nodeId: string,
  keys: ReadonlySet<string>,
): StateSnapshotVersion20["items"][number]["aiAnalysis"] {
  const applications = aiAnalysisElementApplicationsSchema.parse(
    Object.fromEntries(
      AI_ANALYSIS_ELEMENTS.map((element) => [
        element,
        keys.has(JSON.stringify([nodeId, element]))
          ? { status: "retained_ai", reason: "proof_unknown" }
          : analysis.applications[element],
      ]),
    ),
  );
  return { ...analysis, applications };
}

function currentAiAnalysis(
  analysis: StateSnapshotVersion20["items"][number]["aiAnalysis"],
): unknown {
  const current: Record<string, unknown> = {};
  const retained: Record<string, unknown> = {};
  for (const element of AI_ANALYSIS_ELEMENTS) {
    const adopted = analysis.adoptedElements[element];
    if (adopted == null) {
      continue;
    }
    if (analysis.applications[element].status === "current_ai") {
      current[element] = adopted;
    } else {
      retained[element] = adopted;
    }
  }
  return {
    ...analysis,
    adoptedElements: current,
    retainedElements: retained,
  };
}

/** 旧世代snapshotのAI採用値を現在値と履歴へ分離する。 */
export function migrateStateSnapshot(
  source: string,
  legacyEntriesByCacheKey: ReadonlyMap<AiCacheKey, LegacyAiCacheEntry>,
  timezone: string,
): StateSnapshot {
  let value: unknown;
  try {
    const parseJson: (text: string) => unknown = JSON.parse;
    value = parseJson(source);
  } catch (error: unknown) {
    throw new StateFormatError("snapshot", { cause: error });
  }
  const version = snapshotVersionSchema.safeParse(value);
  if (!version.success) {
    throw StateFormatError.fromZodError("snapshot", version.error);
  }
  if (version.data.schemaVersion === "21") {
    return parseStateSnapshot(source);
  }
  const legacy =
    version.data.schemaVersion === "19" || version.data.schemaVersion === "20"
      ? collectLegacyProofsForMigration(value, version.data.schemaVersion)
      : null;
  const previous = migrateVersion20Snapshot(source, legacyEntriesByCacheKey, timezone);
  const migrated = legacy == null ? previous : migrateLegacyCurrentAi(previous, legacy);
  const current =
    migrated === previous
      ? previous
      : migrateVersion19FinalGraphProjection(
          version19SnapshotFields(migratePersonalReminderSubjectChanges(migrated)),
          previous.finalGraphProjection.timezone,
        );
  return createStateSnapshot({
    ...current,
    schemaVersion: "21",
    items: current.items.map((item) => ({
      ...item,
      aiAnalysis: currentAiAnalysis(item.aiAnalysis),
    })),
    collection: {
      repositories: current.collection.repositories.map((repository) => ({
        ...repository,
        items: repository.items.map((item) => ({
          ...item,
          aiAnalysis: currentAiAnalysis(item.aiAnalysis),
        })),
      })),
    },
  });
}
