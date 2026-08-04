import { posix as posixPath } from "node:path";

/** ラベルルールが判定へ与える効果。 */
export type LabelRuleEffects = Readonly<{
  priorityWeight?: number;
  severityLift?: number;
  requiresMaintainerDecision?: boolean;
  suppressNotifications?: boolean;
  countsAsProgress?: boolean;
}>;

/** リポジトリとラベル名に対する意味付けルール。 */
export type LabelRule = Readonly<{
  repository: string;
  namePattern: string;
  effects: LabelRuleEffects;
}>;

/** 一致したすべてのラベルルールを合成した効果。 */
export type ResolvedLabelEffects = Readonly<{
  priorityWeight: number;
  severityLift: number;
  requiresMaintainerDecision: boolean;
  maintainerDecisionLabelNames: readonly string[];
  suppressNotifications: boolean;
  countsAsProgress: boolean;
}>;

/** リポジトリとラベル一覧からラベル効果を解決する関数。 */
export type LabelEffectsResolver = (
  repositoryFullName: string,
  labelNames: readonly string[],
) => ResolvedLabelEffects;

type CompiledLabelRule = Readonly<{
  repositoryPattern: string;
  namePattern: RegExp;
  effects: LabelRuleEffects;
}>;

function compileNamePattern(pattern: string): RegExp {
  try {
    return new RegExp(pattern);
  } catch (error: unknown) {
    throw new TypeError(`label name patternを正規表現として解釈できません: ${pattern}`, {
      cause: error,
    });
  }
}

function compileLabelRule(rule: LabelRule): CompiledLabelRule {
  return Object.freeze({
    repositoryPattern: rule.repository,
    namePattern: compileNamePattern(rule.namePattern),
    effects: Object.freeze({ ...rule.effects }),
  });
}

function matchesRepository(repositoryFullName: string, repositoryPattern: string): boolean {
  try {
    return posixPath.matchesGlob(repositoryFullName, repositoryPattern);
  } catch (error: unknown) {
    throw new TypeError(`repository globを解釈できません: ${repositoryPattern}`, { cause: error });
  }
}

/** 設定済みラベルルールから決定論的な効果解決関数を生成する。 */
export function createLabelEffectsResolver(rules: readonly LabelRule[]): LabelEffectsResolver {
  const compiledRules = rules.map(compileLabelRule);

  return (repositoryFullName: string, labelNames: readonly string[]): ResolvedLabelEffects => {
    let priorityWeight = 0;
    let severityLift = 0;
    let requiresMaintainerDecision = false;
    const maintainerDecisionLabelNames = new Set<string>();
    let suppressNotifications = false;
    let countsAsProgress = false;

    for (const rule of compiledRules) {
      if (!matchesRepository(repositoryFullName, rule.repositoryPattern)) {
        continue;
      }
      const matchedLabelNames = labelNames.filter((labelName) => rule.namePattern.test(labelName));
      if (matchedLabelNames.length === 0) {
        continue;
      }

      priorityWeight += rule.effects.priorityWeight ?? 0;
      severityLift = Math.max(severityLift, rule.effects.severityLift ?? 0);
      requiresMaintainerDecision ||= rule.effects.requiresMaintainerDecision ?? false;
      if (rule.effects.requiresMaintainerDecision === true) {
        for (const labelName of matchedLabelNames) {
          maintainerDecisionLabelNames.add(labelName);
        }
      }
      suppressNotifications ||= rule.effects.suppressNotifications ?? false;
      countsAsProgress ||= rule.effects.countsAsProgress ?? false;
    }

    return Object.freeze({
      priorityWeight,
      severityLift,
      requiresMaintainerDecision,
      maintainerDecisionLabelNames: Object.freeze([...maintainerDecisionLabelNames].sort()),
      suppressNotifications,
      countsAsProgress,
    });
  };
}
