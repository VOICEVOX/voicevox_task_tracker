import { type AiCacheKey } from "../codex/cache.js";
import {
  createGitHubNodeId,
  parseSourceId,
  type AiAnalysisDependency,
  type GitHubNodeId,
  type TrackedItemInputEvent,
} from "../domain/index.js";
import { buildPullRequestCommitSourceId } from "../github/production-source-id.js";
import { type LegacyAiCacheEntry } from "./ai-cache-migration.js";
import type {
  LegacyAiAnalysisDependencyVersion18,
  SnapshotAnalysisPlanFingerprint,
  StateSnapshot,
} from "./snapshot-contracts.js";
import { migrateTrackedItem } from "./snapshot-migration-adoption.js";
import { migrateAiAnalysis, migrationFormatError } from "./snapshot-migration-ai-elements.js";
import {
  createLegacyGraphMigration,
  migratedAiAnalysisElementApplications,
  migrateLegacyRelations,
  migrateTrackedItemAiStateForNativeBlocker,
} from "./snapshot-migration-relations.js";
import {
  createLegacyRelationsById,
  migratedPersonalReminderCausePlanning,
  migratePersonalReminderCausePlanning,
  migratePersonalReminderCauses,
  migrationCollectionAiAnalysis,
} from "./snapshot-migration-reminders.js";
import { legacySnapshotSchema, parseJson } from "./snapshot-migration-schema.js";
import {
  createStateSnapshot,
  parseStateSnapshotVersion11,
  parseStateSnapshotVersion12,
  parseStateSnapshotVersion13,
  parseStateSnapshotVersion14,
  parseStateSnapshotVersion15,
  parseStateSnapshotVersion16,
  parseStateSnapshotVersion17,
  parseStateSnapshotVersion18,
} from "./snapshot.js";

export function migrateVersion11StateSnapshot(source: string): StateSnapshot {
  try {
    const value = parseStateSnapshotVersion11(source);
    const graphMigration = createLegacyGraphMigration(
      value.relations,
      value.items,
      value.externalReferences,
    );
    return createStateSnapshot({
      ...value,
      schemaVersion: "19",
      graphNodeStateObservations: [],
      collection: {
        repositories: value.collection.repositories.map((repository) => ({
          ...repository,
          items: repository.items.map((item) => ({
            ...item,
            aiAnalysis: migrateAiAnalysis(item.aiAnalysis, false, "5"),
          })),
        })),
      },
      items: value.items.map((item) => {
        const aiAnalysis = migrateAiAnalysis(item.aiAnalysis, false, "5");
        const aiState = migrateTrackedItemAiStateForNativeBlocker(
          item.nodeId,
          aiAnalysis.applications,
          graphMigration.nativeOpenBlockerTargetNodeIds,
        );
        return {
          ...item,
          aiAnalysis: {
            ...aiAnalysis,
            applications: aiState.applications,
          },
          aiDependencies: aiState.aiDependencies,
          personalReminderCauses: [],
          personalReminderCausePlanning: migratedPersonalReminderCausePlanning(item.status),
        };
      }),
      relations: graphMigration.relations,
    });
  } catch (error: unknown) {
    throw migrationFormatError(error);
  }
}

export function migrateVersion12StateSnapshot(source: string): StateSnapshot {
  try {
    const value = parseStateSnapshotVersion12(source);
    const graphMigration = createLegacyGraphMigration(
      value.relations,
      value.items,
      value.externalReferences,
    );
    return createStateSnapshot({
      ...value,
      schemaVersion: "19",
      graphNodeStateObservations: [],
      collection: {
        repositories: value.collection.repositories.map((repository) => ({
          ...repository,
          items: repository.items.map((item) => ({
            ...item,
            aiAnalysis: migrateAiAnalysis(item.aiAnalysis, false, "5"),
          })),
        })),
      },
      items: value.items.map((item) => {
        const aiAnalysis = migrateAiAnalysis(item.aiAnalysis, false, "5");
        const aiState = migrateTrackedItemAiStateForNativeBlocker(
          item.nodeId,
          aiAnalysis.applications,
          graphMigration.nativeOpenBlockerTargetNodeIds,
        );
        return {
          ...item,
          aiAnalysis: {
            ...aiAnalysis,
            applications: aiState.applications,
          },
          aiDependencies: aiState.aiDependencies,
          personalReminderCauses: [],
          personalReminderCausePlanning: migratedPersonalReminderCausePlanning(item.status),
        };
      }),
      relations: graphMigration.relations,
    });
  } catch (error: unknown) {
    throw migrationFormatError(error);
  }
}

