import { z } from "zod";

import { genericAiExactInputCategorySchema } from "../../../codex/generic-ai-definition.js";
import type { GenericAiCacheProbeSource } from "./generic-ai-cache-plan.js";

const countSchema = z.number().int().nonnegative();

export type { GenericAiExactInputCategory } from "../../../codex/generic-ai-definition.js";

const nodeRejectionReasonSchema = z.enum([
  "node_missing",
  "prepare_ineligible",
  "no_required_elements",
]);
const elementRejectionReasonSchema = z.enum(["node_missing", "prepare_ineligible", "not_required"]);
const subsetRejectionReasonSchema = z.enum([
  "state_pair_ineligible",
  "exact_input_mismatch",
  "cache_miss",
  "cache_stale",
  "cache_key_mismatch",
]);
const countersSchema = z.strictObject({
  candidateNodes: countSchema,
  candidateElements: countSchema,
  inspectedNodes: countSchema,
  inspectedElements: countSchema,
  requiredNodes: countSchema,
  requiredElements: countSchema,
  candidateSubsets: countSchema,
  inspectedSubsets: countSchema,
  qualifiedSubsets: countSchema,
  rejectedNodes: z.record(nodeRejectionReasonSchema, countSchema),
  rejectedElements: z.record(elementRejectionReasonSchema, countSchema),
  rejectedSubsets: z.record(subsetRejectionReasonSchema, countSchema),
  exactInputMismatchCategories: z.record(genericAiExactInputCategorySchema, countSchema),
});

/** 識別子や入力値を含めないcache probeの棄却集計schema。 */
export const genericAiCacheProbeRejectionSummarySchema = countersSchema.extend({
  scanComplete: z.boolean(),
});

/** 母集団と固定理由別件数だけを保持するcache probeの集計。 */
export type GenericAiCacheProbeRejectionCounters = z.output<typeof countersSchema>;

/** 母集団の検算結果を付けたcache probeの匿名棄却診断。 */
export type GenericAiCacheProbeRejectionSummary = Readonly<
  z.output<typeof genericAiCacheProbeRejectionSummarySchema>
>;

/** first候補の母集団からcache probeの匿名集計を初期化する。 */
export function createCacheProbeRejectionCounters(
  probe: GenericAiCacheProbeSource,
): GenericAiCacheProbeRejectionCounters {
  return {
    candidateNodes: probe.candidates.length,
    candidateElements: probe.candidates.reduce(
      (total, candidate) => total + candidate.elements.length,
      0,
    ),
    inspectedNodes: 0,
    inspectedElements: 0,
    requiredNodes: 0,
    requiredElements: 0,
    candidateSubsets: 0,
    inspectedSubsets: 0,
    qualifiedSubsets: 0,
    rejectedNodes: { node_missing: 0, prepare_ineligible: 0, no_required_elements: 0 },
    rejectedElements: { node_missing: 0, prepare_ineligible: 0, not_required: 0 },
    rejectedSubsets: {
      state_pair_ineligible: 0,
      exact_input_mismatch: 0,
      cache_miss: 0,
      cache_stale: 0,
      cache_key_mismatch: 0,
    },
    exactInputMismatchCategories: z
      .record(genericAiExactInputCategorySchema, countSchema)
      .parse(
        Object.fromEntries(
          genericAiExactInputCategorySchema.options.map((category) => [category, 0]),
        ),
      ),
  };
}

/** 各母集団と棄却件数の合計を検算して匿名診断を確定する。 */
export function summarizeCacheProbeRejections(
  counters: GenericAiCacheProbeRejectionCounters,
): GenericAiCacheProbeRejectionSummary {
  const classifiedSubsets =
    Object.values(counters.rejectedSubsets).reduce((total, count) => total + count, 0) +
    counters.qualifiedSubsets;
  return Object.freeze(
    genericAiCacheProbeRejectionSummarySchema.parse({
      ...counters,
      scanComplete:
        counters.candidateNodes ===
          counters.rejectedNodes.node_missing +
            counters.rejectedNodes.prepare_ineligible +
            counters.inspectedNodes &&
        counters.candidateElements ===
          counters.rejectedElements.node_missing +
            counters.rejectedElements.prepare_ineligible +
            counters.inspectedElements &&
        counters.inspectedNodes ===
          counters.rejectedNodes.no_required_elements + counters.requiredNodes &&
        counters.inspectedElements ===
          counters.rejectedElements.not_required + counters.requiredElements &&
        counters.inspectedSubsets === counters.candidateSubsets &&
        counters.inspectedSubsets === classifiedSubsets,
    }),
  );
}
