import { z } from "zod";

import {
  PERSONAL_REMINDER_AI_INPUT_SCHEMA_VERSION,
  PERSONAL_REMINDER_AI_GENERATION_SCHEMA_VERSION,
  PERSONAL_REMINDER_AI_OUTPUT_SCHEMA_VERSION,
  PERSONAL_REMINDER_AI_PROMPT_VERSION,
  PERSONAL_REMINDER_AI_REVISION,
  PERSONAL_REMINDER_ASSESSMENT_RULES_VERSION,
  personalReminderAiGenerationSchema,
  personalReminderCauseIdSchema,
  type PersonalReminderAiGeneration,
  type PersonalReminderCauseId,
} from "../domain/personal-reminder-causes.js";
import {
  type AiAnalysisElementExecutionFingerprint,
  type AiAnalysisElementInputFingerprint,
} from "../domain/ai-analysis-elements.js";
import { REASONING_EFFORTS, type AiCacheEntryId, type ReasoningEffort } from "../domain/types.js";
import { hashCanonicalJson, parseSha256Hash } from "./canonical-json.js";

const aiCacheEntryIdSchema = z.custom<AiCacheEntryId>(
  (value) => typeof value === "string" && /^sha256:[0-9a-f]{64}$/u.test(value),
  "AI cache entry IDはSHA-256形式にしてください",
);

const personalReminderAiCacheEntrySchema = z.strictObject({
  cacheKey: aiCacheEntryIdSchema,
  causeId: personalReminderCauseIdSchema,
  generation: personalReminderAiGenerationSchema,
});

/** 個人催促AIを再現するcause単位の実行条件と入力識別情報。 */
export type PersonalReminderAiCacheIdentity = Readonly<{
  causeId: PersonalReminderCauseId;
  revision: typeof PERSONAL_REMINDER_AI_REVISION;
  rulesVersion: typeof PERSONAL_REMINDER_ASSESSMENT_RULES_VERSION;
  model: string;
  reasoningEffort: ReasoningEffort;
  backendVersion: string;
  schemaVersion: typeof PERSONAL_REMINDER_AI_GENERATION_SCHEMA_VERSION;
  inputFingerprint: AiAnalysisElementInputFingerprint;
  executionFingerprint: AiAnalysisElementExecutionFingerprint;
}>;

/** 個人催促AI cacheのkey。 */
export type PersonalReminderAiCacheKey = AiCacheEntryId;

/** 個人催促AIのcause単位generationとcache key。 */
export type PersonalReminderAiCacheEntry = Readonly<{
  cacheKey: PersonalReminderAiCacheKey;
  causeId: PersonalReminderCauseId;
  generation: PersonalReminderAiGeneration;
}>;

/** 個人催促AI cacheの読み取り結果。 */
export type PersonalReminderAiCacheReadResult =
  Readonly<{ status: "miss" }> | Readonly<{ status: "hit"; entry: PersonalReminderAiCacheEntry }>;

/** 個人催促AI cacheの読み書き境界。 */
export type PersonalReminderAiCacheStore = Readonly<{
  read: (cacheKey: PersonalReminderAiCacheKey) => Promise<PersonalReminderAiCacheReadResult>;
  write: (entry: PersonalReminderAiCacheEntry) => Promise<void>;
}>;

/** 読み出した個人催促AI cache entryの再利用判定。 */
export type PersonalReminderAiCacheReuseDecision =
  | Readonly<{ status: "reusable"; entry: PersonalReminderAiCacheEntry }>
  | Readonly<{
      status: "stale";
      reason:
        | "cache_key_changed"
        | "cause_changed"
        | "revision_changed"
        | "rules_version_changed"
        | "schema_version_changed"
        | "model_changed"
        | "reasoning_effort_changed"
        | "backend_version_changed"
        | "input_fingerprint_changed"
        | "execution_fingerprint_changed";
    }>;

function validateIdentity(identity: PersonalReminderAiCacheIdentity): void {
  personalReminderCauseIdSchema.parse(identity.causeId);
  if (identity.model.length === 0 || identity.backendVersion.length === 0) {
    throw new TypeError("個人催促AI cache identityの実行条件が空です");
  }
  if (!REASONING_EFFORTS.includes(identity.reasoningEffort)) {
    throw new TypeError("個人催促AI cache identityのreasoningEffortが不正です");
  }
  parseSha256Hash(identity.inputFingerprint);
  parseSha256Hash(identity.executionFingerprint);
}

function createPersonalReminderAiPromptFingerprint(
  input: Readonly<{
    batchInputFingerprint: AiAnalysisElementInputFingerprint;
    promptVersion: string;
  }>,
): AiAnalysisElementInputFingerprint {
  parseSha256Hash(input.batchInputFingerprint);
  if (input.promptVersion.length === 0) {
    throw new TypeError("個人催促AIのprompt versionが空です");
  }
  return hashCanonicalJson({
    batchInputFingerprint: input.batchInputFingerprint,
    promptVersion: input.promptVersion,
  });
}

/** 個人催促AIのcause、入力、実行条件からcache keyを生成する。 */
export function createPersonalReminderAiCacheKey(
  identity: PersonalReminderAiCacheIdentity,
): PersonalReminderAiCacheKey {
  validateIdentity(identity);
  return hashCanonicalJson({
    backendVersion: identity.backendVersion,
    causeId: identity.causeId,
    executionFingerprint: identity.executionFingerprint,
    inputFingerprint: identity.inputFingerprint,
    model: identity.model,
    reasoningEffort: identity.reasoningEffort,
    revision: identity.revision,
    rulesVersion: identity.rulesVersion,
    schemaVersion: identity.schemaVersion,
  });
}

