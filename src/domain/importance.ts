/** 重要度の加点要因として扱う種別。 */
export const IMPORTANCE_FACTOR_KINDS = [
  "priorityLabel",
  "downstreamImpact",
  "significantFeature",
  "futureRisk",
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

/** 重要度の加点に使う重み。 */
export type ImportanceWeights = Readonly<{
  priorityLabelMultiplier: number;
  blockedItem: number;
  blockedRepository: number;
  downstreamImpactMax: number;
  significantFeature: number;
  futureRisk: number;
}>;

/** 自然言語から判定した重要度の加点要因。 */
export type NaturalLanguageImportanceAssessment = Readonly<{
  significantFeature: boolean;
  futureRisk: boolean;
  rationale: string;
}>;

/** 自然言語による重要度判定を利用できるかを表す。 */
export type NaturalLanguageImportanceAssessmentState =
  | Readonly<{
      status: "not_available";
    }>
  | Readonly<{
      status: "available";
      value: NaturalLanguageImportanceAssessment;
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
  weights: ImportanceWeights;
  levels: ImportanceLevelThresholds;
}>;

/** 決定論的な重要度と自然言語による加点を合成する入力。 */
export type CombineImportanceInput = Readonly<{
  deterministic: Importance;
  naturalLanguageAssessment: NaturalLanguageImportanceAssessmentState;
  weights: ImportanceWeights;
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
  validateNonNegativeNumber(input.levels.high, "importance.levels.high");
  validateNonNegativeNumber(input.levels.medium, "importance.levels.medium");
  if (input.levels.high < input.levels.medium) {
    throw new RangeError("importance.levels.highはmedium以上にしてください");
  }
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

function createImportance(
  factors: ImportanceFactor[],
  levels: ImportanceLevelThresholds,
): Importance {
  const sortedFactors = factors.sort(compareFactors);
  const totalPoints = sortedFactors.reduce((sum, factor) => sum + factor.points, 0);
  const score = Math.min(100, Math.max(0, Math.round(totalPoints)));
  return Object.freeze({
    score,
    level: determineLevel(score, levels),
    factors: Object.freeze(sortedFactors),
  });
}

function createNaturalLanguageFactors(
  assessment: NaturalLanguageImportanceAssessment,
  weights: ImportanceWeights,
): readonly ImportanceFactor[] {
  if (assessment.rationale.trim().length === 0) {
    throw new TypeError("自然言語による重要度判定のrationaleは空にできません");
  }
  const definitions = [
    {
      kind: "significantFeature",
      enabled: assessment.significantFeature,
      points: weights.significantFeature,
    },
    {
      kind: "futureRisk",
      enabled: assessment.futureRisk,
      points: weights.futureRisk,
    },
  ] satisfies readonly Readonly<{
    kind: ImportanceFactorKind;
    enabled: boolean;
    points: number;
  }>[];
  return Object.freeze(
    definitions.flatMap((definition) => {
      validateNonNegativeNumber(definition.points, `importance.weights.${definition.kind}`);
      if (!definition.enabled || definition.points === 0) {
        return [];
      }
      return [
        Object.freeze({
          kind: definition.kind,
          points: definition.points,
          detail: `Codex判定で${definition.points.toString()}点です。${assessment.rationale}`,
        }),
      ];
    }),
  );
}

/** 優先度ラベルと依存先への影響から重要度を計算する。 */
export function calculateImportance(input: CalculateImportanceInput): Importance {
  validateInput(input);
  const factors = [createPriorityLabelFactor(input), createDownstreamImpactFactor(input)].filter(
    (factor) => factor != null,
  );
  return createImportance(factors, input.levels);
}

/** 決定論的な重要度へ利用可能な自然言語判定の加点要因を合成する。 */
export function combineImportance(input: CombineImportanceInput): Importance {
  if (input.naturalLanguageAssessment.status === "not_available") {
    return input.deterministic;
  }
  validateNonNegativeNumber(input.levels.high, "importance.levels.high");
  validateNonNegativeNumber(input.levels.medium, "importance.levels.medium");
  if (input.levels.high < input.levels.medium) {
    throw new RangeError("importance.levels.highはmedium以上にしてください");
  }
  return createImportance(
    [
      ...input.deterministic.factors,
      ...createNaturalLanguageFactors(input.naturalLanguageAssessment.value, input.weights),
    ],
    input.levels,
  );
}
