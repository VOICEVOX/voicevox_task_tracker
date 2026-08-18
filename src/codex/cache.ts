import { z } from "zod";

import { hashCanonicalJson, parseSha256Hash, type Sha256Hash } from "./canonical-json.js";
import {
  createUtcIsoDateTime,
  REASONING_EFFORTS,
  type AiCacheEntryId,
  type AnalysisMetadata,
  type ReasoningEffort,
} from "../domain/index.js";

const nonEmptyStringSchema = z.string().min(1, "空文字は指定できません");
const sha256HashSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/u, "SHA-256 hashが不正です");
const analysisMetadataSchema = z.strictObject({
  deterministicRulesVersion: nonEmptyStringSchema,
  model: nonEmptyStringSchema,
  reasoningEffort: z.enum(REASONING_EFFORTS),
  backendVersion: nonEmptyStringSchema,
  promptVersion: nonEmptyStringSchema,
  schemaVersion: nonEmptyStringSchema,
  inputHash: sha256HashSchema,
  outputHash: sha256HashSchema,
  executedAt: z.iso.datetime({
    offset: true,
    error: "タイムゾーンを含むISO 8601日時を指定してください",
  }),
});
const cacheEntrySchema = z.strictObject({
  cacheKey: sha256HashSchema,
  sourceHash: sha256HashSchema,
  metadata: analysisMetadataSchema,
  output: z.json(),
});

/** content-addressed cacheを構成する実行設定、versionと入力hash。 */
export type AiCacheIdentity = Readonly<{
  deterministicRulesVersion: string;
  model: string;
  reasoningEffort: ReasoningEffort;
  backendVersion: string;
  promptVersion: string;
  schemaVersion: string;
  inputHash: Sha256Hash;
}>;

/** content-addressed AI cacheのkey。 */
export type AiCacheKey = AiCacheEntryId;

/** 再現metadataとAI出力を保持するcache entry。 */
export type AiCacheEntry = Readonly<{
  cacheKey: AiCacheKey;
  sourceHash: Sha256Hash;
  metadata: AnalysisMetadata;
  output: unknown;
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
        | "source_hash_changed"
        | "deterministic_rules_version_changed"
        | "model_changed"
        | "reasoning_effort_changed"
        | "backend_version_changed"
        | "prompt_version_changed"
        | "schema_version_changed"
        | "input_hash_changed";
    }>;

function validateIdentity(identity: AiCacheIdentity): void {
  for (const [name, value] of Object.entries(identity)) {
    if (value.length === 0) {
      throw new TypeError(`AI cache identityの${name}は空にできません`);
    }
  }
  parseSha256Hash(identity.inputHash);
}

/** model、reasoning effort、各versionと正規化入力hashからcache keyを生成する。 */
export function createAiCacheKey(identity: AiCacheIdentity): AiCacheKey {
  validateIdentity(identity);
  return hashCanonicalJson({
    backendVersion: identity.backendVersion,
    deterministicRulesVersion: identity.deterministicRulesVersion,
    inputHash: identity.inputHash,
    model: identity.model,
    promptVersion: identity.promptVersion,
    reasoningEffort: identity.reasoningEffort,
    schemaVersion: identity.schemaVersion,
  });
}

/** 未検証の値からAI cache entryを生成する。 */
export function createAiCacheEntry(value: unknown): AiCacheEntry {
  const parsed = cacheEntrySchema.parse(value);
  const entry = Object.freeze({
    cacheKey: parseSha256Hash(parsed.cacheKey),
    sourceHash: parseSha256Hash(parsed.sourceHash),
    metadata: Object.freeze({
      deterministicRulesVersion: parsed.metadata.deterministicRulesVersion,
      model: parsed.metadata.model,
      reasoningEffort: parsed.metadata.reasoningEffort,
      backendVersion: parsed.metadata.backendVersion,
      promptVersion: parsed.metadata.promptVersion,
      schemaVersion: parsed.metadata.schemaVersion,
      inputHash: parseSha256Hash(parsed.metadata.inputHash),
      outputHash: parseSha256Hash(parsed.metadata.outputHash),
      executedAt: createUtcIsoDateTime(parsed.metadata.executedAt),
    }),
    output: parsed.output,
  });
  assertCacheIntegrity(entry);
  return entry;
}

/** sourceと入力hashが一致するcache entryだけを再利用対象にする。 */
export function determineAiCacheReuse(
  entry: AiCacheEntry,
  identity: AiCacheIdentity,
  sourceHash: Sha256Hash,
): AiCacheReuseDecision {
  const expectedCacheKey = createAiCacheKey(identity);
  if (entry.cacheKey !== expectedCacheKey) {
    return Object.freeze({
      status: "stale",
      reason: "cache_key_changed",
    });
  }
  if (entry.sourceHash !== sourceHash) {
    return Object.freeze({
      status: "stale",
      reason: "source_hash_changed",
    });
  }
  if (entry.metadata.deterministicRulesVersion !== identity.deterministicRulesVersion) {
    return Object.freeze({
      status: "stale",
      reason: "deterministic_rules_version_changed",
    });
  }
  if (entry.metadata.model !== identity.model) {
    return Object.freeze({
      status: "stale",
      reason: "model_changed",
    });
  }
  if (entry.metadata.reasoningEffort !== identity.reasoningEffort) {
    return Object.freeze({
      status: "stale",
      reason: "reasoning_effort_changed",
    });
  }
  if (entry.metadata.backendVersion !== identity.backendVersion) {
    return Object.freeze({
      status: "stale",
      reason: "backend_version_changed",
    });
  }
  if (entry.metadata.promptVersion !== identity.promptVersion) {
    return Object.freeze({
      status: "stale",
      reason: "prompt_version_changed",
    });
  }
  if (entry.metadata.schemaVersion !== identity.schemaVersion) {
    return Object.freeze({
      status: "stale",
      reason: "schema_version_changed",
    });
  }
  if (entry.metadata.inputHash !== identity.inputHash) {
    return Object.freeze({
      status: "stale",
      reason: "input_hash_changed",
    });
  }
  return Object.freeze({
    status: "reusable",
    entry,
  });
}

function assertCacheIntegrity(entry: AiCacheEntry): void {
  const metadataCacheKey = createAiCacheKey({
    deterministicRulesVersion: entry.metadata.deterministicRulesVersion,
    model: entry.metadata.model,
    reasoningEffort: entry.metadata.reasoningEffort,
    backendVersion: entry.metadata.backendVersion,
    promptVersion: entry.metadata.promptVersion,
    schemaVersion: entry.metadata.schemaVersion,
    inputHash: parseSha256Hash(entry.metadata.inputHash),
  });
  if (metadataCacheKey !== entry.cacheKey) {
    throw new TypeError("AI cache entryのmetadataとcache keyが一致しません");
  }
  if (hashCanonicalJson(entry.output) !== entry.metadata.outputHash) {
    throw new TypeError("AI cache entryの出力hashが一致しません");
  }
}
