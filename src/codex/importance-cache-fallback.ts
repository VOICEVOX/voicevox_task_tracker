import { z } from "zod";

import {
  createGitHubNodeId,
  createGitHubRepositoryId,
  createUtcIsoDateTime,
  REASONING_EFFORTS,
  type AnalysisMetadata,
  type GitHubNodeId,
  type UtcIsoDateTime,
} from "../domain/index.js";
import {
  CACHE_DOCUMENT_SCHEMA_VERSION,
  createCacheDocument,
  type AiLatestImportanceCacheDocument,
  type CacheRepositoryIdentity,
} from "../persistence/cache-documents.js";
import { createAiCacheEntry, createAiCacheKey, type AiCacheKey } from "./cache.js";
import {
  hashCanonicalJson,
  parseSha256Hash,
  serializeCanonicalJson,
  type Sha256Hash,
} from "./canonical-json.js";
import { type CodexAnalysisInput } from "./input.js";
import { validateCodexAnalysisOutput } from "./output-validation.js";
import {
  validateCodexAnalysisOutputAgainstCacheContext,
  type CodexCacheValidationContext,
} from "./semantic-validation.js";

const repositorySchema = z.strictObject({
  repositoryId: z.string().min(1),
  owner: z.string().min(1),
  name: z.string().min(1),
});

const importanceSchema = z.strictObject({
  significantFeature: z.boolean(),
  explicitDeadline: z.boolean(),
  futureRisk: z.boolean(),
  rationale: z.string().min(1).max(120),
});

const fingerprintSchema = z.strictObject({
  sourceHash: z.string().min(1),
  inputHash: z.string().min(1),
  identityHash: z.string().min(1),
});

const cacheMetadataSchema = z.strictObject({
  deterministicRulesVersion: z.string().min(1),
  model: z.string().min(1),
  reasoningEffort: z.enum(REASONING_EFFORTS),
  backendVersion: z.string().min(1),
  promptVersion: z.string().min(1),
  schemaVersion: z.string().min(1),
  inputHash: z.string().min(1),
  outputHash: z.string().min(1),
  executedAt: z.string().min(1),
});

const cacheEntryReferenceShape = z.strictObject({
  cacheKey: z.string().min(1),
  sourceHash: z.string().min(1),
  nodeId: z.string().min(1),
  repository: repositorySchema,
  importance: importanceSchema,
  confidence: z.number().min(0).max(1),
  metadata: cacheMetadataSchema,
});

const verifiedResultShape = z.strictObject({
  nodeId: z.string().min(1),
  repository: repositorySchema,
  importance: importanceSchema,
  confidence: z.number().min(0).max(1),
  fingerprint: fingerprintSchema,
  entry: cacheEntryReferenceShape,
});

const cacheStateShape = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("available"), document: z.unknown() }),
  z.strictObject({ status: z.literal("not_available") }),
]);

const aiRunStateShape = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("available"), result: verifiedResultShape }),
  z.strictObject({ status: z.literal("execution_failed") }),
  z.strictObject({ status: z.literal("budget_deferred") }),
]);

const contextShape = z.strictObject({
  nodeId: z.string().min(1),
  repository: repositorySchema,
  repositoryAllowlist: z.array(repositorySchema),
  evaluatedAt: z.string().min(1),
  aiCacheEntries: z.array(z.unknown()),
});

const resolutionInputShape = z.strictObject({
  context: contextShape,
  current: aiRunStateShape,
  latest: cacheStateShape,
});

const candidateInputShape = z.strictObject({
  context: contextShape,
  current: verifiedResultShape,
  previous: cacheStateShape,
});

/** AIキャッシュの検証に使うリポジトリ識別子を表す。 */
export type ImportanceCacheRepository = CacheRepositoryIdentity;

/** AIキャッシュの参照を許可するリポジトリ一覧を表す。 */
export type ImportanceCacheRepositoryAllowlist = readonly ImportanceCacheRepository[];

