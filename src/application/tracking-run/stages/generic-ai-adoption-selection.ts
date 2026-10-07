import { determineAnalysisElementReuse } from "../../../codex/analysis-reuse.js";
import { verifiedReuseProof } from "../../../codex/analysis-element-dependencies.js";
import { effectiveElementConfidence } from "../../../codex/analysis-element-confidence.js";
import type { AiAnalysisRunResult } from "../../../codex/analysis-runner.js";
import {
  createAiAnalysisElementGenerationSchema,
  createAiAnalysisMigrationElementResultSchema,
  type AiAnalysisElement,
  type AiAnalysisElementReuseProof,
} from "../../../domain/ai-analysis-elements.js";
import { createAiAnalysisElementSourceGenerationSchema } from "../../../domain/ai-analysis-source-generations.js";
import { assertNonNullable } from "../../../util/assert-non-nullable.js";
import type { GenericAiExecutionOutcome } from "./generic-ai-execution.js";
import type { GenericAiElementPlan } from "./generic-ai-cache-plan.js";
import type { GenericAiItemPlan } from "./generic-ai-plan-contracts.js";
import type {
  GenericAiAdoptedValue,
  GenericAiElementAdoption,
  GenericAiEvaluatedValue,
  GenericAiRetainedValue,
  GenericAiUnverifiedReason,
} from "./generic-ai-adoption-contracts.js";
import { adoptionProvenance } from "./generic-ai-adoption-provenance.js";

type RunElement = AiAnalysisRunResult["results"][number]["elements"][number];

export const STATE_ELEMENTS: readonly ["status", "waitingOn", "nextAction"] = Object.freeze([
  "status",
  "waitingOn",
  "nextAction",
]);

/** 状態系要素かどうかを判定する。 */
export function isStateElement(
  element: AiAnalysisElement,
): element is (typeof STATE_ELEMENTS)[number] {
  return element === "status" || element === "waitingOn" || element === "nextAction";
}

/** 計画から指定要素を取り出す。 */
export function plannedElement(
  item: GenericAiItemPlan,
  element: AiAnalysisElement,
): GenericAiElementPlan {
  const plan = item.elements.find((value) => value.element === element);
  assertNonNullable(plan, `汎用AIの要素計画がありません。対象: ${item.nodeId}/${element}`);
  return plan;
}

/** 実行結果から指定要素を取り出す。 */
export function resultElement(
  outcome: GenericAiExecutionOutcome,
  element: AiAnalysisElement,
): RunElement | undefined {
  return outcome.status === "not_executed"
    ? undefined
    : outcome.result?.elements.find((value) => value.element === element);
}

function attemptStatus(
  plan: GenericAiElementPlan,
  outcome: GenericAiExecutionOutcome,
  result: RunElement | undefined,
): GenericAiElementAdoption["attemptStatus"] {
  if (plan.choice === "not_required" || plan.necessity === "not_required") {
    return "not_required";
  }
  if (plan.choice === "ai_disabled") {
    return "disabled";
  }
  if (result != null || plan.choice === "snapshot_reuse") {
    return "completed";
  }
  if (plan.choice === "budget_deferred" || plan.choice === "deferred") {
    return "deferred";
  }
  if (outcome.status === "failed") {
    return "failed";
  }
  if (outcome.status === "deferred") {
    return "deferred";
  }
  throw new TypeError(`汎用AIの選択要素に結果または失敗理由がありません。対象: ${plan.element}`);
}

function unverifiedReasons(
  plan: GenericAiElementPlan,
  proof: AiAnalysisElementReuseProof,
): readonly GenericAiUnverifiedReason[] {
  if (
    !isStateElement(plan.element) &&
    determineAnalysisElementReuse({
      element: plan.element,
      inputFingerprint: plan.inputFingerprint,
      inputProjectionVersion: plan.inputProjectionVersion,
      dependencyFingerprint: plan.dependencyFingerprint,
      savedProof: proof,
    }) === "verified"
  ) {
    return Object.freeze([]);
  }
  if (proof.status === "unknown") {
    return Object.freeze(["proof_unknown"]);
  }
  const reasons: GenericAiUnverifiedReason[] = [];
  if (proof.revision !== plan.revision) {
    reasons.push("revision_mismatch");
  }
  if (proof.inputProjectionVersion !== plan.inputProjectionVersion) {
    reasons.push("input_projection_mismatch");
  }
  if (proof.inputFingerprint !== plan.inputFingerprint) {
    reasons.push("input_mismatch");
  }
  if (!isStateElement(plan.element) && proof.dependencyFingerprint !== plan.dependencyFingerprint) {
    reasons.push("dependency_mismatch");
  }
  if (reasons.length === 0 && !isStateElement(plan.element)) {
    reasons.push("proof_unknown");
  }
  return Object.freeze(reasons);
}

