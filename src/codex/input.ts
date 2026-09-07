import { z } from "zod";

import { parseSourceId } from "../domain/source-id.js";
import { UnreachableError } from "../util/index.js";
import {
  AI_ANALYSIS_ELEMENTS,
  aiAnalysisElementSchema,
  aiAnalysisDeadlineSchema,
  aiAnalysisImportanceSchema,
  aiAnalysisNextActionSchema,
  aiAnalysisNotificationSchema,
  aiAnalysisProgressSchema,
  aiAnalysisRelationsSchema,
  aiAnalysisStatusSchema,
  aiAnalysisWaitingOnSchema,
  createAiAnalysisMigrationElementResultSchema,
  type AiAnalysisElement,
  type AiAnalysisElementMigrationResult,
  type AiAnalysisElementResult,
  type CodexPreservedElements,
} from "./analysis-elements.js";

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

const lockedResultBaseShape = {
  confidence: z.number().min(0).max(1),
  uncertainties: z.array(z.string().min(1).max(240)).max(20),
};

const lockedWaitingOnSchema = aiAnalysisWaitingOnSchema.element
  .omit({ sourceIds: true })
  .array()
  .max(20);
const lockedRelationsSchema = aiAnalysisRelationsSchema.element
  .omit({ sourceIds: true })
  .array()
  .max(100);
const lockedProgressSchema = aiAnalysisProgressSchema.omit({ latestMeaningfulSourceId: true });

function createCodexLockedElementResultSchema<ValueSchema extends z.ZodType>(
  valueSchema: ValueSchema,
) {
  return z.strictObject({
    value: valueSchema,
    ...lockedResultBaseShape,
  });
}

const codexLockedElementResultSchemas = {
  status: createCodexLockedElementResultSchema(aiAnalysisStatusSchema),
  waitingOn: createCodexLockedElementResultSchema(lockedWaitingOnSchema),
  nextAction: createCodexLockedElementResultSchema(aiAnalysisNextActionSchema),
  relations: createCodexLockedElementResultSchema(lockedRelationsSchema),
  progress: createCodexLockedElementResultSchema(lockedProgressSchema),
  importance: createCodexLockedElementResultSchema(aiAnalysisImportanceSchema),
  deadline: createCodexLockedElementResultSchema(aiAnalysisDeadlineSchema),
  notification: createCodexLockedElementResultSchema(aiAnalysisNotificationSchema),
};

type CodexLockedElementResultByElement = {
  [Element in AiAnalysisElement]: z.output<(typeof codexLockedElementResultSchemas)[Element]>;
};

/** Codex入力へ渡す要素別の固定context。 */
type CodexLockedElementResult<Element extends AiAnalysisElement = AiAnalysisElement> =
  CodexLockedElementResultByElement[Element];

/** 保存済みresultからCodex入力用の固定contextを要素別に投影する。 */
export function projectCodexLockedElementResult(
  element: AiAnalysisElement,
  result: AiAnalysisElementResult | AiAnalysisElementMigrationResult,
): CodexLockedElementResult {
  switch (element) {
    case "status": {
      const parsed = createAiAnalysisMigrationElementResultSchema("status").parse(result);
      return codexLockedElementResultSchemas.status.parse({
        value: parsed.value,
        confidence: parsed.confidence,
        uncertainties: parsed.uncertainties,
      });
    }
    case "waitingOn": {
      const parsed = createAiAnalysisMigrationElementResultSchema("waitingOn").parse(result);
      return codexLockedElementResultSchemas.waitingOn.parse({
        value: parsed.value.map((candidate) => ({
          kind: candidate.kind,
          candidateId: candidate.candidateId,
          role: candidate.role,
          reasonSummary: candidate.reasonSummary,
          confidence: candidate.confidence,
        })),
        confidence: parsed.confidence,
        uncertainties: parsed.uncertainties,
      });
    }
    case "nextAction": {
      const parsed = createAiAnalysisMigrationElementResultSchema("nextAction").parse(result);
      return codexLockedElementResultSchemas.nextAction.parse({
        value: parsed.value,
        confidence: parsed.confidence,
        uncertainties: parsed.uncertainties,
      });
    }
    case "relations": {
      const parsed = createAiAnalysisMigrationElementResultSchema("relations").parse(result);
      return codexLockedElementResultSchemas.relations.parse({
        value: parsed.value.map((candidate) => ({
          candidateId: candidate.candidateId,
          verdict: candidate.verdict,
          reasonSummary: candidate.reasonSummary,
          confidence: candidate.confidence,
        })),
        confidence: parsed.confidence,
        uncertainties: parsed.uncertainties,
      });
    }
    case "progress": {
      const parsed = createAiAnalysisMigrationElementResultSchema("progress").parse(result);
      return codexLockedElementResultSchemas.progress.parse({
        value: {
          reasonSummary: parsed.value.reasonSummary,
          confidence: parsed.value.confidence,
        },
        confidence: parsed.confidence,
        uncertainties: parsed.uncertainties,
      });
    }
    case "importance": {
      const parsed = createAiAnalysisMigrationElementResultSchema("importance").parse(result);
      return codexLockedElementResultSchemas.importance.parse({
        value: parsed.value,
        confidence: parsed.confidence,
        uncertainties: parsed.uncertainties,
      });
    }
    case "deadline": {
      const parsed = createAiAnalysisMigrationElementResultSchema("deadline").parse(result);
      return codexLockedElementResultSchemas.deadline.parse({
        value: parsed.value,
        confidence: parsed.confidence,
        uncertainties: parsed.uncertainties,
      });
    }
    case "notification": {
      const parsed = createAiAnalysisMigrationElementResultSchema("notification").parse(result);
      return codexLockedElementResultSchemas.notification.parse({
        value: parsed.value,
        confidence: parsed.confidence,
        uncertainties: parsed.uncertainties,
      });
    }
    default:
      throw new UnreachableError(element);
  }
}