/** AI出力を含めず重要度キャッシュの整合に必要な情報だけを表す。 */
export type ImportanceCacheEntry = Readonly<{
  cacheKey: AiCacheKey;
  sourceHash: Sha256Hash;
  nodeId: GitHubNodeId;
  repository: ImportanceCacheRepository;
  importance: Readonly<{
    significantFeature: boolean;
    explicitDeadline: boolean;
    futureRisk: boolean;
    rationale: string;
  }>;
  confidence: number;
  metadata: AnalysisMetadata;
}>;

/** 重要度キャッシュの検証に必要な実行時文脈を表す。 */
export type ImportanceCacheContext = Readonly<{
  nodeId: GitHubNodeId;
  repository: ImportanceCacheRepository;
  repositoryAllowlist: ImportanceCacheRepositoryAllowlist;
  evaluatedAt: UtcIsoDateTime;
  aiCacheEntries: readonly ImportanceCacheEntry[];
}>;

/** AI入力と紐付く重要度キャッシュの指紋を表す。 */
export type ImportanceCacheFingerprint = Readonly<{
  sourceHash: Sha256Hash;
  inputHash: Sha256Hash;
  identityHash: Sha256Hash;
}>;

/** 検証済みAI結果から重要度キャッシュへ保存する値を表す。 */
export type VerifiedImportanceResult = Readonly<{
  nodeId: GitHubNodeId;
  repository: ImportanceCacheRepository;
  importance: Readonly<{
    significantFeature: boolean;
    explicitDeadline: boolean;
    futureRisk: boolean;
    rationale: string;
  }>;
  confidence: number;
  fingerprint: ImportanceCacheFingerprint;
  entry: ImportanceCacheEntry;
}>;

/** 現在のAI処理結果または代替判定へ移る理由を表す。 */
export type ImportanceAiRunState =
  | Readonly<{ status: "available"; result: VerifiedImportanceResult }>
  | Readonly<{ status: "execution_failed" }>
  | Readonly<{ status: "budget_deferred" }>;

/** 重要度キャッシュの有無を表す。 */
export type ImportanceCacheState =
  | Readonly<{ status: "available"; document: AiLatestImportanceCacheDocument }>
  | Readonly<{ status: "not_available" }>;

/** 重要度の代替利用に必要な入力を表す。 */
export type ResolveImportanceInput = Readonly<{
  context: ImportanceCacheContext;
  current: ImportanceAiRunState;
  latest: ImportanceCacheState;
}>;

/** 重要度の代替利用結果を表す。 */
export type ImportanceResolution =
  | Readonly<{
      status: "normal";
      source: "current_validated_ai";
      importance: VerifiedImportanceResult["importance"];
    }>
  | Readonly<{
      status: "fallback";
      source: "latest_importance_cache";
      importance: VerifiedImportanceResult["importance"];
    }>
  | Readonly<{
      status: "not_available";
      reason: "latest_importance_cache_missing";
    }>;

/** 最新重要度キャッシュ候補の作成に必要な入力を表す。 */
export type CreateImportanceCacheCandidateInput = Readonly<{
  context: ImportanceCacheContext;
  current: VerifiedImportanceResult;
  previous: ImportanceCacheState;
}>;

/** 同一nodeの重要度entryから最新を選んだ結果を表す。 */
export type LatestImportanceCacheEntrySelection =
  | Readonly<{ status: "available"; entry: ImportanceCacheEntry }>
  | Readonly<{ status: "not_available" }>;

type ValidatedContext = Readonly<{
  nodeId: GitHubNodeId;
  repository: ImportanceCacheRepository;
  repositoryAllowlist: ImportanceCacheRepositoryAllowlist;
  evaluatedAt: UtcIsoDateTime;
  aiCacheEntries: readonly ImportanceCacheEntry[];
}>;

function parseInput<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw result.error;
  }
  return result.data;
}

function validateRepository(repository: unknown): ImportanceCacheRepository {
  const parsed = parseInput<z.infer<typeof repositorySchema>>(repositorySchema, repository);
  return {
    repositoryId: createGitHubRepositoryId(parsed.repositoryId),
    owner: parsed.owner,
    name: parsed.name,
  };
}

function validateNodeId(nodeId: unknown): GitHubNodeId {
  return createGitHubNodeId(parseInput<string>(z.string().min(1), nodeId));
}