export function migrateVersion13StateSnapshot(source: string): StateSnapshot {
  try {
    const value = parseStateSnapshotVersion13(source);
    const graphMigration = createLegacyGraphMigration(
      value.relations,
      value.items,
      value.externalReferences,
    );
    return createStateSnapshot({
      ...value,
      schemaVersion: "19",
      graphNodeStateObservations: [],
      collection: {
        repositories: value.collection.repositories.map((repository) => ({
          ...repository,
          items: repository.items.map((item) => ({
            ...item,
            aiAnalysis: migrateAiAnalysis(item.aiAnalysis, true, "6"),
          })),
        })),
      },
      items: value.items.map((item) => {
        const aiAnalysis = migrateAiAnalysis(item.aiAnalysis, true, "6");
        const aiState = migrateTrackedItemAiStateForNativeBlocker(
          item.nodeId,
          aiAnalysis.applications,
          graphMigration.nativeOpenBlockerTargetNodeIds,
        );
        return {
          ...item,
          aiAnalysis: {
            ...aiAnalysis,
            applications: aiState.applications,
          },
          aiDependencies: aiState.aiDependencies,
          personalReminderCauses: [],
          personalReminderCausePlanning: migratedPersonalReminderCausePlanning(item.status),
        };
      }),
      relations: graphMigration.relations,
    });
  } catch (error: unknown) {
    throw migrationFormatError(error);
  }
}

export function migrateLegacyStateSnapshot(
  source: string,
  legacyEntriesByCacheKey: ReadonlyMap<AiCacheKey, LegacyAiCacheEntry>,
): StateSnapshot {
  try {
    const value = legacySnapshotSchema.parse(parseJson(source));
    const legacyRelationsById = createLegacyRelationsById(value.relations);
    const migratedItems = value.items.map((item) =>
      migrateTrackedItem(item, legacyEntriesByCacheKey, legacyRelationsById),
    );
    const collectionRepositories = value.collection.repositories.map((repository) => ({
      repositoryId: repository.repositoryId,
      successfulAt: repository.successfulAt,
      items: repository.items.map((item) => {
        return {
          freshness: item.freshness,
          nodeId: item.nodeId,
          repositoryId: item.repositoryId,
          itemFingerprint: item.itemFingerprint,
          analysisPlanFingerprint: {
            status: "unplanned",
            reason: "migration",
          } satisfies SnapshotAnalysisPlanFingerprint,
          aiAnalysis: migrationCollectionAiAnalysis(),
          observedAt: item.observedAt,
          state: item.state,
          terminalAt: item.terminalAt,
        };
      }),
    }));
    return createStateSnapshot({
      schemaVersion: "19",
      generatedAt: value.generatedAt,
      trackingStartAt: value.trackingStartAt,
      ai: value.ai,
      collection: {
        repositories: collectionRepositories,
      },
      repositories: value.repositories,
      items: migratedItems,
      graphNodeStateObservations: [],
      externalReferences: value.externalReferences,
      relations: migrateLegacyRelations(value.relations, value.items, value.externalReferences),
      run: value.run,
    });
  } catch (error: unknown) {
    throw migrationFormatError(error);
  }
}

