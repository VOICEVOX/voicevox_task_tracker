import { hashCanonicalJson } from "../../../canonical-json/index.js";
import type {
  AiAnalysisRunResult,
  AiAnalysisTarget,
  AnalysisElementPlanning,
  AnalysisElementReuseRecord,
  CodexAnalysisReduction,
} from "../../../codex/index.js";
import {
  AI_ANALYSIS_ELEMENTS,
  createAiAnalysisMigrationElementResultSchema,
  type AiAnalysisElement,
  type AiAnalysisElementMigrationResult,
} from "../../../domain/ai-analysis-elements.js";
import type {
  TrackedItemAiAnalysisCurrentAdoptedElements,
  TrackedItemAiAnalysisMigrationAdoptedElement,
  TrackedItemAiAnalysisMigrationAdoptedElements,
  TrackedItemAiAnalysisMigrationElements,
} from "../../../domain/index.js";
import { UnreachableError } from "../../../util/index.js";
import type { DeterministicItemAnalysis } from "../../initial-item-analysis.js";
import { generatedElementsForNode } from "../ai-analysis-run-index.js";
import { isForcedUnexecutedElement } from "../ai-analysis-target.js";
import type { MutablePartial, RuntimeState } from "../contracts.js";
import {
  currentAdoptedGenerationForElement,
  unknownReuseProof,
} from "../previous-state/ai-reuse.js";
import {
  currentSavedResultForElement,
  savedMigrationAdoptedElementsForItem,
} from "../previous-state/saved-ai-elements.js";
import { codexElementResult, type ConsumerCodexElementOutput } from "./consumer-output.js";
import { forcedMigrationAdoptedElementForElement } from "./evaluation-records.js";

export function migratedElementsForAnalysis(
  state: RuntimeState,
  analysis: DeterministicItemAnalysis,
  planning: AnalysisElementPlanning,
  run: AiAnalysisRunResult | undefined,
  reduction: CodexAnalysisReduction | undefined,
  consumerOutput: ConsumerCodexElementOutput | undefined,
  target: AiAnalysisTarget | undefined,
): TrackedItemAiAnalysisMigrationElements {
  const saved = savedMigrationAdoptedElementsForItem(state, analysis.item.nodeId);
  const migrated: MutablePartial<TrackedItemAiAnalysisMigrationElements> = {};
  const generated = generatedElementsForNode(run, analysis.item.nodeId);
  for (const element of AI_ANALYSIS_ELEMENTS) {
    const savedResult = saved[element];
    if (savedResult?.origin !== "migration") {
      continue;
    }
    const candidate = planning.candidates[element];
    const preserveForcedUnexecutedElement =
      isForcedUnexecutedElement(analysis, element, target) && candidate.necessity === "required";
    if (candidate.necessity === "not_required") {
      continue;
    }
    const application = reduction?.ai.elements[element]?.application;
    const consumerResult =
      consumerOutput == null ? undefined : codexElementResult(consumerOutput, element);
    const generatedResult = generated[element];
    const generatedWasConsumed =
      generatedResult != null &&
      consumerResult != null &&
      hashCanonicalJson(consumerResult) === hashCanonicalJson(generatedResult.result);
    const stateElement =
      element === "status" || element === "waitingOn" || element === "nextAction";
    const generatedWasAccepted =
      application === "applied" || (!stateElement && generatedWasConsumed);
    if (generatedWasAccepted) {
      continue;
    }
    const currentAdopted = preserveForcedUnexecutedElement
      ? currentSavedResultForElement(state, analysis, element)
      : currentAdoptedGenerationForElement(
          state,
          analysis,
          element,
          candidate.inputFingerprint,
          candidate.savedReuse,
        );
    if (currentAdopted != null) {
      continue;
    }
    const forcedMigration = forcedMigrationAdoptedElementForElement(
      state,
      analysis,
      planning,
      element,
      target,
    );
    let result: AiAnalysisElementMigrationResult;
    if (forcedMigration != null) {
      result = createAiAnalysisMigrationElementResultSchema(element).parse(forcedMigration.result);
    } else {
      const savedReuse = planning.candidates[element].savedReuse;
      const migrationReuse =
        savedMigrationAdoptedElementsForItem(state, analysis.item.nodeId)[element]?.origin ===
        "migration"
          ? savedReuse
          : undefined;
      result = migrationReuse?.result ?? savedResult.result;
    }
    switch (element) {
      case "status":
        migrated.status = createAiAnalysisMigrationElementResultSchema("status").parse(result);
        break;
      case "waitingOn":
        migrated.waitingOn =
          createAiAnalysisMigrationElementResultSchema("waitingOn").parse(result);
        break;
      case "nextAction":
        migrated.nextAction =
          createAiAnalysisMigrationElementResultSchema("nextAction").parse(result);
        break;
      case "relations":
        migrated.relations =
          createAiAnalysisMigrationElementResultSchema("relations").parse(result);
        break;
      case "progress":
        migrated.progress = createAiAnalysisMigrationElementResultSchema("progress").parse(result);
        break;
      case "importance":
        migrated.importance =
          createAiAnalysisMigrationElementResultSchema("importance").parse(result);
        break;
      case "deadline":
        migrated.deadline = createAiAnalysisMigrationElementResultSchema("deadline").parse(result);
        break;
      case "notification":
        migrated.notification =
          createAiAnalysisMigrationElementResultSchema("notification").parse(result);
        break;
      case "selfCommitment":
        migrated.selfCommitment =
          createAiAnalysisMigrationElementResultSchema("selfCommitment").parse(result);
        break;
      default:
        throw new UnreachableError(element);
    }
  }
  return Object.freeze(migrated);
}

