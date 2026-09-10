import {
  AI_ANALYSIS_ELEMENT_INPUT_PROJECTION_VERSIONS,
  AI_ANALYSIS_ELEMENT_REVISIONS,
  aiAnalysisElementReuseProofSchema,
  type AiAnalysisElement,
  type AiAnalysisElementInputFingerprint,
  type AiAnalysisElementReuseProof,
} from "./analysis-elements.js";

/** 採用結果を現在の要素規則へ照合するための入力。 */
export type AnalysisElementReuseInput = Readonly<{
  element: AiAnalysisElement;
  inputFingerprint: AiAnalysisElementInputFingerprint;
  inputProjectionVersion: number;
  dependencyFingerprint: AiAnalysisElementInputFingerprint;
  savedProof?: AiAnalysisElementReuseProof;
}>;

/** 採用結果を現在の要素規則で再利用できるか。 */
export type AnalysisElementReuseDecision = "verified" | "unknown";

/** 採用済み要素の再利用証明を現在の意味契約へ照合する。 */
export function determineAnalysisElementReuse(
  input: AnalysisElementReuseInput,
): AnalysisElementReuseDecision {
  if (input.savedProof == null) {
    return "unknown";
  }
  const proof = aiAnalysisElementReuseProofSchema.parse(input.savedProof);
  if (proof.status === "unknown") {
    return "unknown";
  }
  if (proof.revision !== AI_ANALYSIS_ELEMENT_REVISIONS[input.element]) {
    return "unknown";
  }
  if (
    proof.inputProjectionVersion !== input.inputProjectionVersion ||
    proof.inputProjectionVersion !== AI_ANALYSIS_ELEMENT_INPUT_PROJECTION_VERSIONS[input.element]
  ) {
    return "unknown";
  }
  if (proof.inputFingerprint !== input.inputFingerprint) {
    return "unknown";
  }
  if (proof.dependencyFingerprint !== input.dependencyFingerprint) {
    return "unknown";
  }
  return "verified";
}
