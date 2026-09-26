import type { Config } from "../../config/index.js";
import type { LabelRule } from "../../domain/index.js";

export function normalizeLabelRules(config: Config): readonly LabelRule[] {
  return Object.freeze(
    config.labels.rules.map((rule) => {
      const effects: {
        priorityWeight?: number;
        severityLift?: number;
        requiresMaintainerDecision?: boolean;
        suppressNotifications?: boolean;
        countsAsProgress?: boolean;
      } = {};
      if (rule.effects.priorityWeight != null) {
        effects.priorityWeight = rule.effects.priorityWeight;
      }
      if (rule.effects.severityLift != null) {
        effects.severityLift = rule.effects.severityLift;
      }
      if (rule.effects.requiresMaintainerDecision != null) {
        effects.requiresMaintainerDecision = rule.effects.requiresMaintainerDecision;
      }
      if (rule.effects.suppressNotifications != null) {
        effects.suppressNotifications = rule.effects.suppressNotifications;
      }
      if (rule.effects.countsAsProgress != null) {
        effects.countsAsProgress = rule.effects.countsAsProgress;
      }
      return Object.freeze({
        repository: rule.repository,
        namePattern: rule.namePattern,
        effects: Object.freeze(effects),
      });
    }),
  );
}