export function mixedAdoptedElementsForAnalysis(
  current: TrackedItemAiAnalysisCurrentAdoptedElements,
  migration: TrackedItemAiAnalysisMigrationElements,
  reuseRecords: Readonly<Partial<Record<AiAnalysisElement, AnalysisElementReuseRecord>>>,
): TrackedItemAiAnalysisMigrationAdoptedElements {
  let status: TrackedItemAiAnalysisMigrationAdoptedElement<"status"> | undefined;
  let waitingOn: TrackedItemAiAnalysisMigrationAdoptedElement<"waitingOn"> | undefined;
  let nextAction: TrackedItemAiAnalysisMigrationAdoptedElement<"nextAction"> | undefined;
  let relations: TrackedItemAiAnalysisMigrationAdoptedElement<"relations"> | undefined;
  let progress: TrackedItemAiAnalysisMigrationAdoptedElement<"progress"> | undefined;
  let importance: TrackedItemAiAnalysisMigrationAdoptedElement<"importance"> | undefined;
  let deadline: TrackedItemAiAnalysisMigrationAdoptedElement<"deadline"> | undefined;
  let notification: TrackedItemAiAnalysisMigrationAdoptedElement<"notification"> | undefined;
  let selfCommitment: TrackedItemAiAnalysisMigrationAdoptedElement<"selfCommitment"> | undefined;
  for (const element of AI_ANALYSIS_ELEMENTS) {
    switch (element) {
      case "status":
        if (current.status != null) {
          status = current.status;
        } else if (migration.status != null) {
          status = {
            origin: "migration",
            result: createAiAnalysisMigrationElementResultSchema("status").parse(
              reuseRecords.status?.result ?? migration.status,
            ),
            reuseProof: reuseRecords.status?.proof ?? unknownReuseProof("legacy_migration"),
          };
        }
        break;
      case "waitingOn":
        if (current.waitingOn != null) {
          waitingOn = current.waitingOn;
        } else if (migration.waitingOn != null) {
          waitingOn = {
            origin: "migration",
            result: createAiAnalysisMigrationElementResultSchema("waitingOn").parse(
              reuseRecords.waitingOn?.result ?? migration.waitingOn,
            ),
            reuseProof: reuseRecords.waitingOn?.proof ?? unknownReuseProof("legacy_migration"),
          };
        }
        break;
      case "nextAction":
        if (current.nextAction != null) {
          nextAction = current.nextAction;
        } else if (migration.nextAction != null) {
          nextAction = {
            origin: "migration",
            result: createAiAnalysisMigrationElementResultSchema("nextAction").parse(
              reuseRecords.nextAction?.result ?? migration.nextAction,
            ),
            reuseProof: reuseRecords.nextAction?.proof ?? unknownReuseProof("legacy_migration"),
          };
        }
        break;
      case "relations":
        if (current.relations != null) {
          relations = current.relations;
        } else if (migration.relations != null) {
          relations = {
            origin: "migration",
            result: createAiAnalysisMigrationElementResultSchema("relations").parse(
              reuseRecords.relations?.result ?? migration.relations,
            ),
            reuseProof: reuseRecords.relations?.proof ?? unknownReuseProof("legacy_migration"),
          };
        }
        break;
      case "progress":
        if (current.progress != null) {
          progress = current.progress;
        } else if (migration.progress != null) {
          progress = {
            origin: "migration",
            result: createAiAnalysisMigrationElementResultSchema("progress").parse(
              reuseRecords.progress?.result ?? migration.progress,
            ),
            reuseProof: reuseRecords.progress?.proof ?? unknownReuseProof("legacy_migration"),
          };
        }
        break;
      case "importance":
        if (current.importance != null) {
          importance = current.importance;
        } else if (migration.importance != null) {
          importance = {
            origin: "migration",
            result: createAiAnalysisMigrationElementResultSchema("importance").parse(
              reuseRecords.importance?.result ?? migration.importance,
            ),
            reuseProof: reuseRecords.importance?.proof ?? unknownReuseProof("legacy_migration"),
          };
        }
        break;
      case "deadline":
        if (current.deadline != null) {
          deadline = current.deadline;
        } else if (migration.deadline != null) {
          deadline = {
            origin: "migration",
            result: createAiAnalysisMigrationElementResultSchema("deadline").parse(
              reuseRecords.deadline?.result ?? migration.deadline,
            ),
            reuseProof: reuseRecords.deadline?.proof ?? unknownReuseProof("legacy_migration"),
          };
        }
        break;
      case "notification":
        if (current.notification != null) {
          notification = current.notification;
        } else if (migration.notification != null) {
          notification = {
            origin: "migration",
            result: createAiAnalysisMigrationElementResultSchema("notification").parse(
              reuseRecords.notification?.result ?? migration.notification,
            ),
            reuseProof: reuseRecords.notification?.proof ?? unknownReuseProof("legacy_migration"),
          };
        }
        break;
      case "selfCommitment":
        if (current.selfCommitment != null) {
          selfCommitment = current.selfCommitment;
        } else if (migration.selfCommitment != null) {
          selfCommitment = {
            origin: "migration",
            result: createAiAnalysisMigrationElementResultSchema("selfCommitment").parse(
              reuseRecords.selfCommitment?.result ?? migration.selfCommitment,
            ),
            reuseProof: reuseRecords.selfCommitment?.proof ?? unknownReuseProof("legacy_migration"),
          };
        }
        break;
      default:
        throw new UnreachableError(element);
    }
  }
  return Object.freeze({
    ...(status == null ? {} : { status }),
    ...(waitingOn == null ? {} : { waitingOn }),
    ...(nextAction == null ? {} : { nextAction }),
    ...(relations == null ? {} : { relations }),
    ...(progress == null ? {} : { progress }),
    ...(importance == null ? {} : { importance }),
    ...(deadline == null ? {} : { deadline }),
    ...(notification == null ? {} : { notification }),
    ...(selfCommitment == null ? {} : { selfCommitment }),
  });
}
