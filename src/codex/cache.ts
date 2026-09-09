import { z } from "zod";

import {
  AI_ANALYSIS_ELEMENT_SCHEMA_VERSION,
  aiAnalysisElementGenerationSchema,
  aiAnalysisElementSchema,
  createAiAnalysisElementGeneration,
  createAiAnalysisElementGenerationSchema,
  type AiAnalysisElement,
  type AiAnalysisElementGeneration,
} from "./analysis-elements.js";
import { hashCanonicalJson, parseSha256Hash, type Sha256Hash } from "./canonical-json.js";
import { REASONING_EFFORTS, type AiCacheEntryId, type ReasoningEffort } from "../domain/index.js";

const sha256HashSchema = z
  .string()
  .regex(/^sha256:[0-9a-f]{64}$/u, "SHA-256 hashが不正です")
  .transform((value) => parseSha256Hash(value));
const cacheEntrySchema = z.strictObject({
  cacheKey: sha256HashSchema,
  element: aiAnalysisElementSchema,
  generation: aiAnalysisElementGenerationSchema,
});

/** 一つの要素のAI実行を再現する実行設定と入力識別情報。 */
export type AiCacheIdentity = Readonly<{
  element: AiAnalysisElement;
  revision: number;
  model: string;
  reasoningEffort: ReasoningEffort;
  backendVersion: string;
  schemaVersion: typeof AI_ANALYSIS_ELEMENT_SCHEMA_VERSION;
  inputFingerprint: Sha256Hash;
  executionFingerprint: Sha256Hash;
}>;

/** content-addressed AI cacheのkey。 */
export type AiCacheKey = AiCacheEntryId;

/** 一つのAI判定要素の結果と生成元を保持するcache entry。 */
export type AiCacheEntry = Readonly<{
  cacheKey: AiCacheKey;
  element: AiAnalysisElement;
  generation: AiAnalysisElementGeneration;
}>;

/** AI cacheの読み取り結果。 */
export type AiCacheReadResult =
  | Readonly<{
      status: "miss";
    }>
  | Readonly<{
      status: "hit";
      entry: AiCacheEntry;
    }>;

/** AI cacheの差し替え可能な読み書き境界。 */
export type AiCacheStore = Readonly<{
  read: (cacheKey: AiCacheKey) => Promise<AiCacheReadResult>;
  write: (entry: AiCacheEntry) => Promise<void>;
}>;

/** 読み出したcache entryの安全な再利用判定。 */
export type AiCacheReuseDecision =
  | Readonly<{
      status: "reusable";
      entry: AiCacheEntry;
    }>
  | Readonly<{
      status: "stale";
      reason:
        | "cache_key_changed"
        | "element_changed"
        | "revision_changed"
        | "model_changed"
        | "reasoning_effort_changed"
        | "backend_version_changed"
        | "input_fingerprint_changed"
        | "execution_fingerprint_changed";
    }>;

function freezeGeneration(generation: AiAnalysisElementGeneration): AiAnalysisElementGeneration {
  return Object.freeze(createAiAnalysisElementGeneration(generation));
}

function validateIdentity(identity: AiCacheIdentity): void {
  if (identity.element.length === 0) {
    throw new TypeError("AI cache identityのelementは空にできません");
  }
  if (!Number.isSafeInteger(identity.revision) || identity.revision <= 0) {
    throw new TypeError("AI cache identityのrevisionは正の安全な整数にしてください");
  }
  if (identity.model.length === 0) {
    throw new TypeError("AI cache identityのmodelは空にできません");
  }
  if (identity.backendVersion.length === 0) {
    throw new TypeError("AI cache identityのbackendVersionは空にできません");
  }
  if (identity.schemaVersion.length === 0) {
    throw new TypeError("AI cache identityのschemaVersionは空にできません");
  }
  if (!REASONING_EFFORTS.includes(identity.reasoningEffort)) {
    throw new TypeError("AI cache identityのreasoningEffortが不正です");
  }
  aiAnalysisElementSchema.parse(identity.element);
  parseSha256Hash(identity.inputFingerprint);
  parseSha256Hash(identity.executionFingerprint);
}

