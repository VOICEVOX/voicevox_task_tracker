import { z } from "zod";

import { parseSha256Hash } from "../canonical-json/index.js";
import {
  aiAnalysisElementEvidenceSchema,
  aiAnalysisElementMetadataSchema,
  aiAnalysisImportanceSchema,
  aiAnalysisNextActionSchema,
  aiAnalysisStatusSchema,
  aiAnalysisWaitingOnSchema,
  createAiAnalysisElementValueSchema,
  type AiAnalysisRelation,
} from "../domain/ai-analysis-elements.js";
import { StateFormatError } from "./errors.js";
import { legacyStatusSchema } from "./snapshot-migration-relations.js";

const legacyWaitingOnSchema = z
  .array(
    z.strictObject({
      kind: z.enum(["user", "team", "role", "item", "automation", "unknown"]),
      candidateId: z.string().min(1).max(300).regex(/^\S+$/u),
      role: z.enum([
        "author",
        "maintainer",
        "reviewer",
        "assignee",
        "respondent",
        "dependency",
        "merge_decider",
        "ci",
        "unknown",
      ]),
      reasonSummary: z.string().min(1).max(300),
      sourceIds: z.array(z.string().min(1).regex(/^\S+$/u)).min(1),
      confidence: z.number().min(0).max(1),
    }),
  )
  .max(20);
const legacyCacheKeySchema = z
  .string()
  .regex(/^sha256:[0-9a-f]{64}$/u, "AI cache keyが不正です")
  .transform((value) => parseSha256Hash(value));
const legacyAiAnalysisSchema = z.union([
  z.strictObject({
    status: z.literal("used"),
    cacheKey: legacyCacheKeySchema,
  }),
  z.strictObject({
    status: z.enum(["failed", "deferred", "not_required", "disabled", "not_recorded"]),
  }),
]);
export const legacyEvidenceSchema = z.strictObject({
  sourceId: z.string().min(1),
  supports: z.enum(["status", "waiting_on", "relation", "progress", "notification", "uncertainty"]),
  summary: z.string().min(1).max(240),
});
const legacyRelationContradictionSchema = z.strictObject({
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
});
const legacyRelationFieldsSchema = {
  id: z.string().min(1).regex(/^\S+$/u),
  fromNodeId: z.string().min(1).regex(/^\S+$/u),
  toNodeId: z.string().min(1).regex(/^\S+$/u),
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
  evidence: z.array(legacyEvidenceSchema),
  contradictions: z.array(legacyRelationContradictionSchema),
  firstSeenAt: z.string().min(1),
  lastConfirmedAt: z.string().min(1),
};
const legacyRelationSchema = z.union([
  z.strictObject({
    ...legacyRelationFieldsSchema,
    active: z.literal(true),
  }),
  z.strictObject({
    ...legacyRelationFieldsSchema,
    active: z.literal(false),
    removedAt: z.string().min(1),
  }),
]);
const legacyImportanceAssessmentSchema = z.union([
  z.strictObject({
    status: z.literal("not_available"),
  }),
  z.strictObject({
    status: z.literal("available"),
    value: aiAnalysisImportanceSchema,
  }),
]);
const legacyDeadlineValueSchema = createAiAnalysisElementValueSchema("deadline");
const legacyDeadlineAssessmentSchema = z.union([
  z.strictObject({
    status: z.literal("not_available"),
  }),
  z.strictObject({
    status: z.literal("available"),
    value: legacyDeadlineValueSchema,
  }),
]);
const legacySeverityContextSchema = z
  .object({
    decisionBasis: z.enum(["deterministic", "ai_only"]),
  })
  .catchall(z.unknown());
const legacyTrackedItemSchema = z
  .object({
    nodeId: z.string().min(1),
    url: z.string().min(1),
    aiAnalysis: legacyAiAnalysisSchema,
    status: legacyStatusSchema,
    waitingOn: legacyWaitingOnSchema,
    nextAction: z.string().min(1).max(1000),
    importanceAssessment: legacyImportanceAssessmentSchema,
    deadlineAssessment: legacyDeadlineAssessmentSchema,
    severityContext: legacySeverityContextSchema,
    evidence: z.array(legacyEvidenceSchema),
    confidence: z.number().min(0).max(1),
  })
  .catchall(z.unknown());
export const legacyIdentifiedAuthorSchema = z
  .object({
    status: z.literal("identified"),
    actor: z
      .object({
        login: z.string().min(1),
      })
      .catchall(z.unknown()),
  })
  .catchall(z.unknown());
