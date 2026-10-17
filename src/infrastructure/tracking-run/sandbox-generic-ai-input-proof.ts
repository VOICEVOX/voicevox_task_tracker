import { createHmac } from "node:crypto";

import { z } from "zod";

import type { RunIdentity } from "../../application/tracking-run/request.js";
import type { GenericAiAdoptedRun } from "../../application/tracking-run/stages/generic-ai-adoption.js";
import type {
  GenericAiCacheProbe,
  GenericAiCacheProbeSource,
} from "../../application/tracking-run/stages/generic-ai-cache-plan.js";
import type { GenericAiExecutedRun } from "../../application/tracking-run/stages/generic-ai-execution.js";
import { hashCanonicalJson, serializeCanonicalJson } from "../../canonical-json/index.js";
import { createAnalysisElementExactInput } from "../../codex/analysis-element-dependencies.js";
import {
  assertGenericAiExactInputCategories,
  genericAiExactInputCategorySchema,
  type GenericAiExactInputCategory,
} from "../../codex/generic-ai-definition.js";
import type { CodexAnalysisInput } from "../../codex/input.js";
import { AI_ANALYSIS_ELEMENTS } from "../../domain/ai-analysis-elements.js";
import { assertNonNullable } from "../../util/assert-non-nullable.js";
import { SANDBOX_SOURCE_REPOSITORY, type SandboxRunContext } from "./sandbox-context.js";

const revisionSchema = z.string().regex(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u);
const digestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
const associationSchema = z.string().regex(/^[0-9a-f]{64}$/u);

/** firstの実入力証拠が属する実行とsourceの固定binding。 */
export const sandboxGenericAiInputBindingSchema = z.strictObject({
  actionsRunId: z.string().regex(/^[1-9][0-9]*$/u),
  actionsRunAttempt: z.number().int().positive(),
  job: z.literal("analyze"),
  runId: z.string().regex(/^tracker-run:[0-9a-f]{64}$/u),
  invocationId: z.uuid(),
  environmentId: z.string().regex(/^env-[1-9][0-9]*-[1-9][0-9]*$/u),
  sourceRepository: z.literal(SANDBOX_SOURCE_REPOSITORY),
  sourceRef: z.string().min(1).max(1000).regex(/^\S+$/u),
  codeRevision: revisionSchema,
  seedRevision: revisionSchema,
  baseStateRevision: revisionSchema,
});

const categoryDigestsSchema = z.record(genericAiExactInputCategorySchema, digestSchema);
const proofSchema = z
  .strictObject({
    schemaVersion: z.literal(2),
    kind: z.literal("generic_ai_execution_input_categories"),
    binding: sandboxGenericAiInputBindingSchema,
    records: z
      .array(z.strictObject({ association: associationSchema, categories: categoryDigestsSchema }))
      .max(9000),
  })
  .refine(
    (proof) =>
      new Set(proof.records.map((record) => record.association)).size === proof.records.length,
    {
      message: "汎用AIの実入力証拠が重複しています",
    },
  );

/** 認証済みsidecarに保存する実入力のカテゴリ証拠。 */
export type SandboxGenericAiInputProof = z.output<typeof proofSchema>;

/** firstのcontextと解析identityから証拠のbindingを作る。 */
export function createSandboxGenericAiInputBinding(
  context: SandboxRunContext,
  identity: Pick<RunIdentity, "runId" | "invocationId">,
): z.output<typeof sandboxGenericAiInputBindingSchema> {
  return sandboxGenericAiInputBindingSchema.parse({
    actionsRunId: context.workflowRunId,
    actionsRunAttempt: context.workflowRunAttempt,
    job: "analyze",
    runId: identity.runId,
    invocationId: identity.invocationId,
    environmentId: context.environmentId,
    sourceRepository: context.sourceRepository,
    sourceRef: context.sourceRef,
    codeRevision: context.codeRevision,
    seedRevision: context.seedRevision,
    baseStateRevision: context.baseStateRevision,
  });
}

function inputCategoryDigests(exactInput: object): z.output<typeof categoryDigestsSchema> {
  const input = z.record(z.string(), z.unknown()).parse(exactInput);
  assertGenericAiExactInputCategories(input);
  return categoryDigestsSchema.parse(
    Object.fromEntries(
      genericAiExactInputCategorySchema.options.map((category) => [
        category,
        hashCanonicalJson(
          Object.hasOwn(input, category)
            ? { presence: "present", value: input[category] }
            : { presence: "absent" },
        ),
      ]),
    ),
  );
}

function inputAssociation(
  key: Uint8Array,
  nodeId: string,
  element: Pick<
    GenericAiCacheProbe["elements"][number],
    "element" | "inputFingerprint" | "generationDigest"
  >,
): string {
  return createHmac("sha256", key)
    .update(
      serializeCanonicalJson({
        purpose: "sandbox-generic-ai-execution-input-v1",
        nodeId,
        element: element.element,
        inputFingerprint: element.inputFingerprint,
        generationDigest: element.generationDigest,
      }),
    )
    .digest("hex");
}