export function migrateVersion16StateSnapshot(source: string): StateSnapshot {
  try {
    const value = parseStateSnapshotVersion16(source);
    const graphMigration = createLegacyGraphMigration(
      value.relations,
      value.items,
      value.externalReferences,
    );
    return createStateSnapshot({
      ...value,
      schemaVersion: "19",
      graphNodeStateObservations: [],
      collection: {
        repositories: value.collection.repositories.map((repository) => ({
          ...repository,
          items: repository.items.map((item) => ({
            ...item,
            aiAnalysis: {
              ...item.aiAnalysis,
              applications: migratedAiAnalysisElementApplications(),
            },
          })),
        })),
      },
      items: value.items.map((item) => {
        const applications = migratedAiAnalysisElementApplications();
        const aiState = migrateTrackedItemAiStateForNativeBlocker(
          item.nodeId,
          applications,
          graphMigration.nativeOpenBlockerTargetNodeIds,
        );
        return {
          ...item,
          aiAnalysis: {
            ...item.aiAnalysis,
            applications: aiState.applications,
          },
          aiDependencies: aiState.aiDependencies,
          personalReminderCauses: migratePersonalReminderCauses(item.personalReminderCauses),
          personalReminderCausePlanning: migratePersonalReminderCausePlanning(
            item.personalReminderCausePlanning,
          ),
        };
      }),
      relations: graphMigration.relations,
    });
  } catch (error: unknown) {
    throw migrationFormatError(error);
  }
}

export function migrateVersion17StateSnapshot(source: string): StateSnapshot {
  try {
    const value = parseStateSnapshotVersion17(source);
    const graphMigration = createLegacyGraphMigration(
      value.relations,
      value.items,
      value.externalReferences,
    );
    return createStateSnapshot({
      ...value,
      schemaVersion: "19",
      graphNodeStateObservations: [],
      items: value.items.map((item) => {
        const aiState = migrateTrackedItemAiStateForNativeBlocker(
          item.nodeId,
          item.aiAnalysis.applications,
          graphMigration.nativeOpenBlockerTargetNodeIds,
        );
        return {
          ...item,
          aiAnalysis: {
            ...item.aiAnalysis,
            applications: aiState.applications,
          },
          aiDependencies: aiState.aiDependencies,
          personalReminderCauses: migratePersonalReminderCauses(item.personalReminderCauses),
          personalReminderCausePlanning: migratePersonalReminderCausePlanning(
            item.personalReminderCausePlanning,
          ),
        };
      }),
      relations: graphMigration.relations,
    });
  } catch (error: unknown) {
    throw migrationFormatError(error);
  }
}

export function migrateVersion14StateSnapshot(source: string): StateSnapshot {
  try {
    const value = parseStateSnapshotVersion14(source);
    const graphMigration = createLegacyGraphMigration(
      value.relations,
      value.items,
      value.externalReferences,
    );
    return createStateSnapshot({
      ...value,
      schemaVersion: "19",
      graphNodeStateObservations: [],
      collection: {
        repositories: value.collection.repositories.map((repository) => ({
          ...repository,
          items: repository.items.map((item) => ({
            ...item,
            aiAnalysis: {
              ...item.aiAnalysis,
              applications: migratedAiAnalysisElementApplications(),
            },
          })),
        })),
      },
      items: value.items.map((item) => {
        const applications = migratedAiAnalysisElementApplications();
        const aiState = migrateTrackedItemAiStateForNativeBlocker(
          item.nodeId,
          applications,
          graphMigration.nativeOpenBlockerTargetNodeIds,
        );
        return {
          ...item,
          inputEvents:
            item.type === "pull_request"
              ? migrateVersion14PullRequestInputEvents(item.nodeId, item.inputEvents)
              : item.inputEvents,
          aiAnalysis: {
            ...item.aiAnalysis,
            applications: aiState.applications,
          },
          personalReminderCauses: [],
          personalReminderCausePlanning: migratedPersonalReminderCausePlanning(item.status),
          aiDependencies: aiState.aiDependencies,
        };
      }),
      relations: graphMigration.relations,
    });
  } catch (error: unknown) {
    throw migrationFormatError(error);
  }
}

