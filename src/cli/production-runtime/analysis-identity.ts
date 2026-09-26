import { hashCanonicalJson } from "../../canonical-json/index.js";
import { AI_ANALYSIS_ELEMENT_REVISIONS, CODEX_PROMPT_BUNDLE_VERSION } from "../../codex/index.js";
import type { AiAnalysisRunIdentity } from "../../codex/index.js";
import type { Config } from "../../config/index.js";
import { AI_ANALYSIS_ELEMENT_SCHEMA_VERSION } from "../../domain/ai-analysis-elements.js";
import {
  ISSUE_DETERMINISTIC_RULES_VERSION,
  PULL_REQUEST_DETERMINISTIC_RULES_VERSION,
} from "../../domain/index.js";
import type { EnumeratedGitHubItem, Sha256Fingerprint } from "../../github/index.js";

import {
  createAiAnalysisElementResultSchema,
  createAiAnalysisMigrationElementResultSchema,
  type AiAnalysisElement,
  type AiAnalysisElementEvidence,
  type AiAnalysisElementExecutionFingerprint,
  type AiAnalysisElementInputFingerprint,
  type AiAnalysisElementMigrationResult,
} from "../../domain/ai-analysis-elements.js";
import type {
  TrackedItemAiAnalysisCurrentAdoptedElements,
  TrackedItemAiAnalysisMigrationElements,
} from "../../domain/index.js";
import type { AnalysisElementDependencyFingerprintMap } from "../../codex/analysis-element-dependencies.js";
import { UnreachableError } from "../../util/index.js";
import type { DeterministicItemAnalysis } from "../initial-item-analysis.js";
import type { RuntimeState } from "./contracts.js";
import { adoptedResultForRetainedItem } from "./previous-state/saved-ai-elements.js";
import { previousTrackedItem } from "./previous-state/snapshot.js";

type AnalysisElementExecutionFingerprintMap = Readonly<
  Record<AiAnalysisElement, AiAnalysisElementExecutionFingerprint>
>;

const CODEX_CLI_VERSION = "0.145.0";
export const CODEX_BACKEND_VERSION = `codex-cli-${CODEX_CLI_VERSION}`;
export const CODEX_PROMPT_FINGERPRINT = hashCanonicalJson({
  bundleVersion: CODEX_PROMPT_BUNDLE_VERSION,
});

/** AI解析の実行識別情報を作る。 */
export function createAiAnalysisRunIdentity(config: Config): AiAnalysisRunIdentity {
  return Object.freeze({
    model: config.ai.model,
    reasoningEffort: config.ai.execution.reasoningEffort,
    backendVersion: CODEX_BACKEND_VERSION,
    schemaVersion: AI_ANALYSIS_ELEMENT_SCHEMA_VERSION,
  });
}

function deterministicRulesVersionForItem(item: EnumeratedGitHubItem): string {
  switch (item.type) {
    case "issue":
      return ISSUE_DETERMINISTIC_RULES_VERSION;
    case "pull_request":
      return PULL_REQUEST_DETERMINISTIC_RULES_VERSION;
  }
}

/** 項目の解析計画fingerprintを作る。 */
export function analysisPlanFingerprintForItem(
  item: EnumeratedGitHubItem,
  identity: AiAnalysisRunIdentity,
): Sha256Fingerprint {
  return hashCanonicalJson({
    itemType: item.type,
    deterministicRulesVersion: deterministicRulesVersionForItem(item),
    elementRevisions: AI_ANALYSIS_ELEMENT_REVISIONS,
    execution: {
      model: identity.model,
      reasoningEffort: identity.reasoningEffort,
      backendVersion: identity.backendVersion,
      schemaVersion: identity.schemaVersion,
    },
  });
}

export function elementExecutionFingerprints(
  identity: AiAnalysisRunIdentity,
): AnalysisElementExecutionFingerprintMap {
  const createFingerprint = (element: AiAnalysisElement): AiAnalysisElementExecutionFingerprint =>
    hashCanonicalJson({
      element,
      model: identity.model,
      reasoningEffort: identity.reasoningEffort,
      backendVersion: identity.backendVersion,
      schemaVersion: identity.schemaVersion,
    });
  return Object.freeze({
    status: createFingerprint("status"),
    waitingOn: createFingerprint("waitingOn"),
    nextAction: createFingerprint("nextAction"),
    relations: createFingerprint("relations"),
    progress: createFingerprint("progress"),
    importance: createFingerprint("importance"),
    deadline: createFingerprint("deadline"),
    notification: createFingerprint("notification"),
    selfCommitment: createFingerprint("selfCommitment"),
  });
}