function validateTime(value: unknown): UtcIsoDateTime {
  const parsed = createUtcIsoDateTime(parseInput<string>(z.string().min(1), value));
  if (parsed !== value) {
    throw new Error("日時は正規化済みのISO日時でなければなりません");
  }
  return parsed;
}

function createValidatedImportanceCacheEntry(
  entry: ReturnType<typeof createAiCacheEntry>,
  output: ReturnType<typeof createAiCacheEntry>["output"],
): ImportanceCacheEntry {
  return {
    cacheKey: entry.cacheKey,
    sourceHash: entry.sourceHash,
    nodeId: validateNodeId(entry.nodeId),
    repository: validateRepository(entry.repository),
    importance: validateImportance(output.importance),
    confidence: output.confidence,
    metadata: entry.metadata,
  };
}

/** AI entry自身の縮約済み識別情報と出力schemaから重要度用entryを再構築する。 */
export function createImportanceCacheEntryFromAiResult(value: unknown): ImportanceCacheEntry {
  const entry = createAiCacheEntry(value);
  if (entry.nodeId !== entry.output.item.nodeId) {
    throw new Error("AIエントリのnode IDが出力と一致しません");
  }
  return createValidatedImportanceCacheEntry(entry, entry.output);
}

/** 完全なAI cache entryを現在のAI入力で検証して重要度用へ縮約する。 */
export function createImportanceCacheEntry(
  value: unknown,
  input: CodexAnalysisInput,
): ImportanceCacheEntry {
  const entry = createAiCacheEntry(value);
  const output = validateCodexAnalysisOutput(entry.output, input);
  if (entry.nodeId !== output.item.nodeId) {
    throw new Error("AIエントリのnode IDが出力と一致しません");
  }
  return createValidatedImportanceCacheEntry(entry, output);
}

/** raw非保持cache contextで再検証したAI entryを重要度用へ縮約する。 */
export function createImportanceCacheEntryFromCacheContext(
  value: unknown,
  context: CodexCacheValidationContext,
): ImportanceCacheEntry {
  const entry = createAiCacheEntry(value);
  const output = validateCodexAnalysisOutputAgainstCacheContext(entry.output, context);
  if (entry.nodeId !== output.item.nodeId) {
    throw new Error("AIエントリのnode IDが出力と一致しません");
  }
  return createValidatedImportanceCacheEntry(entry, output);
}

/** latest importance文書と完全なAI entryを照合して重要度用へ縮約する。 */
export function createImportanceCacheEntryFromLatest(
  value: unknown,
  latestValue: unknown,
): ImportanceCacheEntry {
  const entry = createAiCacheEntry(value);
  const latest = createCacheDocument(latestValue);
  if (latest.kind !== "ai_latest_importance") {
    throw new Error("重要度キャッシュ文書の種別が不正です");
  }
  const reduced = createImportanceCacheEntryFromAiResult(entry);
  const reference = latest.aiCacheReference;
  if (
    reduced.cacheKey !== reference.cacheKey ||
    reduced.sourceHash !== reference.sourceHash ||
    reduced.metadata.inputHash !== reference.inputHash ||
    calculateIdentityHash(reduced) !== reference.identityHash
  ) {
    throw new Error("重要度キャッシュのAI参照がAIエントリと一致しません");
  }
  if (reduced.nodeId !== latest.nodeId) {
    throw new Error("重要度キャッシュのnode IDがAIエントリと一致しません");
  }
  if (
    reduced.repository.repositoryId !== latest.repository.repositoryId ||
    reduced.repository.owner !== latest.repository.owner ||
    reduced.repository.name !== latest.repository.name
  ) {
    throw new Error("重要度キャッシュのリポジトリがAIエントリと一致しません");
  }
  if (!importanceEquals(reduced.importance, latest.importance)) {
    throw new Error("重要度キャッシュの重要度がAIエントリと一致しません");
  }
  if (reduced.confidence !== latest.confidence) {
    throw new Error("重要度キャッシュのconfidenceがAIエントリと一致しません");
  }
  if (
    reduced.metadata.deterministicRulesVersion !== latest.metadata.deterministicRulesVersion ||
    reduced.metadata.model !== latest.metadata.model ||
    reduced.metadata.reasoningEffort !== latest.metadata.reasoningEffort ||
    reduced.metadata.backendVersion !== latest.metadata.backendVersion ||
    reduced.metadata.promptVersion !== latest.metadata.promptVersion ||
    reduced.metadata.schemaVersion !== latest.metadata.analysisSchemaVersion ||
    reduced.metadata.executedAt !== latest.metadata.executedAt
  ) {
    throw new Error("重要度キャッシュのメタデータがAIエントリと一致しません");
  }
  return reduced;
}

