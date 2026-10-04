import { aiAnalysisDependencyForApplication } from "../../../domain/ai-analysis-dependencies.js";
import type {
  AiAnalysisElement,
  AiAnalysisElementApplication,
} from "../../../domain/ai-analysis-elements.js";
import type { GitHubNodeId } from "../../../domain/types.js";
import type {
  GenericAiAdoptedValue,
  GenericAiElementAdoption,
} from "./generic-ai-adoption-contracts.js";

function applicationFor(adopted: GenericAiAdoptedValue): AiAnalysisElementApplication {
  if (adopted.status === "ai") {
    return Object.freeze({
      status: "current_ai",
      origin:
        adopted.origin === "executed" || adopted.origin === "cache"
          ? adopted.origin
          : "verified_reuse",
    });
  }
  if (adopted.status === "deterministic") {
    if (adopted.reason === "not_required") {
      return Object.freeze({ status: "not_required" });
    }
    if (adopted.reason === "disabled") {
      return Object.freeze({ status: "disabled" });
    }
    return Object.freeze({ status: "deterministic_fallback" });
  }
  if (adopted.reason === "disabled") {
    return Object.freeze({ status: "disabled" });
  }
  return Object.freeze({
    status: "unavailable",
    reason:
      adopted.reason === "failed" || adopted.reason === "deferred"
        ? adopted.reason
        : "current_evaluation_not_adopted",
  });
}

/** 採用値から生成元、適用元、値単位のAI依存を一緒に確定する。 */
export function adoptionProvenance(
  nodeId: GitHubNodeId,
  element: AiAnalysisElement,
  adopted: GenericAiAdoptedValue,
): Pick<GenericAiElementAdoption, "producer" | "application" | "aiDependency"> {
  let producer: GenericAiElementAdoption["producer"];
  if (adopted.status === "ai") {
    producer = Object.freeze({ kind: "ai", nodeId, element, origin: adopted.origin });
  } else if (adopted.status === "deterministic") {
    producer = Object.freeze({ kind: "deterministic", nodeId, element });
  } else {
    producer = Object.freeze({ kind: "unavailable", nodeId, element });
  }
  const application = applicationFor(adopted);
  return Object.freeze({
    producer,
    application,
    aiDependency: aiAnalysisDependencyForApplication(nodeId, element, application),
  });
}
