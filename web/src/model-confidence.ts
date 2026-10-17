import type { ConfidencePresentation, ConfidenceThresholds } from "./model-contracts.js";

/** confidenceを確定、推定、候補の表示へ変換する。 */
export function confidencePresentation(
  confidence: number,
  thresholds: ConfidenceThresholds,
): ConfidencePresentation {
  if (confidence < 0 || confidence > 1) {
    throw new RangeError("confidenceは0以上1以下でなければなりません");
  }
  if (confidence === 1) {
    return {
      level: "confirmed",
      label: "確定",
      fieldQualifier: "",
    };
  }
  if (confidence >= thresholds.high) {
    return {
      level: "high_estimate",
      label: "確度の高い推定",
      fieldQualifier: "推定",
    };
  }
  if (confidence >= thresholds.medium) {
    return {
      level: "estimate",
      label: "推定",
      fieldQualifier: "推定",
    };
  }
  return {
    level: "uncertain",
    label: "未確定",
    fieldQualifier: "候補",
  };
}