function validateCacheEntry(value: unknown): ImportanceCacheEntry {
  const parsed = parseInput<z.infer<typeof cacheEntryReferenceShape>>(
    cacheEntryReferenceShape,
    value,
  );
  const cacheKey = parseSha256Hash(parsed.cacheKey);
  const metadata: AnalysisMetadata = {
    deterministicRulesVersion: parsed.metadata.deterministicRulesVersion,
    model: parsed.metadata.model,
    reasoningEffort: parsed.metadata.reasoningEffort,
    backendVersion: parsed.metadata.backendVersion,
    promptVersion: parsed.metadata.promptVersion,
    schemaVersion: parsed.metadata.schemaVersion,
    inputHash: parseSha256Hash(parsed.metadata.inputHash),
    outputHash: parseSha256Hash(parsed.metadata.outputHash),
    executedAt: createUtcIsoDateTime(parsed.metadata.executedAt),
  };
  const expectedCacheKey = createAiCacheKey({
    deterministicRulesVersion: metadata.deterministicRulesVersion,
    model: metadata.model,
    reasoningEffort: metadata.reasoningEffort,
    backendVersion: metadata.backendVersion,
    promptVersion: metadata.promptVersion,
    schemaVersion: metadata.schemaVersion,
    inputHash: parseSha256Hash(metadata.inputHash),
  });
  if (cacheKey !== expectedCacheKey) {
    throw new Error("AIエントリのcache keyがメタデータと一致しません");
  }
  return {
    cacheKey,
    sourceHash: parseSha256Hash(parsed.sourceHash),
    nodeId: validateNodeId(parsed.nodeId),
    repository: validateRepository(parsed.repository),
    importance: validateImportance(parsed.importance),
    confidence: parsed.confidence,
    metadata,
  };
}

function compareTimes(left: UtcIsoDateTime, right: UtcIsoDateTime): number {
  const leftMilliseconds = Date.parse(left);
  const rightMilliseconds = Date.parse(right);
  if (Number.isNaN(leftMilliseconds) || Number.isNaN(rightMilliseconds)) {
    throw new Error("日時を比較できません");
  }
  return leftMilliseconds - rightMilliseconds;
}

/** 実行時刻とcache keyの安定順で最新の重要度entryを選ぶ。 */
export function selectLatestImportanceCacheEntry(
  values: readonly unknown[],
): LatestImportanceCacheEntrySelection {
  const entries = values.map(validateCacheEntry);
  const cacheKeys = new Set<AiCacheKey>();
  for (const entry of entries) {
    if (cacheKeys.has(entry.cacheKey)) {
      throw new Error(`最新重要度候補のAI cache keyが重複しています。対象: ${entry.cacheKey}`);
    }
    cacheKeys.add(entry.cacheKey);
  }
  entries.sort((left, right) => {
    const timeComparison = compareTimes(right.metadata.executedAt, left.metadata.executedAt);
    if (timeComparison !== 0) {
      return timeComparison;
    }
    return left.cacheKey < right.cacheKey ? -1 : left.cacheKey > right.cacheKey ? 1 : 0;
  });
  const entry = entries[0];
  return entry == null
    ? Object.freeze({ status: "not_available" })
    : Object.freeze({ status: "available", entry });
}

