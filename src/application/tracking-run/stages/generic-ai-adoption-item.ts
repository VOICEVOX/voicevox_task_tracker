import { serializeCanonicalJson } from "../../../canonical-json/value.js";
import { effectiveElementConfidence } from "../../../codex/analysis-element-confidence.js";
import { verifiedReuseProof } from "../../../codex/analysis-element-dependencies.js";
import { GENERIC_AI_ELEMENT_DEFINITIONS } from "../../../codex/generic-ai-definition.js";
import {
  AI_ANALYSIS_ELEMENTS,
  createAiAnalysisMigrationElementResultSchema,
  type AiAnalysisElement,
  type AiAnalysisElementInputFingerprint,
} from "../../../domain/ai-analysis-elements.js";
import { createAiAnalysisElementSourceGenerationSchema } from "../../../domain/ai-analysis-source-generations.js";
import { isTerminalStatus } from "../../../domain/status.js";
import { assertNonNullable } from "../../../util/assert-non-nullable.js";
import { UnreachableError } from "../../../util/unreachable-error.js";
import type { ContentDigestPort } from "../contracts/content-digest-port.js";
import type { DeterministicItemAnalysis } from "./deterministic-item.js";
import type { GenericAiExecutionOutcome } from "./generic-ai-execution.js";
import type { GenericAiInputFailurePlan, GenericAiItemPlan } from "./generic-ai-plan-contracts.js";
import type {
  GenericAiAdoptedValue,
  GenericAiElementAdoption,
  GenericAiItemAdoption,
  GenericAiRetainedValue,
  GenericAiUnverifiedReason,
} from "./generic-ai-adoption-contracts.js";
import {
  adoptionRecord,
  isStateElement,
  plannedElement,
  resultElement,
  STATE_ELEMENTS,
} from "./generic-ai-adoption-selection.js";
import { adoptionProvenance } from "./generic-ai-adoption-provenance.js";

function recordsForItem(
  item: GenericAiItemPlan,
  outcome: GenericAiExecutionOutcome,
  minimumConfidence: number,
  rejectSelectedState: boolean,
  forceDeterministicState: boolean,
  aiEnabled: boolean,
): GenericAiItemAdoption["elements"] {
  const record = (element: AiAnalysisElement): GenericAiElementAdoption =>
    adoptionRecord(
      item,
      outcome,
      element,
      minimumConfidence,
      rejectSelectedState,
      forceDeterministicState,
      aiEnabled,
    );
  return Object.freeze({
    status: record("status"),
    waitingOn: record("waitingOn"),
    nextAction: record("nextAction"),
    relations: record("relations"),
    progress: record("progress"),
    importance: record("importance"),
    deadline: record("deadline"),
    notification: record("notification"),
    selfCommitment: record("selfCommitment"),
  });
}

function stateValuesAreConsistent(
  records: GenericAiItemAdoption["elements"],
  analysis: DeterministicItemAnalysis,
): boolean {
  const status =
    records.status.adopted.status === "ai"
      ? createAiAnalysisMigrationElementResultSchema("status").parse(records.status.adopted.result)
          .value
      : analysis.decision.status;
  const waitingOn =
    records.waitingOn.adopted.status === "ai"
      ? createAiAnalysisMigrationElementResultSchema("waitingOn").parse(
          records.waitingOn.adopted.result,
        ).value
      : analysis.decision.waitingOn;
  return isTerminalStatus(status) ? waitingOn.length === 0 : waitingOn.length !== 0;
}

function stateDependencyFingerprint(
  records: GenericAiItemAdoption["elements"],
  analysis: DeterministicItemAnalysis,
  digest: ContentDigestPort,
): AiAnalysisElementInputFingerprint {
  const projection = Object.fromEntries(
    STATE_ELEMENTS.map((element) => {
      const adopted = records[element].adopted;
      const result = adopted.status === "ai" ? adopted.result : undefined;
      const deterministic = analysis.decision;
      const deterministicValue = (() => {
        switch (element) {
          case "status":
            return deterministic.status;
          case "waitingOn":
            return deterministic.waitingOn;
          case "nextAction":
            return deterministic.nextAction;
          default:
            throw new UnreachableError(element);
        }
      })();
      return [
        element,
        {
          status: "available",
          value: result?.value ?? deterministicValue,
          confidence: result?.confidence ?? deterministic.confidence,
          uncertainties: result?.uncertainties ?? deterministic.uncertainties,
        },
      ];
    }),
  );
  return digest.sha256Utf8(serializeCanonicalJson({ kind: "state", elements: projection }));
}