function retainedValue(
  item: GenericAiItemPlan,
  plan: GenericAiElementPlan,
): GenericAiRetainedValue | undefined {
  const previous = item.previousAdopted[plan.element];
  if (previous == null) {
    return undefined;
  }
  const savedReuse = item.planning.candidates[plan.element].savedReuse;
  const proof = savedReuse?.proof ?? previous.reuseProof;
  const checkedReasons = unverifiedReasons(plan, proof);
  const reasons =
    previous.origin === "migration" && checkedReasons.length === 0
      ? Object.freeze(["proof_unknown"] satisfies readonly GenericAiUnverifiedReason[])
      : checkedReasons;
  return Object.freeze({
    origin: previous.origin === "migration" ? "migration" : "snapshot",
    result: createAiAnalysisMigrationElementResultSchema(plan.element).parse(
      savedReuse?.result ?? previous.result,
    ),
    ...(previous.origin === "current"
      ? {
          generation: createAiAnalysisElementSourceGenerationSchema(plan.element).parse(
            previous.generation,
          ),
        }
      : {}),
    proof,
    currentness: reasons.length === 0 ? "current" : "unverified",
    unverifiedReasons: reasons,
  });
}

function evaluatedValue(
  item: GenericAiItemPlan,
  plan: GenericAiElementPlan,
  result: RunElement | undefined,
): GenericAiEvaluatedValue | undefined {
  if (result != null) {
    const generation = createAiAnalysisElementGenerationSchema(plan.element).parse(
      result.generation,
    );
    return Object.freeze({
      origin: result.origin,
      generation,
      result: createAiAnalysisMigrationElementResultSchema(plan.element).parse(generation.result),
      proof: verifiedReuseProof(
        plan.element,
        plan.inputFingerprint,
        plan.dependencyFingerprint,
        "current_generation",
        ["current_evaluation"],
      ),
    });
  }
  const previous = item.previousEvaluated[plan.element];
  if (previous == null) {
    return undefined;
  }
  const savedEvaluation = item.planning.candidates[plan.element].savedEvaluation;
  return Object.freeze({
    origin: "snapshot",
    generation: createAiAnalysisElementSourceGenerationSchema(plan.element).parse(
      previous.generation,
    ),
    result: createAiAnalysisMigrationElementResultSchema(plan.element).parse(
      savedEvaluation?.result ?? previous.result,
    ),
    proof: savedEvaluation?.proof ?? previous.evaluationProof,
  });
}

function retentionReason(
  attempt: GenericAiElementAdoption["attemptStatus"],
): Extract<GenericAiAdoptedValue, { status: "ai" }>["reason"] {
  switch (attempt) {
    case "failed":
      return "retained_after_failure";
    case "deferred":
      return "retained_after_deferred";
    case "disabled":
      return "retained_while_disabled";
    case "completed":
    case "not_required":
      return "retained_after_nonadoption";
  }
}

function unavailableReason(
  attempt: GenericAiElementAdoption["attemptStatus"],
): Extract<GenericAiAdoptedValue, { status: "unavailable" }>["reason"] {
  switch (attempt) {
    case "failed":
      return "failed";
    case "deferred":
      return "deferred";
    case "disabled":
      return "disabled";
    case "completed":
    case "not_required":
      return "current_evaluation_not_adopted";
  }
}

