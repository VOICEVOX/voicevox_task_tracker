import { type DeadlineLevel } from "./deadline.js";
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

/** 重要度、期限の切迫度と停滞の鮮度から要対応度を計算する入力。 */
export type CalculateAttentionInput = Readonly<{
  importanceScore: number;
  deadlineLevel: DeadlineLevel;
  deadlinePoints: Readonly<Record<DeadlineLevel, number>>;
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

function validateNonNegativeSafeInteger(value: number, description: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${description}は0以上の安全な整数にしてください`);
  }
}

function validateInput(input: CalculateAttentionInput): void {
  if (!Number.isSafeInteger(input.importanceScore) || input.importanceScore < 0) {
    throw new RangeError("重要度スコアは0以上の安全な整数にしてください");
  }
  if (input.importanceScore > 100) {
    throw new RangeError("重要度スコアは100以下にしてください");
  }
  if (!(input.deadlineLevel in input.deadlinePoints)) {
    throw new RangeError("期限の切迫度levelが不正です");
  }
  for (const level of ["none", "low", "medium", "high"] as const) {
    validateNonNegativeSafeInteger(
      input.deadlinePoints[level],
      `attention.deadlinePoints.${level}`,
    );
  }
  if (input.deadlinePoints.high > 100) {
    throw new RangeError("attention.deadlinePoints.highは100以下にしてください");
  }
  if (
    input.deadlinePoints.none !== 0 ||
    !(input.deadlinePoints.none < input.deadlinePoints.low) ||
    !(input.deadlinePoints.low < input.deadlinePoints.medium) ||
    !(input.deadlinePoints.medium < input.deadlinePoints.high)
  ) {
    throw new RangeError(
      "attention.deadlinePointsは0 = none < low < medium < highを満たしてください",
    );
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

/** 重要度の容量を期限加点の上限に合わせて鮮度調整し、期限加点を加えて要対応度を計算する。 */
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
  const importanceCapacity = 100 - input.deadlinePoints.high;
  const recencyScore = Math.round(
    (input.importanceScore * recencyCoefficient * importanceCapacity) / 100,
  );
  const score = recencyScore + input.deadlinePoints[input.deadlineLevel];
  return Object.freeze({
    score,
    level: determineLevel(score, input.levels),
  });
}
