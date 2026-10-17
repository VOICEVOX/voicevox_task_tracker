import { normalizeAiAnalysisDependency } from "../domain/ai-analysis-dependencies.js";
import {
  personalReminderCauseAiDependenciesSchema,
  personalReminderCausePlanningSchema,
  personalReminderCauseSchema,
  type Actor,
  type GitHubAccountActor,
  type PersonalReminderCause,
  type PersonalReminderCausePlanning,
} from "../domain/index.js";
import { aiAnalysisElementApplicationsSchema } from "../domain/ai-analysis-elements.js";
import { normalizeTrackedItemInputEvents } from "../domain/tracked-item-input-events.js";
import { type TrackedItemAiAnalysis, type TrackedItemAiDependencies } from "../domain/index.js";
import type { StateSnapshot } from "./snapshot-contracts.js";
import { compareStrings } from "./snapshot-values.js";

export function normalizeSnapshot(snapshot: StateSnapshot): StateSnapshot {
  return Object.freeze({
    ...snapshot,
    trackingStartAt: Object.freeze({
      ...snapshot.trackingStartAt,
    }),
    ai: Object.freeze({
      ...snapshot.ai,
    }),
    collection: Object.freeze({
      repositories: Object.freeze(
        [...snapshot.collection.repositories]
          .sort((left, right) => compareStrings(left.repositoryId, right.repositoryId))
          .map((repository) =>
            Object.freeze({
              ...repository,
              items: Object.freeze(
                [...repository.items]
                  .sort((left, right) => compareStrings(left.nodeId, right.nodeId))
                  .map((item) =>
                    Object.freeze({
                      ...item,
                      aiAnalysis: normalizeTrackedItemAiAnalysis(item.aiAnalysis),
                    }),
                  ),
              ),
            }),
          ),
      ),
    }),
    repositories: Object.freeze(
      [...snapshot.repositories].sort((left, right) => compareStrings(left.id, right.id)),
    ),
    items: Object.freeze(
      [...snapshot.items]
        .sort((left, right) => compareStrings(left.nodeId, right.nodeId))
        .map((item) =>
          Object.freeze({
            ...item,
            aiDependencies: normalizeTrackedItemAiDependencies(item.aiDependencies),
            importance: Object.freeze({
              ...item.importance,
              factors: Object.freeze(
                item.importance.factors.map((factor) =>
                  Object.freeze({
                    ...factor,
                  }),
                ),
              ),
            }),
            attention: Object.freeze({
              ...item.attention,
            }),
            importanceAssessment:
              item.importanceAssessment.status === "not_available"
                ? Object.freeze({
                    status: "not_available",
                  })
                : Object.freeze({
                    status: "available",
                    value: Object.freeze({
                      ...item.importanceAssessment.value,
                    }),
                  }),
            deadlineAssessment:
              item.deadlineAssessment.status === "not_available"
                ? Object.freeze({
                    status: "not_available",
                  })
                : Object.freeze({
                    status: "available",
                    value: Object.freeze({
                      ...item.deadlineAssessment.value,
                    }),
                  }),
            author:
              item.author.status === "unavailable"
                ? Object.freeze({ ...item.author })
                : Object.freeze({
                    ...item.author,
                    actor: normalizeAccountActor(item.author.actor),
                  }),
            latestEventActor:
              item.latestEventActor.status === "absent"
                ? Object.freeze({ ...item.latestEventActor })
                : Object.freeze({
                    ...item.latestEventActor,
                    actor: normalizeActor(item.latestEventActor.actor),
                  }),
            personalReminderCauses: Object.freeze(
              [...item.personalReminderCauses]
                .sort((left, right) => compareStrings(left.causeId, right.causeId))
                .map(normalizePersonalReminderCause),
            ),
            personalReminderCausePlanning: normalizePersonalReminderCausePlanning(
              item.personalReminderCausePlanning,
            ),
            aiAnalysis: normalizeTrackedItemAiAnalysis(item.aiAnalysis),
            inputEvents: normalizeTrackedItemInputEvents(item.inputEvents),
            severityContext: Object.freeze({
              ...item.severityContext,
            }),
          }),
        ),
    ),
    graphNodeStateObservations: Object.freeze(
      [...snapshot.graphNodeStateObservations]
        .sort((left, right) => compareStrings(left.nodeId, right.nodeId))
        .map((observation) => Object.freeze({ ...observation })),
    ),
    externalReferences: Object.freeze(
      [...snapshot.externalReferences].sort((left, right) =>
        compareStrings(left.nodeId, right.nodeId),
      ),
    ),
    relations: Object.freeze(
      [...snapshot.relations]
        .sort((left, right) => compareStrings(left.id, right.id))
        .map((relation) =>
          Object.freeze({
            ...relation,
            aiDependency: normalizeAiAnalysisDependency(relation.aiDependency),
          }),
        ),
    ),
    run: Object.freeze({
      ...snapshot.run,
    }),
  });
}

