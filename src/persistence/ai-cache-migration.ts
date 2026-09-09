import { z } from "zod";

import { createAiCacheEntry, type AiCacheEntry, type AiCacheKey } from "../codex/cache.js";
import {
  aiAnalysisElementEvidenceSchema,
  aiAnalysisElementMetadataSchema,
  aiAnalysisElementSchema,
  createAiAnalysisElementResultSchema,
} from "../domain/ai-analysis-elements.js";
import {
  createUtcIsoDateTime,
  REASONING_EFFORTS,
  type ReasoningEffort,
  type UtcIsoDateTime,
} from "../domain/index.js";
import { assertValidStatePath } from "./branch-adapter.js";
import { hashCanonicalJson, parseSha256Hash, type Sha256Hash } from "./canonical-json.js";
import { StateFormatError } from "./errors.js";

const LEGACY_AI_CACHE_FILE_PATTERN = /^([0-9a-f]{64})\.json$/u;
const legacyAiCacheSchemaVersionSchema = z.enum(["1", "2", "3", "4"]);
const sha256HashSchema = z
  .string()
  .regex(/^sha256:[0-9a-f]{64}$/u, "SHA-256 hashが不正です")
  .transform((value) => parseSha256Hash(value));
const nonEmptyStringSchema = z.string().min(1, "空文字は指定できません");
const legacyAiCacheMetadataSchema = z.strictObject({
  deterministicRulesVersion: nonEmptyStringSchema,
  model: nonEmptyStringSchema,
  reasoningEffort: z.enum(REASONING_EFFORTS),
  backendVersion: nonEmptyStringSchema,
  promptVersion: nonEmptyStringSchema,
  schemaVersion: legacyAiCacheSchemaVersionSchema,
  inputHash: sha256HashSchema,
  outputHash: sha256HashSchema,
  executedAt: z.iso
    .datetime({
      offset: true,
      error: "タイムゾーンを含むISO 8601日時を指定してください",
    })
    .transform((value) => createUtcIsoDateTime(value)),
});
const legacyAiCacheEnvelopeSchema = z.strictObject({
  cacheKey: sha256HashSchema,
  sourceHash: sha256HashSchema,
  metadata: legacyAiCacheMetadataSchema,
  output: z.json(),
});
const currentAiCacheEnvelopeSchema = z.strictObject({
  cacheKey: sha256HashSchema,
  element: aiAnalysisElementSchema,
  generation: z.unknown(),
});
const legacyCurrentAiCacheMetadataSchema = aiAnalysisElementMetadataSchema.extend({
  schemaVersion: z.literal("5"),
});
const legacyCurrentAiCacheEvidenceSchema = z
  .array(aiAnalysisElementEvidenceSchema.omit({ supports: true }))
  .min(1)
  .max(30);

/** 旧AI cache metadataのschema version。 */
export type LegacyAiCacheSchemaVersion = z.output<typeof legacyAiCacheSchemaVersionSchema>;

/** 旧AI cacheの実行metadata。 */
export type LegacyAiCacheMetadata = Readonly<{
  deterministicRulesVersion: string;
  model: string;
  reasoningEffort: ReasoningEffort;
  backendVersion: string;
  promptVersion: string;
  schemaVersion: LegacyAiCacheSchemaVersion;
  inputHash: Sha256Hash;
  outputHash: Sha256Hash;
  executedAt: UtcIsoDateTime;
}>;

/** 旧AI cacheのenvelope。outputは利用箇所で必要な範囲を検証する。 */
export type LegacyAiCacheEntry = Readonly<{
  path: string;
  cacheKey: AiCacheKey;
  sourceHash: Sha256Hash;
  metadata: LegacyAiCacheMetadata;
  output: unknown;
}>;

type ObsoleteAiCacheEntry = Readonly<{
  path: string;
  cacheKey: AiCacheKey;
  schemaVersion: "5";
}>;

/** AI cache移行へ渡す一つのstate file。 */
export type AiCacheMigrationFile = Readonly<{
  path: string;
  source: string;
}>;

/** 固定revisionのAI cacheを分類した移行計画。 */
export type AiCacheMigrationPlan = Readonly<{
  legacyCachePaths: readonly string[];
  legacyEntriesByCacheKey: ReadonlyMap<AiCacheKey, LegacyAiCacheEntry>;
  currentEntriesByCacheKey: ReadonlyMap<AiCacheKey, AiCacheEntry>;
  sourceSchemaVersions: readonly string[];
  migratedSchemaVersions: readonly string[];
}>;