const legacyCollectionItemSchema = z.strictObject({
  freshness: z.literal("fresh"),
  nodeId: z.string().min(1),
  repositoryId: z.string().min(1),
  itemFingerprint: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
  aiAnalysisFingerprint: z.discriminatedUnion("status", [
    z.strictObject({
      status: z.literal("unavailable"),
    }),
    z.strictObject({
      status: z.literal("available"),
      fingerprint: z.strictObject({
        sourceHash: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
        inputHash: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
        graphNeighborhoodHash: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
        identityHash: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
      }),
    }),
  ]),
  analysisRulesFingerprint: z.discriminatedUnion("status", [
    z.strictObject({
      status: z.literal("unavailable"),
    }),
    z.strictObject({
      status: z.literal("available"),
      fingerprint: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
    }),
  ]),
  deterministicRulesVersion: z.discriminatedUnion("status", [
    z.strictObject({
      status: z.literal("unavailable"),
    }),
    z.strictObject({
      status: z.literal("available"),
      version: z.string().min(1),
    }),
  ]),
  observedAt: z.string().min(1),
  state: z.enum(["open", "closed"]),
  terminalAt: z.union([z.string().min(1), z.null()]),
});
const legacyCollectionRepositorySchema = z.strictObject({
  repositoryId: z.string().min(1),
  successfulAt: z.string().min(1),
  items: z.array(legacyCollectionItemSchema),
});
export const legacySnapshotSchema = z.strictObject({
  schemaVersion: z.literal("10"),
  generatedAt: z.unknown(),
  trackingStartAt: z.unknown(),
  ai: z.unknown(),
  collection: z.strictObject({
    repositories: z.array(legacyCollectionRepositorySchema),
  }),
  repositories: z.array(z.unknown()),
  items: z.array(legacyTrackedItemSchema),
  externalReferences: z.array(z.unknown()),
  relations: z.array(legacyRelationSchema),
  run: z.unknown(),
});
export const snapshotVersionSchema = z.object({
  schemaVersion: z.string().min(1),
});

const legacyOutputEvidenceSchema = z.strictObject({
  sourceId: z.string().min(1),
  supports: z.enum(["status", "waiting_on", "relation", "progress", "notification", "uncertainty"]),
  summary: z.string().min(1).max(240),
});
export const legacyOutputSchema = z.strictObject({
  schemaVersion: z.literal("4"),
  item: z.strictObject({
    nodeId: z.string().min(1),
    url: z.string().min(1),
  }),
  status: aiAnalysisStatusSchema,
  waitingOn: aiAnalysisWaitingOnSchema,
  nextAction: aiAnalysisNextActionSchema,
  relations: z.json(),
  progress: z.json(),
  importance: aiAnalysisImportanceSchema,
  deadline: legacyDeadlineValueSchema,
  notification: z.json(),
  confidence: z.number().min(0).max(1),
  evidence: z.array(legacyOutputEvidenceSchema).min(1).max(30),
  uncertainties: z.array(z.string().min(1).max(240)).max(20),
});

export type LegacyTrackedItem = z.output<typeof legacyTrackedItemSchema>;
export type LegacyOutput = z.output<typeof legacyOutputSchema>;
export type LegacyRelation = z.output<typeof legacyRelationSchema>;
export type LegacyWaitingOnCandidate = z.output<typeof legacyWaitingOnSchema>[number];
export type AdoptedLegacyRelation = Readonly<{
  candidate: AiAnalysisRelation;
  relation: LegacyRelation;
}>;

export const legacyElementMetadataSchema = aiAnalysisElementMetadataSchema.extend({
  schemaVersion: z.literal("5"),
});
export const legacyElementEvidenceSchema = z
  .array(aiAnalysisElementEvidenceSchema.omit({ supports: true }))
  .min(1)
  .max(30);
export const legacyMigrationElementEvidenceSchema = z
  .array(aiAnalysisElementEvidenceSchema.omit({ supports: true }))
  .min(1);
export const legacyAdoptedElementSchema = z.discriminatedUnion("origin", [
  z.strictObject({
    origin: z.literal("current"),
    generation: z.unknown(),
  }),
  z.strictObject({
    origin: z.literal("migration"),
    result: z.unknown(),
  }),
]);

export function parseJson(source: string): unknown {
  try {
    const parse: (value: string) => unknown = JSON.parse;
    return parse(source);
  } catch (error: unknown) {
    throw new StateFormatError("snapshot", {
      cause: new SyntaxError("JSON構文が不正です", {
        cause: error,
      }),
    });
  }
}
