import { z } from "zod";
import { aiAnalysisDependencySchema } from "../domain/ai-analysis-dependencies.js";
import type { AnalyzeGraphInput } from "./analyze-graph-types.js";

const nodeIdSchema = z.string().min(1, "node IDは空にできません").regex(/^\S+$/u, {
  error: "node IDに空白は使えません",
});

const repositoryIdentitySchema = z
  .string()
  .min(1, "リポジトリ識別子は空にできません")
  .regex(/^\S+$/u, {
    error: "リポジトリ識別子に空白は使えません",
  });

const trackedNodeSchema = z.object({
  kind: z.enum(["issue", "pull_request"]),
  nodeId: nodeIdSchema,
  repositoryId: repositoryIdentitySchema,
  state: z.enum(["open", "closed", "merged"]),
  directNotification: z.literal("eligible"),
});

const candidateOnlyNodeSchema = z.object({
  kind: z.enum(["issue", "pull_request"]),
  nodeId: nodeIdSchema,
  repositoryId: repositoryIdentitySchema,
  state: z.enum(["open", "closed", "merged"]),
  directNotification: z.literal("not_eligible"),
});

const externalNodeSchema = z.object({
  kind: z.literal("external_reference"),
  nodeId: nodeIdSchema,
  repositoryFullName: repositoryIdentitySchema,
  state: z.enum(["open", "closed", "merged"]),
  directNotification: z.literal("not_eligible"),
});

const evidenceSchema = z.object({
  sourceId: z.string().min(1, "source IDは空にできません"),
  supports: z.enum([
    "status",
    "waiting_on",
    "relation",
    "progress",
    "notification",
    "uncertainty",
    "self_commitment",
  ]),
  summary: z.string().trim().min(1, "根拠の要約は空にできません"),
});

const aiDependencySchema = aiAnalysisDependencySchema;

const contradictionSchema = z.object({
  verdict: z.enum([
    "current_is_blocked_by_target",
    "current_blocks_target",
    "current_implements_target",
    "target_is_subtask_of_current",
    "current_is_subtask_of_target",
    "duplicates",
    "related",
    "none",
  ]),
  confidence: z.number().min(0).max(1),
  evidence: z.array(evidenceSchema),
});

const graphEdgeSchema = z.object({
  id: z.string().min(1, "edge IDは空にできません"),
  fromNodeId: nodeIdSchema,
  toNodeId: nodeIdSchema,
  type: z.enum(["blocks", "parent_of", "implements", "related_to", "duplicates"]),
  provenance: z.enum([
    "native",
    "explicit_text",
    "closing_keyword",
    "checklist",
    "cross_reference",
    "ai_inference",
  ]),
  confidence: z.number().min(0).max(1),
  evidence: z.array(evidenceSchema),
  authoritative: z.boolean(),
  contradictions: z.array(contradictionSchema),
  aiDependency: aiDependencySchema,
  active: z.boolean(),
});

const canonicalRelationSchema = z.strictObject({
  fromNodeId: nodeIdSchema,
  toNodeId: nodeIdSchema,
  type: z.enum(["blocks", "parent_of", "implements", "related_to", "duplicates"]),
});

const relationCandidateResolutionSchema = z.union([
  z.strictObject({
    candidateId: z.string().min(1),
    status: z.literal("active"),
    edgeId: z.string().min(1),
  }),
  z.strictObject({
    candidateId: z.string().min(1),
    status: z.literal("pending"),
    reason: z.literal("assessment_missing"),
  }),
  z.strictObject({
    candidateId: z.string().min(1),
    status: z.literal("pending"),
    reason: z.literal("confidence_below_threshold"),
    confidence: z.number().min(0).max(1),
  }),
  z.strictObject({
    candidateId: z.string().min(1),
    status: z.literal("rejected"),
    reason: z.literal("verdict_none"),
    confidence: z.number().min(0).max(1),
  }),
  z.strictObject({
    candidateId: z.string().min(1),
    status: z.literal("rejected"),
    reason: z.literal("blocker_not_open"),
    confidence: z.number().min(0).max(1),
  }),
]);

export const candidateDecisionProofSchema = z.strictObject({
  candidateId: z.string().min(1),
  endpointNodeIds: z.tuple([nodeIdSchema, nodeIdSchema]),
  authority: z.enum(["authoritative", "inferred"]),
  resolution: relationCandidateResolutionSchema,
  dependency: aiAnalysisDependencySchema,
  canonicalRelation: canonicalRelationSchema.optional(),
});

const snapshotSchema = z.object({
  nodes: z.array(z.union([trackedNodeSchema, candidateOnlyNodeSchema, externalNodeSchema])),
  edges: z.array(graphEdgeSchema),
});

const analyzeGraphInputSchema = z.object({
  current: snapshotSchema,
  previous: z.discriminatedUnion("availability", [
    z.object({
      availability: z.literal("unavailable"),
    }),
    z.object({
      availability: z.literal("available"),
      snapshot: snapshotSchema,
    }),
  ]),
});

/** graph解析入力の構造を検証する。 */
export function validateInput(input: AnalyzeGraphInput): void {
  const validation = analyzeGraphInputSchema.safeParse(input);
  if (!validation.success) {
    throw new TypeError("グラフ解析入力が不正です", {
      cause: validation.error,
    });
  }
}