function compareStrings(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function uniqueSorted(values: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(values)].sort(compareStrings));
}

function parseJson(source: string): unknown {
  try {
    const parse: (value: string) => unknown = JSON.parse;
    return parse(source);
  } catch (error: unknown) {
    throw new StateFormatError("AI cache", {
      cause: new SyntaxError("JSON構文が不正です", {
        cause: error,
      }),
    });
  }
}

function createMigrationError(error: unknown): StateFormatError {
  if (error instanceof StateFormatError) {
    return error;
  }
  if (error instanceof z.ZodError) {
    return StateFormatError.fromZodError("AI cache", error);
  }
  return new StateFormatError("AI cache", {
    cause: new TypeError("AI cacheの移行判定に失敗しました", {
      cause: error,
    }),
  });
}

function cacheKeyFromPath(directory: string, path: string): AiCacheKey {
  assertValidStatePath(path);
  const prefix = `${directory}/`;
  if (!path.startsWith(prefix)) {
    throw new TypeError("AI cacheのpathがdirectory配下ではありません");
  }
  const fileName = path.slice(prefix.length);
  const match = LEGACY_AI_CACHE_FILE_PATTERN.exec(fileName);
  if (match == null) {
    throw new TypeError("AI cacheのファイル名が不正です");
  }
  const digest = match[1];
  if (digest == null) {
    throw new TypeError("AI cacheのファイル名からhashを取得できません");
  }
  return parseSha256Hash(`sha256:${digest}`);
}

function parseLegacyAiCacheEntry(
  path: string,
  value: unknown,
  expectedCacheKey: AiCacheKey,
): LegacyAiCacheEntry {
  const parsed = legacyAiCacheEnvelopeSchema.parse(value);
  if (parsed.cacheKey !== expectedCacheKey) {
    throw new TypeError("AI cacheのcache keyとファイル名が一致しません");
  }
  if (hashCanonicalJson(parsed.output) !== parsed.metadata.outputHash) {
    throw new TypeError("AI cacheの出力hashが一致しません");
  }
  return Object.freeze({
    path,
    cacheKey: parsed.cacheKey,
    sourceHash: parsed.sourceHash,
    metadata: Object.freeze({
      ...parsed.metadata,
    }),
    output: parsed.output,
  });
}

function legacyCurrentCacheKey(
  element: z.output<typeof aiAnalysisElementSchema>,
  metadata: z.output<typeof legacyCurrentAiCacheMetadataSchema>,
): AiCacheKey {
  return hashCanonicalJson({
    backendVersion: metadata.backendVersion,
    element,
    executionFingerprint: metadata.executionFingerprint,
    inputFingerprint: metadata.inputFingerprint,
    model: metadata.model,
    reasoningEffort: metadata.reasoningEffort,
    revision: metadata.revision,
    schemaVersion: metadata.schemaVersion,
  });
}

function parseObsoleteAiCacheEntry(
  path: string,
  value: unknown,
  expectedCacheKey: AiCacheKey,
): ObsoleteAiCacheEntry {
  const parsed = currentAiCacheEnvelopeSchema.parse(value);
  const generationSchema = z.strictObject({
    metadata: legacyCurrentAiCacheMetadataSchema,
    result: createAiAnalysisElementResultSchema(parsed.element).extend({
      evidence: legacyCurrentAiCacheEvidenceSchema,
    }),
  });
  const generation = generationSchema.parse(parsed.generation);
  if (parsed.cacheKey !== expectedCacheKey) {
    throw new TypeError("AI cacheのcache keyとファイル名が一致しません");
  }
  if (legacyCurrentCacheKey(parsed.element, generation.metadata) !== parsed.cacheKey) {
    throw new TypeError("AI cacheのmetadataとcache keyが一致しません");
  }
  if (hashCanonicalJson(generation.result) !== generation.metadata.outputHash) {
    throw new TypeError("AI cacheの出力hashが一致しません");
  }
  return Object.freeze({
    path,
    cacheKey: parsed.cacheKey,
    schemaVersion: "5",
  });
}