function validateContext(context: unknown): ValidatedContext {
  const parsed = parseInput<z.infer<typeof contextShape>>(contextShape, context);
  const nodeId = validateNodeId(parsed.nodeId);
  const repository = validateRepository(parsed.repository);
  const repositoryAllowlist = parsed.repositoryAllowlist.map(validateRepository);
  const evaluatedAt = validateTime(parsed.evaluatedAt);
  const matchingRepositories = repositoryAllowlist.filter(
    (allowedRepository) => allowedRepository.repositoryId === repository.repositoryId,
  );
  if (matchingRepositories.length !== 1) {
    throw new Error("対象リポジトリが公開許可一覧と一致しません");
  }
  const matchingRepository = matchingRepositories.at(0);
  if (matchingRepository == null) {
    throw new Error("対象リポジトリが公開許可一覧と一致しません");
  }
  if (
    matchingRepository.owner !== repository.owner ||
    matchingRepository.name !== repository.name
  ) {
    throw new Error("対象リポジトリの所有者または名前が公開許可一覧と一致しません");
  }

  const aiCacheEntries = parsed.aiCacheEntries.map(validateCacheEntry);
  const cacheKeys = new Set<string>();
  for (const entry of aiCacheEntries) {
    if (cacheKeys.has(entry.cacheKey)) {
      throw new Error("AIキャッシュキーが重複しています");
    }
    cacheKeys.add(entry.cacheKey);
    if (compareTimes(entry.metadata.executedAt, evaluatedAt) > 0) {
      throw new Error("評価時刻より新しいAIキャッシュは利用できません");
    }
    if (
      entry.nodeId !== nodeId ||
      entry.repository.repositoryId !== repository.repositoryId ||
      entry.repository.owner !== repository.owner ||
      entry.repository.name !== repository.name
    ) {
      throw new Error("AIキャッシュの項目またはリポジトリが対象と一致しません");
    }
  }

  return { nodeId, repository, repositoryAllowlist, evaluatedAt, aiCacheEntries };
}

function validateImportance(value: unknown): VerifiedImportanceResult["importance"] {
  return parseInput<z.infer<typeof importanceSchema>>(importanceSchema, value);
}

function importanceEquals(
  left: VerifiedImportanceResult["importance"],
  right: VerifiedImportanceResult["importance"],
): boolean {
  return (
    left.significantFeature === right.significantFeature &&
    left.explicitDeadline === right.explicitDeadline &&
    left.futureRisk === right.futureRisk &&
    left.rationale === right.rationale
  );
}

function validateFingerprint(value: unknown): ImportanceCacheFingerprint {
  const parsed = parseInput<z.infer<typeof fingerprintSchema>>(fingerprintSchema, value);
  return {
    sourceHash: parseSha256Hash(parsed.sourceHash),
    inputHash: parseSha256Hash(parsed.inputHash),
    identityHash: parseSha256Hash(parsed.identityHash),
  };
}

function calculateIdentityHash(entry: ImportanceCacheEntry): Sha256Hash {
  return hashCanonicalJson({
    backendVersion: entry.metadata.backendVersion,
    deterministicRulesVersion: entry.metadata.deterministicRulesVersion,
    model: entry.metadata.model,
    promptVersion: entry.metadata.promptVersion,
    reasoningEffort: entry.metadata.reasoningEffort,
    schemaVersion: entry.metadata.schemaVersion,
  });
}