/** 個人催促AIの実行条件から実行fingerprintを生成する。 */
export function createPersonalReminderAiExecutionFingerprint(
  input: Readonly<{
    model: string;
    reasoningEffort: ReasoningEffort;
    backendVersion: string;
    promptVersion: string;
  }>,
): AiAnalysisElementExecutionFingerprint {
  if (
    input.model.length === 0 ||
    input.backendVersion.length === 0 ||
    input.promptVersion.length === 0
  ) {
    throw new TypeError("個人催促AIの実行fingerprint入力が空です");
  }
  if (!REASONING_EFFORTS.includes(input.reasoningEffort)) {
    throw new TypeError("個人催促AIの実行fingerprintのreasoningEffortが不正です");
  }
  return hashCanonicalJson({
    backendVersion: input.backendVersion,
    inputSchemaVersion: PERSONAL_REMINDER_AI_INPUT_SCHEMA_VERSION,
    model: input.model,
    outputSchemaVersion: PERSONAL_REMINDER_AI_OUTPUT_SCHEMA_VERSION,
    promptVersion: input.promptVersion,
    reasoningEffort: input.reasoningEffort,
    revision: PERSONAL_REMINDER_AI_REVISION,
    schemaVersion: PERSONAL_REMINDER_AI_GENERATION_SCHEMA_VERSION,
  });
}

/** 未検証の値から個人催促AI cache entryを作成する。 */
export function createPersonalReminderAiCacheEntry(value: unknown): PersonalReminderAiCacheEntry {
  const parsed = personalReminderAiCacheEntrySchema.parse(value);
  const entry = Object.freeze({
    cacheKey: parsed.cacheKey,
    causeId: parsed.causeId,
    generation: Object.freeze({
      metadata: Object.freeze({ ...parsed.generation.metadata }),
      result: parsed.generation.result,
    }),
  });
  assertPersonalReminderAiCacheIntegrity(entry);
  return entry;
}

/** 個人催促AIの実行条件と入力fingerprintが一致するcache entryだけを再利用する。 */
export function determinePersonalReminderAiCacheReuse(
  entry: PersonalReminderAiCacheEntry,
  identity: PersonalReminderAiCacheIdentity,
): PersonalReminderAiCacheReuseDecision {
  const metadata = entry.generation.metadata;
  if (metadata.rulesVersion !== identity.rulesVersion) {
    return Object.freeze({ status: "stale", reason: "rules_version_changed" });
  }
  const expectedCacheKey = createPersonalReminderAiCacheKey(identity);
  if (entry.cacheKey !== expectedCacheKey) {
    return Object.freeze({ status: "stale", reason: "cache_key_changed" });
  }
  if (entry.causeId !== identity.causeId) {
    return Object.freeze({ status: "stale", reason: "cause_changed" });
  }
  if (metadata.revision !== identity.revision) {
    return Object.freeze({ status: "stale", reason: "revision_changed" });
  }
  if (metadata.model !== identity.model) {
    return Object.freeze({ status: "stale", reason: "model_changed" });
  }
  if (metadata.reasoningEffort !== identity.reasoningEffort) {
    return Object.freeze({ status: "stale", reason: "reasoning_effort_changed" });
  }
  if (metadata.backendVersion !== identity.backendVersion) {
    return Object.freeze({ status: "stale", reason: "backend_version_changed" });
  }
  if (metadata.inputFingerprint !== identity.inputFingerprint) {
    return Object.freeze({ status: "stale", reason: "input_fingerprint_changed" });
  }
  if (metadata.executionFingerprint !== identity.executionFingerprint) {
    return Object.freeze({ status: "stale", reason: "execution_fingerprint_changed" });
  }
  return Object.freeze({ status: "reusable", entry });
}

function assertPersonalReminderAiCacheIntegrity(entry: PersonalReminderAiCacheEntry): void {
  const metadata = entry.generation.metadata;
  const expectedCacheKey = hashCanonicalJson({
    backendVersion: metadata.backendVersion,
    causeId: entry.causeId,
    executionFingerprint: metadata.executionFingerprint,
    inputFingerprint: metadata.inputFingerprint,
    model: metadata.model,
    reasoningEffort: metadata.reasoningEffort,
    revision: metadata.revision,
    rulesVersion: metadata.rulesVersion,
    schemaVersion: metadata.schemaVersion,
  });
  if (expectedCacheKey !== entry.cacheKey) {
    throw new TypeError("個人催促AI cache entryのmetadataとcache keyが一致しません");
  }
  if (hashCanonicalJson(entry.generation.result) !== metadata.outputHash) {
    throw new TypeError("個人催促AI cache entryの出力hashが一致しません");
  }
  const expectedPromptFingerprint = createPersonalReminderAiPromptFingerprint({
    batchInputFingerprint: metadata.batchInputFingerprint,
    promptVersion: PERSONAL_REMINDER_AI_PROMPT_VERSION,
  });
  if (expectedPromptFingerprint !== metadata.promptFingerprint) {
    throw new TypeError("個人催促AI cache entryのprompt fingerprintが一致しません");
  }
}
