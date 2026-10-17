import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { z } from "zod";

import type { GenericAiPlannedRun } from "../../application/tracking-run/stages/generic-ai-plan-contracts.js";
import { hashCanonicalJson, serializeCanonicalJson } from "../../canonical-json/index.js";
import { aiAnalysisElementSchema } from "../../domain/ai-analysis-elements.js";
import type { SandboxRunContext } from "./sandbox-context.js";

const planProofSchema = z
  .strictObject({
    schemaVersion: z.literal(2),
    actionsRunId: z.string().regex(/^[1-9][0-9]*$/u),
    actionsRunAttempt: z.number().int().positive(),
    runId: z.string().regex(/^tracker-run:[0-9a-f]{64}$/u),
    invocationId: z.uuid(),
    codeRevision: z.string().regex(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u),
    baseStateRevision: z.string().regex(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u),
    cacheProbeSourceDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
    cacheProbe: z.strictObject({
      nodeId: z.string().min(1).regex(/^\S+$/u),
      elements: z
        .array(
          z.strictObject({
            element: aiAnalysisElementSchema,
            inputFingerprint: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
            cacheKey: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
            generationDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
          }),
        )
        .min(1)
        .refine(
          (elements) => new Set(elements.map((entry) => entry.element)).size === elements.length,
          { message: "cache probeの要素が重複しています" },
        ),
    }),
    choices: z.array(
      z.strictObject({
        nodeId: z.string().min(1).regex(/^\S+$/u),
        element: aiAnalysisElementSchema,
        choice: z.literal("snapshot_reuse"),
        inputFingerprint: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
      }),
    ),
  })
  .refine(
    (proof) =>
      new Set(proof.choices.map((entry) => JSON.stringify([entry.nodeId, entry.element]))).size ===
      proof.choices.length,
    { message: "snapshot再利用の計画対象が重複しています" },
  );

/** secondの汎用AI計画から本文を含まないsnapshot再利用証拠を作る。 */
export function createSandboxReusePlanProof(
  planned: GenericAiPlannedRun,
  context: SandboxRunContext,
): z.output<typeof planProofSchema> {
  if (context.analysisMode.kind !== "cache_probe") {
    throw new TypeError("snapshot再利用証拠にはcache probeが必要です");
  }
  const probe = planned.data.plan.cacheProbe;
  if (probe == null) {
    throw new TypeError("snapshot再利用証拠のcache probeが実計画と一致しません");
  }
  const item = planned.data.plan.items.find((entry) => entry.nodeId === probe.nodeId);
  if (item == null) {
    throw new TypeError("snapshot再利用証拠のcache probeが実計画と一致しません");
  }
  if (
    item.selectedElements.length !== probe.elements.length ||
    item.selectedElements.some(
      (element) => !probe.elements.some((expected) => expected.element === element),
    ) ||
    probe.elements.some((expected) => {
      const actual = item.elements.find((element) => element.element === expected.element);
      return (
        actual?.choice !== "cache_hit" ||
        actual.inputFingerprint !== expected.inputFingerprint ||
        actual.entry.cacheKey !== expected.cacheKey ||
        hashCanonicalJson(actual.entry.generation) !== expected.generationDigest
      );
    })
  ) {
    throw new TypeError("snapshot再利用証拠のcache probeが実計画と一致しません");
  }
  return planProofSchema.parse({
    schemaVersion: 2,
    actionsRunId: context.workflowRunId,
    actionsRunAttempt: context.workflowRunAttempt,
    runId: planned.core.identity.runId,
    invocationId: planned.core.identity.invocationId,
    codeRevision: context.codeRevision,
    baseStateRevision: context.baseStateRevision,
    cacheProbeSourceDigest: context.analysisMode.probe.candidateDigest,
    cacheProbe: probe,
    choices: planned.data.plan.items.flatMap((item) =>
      item.elements.flatMap((element) =>
        element.choice === "snapshot_reuse"
          ? [
              {
                nodeId: item.nodeId,
                element: element.element,
                choice: element.choice,
                inputFingerprint: element.inputFingerprint,
              },
            ]
          : [],
      ),
    ),
  });
}

/** secondのsnapshot再利用計画証拠をcheckpointと同じartifactへ保存する。 */
export function writeSandboxReusePlanProof(
  path: string,
  planned: GenericAiPlannedRun,
  context: SandboxRunContext,
): void {
  const proof = createSandboxReusePlanProof(planned, context);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${serializeCanonicalJson(proof)}\n`, { mode: 0o600 });
}

/** artifactから読み込んだsnapshot再利用計画証拠を検証する。 */
export function parseSandboxReusePlanProof(value: unknown): z.output<typeof planProofSchema> {
  return planProofSchema.parse(value);
}
