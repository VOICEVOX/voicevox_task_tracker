import { type ImportanceLevel } from "./importance.js";
import { type SeverityThresholds } from "./severity.js";
import { type StalenessWaitClass } from "./staleness.js";

/** 追跡項目の要対応度level。 */
export type AttentionLevel = ImportanceLevel;

/** 追跡項目の要対応度判定結果。 */
export type Attention = Readonly<{
  score: number;
  level: AttentionLevel;
}>;

/** 要対応度levelの閾値。 */
export type AttentionLevelThresholds = Readonly<{
  high: number;
  medium: number;
}>;

/** 重要度と停滞の鮮度から要対応度を計算する入力。 */
export type CalculateAttentionInput = Readonly<{
  importanceScore: number;
  elapsedHours: number;
  waitClass: StalenessWaitClass;
  thresholdsHours: SeverityThresholds;
  recencyFloor: number;
  levels: AttentionLevelThresholds;
}>;

function validateNonNegativeNumber(value: number, description: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${description}は0以上の有限値にしてください`);
  }
}

function validateInput(input: CalculateAttentionInput): void {
  if (!Number.isSafeInteger(input.importanceScore) || input.importanceScore < 0) {
    throw new RangeError("重要度スコアは0以上の安全な整数にしてください");
  }
  if (input.importanceScore > 100) {
    throw new RangeError("重要度スコアは100以下にしてください");
  }
  validateNonNegativeNumber(input.elapsedHours, "要対応度計算の停滞時間");
  if (!Number.isFinite(input.recencyFloor) || input.recencyFloor < 0 || input.recencyFloor > 1) {
    throw new RangeError("attention.recencyFloorは0以上1以下の有限値にしてください");
  }
  validateNonNegativeNumber(input.levels.high, "attention.levels.high");
  validateNonNegativeNumber(input.levels.medium, "attention.levels.medium");
  if (input.levels.high < input.levels.medium) {
    throw new RangeError("attention.levels.highはmedium以上にしてください");
  }
}

function determineLevel(score: number, levels: AttentionLevelThresholds): AttentionLevel {
  if (score >= levels.high) {
    return "high";
  }
  if (score >= levels.medium) {
    return "medium";
  }
  return "low";
}

/** 重要度へwait class基準の鮮度係数を掛けて要対応度を計算する。 */
export function calculateAttention(input: CalculateAttentionInput): Attention {
  validateInput(input);
  if (input.waitClass === "notApplicable" || input.waitClass === "blockedParent") {
    return Object.freeze({
      score: 0,
      level: determineLevel(0, input.levels),
    });
  }

  const watchThresholdHours = input.thresholdsHours[input.waitClass].watch;
  if (!Number.isFinite(watchThresholdHours) || watchThresholdHours <= 0) {
    throw new RangeError(`${input.waitClass}.watchの閾値は0より大きい有限値にしてください`);
  }
  const recencyCoefficient =
    input.recencyFloor +
    (1 - input.recencyFloor) * 0.5 ** (input.elapsedHours / watchThresholdHours);
  const score = Math.round(input.importanceScore * recencyCoefficient);
  return Object.freeze({
    score,
    level: determineLevel(score, input.levels),
  });
}
