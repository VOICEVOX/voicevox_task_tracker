import { type TrackedItemMilestone, type UtcIsoDateTime } from "./types.js";

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

/** 重要度の加点要因として扱う種別。 */
export const IMPORTANCE_FACTOR_KINDS = [
  "priorityLabel",
  "downstreamImpact",
  "milestoneDeadline",
] as const;

/** 追跡項目の重要度。 */
export type ImportanceLevel = "low" | "medium" | "high";

/** 重要度の加点要因の種別。 */
export type ImportanceFactorKind = (typeof IMPORTANCE_FACTOR_KINDS)[number];

/** 重要度を構成する加点要因。 */
export type ImportanceFactor = Readonly<{
  kind: ImportanceFactorKind;
  points: number;
  detail: string;
}>;

/** 追跡項目の重要度判定結果。 */
export type Importance = Readonly<{
  score: number;
  level: ImportanceLevel;
  factors: readonly ImportanceFactor[];
}>;

/** 重要度の決定論的な加点に使う重み。 */
export type ImportanceWeights = Readonly<{
  priorityLabelMultiplier: number;
  blockedItem: number;
  blockedRepository: number;
  downstreamImpactMax: number;
  milestoneWithDueDate: number;
  milestoneDueSoon: number;
}>;

/** 重要度levelの閾値。 */
export type ImportanceLevelThresholds = Readonly<{
  high: number;
  medium: number;
}>;

/** 重要度へ反映する依存先への影響規模。 */
export type ImportanceDownstreamImpact = Readonly<{
  openNodeCount: number;
  repositoryCount: number;
}>;

/** 決定論的な重要度計算の入力。 */
export type CalculateImportanceInput = Readonly<{
  priorityWeight: number;
  downstreamImpact: ImportanceDownstreamImpact;
  milestone: TrackedItemMilestone | null;
  evaluatedAt: UtcIsoDateTime;
  weights: ImportanceWeights;
  dueSoonDays: number;
  levels: ImportanceLevelThresholds;
}>;

function validateNonNegativeNumber(value: number, description: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${description}は0以上の有限値にしてください`);
  }
}

function validateCount(value: number, description: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${description}は0以上の安全な整数にしてください`);
  }
}

function validateInput(input: CalculateImportanceInput): void {
  validateNonNegativeNumber(input.priorityWeight, "priority weight");
  validateCount(input.downstreamImpact.openNodeCount, "停止しているopen項目数");
  validateCount(input.downstreamImpact.repositoryCount, "影響するリポジトリ数");
  for (const [name, value] of Object.entries(input.weights)) {
    validateNonNegativeNumber(value, `importance.weights.${name}`);
  }
  validateNonNegativeNumber(input.dueSoonDays, "importance.dueSoonDays");
  validateNonNegativeNumber(input.levels.high, "importance.levels.high");
  validateNonNegativeNumber(input.levels.medium, "importance.levels.medium");
  if (input.levels.high < input.levels.medium) {
    throw new RangeError("importance.levels.highはmedium以上にしてください");
  }
}

function parseTimestamp(value: UtcIsoDateTime, description: string): number {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new TypeError(`${description}が不正です`);
  }
  return timestamp;
}

function createPriorityLabelFactor(input: CalculateImportanceInput): ImportanceFactor | undefined {
  const points = input.priorityWeight * input.weights.priorityLabelMultiplier;
  validateNonNegativeNumber(points, "priorityLabelの加点");
  if (points === 0) {
    return undefined;
  }
  return Object.freeze({
    kind: "priorityLabel",
    points,
    detail: `優先度ラベルの重みで${points.toString()}点を加算します`,
  });
}

function createDownstreamImpactFactor(
  input: CalculateImportanceInput,
): ImportanceFactor | undefined {
  const uncappedPoints =
    input.downstreamImpact.openNodeCount * input.weights.blockedItem +
    input.downstreamImpact.repositoryCount * input.weights.blockedRepository;
  validateNonNegativeNumber(uncappedPoints, "downstreamImpactの上限適用前の加点");
  const points = Math.min(uncappedPoints, input.weights.downstreamImpactMax);
  if (points === 0) {
    return undefined;
  }
  const impactDetail = `open項目${input.downstreamImpact.openNodeCount.toString()}件とリポジトリ${input.downstreamImpact.repositoryCount.toString()}件への影響で${uncappedPoints.toString()}点です`;
  return Object.freeze({
    kind: "downstreamImpact",
    points,
    detail:
      points === uncappedPoints
        ? impactDetail
        : `${impactDetail}。上限${input.weights.downstreamImpactMax.toString()}点を適用します`,
  });
}

function isMilestoneDueSoon(
  milestone: TrackedItemMilestone,
  evaluatedAt: UtcIsoDateTime,
  dueSoonDays: number,
): boolean {
  if (milestone.dueOn == null) {
    throw new TypeError("期限判定対象のmilestoneに期限がありません");
  }
  const remainingMilliseconds =
    parseTimestamp(milestone.dueOn, "milestone期限") - parseTimestamp(evaluatedAt, "評価基準時刻");
  return remainingMilliseconds <= dueSoonDays * MILLISECONDS_PER_DAY;
}

function createMilestoneDeadlineFactor(
  input: CalculateImportanceInput,
): ImportanceFactor | undefined {
  if (input.milestone?.state !== "open" || input.milestone.dueOn == null) {
    return undefined;
  }
  const dueSoon = isMilestoneDueSoon(input.milestone, input.evaluatedAt, input.dueSoonDays);
  const points =
    input.weights.milestoneWithDueDate + (dueSoon ? input.weights.milestoneDueSoon : 0);
  validateNonNegativeNumber(points, "milestoneDeadlineの加点");
  if (points === 0) {
    return undefined;
  }
  const dueDateDetail = `期限付きのopen milestoneで${input.weights.milestoneWithDueDate.toString()}点です`;
  return Object.freeze({
    kind: "milestoneDeadline",
    points,
    detail: dueSoon
      ? `${dueDateDetail}。期限が${input.dueSoonDays.toString()}日以内のため${input.weights.milestoneDueSoon.toString()}点を加算します`
      : dueDateDetail,
  });
}

function compareFactors(left: ImportanceFactor, right: ImportanceFactor): number {
  if (left.points !== right.points) {
    return right.points - left.points;
  }
  return IMPORTANCE_FACTOR_KINDS.indexOf(left.kind) - IMPORTANCE_FACTOR_KINDS.indexOf(right.kind);
}

function determineLevel(score: number, levels: ImportanceLevelThresholds): ImportanceLevel {
  if (score >= levels.high) {
    return "high";
  }
  if (score >= levels.medium) {
    return "medium";
  }
  return "low";
}

/** 優先度ラベル、依存先への影響、milestone期限から重要度を計算する。 */
export function calculateImportance(input: CalculateImportanceInput): Importance {
  validateInput(input);
  const factors = [
    createPriorityLabelFactor(input),
    createDownstreamImpactFactor(input),
    createMilestoneDeadlineFactor(input),
  ]
    .filter((factor) => factor != null)
    .sort(compareFactors);
  const totalPoints = factors.reduce((sum, factor) => sum + factor.points, 0);
  const score = Math.min(100, Math.max(0, Math.round(totalPoints)));
  return Object.freeze({
    score,
    level: determineLevel(score, input.levels),
    factors: Object.freeze(factors),
  });
}