export function migrateVersion15StateSnapshot(source: string): StateSnapshot {
  try {
    const value = parseStateSnapshotVersion15(source);
    const graphMigration = createLegacyGraphMigration(
      value.relations,
      value.items,
      value.externalReferences,
    );
    return createStateSnapshot({
      ...value,
      schemaVersion: "19",
      graphNodeStateObservations: [],
      collection: {
        repositories: value.collection.repositories.map((repository) => ({
          ...repository,
          items: repository.items.map((item) => ({
            ...item,
            aiAnalysis: {
              ...item.aiAnalysis,
              applications: migratedAiAnalysisElementApplications(),
            },
          })),
        })),
      },
      items: value.items.map((item) => {
        const applications = migratedAiAnalysisElementApplications();
        const aiState = migrateTrackedItemAiStateForNativeBlocker(
          item.nodeId,
          applications,
          graphMigration.nativeOpenBlockerTargetNodeIds,
        );
        return {
          ...item,
          aiAnalysis: {
            ...item.aiAnalysis,
            applications: aiState.applications,
          },
          aiDependencies: aiState.aiDependencies,
          personalReminderCauses: migratePersonalReminderCauses(item.personalReminderCauses),
          personalReminderCausePlanning: migratePersonalReminderCausePlanning(
            item.personalReminderCausePlanning,
          ),
        };
      }),
      relations: graphMigration.relations,
    });
  } catch (error: unknown) {
    throw migrationFormatError(error);
  }
}

function migrateVersion14PullRequestInputEvents(
  pullRequestNodeId: GitHubNodeId,
  inputEvents: readonly TrackedItemInputEvent[],
): readonly TrackedItemInputEvent[] {
  return inputEvents.map((event) => {
    const source = parseSourceId(event.sourceId);
    if (source.kind !== "github_commit") {
      return event;
    }
    return {
      ...event,
      sourceId: buildPullRequestCommitSourceId(
        pullRequestNodeId,
        createGitHubNodeId(source.originalId),
      ),
    };
  });
}

function migrateVersion18AiAnalysisDependency(
  dependency: LegacyAiAnalysisDependencyVersion18,
): AiAnalysisDependency {
  if (dependency.status !== "unknown") {
    return dependency;
  }
  return Object.freeze({
    status: dependency.status,
    reasons: Object.freeze([dependency.reason]),
    ...(dependency.producers == null ? {} : { producers: dependency.producers }),
  } satisfies AiAnalysisDependency);
}

export function migrateVersion18StateSnapshot(source: string): StateSnapshot {
  try {
    const snapshot = parseStateSnapshotVersion18(source);
    return createStateSnapshot({
      ...snapshot,
      schemaVersion: "19",
      items: snapshot.items.map((item) => ({
        ...item,
        aiDependencies: Object.fromEntries(
          Object.entries(item.aiDependencies).map(([element, dependency]) => [
            element,
            migrateVersion18AiAnalysisDependency(dependency),
          ]),
        ),
        personalReminderCauses: item.personalReminderCauses.map((cause) => ({
          ...cause,
          aiDependencies: Object.fromEntries(
            Object.entries(cause.aiDependencies).map(([element, dependency]) => [
              element,
              migrateVersion18AiAnalysisDependency(dependency),
            ]),
          ),
          currentInput: {
            ...cause.currentInput,
            aiDependency: migrateVersion18AiAnalysisDependency(cause.currentInput.aiDependency),
          },
        })),
        personalReminderCausePlanning:
          item.personalReminderCausePlanning.status === "completed"
            ? {
                ...item.personalReminderCausePlanning,
                causeSetAiDependency: migrateVersion18AiAnalysisDependency(
                  item.personalReminderCausePlanning.causeSetAiDependency,
                ),
              }
            : item.personalReminderCausePlanning,
      })),
      relations: snapshot.relations.map((relation) => ({
        ...relation,
        aiDependency: migrateVersion18AiAnalysisDependency(relation.aiDependency),
      })),
    });
  } catch (error: unknown) {
    throw migrationFormatError(error);
  }
}