export function deterministicElementResult(
  analysis: DeterministicItemAnalysis,
  element: AiAnalysisElement,
): AiAnalysisElementMigrationResult | undefined {
  const evidence: readonly AiAnalysisElementEvidence[] = Object.freeze([
    Object.freeze({
      sourceId: analysis.item.sourceId,
      summary: "決定論的な判定結果です",
      supports: "element",
    }),
  ]);
  const common = {
    evidence,
    confidence: analysis.decision.confidence,
    uncertainties: analysis.decision.uncertainties,
  };
  switch (element) {
    case "status":
      return createAiAnalysisElementResultSchema("status").parse({
        ...common,
        value: analysis.decision.status,
      });
    case "waitingOn":
      return createAiAnalysisMigrationElementResultSchema("waitingOn").parse({
        ...common,
        value: analysis.decision.waitingOn,
      });
    case "nextAction":
      return createAiAnalysisElementResultSchema("nextAction").parse({
        ...common,
        value: analysis.decision.nextAction,
      });
    case "relations":
    case "progress":
    case "importance":
    case "deadline":
    case "notification":
    case "selfCommitment":
      return undefined;
    default:
      throw new UnreachableError(element);
  }
}

function dependencyResultForElement(
  state: RuntimeState,
  analysis: DeterministicItemAnalysis,
  element: AiAnalysisElement,
): AiAnalysisElementMigrationResult | undefined {
  const item = previousTrackedItem(state, analysis.item.nodeId);
  return item == null ? undefined : adoptedResultForRetainedItem(item, element);
}

export function stateDependencyFingerprintForResults(
  analysis: DeterministicItemAnalysis,
  results: Readonly<Partial<Record<AiAnalysisElement, AiAnalysisElementMigrationResult>>>,
): AiAnalysisElementInputFingerprint {
  const elements = Object.fromEntries(
    (["status", "waitingOn", "nextAction"] as const).map((element) => {
      const savedResult = results[element];
      const result =
        savedResult == null
          ? deterministicElementResult(analysis, element)
          : createAiAnalysisMigrationElementResultSchema(element).parse(savedResult);
      return [
        element,
        result == null
          ? { status: "unavailable" }
          : {
              status: "available",
              value: result.value,
              confidence: result.confidence,
              uncertainties: result.uncertainties,
            },
      ];
    }),
  );
  return hashCanonicalJson({ kind: "state", elements });
}

export function stateDependencyFingerprint(
  state: RuntimeState,
  analysis: DeterministicItemAnalysis,
): AiAnalysisElementInputFingerprint {
  const results: Partial<Record<AiAnalysisElement, AiAnalysisElementMigrationResult>> = {};
  for (const element of ["status", "waitingOn", "nextAction"] as const) {
    const result = dependencyResultForElement(state, analysis, element);
    if (result != null) {
      results[element] = result;
    }
  }
  return stateDependencyFingerprintForResults(analysis, results);
}

export function finalStateDependencyFingerprint(
  analysis: DeterministicItemAnalysis,
  current: TrackedItemAiAnalysisCurrentAdoptedElements,
  migration: TrackedItemAiAnalysisMigrationElements,
): AiAnalysisElementInputFingerprint {
  const results: Partial<Record<AiAnalysisElement, AiAnalysisElementMigrationResult>> = {};
  for (const element of ["status", "waitingOn", "nextAction"] as const) {
    const currentElement = current[element];
    if (currentElement != null) {
      results[element] = currentElement.result;
      continue;
    }
    const migrationResult = migration[element];
    if (migrationResult != null) {
      results[element] = migrationResult;
    }
  }
  return stateDependencyFingerprintForResults(analysis, results);
}

export function elementDependencyFingerprints(
  state: RuntimeState,
  analysis: DeterministicItemAnalysis,
): AnalysisElementDependencyFingerprintMap {
  const stateFingerprint = stateDependencyFingerprint(state, analysis);
  const independentFingerprint = hashCanonicalJson({ kind: "independent" });
  return Object.freeze({
    status: stateFingerprint,
    waitingOn: stateFingerprint,
    nextAction: stateFingerprint,
    relations: independentFingerprint,
    progress: independentFingerprint,
    importance: independentFingerprint,
    deadline: independentFingerprint,
    notification: independentFingerprint,
    selfCommitment: independentFingerprint,
  });
}