function withStateProof(
  records: GenericAiItemAdoption["elements"],
  analysis: DeterministicItemAnalysis,
  digest: ContentDigestPort,
): GenericAiItemAdoption["elements"] {
  const dependencyFingerprint = stateDependencyFingerprint(records, analysis, digest);
  const update = (element: AiAnalysisElement): GenericAiElementAdoption => {
    const record = records[element];
    if (!isStateElement(element)) {
      return record;
    }
    const evaluated = record.evaluated;
    const adopted = record.adopted;
    assertNonNullable(record.inputFingerprint, `汎用AI採用入力がありません。対象: ${element}`);
    const proof = verifiedReuseProof(
      element,
      record.inputFingerprint,
      dependencyFingerprint,
      "current_generation",
      ["current_generation"],
    );
    const retained = record.retained;
    const retainedReasons =
      retained == null
        ? undefined
        : Object.freeze([
            ...retained.unverifiedReasons.filter((reason) => reason !== "dependency_mismatch"),
            ...(retained.proof.status === "verified" &&
            retained.proof.dependencyFingerprint !== dependencyFingerprint
              ? (["dependency_mismatch"] satisfies readonly GenericAiUnverifiedReason[])
              : []),
          ]);
    const retainedCurrentness: GenericAiRetainedValue["currentness"] =
      retainedReasons?.length === 0 ? "current" : "unverified";
    const updatedRetained =
      retained == null || retainedReasons == null
        ? undefined
        : Object.freeze({
            ...retained,
            currentness: retainedCurrentness,
            unverifiedReasons: retainedReasons,
          });
    let updatedAdopted: GenericAiAdoptedValue = adopted;
    if (adopted.status === "ai" && (adopted.origin === "cache" || adopted.origin === "executed")) {
      updatedAdopted = Object.freeze({ ...adopted, proof });
    } else if (
      adopted.status === "ai" &&
      (adopted.proof.status !== "verified" ||
        adopted.proof.dependencyFingerprint !== dependencyFingerprint)
    ) {
      updatedAdopted = Object.freeze({
        status: "deterministic",
        currentness: "current",
        reason: "ai_unavailable",
      });
    }
    const updatedEvaluated =
      evaluated != null &&
      evaluated.origin !== "snapshot" &&
      updatedAdopted.status === "ai" &&
      (updatedAdopted.origin === "cache" || updatedAdopted.origin === "executed")
        ? Object.freeze({ ...evaluated, proof })
        : evaluated;
    return Object.freeze({
      ...record,
      dependencyFingerprint,
      adopted: updatedAdopted,
      ...(updatedRetained == null ? {} : { retained: updatedRetained }),
      ...(updatedEvaluated == null ? {} : { evaluated: updatedEvaluated }),
      ...adoptionProvenance(analysis.item.nodeId, element, updatedAdopted),
    });
  };
  const updated = Object.freeze({
    ...records,
    status: update("status"),
    waitingOn: update("waitingOn"),
    nextAction: update("nextAction"),
  });
  return STATE_ELEMENTS.some(
    (element) => records[element].adopted.status !== updated[element].adopted.status,
  )
    ? withStateProof(updated, analysis, digest)
    : updated;
}