/** firstで実行され採用されたgenerationを実輸送入力のカテゴリ証拠へ結ぶ。 */
export function createSandboxGenericAiInputProof(
  executed: GenericAiExecutedRun,
  adopted: GenericAiAdoptedRun,
  context: SandboxRunContext,
  key: Uint8Array,
): SandboxGenericAiInputProof {
  if (
    executed.core.identity.runId !== adopted.core.identity.runId ||
    executed.core.identity.invocationId !== adopted.core.identity.invocationId
  ) {
    throw new TypeError("汎用AIの実入力証拠と採用段階のidentityが一致しません");
  }
  if (
    executed.core.baseRevision.status !== "present" ||
    executed.core.baseRevision.revision !== context.baseStateRevision
  ) {
    throw new TypeError("汎用AIの実入力証拠と実行基準revisionが一致しません");
  }
  const outcomes = new Map(executed.data.outcomes.map((outcome) => [outcome.item.nodeId, outcome]));
  const records: SandboxGenericAiInputProof["records"] = [];
  for (const item of adopted.data.items) {
    for (const element of AI_ANALYSIS_ELEMENTS) {
      const adoption = item.elements[element];
      if (adoption.adopted.status !== "ai" || adoption.adopted.origin !== "executed") {
        continue;
      }
      const outcome = outcomes.get(item.nodeId);
      assertNonNullable(outcome, "汎用AIの実入力証拠に対応する実行結果がありません");
      const executionCandidate = outcome.item.executionCandidate;
      assertNonNullable(executionCandidate, "汎用AIの実入力証拠に対応する実行入力がありません");
      const generation = adoption.adopted.generation;
      assertNonNullable(generation, "汎用AIの実入力証拠に対応する採用generationがありません");
      const result =
        outcome.status === "not_executed"
          ? undefined
          : outcome.result?.elements.find((entry) => entry.element === element);
      const exact = createAnalysisElementExactInput(executionCandidate.input, element);
      if (
        result?.origin !== "executed" ||
        executionCandidate.id !== item.nodeId ||
        executionCandidate.input.item.nodeId !== item.nodeId ||
        !executionCandidate.input.selectedElements.includes(element) ||
        exact.fingerprint !== generation.metadata.inputFingerprint ||
        hashCanonicalJson(result.generation) !== hashCanonicalJson(generation)
      ) {
        throw new TypeError("汎用AIの採用generationと実行入力が一致しません");
      }
      records.push({
        association: inputAssociation(key, item.nodeId, {
          element,
          inputFingerprint: generation.metadata.inputFingerprint,
          generationDigest: hashCanonicalJson(generation),
        }),
        categories: inputCategoryDigests(exact.exactInput),
      });
    }
  }
  return proofSchema.parse({
    schemaVersion: 2,
    kind: "generic_ai_execution_input_categories",
    binding: createSandboxGenericAiInputBinding(context, executed.core.identity),
    records,
  });
}

/** 認証後のsidecarから実入力のカテゴリ証拠を検証する。 */
export function parseSandboxGenericAiInputProof(value: unknown): SandboxGenericAiInputProof {
  return proofSchema.parse(value);
}

/** firstの全実file cache候補に証拠を要求し、secondの厳密入力比較を作る。 */
export function createSandboxGenericAiInputComparison(
  proof: SandboxGenericAiInputProof,
  source: GenericAiCacheProbeSource,
  key: Uint8Array,
): (
  probe: GenericAiCacheProbe,
  input: CodexAnalysisInput,
) => readonly GenericAiExactInputCategory[] {
  const records = new Map(proof.records.map((record) => [record.association, record.categories]));
  for (const candidate of source.candidates) {
    for (const element of candidate.elements) {
      if (!records.has(inputAssociation(key, candidate.nodeId, element))) {
        throw new TypeError("firstの実file cache候補に実入力のカテゴリ証拠がありません");
      }
    }
  }
  return (probe, input) => {
    if (input.item.nodeId !== probe.nodeId) {
      throw new TypeError("cache probeの比較対象とsecondの実入力が一致しません");
    }
    const mismatches = new Set<GenericAiExactInputCategory>();
    for (const element of probe.elements) {
      const previous = records.get(inputAssociation(key, probe.nodeId, element));
      assertNonNullable(previous, "cache probeの実入力カテゴリ証拠がありません");
      const current = inputCategoryDigests(
        createAnalysisElementExactInput(input, element.element).exactInput,
      );
      for (const category of genericAiExactInputCategorySchema.options) {
        if (previous[category] !== current[category]) {
          mismatches.add(category);
        }
      }
    }
    return Object.freeze(
      genericAiExactInputCategorySchema.options.filter((category) => mismatches.has(category)),
    );
  };
}