function parseCacheFile(
  path: string,
  source: string,
  expectedCacheKey: AiCacheKey,
):
  | Readonly<{
      status: "legacy";
      entry: LegacyAiCacheEntry;
    }>
  | Readonly<{
      status: "current";
      entry: AiCacheEntry;
    }>
  | Readonly<{
      status: "obsolete";
      entry: ObsoleteAiCacheEntry;
    }> {
  const value = parseJson(source);
  const legacyResult = legacyAiCacheEnvelopeSchema.safeParse(value);
  if (legacyResult.success) {
    return Object.freeze({
      status: "legacy",
      entry: parseLegacyAiCacheEntry(path, legacyResult.data, expectedCacheKey),
    });
  }
  const currentEnvelope = currentAiCacheEnvelopeSchema.safeParse(value);
  if (currentEnvelope.success) {
    const generationMetadata = z
      .object({
        metadata: z.object({
          schemaVersion: z.string(),
        }),
      })
      .safeParse(currentEnvelope.data.generation);
    if (generationMetadata.success && generationMetadata.data.metadata.schemaVersion === "5") {
      return Object.freeze({
        status: "obsolete",
        entry: parseObsoleteAiCacheEntry(path, value, expectedCacheKey),
      });
    }
  }
  const entry = createAiCacheEntry(value);
  if (entry.cacheKey !== expectedCacheKey) {
    throw new TypeError("AI cacheのcache keyとファイル名が一致しません");
  }
  return Object.freeze({
    status: "current",
    entry,
  });
}

/** 固定revisionのAI cacheを検証し、旧cache削除計画を作成する。 */
export function createAiCacheMigrationPlan(
  aiCacheDirectory: string,
  files: readonly AiCacheMigrationFile[],
): AiCacheMigrationPlan {
  assertValidStatePath(aiCacheDirectory);
  const sortedFiles = [...files].sort((left, right) => compareStrings(left.path, right.path));
  const seenPaths = new Set<string>();
  const legacyCachePaths: string[] = [];
  const legacyEntriesByCacheKey = new Map<AiCacheKey, LegacyAiCacheEntry>();
  const currentEntriesByCacheKey = new Map<AiCacheKey, AiCacheEntry>();
  const obsoleteCacheKeys = new Set<AiCacheKey>();
  const sourceSchemaVersions: string[] = [];
  const migratedSchemaVersions: string[] = [];
  for (const file of sortedFiles) {
    if (seenPaths.has(file.path)) {
      throw new StateFormatError("AI cache", {
        cause: new TypeError("AI cacheのpathが重複しています"),
      });
    }
    seenPaths.add(file.path);
    let expectedCacheKey: AiCacheKey;
    try {
      expectedCacheKey = cacheKeyFromPath(aiCacheDirectory, file.path);
      const parsed = parseCacheFile(file.path, file.source, expectedCacheKey);
      if (parsed.status === "legacy") {
        if (
          legacyEntriesByCacheKey.has(parsed.entry.cacheKey) ||
          currentEntriesByCacheKey.has(parsed.entry.cacheKey) ||
          obsoleteCacheKeys.has(parsed.entry.cacheKey)
        ) {
          throw new TypeError("AI cacheのcache keyが重複しています");
        }
        legacyEntriesByCacheKey.set(parsed.entry.cacheKey, parsed.entry);
        legacyCachePaths.push(file.path);
        sourceSchemaVersions.push(parsed.entry.metadata.schemaVersion);
        continue;
      }
      if (parsed.status === "obsolete") {
        if (
          legacyEntriesByCacheKey.has(parsed.entry.cacheKey) ||
          currentEntriesByCacheKey.has(parsed.entry.cacheKey) ||
          obsoleteCacheKeys.has(parsed.entry.cacheKey)
        ) {
          throw new TypeError("AI cacheのcache keyが重複しています");
        }
        obsoleteCacheKeys.add(parsed.entry.cacheKey);
        legacyCachePaths.push(parsed.entry.path);
        sourceSchemaVersions.push(parsed.entry.schemaVersion);
        continue;
      }
      if (
        legacyEntriesByCacheKey.has(parsed.entry.cacheKey) ||
        currentEntriesByCacheKey.has(parsed.entry.cacheKey) ||
        obsoleteCacheKeys.has(parsed.entry.cacheKey)
      ) {
        throw new TypeError("AI cacheのcache keyが重複しています");
      }
      currentEntriesByCacheKey.set(parsed.entry.cacheKey, parsed.entry);
      sourceSchemaVersions.push(parsed.entry.generation.metadata.schemaVersion);
      migratedSchemaVersions.push(parsed.entry.generation.metadata.schemaVersion);
    } catch (error: unknown) {
      throw createMigrationError(error);
    }
  }
  return Object.freeze({
    legacyCachePaths: Object.freeze(legacyCachePaths),
    legacyEntriesByCacheKey,
    currentEntriesByCacheKey,
    sourceSchemaVersions: uniqueSorted(sourceSchemaVersions),
    migratedSchemaVersions: uniqueSorted(migratedSchemaVersions),
  });
}