/** 保存済み要素別full resultをCodex入力用の固定contextへ投影する。 */
export function projectCodexLockedElements(
  preservedElements: CodexPreservedElements,
): Readonly<Partial<Record<AiAnalysisElement, CodexLockedElementResult>>> {
  const knownElements = new Set<string>(AI_ANALYSIS_ELEMENTS);
  for (const element of Object.keys(preservedElements)) {
    if (!knownElements.has(element)) {
      throw new TypeError(`保持するAI判定要素が不正です。対象: ${element}`);
    }
  }
  const lockedElements: Partial<Record<AiAnalysisElement, CodexLockedElementResult>> = {};
  for (const element of AI_ANALYSIS_ELEMENTS) {
    const result = preservedElements[element];
    if (result == null) {
      continue;
    }
    lockedElements[element] = projectCodexLockedElementResult(element, result);
  }
  return Object.freeze(lockedElements);
}

const lockedElementsSchema = z.strictObject({
  status: codexLockedElementResultSchemas.status.optional(),
  waitingOn: codexLockedElementResultSchemas.waitingOn.optional(),
  nextAction: codexLockedElementResultSchemas.nextAction.optional(),
  relations: codexLockedElementResultSchemas.relations.optional(),
  progress: codexLockedElementResultSchemas.progress.optional(),
  importance: codexLockedElementResultSchemas.importance.optional(),
  deadline: codexLockedElementResultSchemas.deadline.optional(),
  notification: codexLockedElementResultSchemas.notification.optional(),
});

const codexAnalysisInputSchema = z
  .strictObject({
    schemaVersion: z.literal("3"),
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
    selectedElements: z.array(aiAnalysisElementSchema).max(AI_ANALYSIS_ELEMENTS.length),
    lockedElements: lockedElementsSchema,
  })
  .superRefine((input, context) => {
    const selectedElements = new Set(input.selectedElements);
    const statusSelected = selectedElements.has("status");
    const waitingOnSelected = selectedElements.has("waitingOn");
    if (statusSelected !== waitingOnSelected) {
      const counterpart = statusSelected ? "waitingOn" : "status";
      if (input.lockedElements[counterpart] == null) {
        context.addIssue({
          code: "custom",
          path: ["selectedElements"],
          message:
            "statusとwaitingOnは同時に選択するか、未選択の要素をlockedElementsへ指定してください",
        });
      }
    }
    for (const element of AI_ANALYSIS_ELEMENTS) {
      if (selectedElements.has(element) && input.lockedElements[element] != null) {
        context.addIssue({
          code: "custom",
          path: ["lockedElements", element],
          message: "選択したAI判定要素をlockedElementsへ指定できません",
        });
      }
    }
    if (selectedElements.size !== input.selectedElements.length) {
      context.addIssue({
        code: "custom",
        path: ["selectedElements"],
        message: "selectedElementsの要素が重複しています",
      });
    }

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
