import { z } from "zod";

import { parseSourceId } from "../domain/source-id.js";

const opaqueIdSchema = z
  .string()
  .min(1, "IDは空にできません")
  .regex(/^\S+$/u, "IDに空白は使えません");
const githubItemUrlSchema = z
  .string()
  .regex(
    /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/(?:issues|pull)\/[1-9]\d*\/?$/u,
    "GitHub IssueまたはPull RequestのURLを指定してください",
  );
const jsonValueSchema = z.json();

const sourceIdSchema = z.string().superRefine((value, context) => {
  try {
    parseSourceId(value);
  } catch (error: unknown) {
    if (!(error instanceof TypeError)) {
      throw error;
    }
    context.addIssue({
      code: "custom",
      message: "正規形式のsource IDを指定してください",
    });
  }
});

const itemSchema = z
  .strictObject({
    nodeId: opaqueIdSchema,
    url: githubItemUrlSchema,
    type: z.enum(["issue", "pull_request"]),
    title: z.string().min(1, "titleは空にできません"),
    authorCandidateId: opaqueIdSchema.optional(),
    headSha: opaqueIdSchema.optional(),
  })
  .catchall(jsonValueSchema);

const waitingOnCandidateSchema = z
  .strictObject({
    id: opaqueIdSchema,
  })
  .catchall(jsonValueSchema);

const relationCandidateSchema = z
  .strictObject({
    id: z.string().regex(/^rel:\S+$/u, "relation candidate IDはrel:で始めてください"),
    targetUrl: githubItemUrlSchema,
  })
  .catchall(jsonValueSchema);

const sourceSchema = z
  .strictObject({
    id: sourceIdSchema,
    kind: opaqueIdSchema,
    actorType: z.enum(["human", "bot", "system"]),
    createdAt: z.iso.datetime({
      offset: true,
      error: "タイムゾーンを含むISO 8601日時を指定してください",
    }),
  })
  .catchall(jsonValueSchema);

const codexAnalysisInputSchema = z
  .strictObject({
    schemaVersion: z.literal("1"),
    now: z.iso.datetime({
      offset: true,
      error: "タイムゾーンを含むISO 8601日時を指定してください",
    }),
    item: itemSchema,
    candidates: z.strictObject({
      waitingOn: z.array(waitingOnCandidateSchema),
      relations: z.array(relationCandidateSchema),
    }),
    sources: z.array(sourceSchema).min(1, "sourceを1件以上指定してください"),
    deterministicSignals: z.record(z.string(), jsonValueSchema),
    priorAnalysis: jsonValueSchema,
  })
  .superRefine((input, context) => {
    const waitingOnIds = new Set<string>();
    for (const [index, candidate] of input.candidates.waitingOn.entries()) {
      if (waitingOnIds.has(candidate.id)) {
        context.addIssue({
          code: "custom",
          path: ["candidates", "waitingOn", index, "id"],
          message: "waitingOn candidate IDが重複しています",
        });
      }
      waitingOnIds.add(candidate.id);
    }

    const relationIds = new Set<string>();
    for (const [index, candidate] of input.candidates.relations.entries()) {
      if (relationIds.has(candidate.id)) {
        context.addIssue({
          code: "custom",
          path: ["candidates", "relations", index, "id"],
          message: "relation candidate IDが重複しています",
        });
      }
      relationIds.add(candidate.id);
    }

    const sourceIds = new Set<string>();
    for (const [index, source] of input.sources.entries()) {
      if (sourceIds.has(source.id)) {
        context.addIssue({
          code: "custom",
          path: ["sources", index, "id"],
          message: "source IDが重複しています",
        });
      }
      sourceIds.add(source.id);
    }
  });

/** Codexへ渡すsource ID付きの分析入力。 */
export type CodexAnalysisInput = z.output<typeof codexAnalysisInputSchema>;

/** 未検証の値からCodex分析入力を組み立てる。 */
export function createCodexAnalysisInput(value: unknown): CodexAnalysisInput {
  return codexAnalysisInputSchema.parse(value);
}

/** Codex分析入力を未信頼データ用のJSONへ変換する。 */
export function serializeCodexAnalysisInput(value: CodexAnalysisInput): string {
  const input = createCodexAnalysisInput(value);
  return `${JSON.stringify(input)}\n`;
}
