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
    priorAnalysis: z.null(),
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

function jsonPointerPath(parent: string, field: string): string {
  const escapedField = field.replaceAll("~", "~0").replaceAll("/", "~1");
  return `${parent}/${escapedField}`;
}

function sourceReferenceCardinality(field: string): "single" | "multiple" | undefined {
  if (field === "sourceId" || field.endsWith("SourceId")) {
    return "single";
  }
  if (field === "sourceIds" || field.endsWith("SourceIds")) {
    return "multiple";
  }
  return undefined;
}

function assertSourceReference(value: unknown, path: string, sourceIds: ReadonlySet<string>): void {
  if (value == null) {
    return;
  }
  if (typeof value !== "string") {
    throw new TypeError(`Codex入力のsource ID参照は文字列にしてください。対象: ${path}`);
  }
  if (!sourceIds.has(value)) {
    throw new TypeError(`Codex入力のsource ID参照に対応するrecordがありません。対象: ${path}`);
  }
}

function assertSourceReferences(
  value: unknown,
  path: string,
  sourceIds: ReadonlySet<string>,
): void {
  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) {
      assertSourceReferences(entry, jsonPointerPath(path, index.toString()), sourceIds);
    }
    return;
  }
  if (typeof value !== "object" || value == null) {
    return;
  }
  for (const [field, entry] of Object.entries(value)) {
    const entryPath = jsonPointerPath(path, field);
    const cardinality = sourceReferenceCardinality(field);
    if (cardinality === "single") {
      assertSourceReference(entry, entryPath, sourceIds);
    } else if (cardinality === "multiple") {
      if (!Array.isArray(entry)) {
        throw new TypeError(
          `Codex入力のsource ID参照は文字列配列にしてください。対象: ${entryPath}`,
        );
      }
      for (const [index, sourceId] of entry.entries()) {
        assertSourceReference(sourceId, jsonPointerPath(entryPath, index.toString()), sourceIds);
      }
    }
    assertSourceReferences(entry, entryPath, sourceIds);
  }
}

function assertSourceIntegrity(input: CodexAnalysisInput): void {
  const sourceIds = new Set(input.sources.map((source) => source.id));
  assertSourceReferences(input, "", sourceIds);
}

function mapSourceReference(
  value: unknown,
  path: string,
  sourceAliases: ReadonlyMap<string, string>,
): unknown {
  if (value == null) {
    return value;
  }
  if (typeof value !== "string") {
    throw new TypeError(`Codex入力のsource ID参照は文字列にしてください。対象: ${path}`);
  }
  const alias = sourceAliases.get(value);
  if (alias == null) {
    throw new TypeError(`Codex入力のsource ID参照に対応するrecordがありません。対象: ${path}`);
  }
  return alias;
}

/** Codex入力の構造化されたsource参照だけを変換する。 */
export function transformCodexSourceReferences(
  value: unknown,
  sourceAliases: ReadonlyMap<string, string>,
  path: string,
): unknown {
  if (Array.isArray(value)) {
    return value.map((entry, index) =>
      transformCodexSourceReferences(entry, sourceAliases, jsonPointerPath(path, index.toString())),
    );
  }
  if (typeof value !== "object" || value == null) {
    return value;
  }

  const transformed: Record<string, unknown> = {};
  for (const [field, entry] of Object.entries(value)) {
    const entryPath = jsonPointerPath(path, field);
    const cardinality = sourceReferenceCardinality(field);
    let transformedEntry: unknown = entry;
    if (cardinality === "single") {
      transformedEntry = mapSourceReference(entry, entryPath, sourceAliases);
    } else if (cardinality === "multiple") {
      if (!Array.isArray(entry)) {
        throw new TypeError(
          `Codex入力のsource ID参照は文字列配列にしてください。対象: ${entryPath}`,
        );
      }
      transformedEntry = entry.map((sourceId, index) =>
        mapSourceReference(sourceId, jsonPointerPath(entryPath, index.toString()), sourceAliases),
      );
    }
    transformed[field] = transformCodexSourceReferences(transformedEntry, sourceAliases, entryPath);
  }
  return transformed;
}

/** Codexへ渡すsource ID付きの分析入力。 */
export type CodexAnalysisInput = z.output<typeof codexAnalysisInputSchema>;

/** 未検証の値からCodex分析入力を組み立てる。 */
export function createCodexAnalysisInput(value: unknown): CodexAnalysisInput {
  const input = codexAnalysisInputSchema.parse(value);
  assertSourceIntegrity(input);
  return input;
}

/** Codex分析入力を未信頼データ用のJSONへ変換する。 */
export function serializeCodexAnalysisInput(value: CodexAnalysisInput): string {
  const input = createCodexAnalysisInput(value);
  return `${JSON.stringify(input)}\n`;
}