function validateVerifiedResult(
  result: unknown,
  context: ValidatedContext,
): VerifiedImportanceResult {
  const parsed = parseInput<z.infer<typeof verifiedResultShape>>(verifiedResultShape, result);
  const nodeId = validateNodeId(parsed.nodeId);
  if (nodeId !== context.nodeId) {
    throw new Error("AI結果のnode IDが対象と一致しません");
  }
  const repository = validateRepository(parsed.repository);
  if (
    repository.repositoryId !== context.repository.repositoryId ||
    repository.owner !== context.repository.owner ||
    repository.name !== context.repository.name
  ) {
    throw new Error("AI結果のリポジトリが対象と一致しません");
  }
  const importance = validateImportance(parsed.importance);
  const confidence = parsed.confidence;
  const fingerprint = validateFingerprint(parsed.fingerprint);
  const entry = validateCacheEntry(parsed.entry);
  if (entry.nodeId !== nodeId) {
    throw new Error("AIエントリのnode IDが結果と一致しません");
  }
  if (
    entry.repository.repositoryId !== repository.repositoryId ||
    entry.repository.owner !== repository.owner ||
    entry.repository.name !== repository.name
  ) {
    throw new Error("AIエントリのリポジトリが結果と一致しません");
  }
  if (!importanceEquals(entry.importance, importance)) {
    throw new Error("AIエントリの重要度が結果と一致しません");
  }
  if (entry.confidence !== confidence) {
    throw new Error("AIエントリのconfidenceが結果と一致しません");
  }
  if (entry.sourceHash !== fingerprint.sourceHash) {
    throw new Error("AI結果のsource hashがキャッシュと一致しません");
  }
  if (entry.metadata.inputHash !== fingerprint.inputHash) {
    throw new Error("AI結果のinput hashがキャッシュと一致しません");
  }
  if (calculateIdentityHash(entry) !== fingerprint.identityHash) {
    throw new Error("AI結果のidentity hashがキャッシュと一致しません");
  }
  const expectedCacheKey = createAiCacheKey({
    deterministicRulesVersion: entry.metadata.deterministicRulesVersion,
    model: entry.metadata.model,
    reasoningEffort: entry.metadata.reasoningEffort,
    backendVersion: entry.metadata.backendVersion,
    promptVersion: entry.metadata.promptVersion,
    schemaVersion: entry.metadata.schemaVersion,
    inputHash: parseSha256Hash(entry.metadata.inputHash),
  });
  if (expectedCacheKey !== entry.cacheKey) {
    throw new Error("AI結果のcache keyがメタデータと一致しません");
  }
  if (compareTimes(entry.metadata.executedAt, context.evaluatedAt) > 0) {
    throw new Error("評価時刻より新しいAI結果は利用できません");
  }
  return { nodeId, repository, importance, confidence, fingerprint, entry };
}

function validateLatestCache(
  state: unknown,
  context: ValidatedContext,
): AiLatestImportanceCacheDocument {
  const parsedState = parseInput<z.infer<typeof cacheStateShape>>(cacheStateShape, state);
  if (parsedState.status !== "available") {
    throw new Error("利用可能な重要度キャッシュが必要です");
  }
  const document = createCacheDocument(parsedState.document);
  if (document.kind !== "ai_latest_importance") {
    throw new Error("重要度キャッシュ文書の種別が不正です");
  }
  if (document.nodeId !== context.nodeId) {
    throw new Error("重要度キャッシュのnode IDが対象と一致しません");
  }
  if (
    document.repository.repositoryId !== context.repository.repositoryId ||
    document.repository.owner !== context.repository.owner ||
    document.repository.name !== context.repository.name
  ) {
    throw new Error("重要度キャッシュのリポジトリが対象と一致しません");
  }
  if (compareTimes(document.metadata.executedAt, context.evaluatedAt) > 0) {
    throw new Error("評価時刻より新しい重要度キャッシュは利用できません");
  }
  const reference = document.aiCacheReference;
  const entry = context.aiCacheEntries.find(
    (candidate) => candidate.cacheKey === reference.cacheKey,
  );
  if (entry == null) {
    throw new Error("重要度キャッシュが参照するAIエントリがありません");
  }
  if (entry.sourceHash !== reference.sourceHash) {
    throw new Error("重要度キャッシュのsource hashがAIエントリと一致しません");
  }
  if (entry.metadata.inputHash !== reference.inputHash) {
    throw new Error("重要度キャッシュのinput hashがAIエントリと一致しません");
  }
  if (calculateIdentityHash(entry) !== reference.identityHash) {
    throw new Error("重要度キャッシュのidentity hashがAIエントリと一致しません");
  }
  if (entry.nodeId !== document.nodeId) {
    throw new Error("重要度キャッシュのnode IDがAIエントリと一致しません");
  }
  if (
    entry.repository.repositoryId !== document.repository.repositoryId ||
    entry.repository.owner !== document.repository.owner ||
    entry.repository.name !== document.repository.name
  ) {
    throw new Error("重要度キャッシュのリポジトリがAIエントリと一致しません");
  }
  if (!importanceEquals(entry.importance, document.importance)) {
    throw new Error("重要度キャッシュの重要度がAIエントリと一致しません");
  }
  if (entry.confidence !== document.confidence) {
    throw new Error("重要度キャッシュのconfidenceがAIエントリと一致しません");
  }
  if (
    entry.metadata.deterministicRulesVersion !== document.metadata.deterministicRulesVersion ||
    entry.metadata.model !== document.metadata.model ||
    entry.metadata.reasoningEffort !== document.metadata.reasoningEffort ||
    entry.metadata.backendVersion !== document.metadata.backendVersion ||
    entry.metadata.promptVersion !== document.metadata.promptVersion ||
    entry.metadata.schemaVersion !== document.metadata.analysisSchemaVersion ||
    entry.metadata.executedAt !== document.metadata.executedAt
  ) {
    throw new Error("重要度キャッシュのメタデータがAIエントリと一致しません");
  }
  return document;
}

