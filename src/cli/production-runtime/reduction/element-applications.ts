import { hashCanonicalJson } from "../../../canonical-json/index.js";
import {
  determineAnalysisElementReuse,
  type AnalysisElementPlanning,
  type AiAnalysisRunResult,
  type CodexAnalysisReduction,
} from "../../../codex/index.js";
import { isStateAnalysisElement } from "../../../codex/analysis-element-dependencies.js";
import {
  AI_ANALYSIS_ELEMENTS,
  aiAnalysisElementApplicationsSchema,
  createAiAnalysisMigrationElementResultSchema,
  type AiAnalysisElement,
  type AiAnalysisElementApplication,
  type AiAnalysisElementMigrationResult,
} from "../../../domain/ai-analysis-elements.js";
import type { AiAnalysisElementSourceGeneration } from "../../../domain/ai-analysis-source-generations.js";
import type { GitHubNodeId, TrackedItemAiAnalysisApplications } from "../../../domain/index.js";
import { assertNonNullable, UnreachableError } from "../../../util/index.js";
import type { DeterministicItemAnalysis } from "../../initial-item-analysis.js";
import { aiAnalysisRunIndex, generatedElementsForNode } from "../ai-analysis-run-index.js";
import { deterministicElementResult } from "../analysis-identity.js";
import type { RuntimeState } from "../contracts.js";
import {
  verifiedCurrentAdoptedResultForElement,
  verifiedMigrationAdoptedResultForElement,
} from "../previous-state/ai-reuse.js";
import {
  currentAdoptedElementForElement,
  savedMigrationAdoptedElementsForItem,
} from "../previous-state/saved-ai-elements.js";
import { codexElementResult, type ConsumerCodexElementOutput } from "./consumer-output.js";

type AiAnalysisElementApplicationReason = Extract<
  AiAnalysisElementApplication,
  { status: "retained_ai" }
>["reason"];

function sameAiAnalysisElementResult(
  left: AiAnalysisElementMigrationResult | undefined,
  right: AiAnalysisElementMigrationResult | undefined,
): boolean {
  return left != null && right != null && hashCanonicalJson(left) === hashCanonicalJson(right);
}

function aiAnalysisElementApplicationReason(
  run: AiAnalysisRunResult | undefined,
  nodeId: GitHubNodeId,
  generated: AiAnalysisElementSourceGeneration | undefined,
): AiAnalysisElementApplicationReason {
  const runIndex = aiAnalysisRunIndex(run);
  if (runIndex.failureByNodeId.has(nodeId)) {
    return "failed";
  }
  if (runIndex.deferredByNodeId.has(nodeId)) {
    return "deferred";
  }
  if (generated != null) {
    return "current_evaluation_not_adopted";
  }
  return "proof_unknown";
}