/** 計画と部分結果を含む実行結果から9要素の採用記録を確定する。 */
export function adoptGenericAiItem(
  outcome: GenericAiExecutionOutcome,
  analysis: DeterministicItemAnalysis,
  minimumConfidence: number,
  digest: ContentDigestPort,
  aiEnabled: boolean,
): GenericAiItemAdoption {
  const item = outcome.item;
  if (
    item.nodeId !== analysis.item.nodeId ||
    item.elements.length !== AI_ANALYSIS_ELEMENTS.length
  ) {
    throw new TypeError(`汎用AIの採用対象と計画が一致しません。対象: ${item.nodeId}`);
  }
  const selectedState = STATE_ELEMENTS.filter((element) => plannedElement(item, element).selected);
  const rejectSelectedState =
    selectedState.length >= 2 &&
    selectedState.some((element) => {
      const result = resultElement(outcome, element);
      return (
        result == null ||
        effectiveElementConfidence(element, result.generation.result) < minimumConfidence
      );
    });
  let records = recordsForItem(
    item,
    outcome,
    minimumConfidence,
    rejectSelectedState,
    false,
    aiEnabled,
  );
  if (!stateValuesAreConsistent(records, analysis)) {
    records = recordsForItem(
      item,
      outcome,
      minimumConfidence,
      rejectSelectedState,
      true,
      aiEnabled,
    );
  }
  records = withStateProof(records, analysis, digest);
  let status: GenericAiItemAdoption["status"];
  if (!aiEnabled) {
    status = "disabled";
  } else {
    switch (outcome.status) {
      case "completed":
        status = "used";
        break;
      case "failed":
        status = "failed";
        break;
      case "deferred":
        status = "deferred";
        break;
      case "not_executed":
        if (AI_ANALYSIS_ELEMENTS.some((element) => records[element].attemptStatus === "deferred")) {
          status = "deferred";
        } else {
          status = outcome.reason === "ai_disabled" ? "disabled" : "not_required";
        }
        break;
    }
  }
  return Object.freeze({ nodeId: item.nodeId, status, elements: records });
}

function inputFailureRecord(
  failure: GenericAiInputFailurePlan,
  element: AiAnalysisElement,
): GenericAiElementAdoption {
  const previous = failure.previousAdopted[element];
  const retained: GenericAiRetainedValue | undefined =
    previous == null
      ? undefined
      : Object.freeze({
          origin: previous.origin === "migration" ? "migration" : "snapshot",
          result: createAiAnalysisMigrationElementResultSchema(element).parse(previous.result),
          ...(previous.origin === "current"
            ? {
                generation: createAiAnalysisElementSourceGenerationSchema(element).parse(
                  previous.generation,
                ),
              }
            : {}),
          proof: previous.reuseProof,
          currentness: "unverified",
          unverifiedReasons: Object.freeze([
            "input_unavailable",
          ] satisfies readonly GenericAiUnverifiedReason[]),
        });
  let adopted: GenericAiAdoptedValue;
  if (isStateElement(element)) {
    adopted = Object.freeze({
      status: "deterministic",
      currentness: "current",
      reason: "ai_unavailable",
    });
  } else {
    adopted = Object.freeze({
      status: "unavailable",
      currentness: "not_applicable",
      reason: "failed",
    });
  }
  const oldEvaluation = failure.previousEvaluated[element];
  const evaluated =
    oldEvaluation == null
      ? undefined
      : Object.freeze({
          origin: "snapshot",
          generation: createAiAnalysisElementSourceGenerationSchema(element).parse(
            oldEvaluation.generation,
          ),
          result: createAiAnalysisMigrationElementResultSchema(element).parse(oldEvaluation.result),
          proof: oldEvaluation.evaluationProof,
        });
  return Object.freeze({
    element,
    revision: GENERIC_AI_ELEMENT_DEFINITIONS[element].revision,
    attemptStatus: "failed",
    adopted,
    ...(retained == null ? {} : { retained }),
    ...(evaluated == null ? {} : { evaluated }),
    ...adoptionProvenance(failure.candidateId, element, adopted),
  });
}

/** 厳密入力を検証できなかった項目の9要素を未検証の保持値として確定する。 */
export function adoptGenericAiInputFailure(
  failure: GenericAiInputFailurePlan,
): GenericAiItemAdoption {
  const record = (element: AiAnalysisElement): GenericAiElementAdoption =>
    inputFailureRecord(failure, element);
  return Object.freeze({
    nodeId: failure.candidateId,
    status: "failed",
    elements: Object.freeze({
      status: record("status"),
      waitingOn: record("waitingOn"),
      nextAction: record("nextAction"),
      relations: record("relations"),
      progress: record("progress"),
      importance: record("importance"),
      deadline: record("deadline"),
      notification: record("notification"),
      selfCommitment: record("selfCommitment"),
    }),
  });
}