/** 検証済みAI結果または直近重要度キャッシュから重要度を決定する。 */
export function resolveImportance(input: ResolveImportanceInput): ImportanceResolution {
  const parsedInput = parseInput<z.infer<typeof resolutionInputShape>>(resolutionInputShape, input);
  const context = validateContext(parsedInput.context);
  if (parsedInput.current.status === "available") {
    const result = validateVerifiedResult(parsedInput.current.result, context);
    return {
      status: "normal",
      source: "current_validated_ai",
      importance: result.importance,
    };
  }
  if (parsedInput.latest.status === "not_available") {
    return {
      status: "not_available",
      reason: "latest_importance_cache_missing",
    };
  }
  const document = validateLatestCache(parsedInput.latest, context);
  return {
    status: "fallback",
    source: "latest_importance_cache",
    importance: document.importance,
  };
}

/** 検証済みAI結果から時刻順を保証した最新重要度キャッシュ候補を作成する。 */
export function createImportanceCacheCandidate(
  input: CreateImportanceCacheCandidateInput,
): AiLatestImportanceCacheDocument {
  const parsedInput = parseInput<z.infer<typeof candidateInputShape>>(candidateInputShape, input);
  const context = validateContext(parsedInput.context);
  const current = validateVerifiedResult(parsedInput.current, context);
  const document: AiLatestImportanceCacheDocument = {
    schemaVersion: CACHE_DOCUMENT_SCHEMA_VERSION,
    kind: "ai_latest_importance",
    repository: context.repository,
    nodeId: context.nodeId,
    importance: current.importance,
    confidence: current.confidence,
    aiCacheReference: {
      status: "available",
      cacheKey: current.entry.cacheKey,
      sourceHash: current.fingerprint.sourceHash,
      inputHash: current.fingerprint.inputHash,
      identityHash: current.fingerprint.identityHash,
    },
    metadata: {
      deterministicRulesVersion: current.entry.metadata.deterministicRulesVersion,
      model: current.entry.metadata.model,
      reasoningEffort: current.entry.metadata.reasoningEffort,
      backendVersion: current.entry.metadata.backendVersion,
      promptVersion: current.entry.metadata.promptVersion,
      analysisSchemaVersion: current.entry.metadata.schemaVersion,
      executedAt: current.entry.metadata.executedAt,
    },
  };
  const validatedDocument = createCacheDocument(document);
  if (validatedDocument.kind !== "ai_latest_importance") {
    throw new Error("重要度キャッシュ候補の種別が不正です");
  }
  if (parsedInput.previous.status === "available") {
    const previous = validateLatestCache(parsedInput.previous, context);
    const timeComparison = compareTimes(
      previous.metadata.executedAt,
      current.entry.metadata.executedAt,
    );
    if (timeComparison > 0) {
      throw new Error(
        `新しいAI結果の実行時刻が直近キャッシュより前です。node ID: ${context.nodeId}。現在: ${current.entry.metadata.executedAt}。直近: ${previous.metadata.executedAt}`,
      );
    }
    if (timeComparison === 0) {
      if (serializeCanonicalJson(previous) === serializeCanonicalJson(validatedDocument)) {
        return previous;
      }
      return validatedDocument;
    }
  }
  return validatedDocument;
}