function adoptValue(
  item: GenericAiItemPlan,
  plan: GenericAiElementPlan,
  result: RunElement | undefined,
  retained: GenericAiRetainedValue | undefined,
  evaluated: GenericAiEvaluatedValue | undefined,
  attempt: GenericAiElementAdoption["attemptStatus"],
  minimumConfidence: number,
  rejectSelectedState: boolean,
  forceDeterministicState: boolean,
  aiEnabled: boolean,
): GenericAiAdoptedValue {
  const stateElement = isStateElement(plan.element);
  const noUnverifiedReasons: readonly [] = Object.freeze([]);
  if (attempt === "not_required") {
    return Object.freeze({
      status: "deterministic",
      currentness: "current",
      reason: "not_required",
    });
  }
  if (!aiEnabled || attempt === "disabled") {
    return stateElement
      ? Object.freeze({ status: "deterministic", currentness: "current", reason: "disabled" })
      : Object.freeze({ status: "unavailable", currentness: "not_applicable", reason: "disabled" });
  }
  if (stateElement && (item.deterministicStatePriority || forceDeterministicState)) {
    return Object.freeze({
      status: "deterministic",
      currentness: "current",
      reason: forceDeterministicState ? "state_inconsistent" : "deterministic_priority",
    });
  }
  if (
    result != null &&
    !(stateElement && rejectSelectedState) &&
    effectiveElementConfidence(plan.element, result.generation.result) >= minimumConfidence
  ) {
    const generation = createAiAnalysisElementGenerationSchema(plan.element).parse(
      result.generation,
    );
    return Object.freeze({
      status: "ai",
      origin: result.origin,
      currentness: "current",
      reason: "completed_result",
      result: createAiAnalysisMigrationElementResultSchema(plan.element).parse(generation.result),
      generation,
      proof: verifiedReuseProof(
        plan.element,
        plan.inputFingerprint,
        plan.dependencyFingerprint,
        "current_generation",
        ["current_generation"],
      ),
      unverifiedReasons: noUnverifiedReasons,
    });
  }
  if (retained?.currentness === "current") {
    return Object.freeze({
      status: "ai",
      origin: retained.origin,
      currentness: "current",
      reason: plan.choice === "snapshot_reuse" ? "snapshot_reuse" : retentionReason(attempt),
      result: retained.result,
      ...(retained.generation == null ? {} : { generation: retained.generation }),
      proof: retained.proof,
      unverifiedReasons: noUnverifiedReasons,
    });
  }
  if (
    plan.choice === "snapshot_reuse" &&
    evaluated != null &&
    unverifiedReasons(plan, evaluated.proof).length === 0 &&
    !(stateElement && rejectSelectedState) &&
    effectiveElementConfidence(plan.element, evaluated.result) >= minimumConfidence
  ) {
    return Object.freeze({
      status: "ai",
      origin: "snapshot",
      currentness: "current",
      reason: "snapshot_reuse",
      result: evaluated.result,
      generation: evaluated.generation,
      proof: evaluated.proof,
      unverifiedReasons: noUnverifiedReasons,
    });
  }
  if (stateElement) {
    return Object.freeze({
      status: "deterministic",
      currentness: "current",
      reason: "ai_unavailable",
    });
  }
  return Object.freeze({
    status: "unavailable",
    currentness: "not_applicable",
    reason: unavailableReason(attempt),
  });
}

/** 計画と実行結果から指定要素の採用記録を作る。 */
export function adoptionRecord(
  item: GenericAiItemPlan,
  outcome: GenericAiExecutionOutcome,
  element: AiAnalysisElement,
  minimumConfidence: number,
  rejectSelectedState: boolean,
  forceDeterministicState: boolean,
  aiEnabled: boolean,
): GenericAiElementAdoption {
  const plan = plannedElement(item, element);
  const result = resultElement(outcome, element);
  const attempt = attemptStatus(plan, outcome, result);
  const retained = retainedValue(item, plan);
  const evaluated = evaluatedValue(item, plan, result);
  if (plan.choice === "snapshot_reuse" && retained == null && evaluated == null) {
    throw new TypeError(
      `再利用を計画した汎用AIの完了値がありません。対象: ${item.nodeId}/${element}`,
    );
  }
  const adopted = adoptValue(
    item,
    plan,
    result,
    retained,
    evaluated,
    attempt,
    minimumConfidence,
    rejectSelectedState,
    forceDeterministicState,
    aiEnabled,
  );
  return Object.freeze({
    element,
    revision: plan.revision,
    inputFingerprint: plan.inputFingerprint,
    dependencyFingerprint: plan.dependencyFingerprint,
    attemptStatus: attempt,
    adopted,
    ...(retained == null ? {} : { retained }),
    ...(evaluated == null ? {} : { evaluated }),
    ...adoptionProvenance(item.nodeId, element, adopted),
  });
}