/** 要素revision、入力fingerprint、実行条件からcache keyを生成する。 */
export function createAiCacheKey(identity: AiCacheIdentity): AiCacheKey {
  validateIdentity(identity);
  return hashCanonicalJson({
    backendVersion: identity.backendVersion,
    element: identity.element,
    executionFingerprint: identity.executionFingerprint,
    inputFingerprint: identity.inputFingerprint,
    model: identity.model,
    reasoningEffort: identity.reasoningEffort,
    revision: identity.revision,
    schemaVersion: identity.schemaVersion,
  });
}

/** 未検証の値からAI cache entryを生成する。 */
export function createAiCacheEntry(value: unknown): AiCacheEntry {
  const parsed = cacheEntrySchema.parse(value);
  const generation = freezeGeneration(parsed.generation);
  const entry = Object.freeze({
    cacheKey: parsed.cacheKey,
    element: parsed.element,
    generation,
  });
  assertCacheIntegrity(entry);
  return entry;
}

/** 要素の実行条件と入力fingerprintが一致するcache entryだけを再利用する。 */
export function determineAiCacheReuse(
  entry: AiCacheEntry,
  identity: AiCacheIdentity,
): AiCacheReuseDecision {
  const expectedCacheKey = createAiCacheKey(identity);
  if (entry.cacheKey !== expectedCacheKey) {
    return Object.freeze({
      status: "stale",
      reason: "cache_key_changed",
    });
  }
  if (entry.element !== identity.element) {
    return Object.freeze({
      status: "stale",
      reason: "element_changed",
    });
  }
  const metadata = entry.generation.metadata;
  if (metadata.revision !== identity.revision) {
    return Object.freeze({
      status: "stale",
      reason: "revision_changed",
    });
  }
  if (metadata.model !== identity.model) {
    return Object.freeze({
      status: "stale",
      reason: "model_changed",
    });
  }
  if (metadata.reasoningEffort !== identity.reasoningEffort) {
    return Object.freeze({
      status: "stale",
      reason: "reasoning_effort_changed",
    });
  }
  if (metadata.backendVersion !== identity.backendVersion) {
    return Object.freeze({
      status: "stale",
      reason: "backend_version_changed",
    });
  }
  if (metadata.inputFingerprint !== identity.inputFingerprint) {
    return Object.freeze({
      status: "stale",
      reason: "input_fingerprint_changed",
    });
  }
  if (metadata.executionFingerprint !== identity.executionFingerprint) {
    return Object.freeze({
      status: "stale",
      reason: "execution_fingerprint_changed",
    });
  }
  return Object.freeze({
    status: "reusable",
    entry,
  });
}

function assertCacheIntegrity(entry: AiCacheEntry): void {
  const metadata = entry.generation.metadata;
  const metadataCacheKey = createAiCacheKey({
    element: entry.element,
    revision: metadata.revision,
    model: metadata.model,
    reasoningEffort: metadata.reasoningEffort,
    backendVersion: metadata.backendVersion,
    schemaVersion: metadata.schemaVersion,
    inputFingerprint: parseSha256Hash(metadata.inputFingerprint),
    executionFingerprint: parseSha256Hash(metadata.executionFingerprint),
  });
  if (metadataCacheKey !== entry.cacheKey) {
    throw new TypeError("AI cache entryのmetadataとcache keyが一致しません");
  }
  if (hashCanonicalJson(entry.generation.result) !== metadata.outputHash) {
    throw new TypeError("AI cache entryの出力hashが一致しません");
  }
  const parsedGeneration = createAiAnalysisElementGenerationSchema(entry.element).safeParse(
    entry.generation,
  );
  if (!parsedGeneration.success) {
    throw new TypeError("AI cache entryの生成記録が不正です", {
      cause: parsedGeneration.error,
    });
  }
}