function aiAnalysisElementApplicationForAnalysis(
  state: RuntimeState,
  analysis: DeterministicItemAnalysis,
  planning: AnalysisElementPlanning,
  run: AiAnalysisRunResult | undefined,
  reduction: CodexAnalysisReduction | undefined,
  consumerOutput: ConsumerCodexElementOutput | undefined,
  element: AiAnalysisElement,
): AiAnalysisElementApplication {
  const candidate = planning.candidates[element];
  if (candidate.necessity === "not_required") {
    return Object.freeze({
      status: "not_required",
    });
  }

  const generated = generatedElementsForNode(run, analysis.item.nodeId)[element];
  const consumerResult =
    consumerOutput == null ? undefined : codexElementResult(consumerOutput, element);
  const reductionApplication = reduction?.ai.elements[element]?.application;
  const stateElement = isStateAnalysisElement(element);
  if (stateElement && run == null) {
    return Object.freeze({
      status: "disabled",
    });
  }
  if (stateElement) {
    switch (reductionApplication) {
      case "applied":
        break;
      case "preserved":
        if (reduction?.decision.origin !== "codex") {
          throw new TypeError(`保持AI判定が最終stateへ寄与していません。対象: ${element}`);
        }
        assertNonNullable(consumerResult, `保持AI判定の最終値がありません。対象: ${element}`);
        break;
      case "deterministic_fallback":
        if (reduction?.ai.status === "unavailable") {
          return Object.freeze({
            status: "unavailable",
            reason: aiAnalysisElementApplicationReason(run, analysis.item.nodeId, generated),
          });
        }
        return Object.freeze({
          status: "deterministic_fallback",
        });
      case undefined:
        if (
          reduction?.ai.status === "unavailable" ||
          (reduction == null && generated == null && consumerResult == null)
        ) {
          return Object.freeze({
            status: "unavailable",
            reason: aiAnalysisElementApplicationReason(run, analysis.item.nodeId, generated),
          });
        }
        return Object.freeze({
          status: "deterministic_fallback",
        });
      default:
        throw new UnreachableError(reductionApplication);
    }
  }
  if (reductionApplication === "deterministic_fallback") {
    return Object.freeze({
      status: "deterministic_fallback",
    });
  }

  const generatedWasConsumed = sameAiAnalysisElementResult(
    consumerResult,
    generated?.result == null
      ? undefined
      : createAiAnalysisMigrationElementResultSchema(element).parse(generated.result),
  );
  const generatedWasApplied =
    reductionApplication === "applied" || (!stateElement && generatedWasConsumed);
  if (generatedWasApplied) {
    assertNonNullable(generated, `適用されたAI生成要素がありません。対象: ${element}`);
    const runResult = aiAnalysisRunIndex(run).resultByNodeId.get(analysis.item.nodeId);
    const runElement = runResult?.elements.find((result) => result.element === element);
    assertNonNullable(runElement, `適用されたAI生成要素の実行記録がありません。対象: ${element}`);
    return Object.freeze({
      status: "current_ai",
      origin: runElement.origin,
    });
  }

  const verifiedSavedReuse = candidate.savedReuse;
  const savedReuseIsVerified =
    verifiedSavedReuse != null &&
    determineAnalysisElementReuse({
      element,
      inputFingerprint: candidate.inputFingerprint,
      inputProjectionVersion: candidate.inputProjectionVersion,
      dependencyFingerprint: candidate.dependencyFingerprint,
      savedProof: verifiedSavedReuse.proof,
    }) === "verified" &&
    sameAiAnalysisElementResult(consumerResult, verifiedSavedReuse.result);
  const verifiedCurrent = verifiedCurrentAdoptedResultForElement(
    state,
    analysis,
    element,
    candidate.inputFingerprint,
    candidate.savedReuse,
  );
  const verifiedMigration = verifiedMigrationAdoptedResultForElement(
    state,
    analysis,
    element,
    candidate.inputFingerprint,
    candidate.savedReuse,
  );
  if (
    savedReuseIsVerified ||
    sameAiAnalysisElementResult(consumerResult, verifiedCurrent) ||
    sameAiAnalysisElementResult(consumerResult, verifiedMigration)
  ) {
    return Object.freeze({
      status: "current_ai",
      origin: "verified_reuse",
    });
  }

  const currentAdopted = currentAdoptedElementForElement(state, analysis, element);
  const migrationAdopted = savedMigrationAdoptedElementsForItem(state, analysis.item.nodeId)[
    element
  ];
  const currentResult = currentAdopted?.result;
  const migrationResult =
    migrationAdopted?.origin === "migration" ? migrationAdopted.result : undefined;
  if (sameAiAnalysisElementResult(consumerResult, currentResult)) {
    return Object.freeze({
      status: "retained_ai",
      reason: aiAnalysisElementApplicationReason(run, analysis.item.nodeId, generated),
    });
  }
  if (sameAiAnalysisElementResult(consumerResult, migrationResult)) {
    return Object.freeze({
      status: "unknown",
      reason: "migration",
    });
  }

  const deterministicResult = deterministicElementResult(analysis, element);
  if (sameAiAnalysisElementResult(consumerResult, deterministicResult)) {
    return Object.freeze({
      status: "deterministic_fallback",
    });
  }
  if (consumerResult == null) {
    if (run == null) {
      return Object.freeze({
        status: "disabled",
      });
    }
    return Object.freeze({
      status: "unavailable",
      reason: aiAnalysisElementApplicationReason(run, analysis.item.nodeId, generated),
    });
  }
  if (
    candidate.savedReuse != null &&
    sameAiAnalysisElementResult(consumerResult, candidate.savedReuse.result)
  ) {
    throw new TypeError(`AI採用元の現行形式を特定できません。対象: ${element}`);
  }
  throw new TypeError(`AI判定要素の最終適用元を特定できません。対象: ${element}`);
}

/** 解析要素ごとの最終適用元を確定する。 */
export function aiAnalysisElementApplicationsForAnalysis(
  state: RuntimeState,
  analysis: DeterministicItemAnalysis,
  planning: AnalysisElementPlanning,
  run: AiAnalysisRunResult | undefined,
  reduction: CodexAnalysisReduction | undefined,
  consumerOutput: ConsumerCodexElementOutput | undefined,
): TrackedItemAiAnalysisApplications {
  const applications: Partial<Record<AiAnalysisElement, AiAnalysisElementApplication>> = {};
  for (const element of AI_ANALYSIS_ELEMENTS) {
    applications[element] = aiAnalysisElementApplicationForAnalysis(
      state,
      analysis,
      planning,
      run,
      reduction,
      consumerOutput,
      element,
    );
  }
  return Object.freeze(aiAnalysisElementApplicationsSchema.parse(applications));
}