function normalizeTrackedItemAiAnalysis(aiAnalysis: TrackedItemAiAnalysis): TrackedItemAiAnalysis {
  const applications = Object.freeze(
    aiAnalysisElementApplicationsSchema.parse(aiAnalysis.applications),
  );
  if (aiAnalysis.origin === "current") {
    return Object.freeze({
      ...aiAnalysis,
      elements: Object.freeze({
        ...aiAnalysis.elements,
      }),
      adoptedElements: Object.freeze({
        ...aiAnalysis.adoptedElements,
      }),
      applications,
    });
  }
  return Object.freeze({
    ...aiAnalysis,
    elements: Object.freeze({
      ...aiAnalysis.elements,
    }),
    adoptedElements: Object.freeze({
      ...aiAnalysis.adoptedElements,
    }),
    applications,
  });
}

function normalizeTrackedItemAiDependencies(
  dependencies: TrackedItemAiDependencies,
): TrackedItemAiDependencies {
  return Object.freeze({
    status: normalizeAiAnalysisDependency(dependencies.status),
    waitingOn: normalizeAiAnalysisDependency(dependencies.waitingOn),
    nextAction: normalizeAiAnalysisDependency(dependencies.nextAction),
    primaryWaitingOn: normalizeAiAnalysisDependency(dependencies.primaryWaitingOn),
    confidence: normalizeAiAnalysisDependency(dependencies.confidence),
    evidence: normalizeAiAnalysisDependency(dependencies.evidence),
    uncertainties: normalizeAiAnalysisDependency(dependencies.uncertainties),
    deadline: normalizeAiAnalysisDependency(dependencies.deadline),
    deadlineLevel: normalizeAiAnalysisDependency(dependencies.deadlineLevel),
    lastProgressAt: normalizeAiAnalysisDependency(dependencies.lastProgressAt),
    stallSince: normalizeAiAnalysisDependency(dependencies.stallSince),
    severity: normalizeAiAnalysisDependency(dependencies.severity),
    downstreamImpact: normalizeAiAnalysisDependency(dependencies.downstreamImpact),
    importance: normalizeAiAnalysisDependency(dependencies.importance),
    attention: normalizeAiAnalysisDependency(dependencies.attention),
    blockers: normalizeAiAnalysisDependency(dependencies.blockers),
    relationSet: normalizeAiAnalysisDependency(dependencies.relationSet),
  });
}

export function normalizeActor(actor: Actor): Actor {
  if (actor.type === "system") {
    return Object.freeze({
      type: actor.type,
      name: actor.name,
    });
  }
  return Object.freeze({
    type: actor.type,
    nodeId: actor.nodeId,
    login: actor.login,
  });
}

export function normalizePersonalReminderCause(
  cause: PersonalReminderCause,
): PersonalReminderCause {
  return personalReminderCauseSchema.parse({
    ...cause,
    aiDependencies: personalReminderCauseAiDependenciesSchema.parse({
      presence: normalizeAiAnalysisDependency(cause.aiDependencies.presence),
      responseMembership: normalizeAiAnalysisDependency(cause.aiDependencies.responseMembership),
      responsible: normalizeAiAnalysisDependency(cause.aiDependencies.responsible),
      action: normalizeAiAnalysisDependency(cause.aiDependencies.action),
      evidence: normalizeAiAnalysisDependency(cause.aiDependencies.evidence),
    }),
    currentInput: {
      ...cause.currentInput,
      aiDependency: normalizeAiAnalysisDependency(cause.currentInput.aiDependency),
    },
  });
}

export function normalizePersonalReminderCausePlanning(
  planning: PersonalReminderCausePlanning,
): PersonalReminderCausePlanning {
  if (planning.status !== "completed") {
    return personalReminderCausePlanningSchema.parse(planning);
  }
  return personalReminderCausePlanningSchema.parse({
    ...planning,
    causeSetAiDependency: normalizeAiAnalysisDependency(planning.causeSetAiDependency),
  });
}

export function normalizeAccountActor(actor: GitHubAccountActor): GitHubAccountActor {
  return Object.freeze({
    type: actor.type,
    nodeId: actor.nodeId,
    login: actor.login,
  });
}
