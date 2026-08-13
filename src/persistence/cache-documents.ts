import { z, type ZodError } from "zod";

import {
  buildSourceId,
  createGitHubNodeId,
  createGitHubRepositoryId,
  createUtcIsoDateTime,
  REASONING_EFFORTS,
  type GitHubItemUrl,
  type GitHubNodeId,
  type SourceId,
  type UtcIsoDateTime,
} from "../domain/index.js";
import { parseSourceId } from "../domain/source-id.js";
import { parseSha256Hash, serializeCanonicalJsonLine } from "./canonical-json.js";
import { StatePersistenceError } from "./errors.js";

/** cache文書schemaのversion。 */
export const CACHE_DOCUMENT_SCHEMA_VERSION = "1";
/** terminal itemを保持する日数。 */
export const CACHE_TERMINAL_RETENTION_DAYS = 180;
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;
const TERMINAL_RETENTION_MILLISECONDS = CACHE_TERMINAL_RETENTION_DAYS * MILLISECONDS_PER_DAY;
const MAX_CACHE_STRING_LENGTH = 4096;
const MAX_IDENTIFIER_LENGTH = 512;
const MAX_REPOSITORY_NAME_LENGTH = 100;
const MAX_EVENT_KIND_LENGTH = 100;
const MAX_AI_IMPORTANCE_RATIONALE_LENGTH = 120;
const SHA256_HASH_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const REPOSITORY_NAME_PATTERN = /^[^/\s]+$/u;
const NODE_ID_PATTERN = /^\S+$/u;
const EVENT_KIND_PATTERN = /^[a-z][a-z0-9_]*$/u;
const GITHUB_ITEM_URL_PATTERN =
  /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/(?:issues|pull)\/[1-9]\d*\/?$/u;

const SECRET_PATTERNS: readonly RegExp[] = [
  /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/iu,
  /\bauthorization\b\s*[:=]\s*(?:basic|bearer|token)\s+\S+/iu,
  /\b(?:github_pat_[A-Za-z0-9_]{8,}|gh[pousr]_[A-Za-z0-9]{8,})\b/u,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{8,}\b/u,
  /\bAKIA[0-9A-Z]{16}\b/u,
  /\bxox[baprs]-[A-Za-z0-9-]{8,}\b/u,
  /\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/u,
  /https:\/\/(?:canary\.|ptb\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[A-Za-z0-9._-]+/iu,
];
const CREDENTIAL_FIELD_NAMES = new Set([
  "accesstoken",
  "apikey",
  "authorization",
  "credential",
  "credentials",
  "discordwebhookurl",
  "githubtoken",
  "installationtoken",
  "openaiapikey",
  "password",
  "privatekey",
  "rawtoken",
  "secret",
  "token",
  "webhookurl",
]);
const FORBIDDEN_FIELD_NAMES = new Set([
  "body",
  "bodytext",
  "comment",
  "commentbody",
  "comments",
  "content",
  "diff",
  "raw",
  "rawbody",
  "rawcontent",
  "rawresponse",
  "responsetext",
  "text",
]);

const nonEmptyStringSchema = z.string().min(1).max(MAX_CACHE_STRING_LENGTH);
const boundedIdentifierSchema = nonEmptyStringSchema
  .max(MAX_IDENTIFIER_LENGTH)
  .regex(NODE_ID_PATTERN);
const githubNodeIdSchema = boundedIdentifierSchema.transform(createGitHubNodeId);
const githubRepositoryIdSchema = boundedIdentifierSchema.transform(createGitHubRepositoryId);
const sourceIdSchema = nonEmptyStringSchema.max(MAX_IDENTIFIER_LENGTH).transform((value) => {
  const parts = parseSourceId(value);
  return buildSourceId(parts.kind, parts.originalId);
});
const sha256HashSchema = z.string().regex(SHA256_HASH_PATTERN).transform(parseSha256Hash);
const utcIsoDateTimeSchema = z.iso
  .datetime({
    offset: true,
    error: "タイムゾーンを含むISO 8601日時を指定してください",
  })
  .transform(createUtcIsoDateTime);
const repositoryNameSchema = nonEmptyStringSchema
  .max(MAX_REPOSITORY_NAME_LENGTH)
  .regex(REPOSITORY_NAME_PATTERN);
const githubItemUrlSchema = z.custom<GitHubItemUrl>(
  (value) =>
    typeof value === "string" &&
    value.length <= MAX_CACHE_STRING_LENGTH &&
    GITHUB_ITEM_URL_PATTERN.test(value),
  {
    error: "GitHub IssueまたはPull Request URLが不正です",
  },
);
const eventKindSchema = nonEmptyStringSchema.max(MAX_EVENT_KIND_LENGTH).regex(EVENT_KIND_PATTERN);
const reasoningEffortSchema = z.enum(REASONING_EFFORTS);

const cacheRepositoryIdentitySchema = z.strictObject({
  repositoryId: githubRepositoryIdSchema,
  owner: repositoryNameSchema,
  name: repositoryNameSchema,
});

const cacheLifecycleSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("open"),
  }),
  z.strictObject({
    kind: z.literal("terminal"),
    terminalAt: utcIsoDateTimeSchema,
    expiresAt: utcIsoDateTimeSchema,
  }),
]);

const cacheItemStateSchema = z.enum(["open", "closed", "merged"]);
const cacheDraftStateSchema = z.enum(["not_applicable", "draft", "ready_for_review"]);

const cacheTemporalActorSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("identified"),
    nodeId: githubNodeIdSchema,
  }),
  z.strictObject({
    status: z.literal("unavailable"),
  }),
]);

const cacheTemporalEventSchema = z.strictObject({
  sourceId: sourceIdSchema,
  kind: eventKindSchema,
  sequence: z.number().int().nonnegative(),
  occurredAt: utcIsoDateTimeSchema,
  actor: cacheTemporalActorSchema,
  relatedNodeIds: z.array(githubNodeIdSchema).max(100),
});

const cacheHistorySchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("complete"),
    events: z.array(cacheTemporalEventSchema),
  }),
  z.strictObject({
    status: z.literal("unavailable"),
    reason: z.enum(["not_returned", "redacted", "cache_miss"]),
  }),
]);

const aiCacheReferenceSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("available"),
    cacheKey: sha256HashSchema,
    sourceHash: sha256HashSchema,
    inputHash: sha256HashSchema,
    graphNeighborhoodHash: sha256HashSchema,
    identityHash: sha256HashSchema,
  }),
  z.strictObject({
    status: z.literal("unavailable"),
  }),
]);

const cacheItemIndexSchema = z.strictObject({
  nodeId: githubNodeIdSchema,
  repositoryId: githubRepositoryIdSchema,
  type: z.enum(["issue", "pull_request"]),
  number: z.number().int().positive(),
  url: githubItemUrlSchema,
  state: cacheItemStateSchema,
  draftState: cacheDraftStateSchema,
  bodyFingerprint: sha256HashSchema,
  itemFingerprint: sha256HashSchema,
  analysisRulesFingerprint: sha256HashSchema,
  deterministicRulesVersion: nonEmptyStringSchema,
  createdAt: utcIsoDateTimeSchema,
  updatedAt: utcIsoDateTimeSchema,
  observedAt: utcIsoDateTimeSchema,
  lifecycle: cacheLifecycleSchema,
});

const githubRepositoryCacheSchema = z.strictObject({
  schemaVersion: z.literal(CACHE_DOCUMENT_SCHEMA_VERSION),
  kind: z.literal("github_repository"),
  repository: cacheRepositoryIdentitySchema,
  successfulAt: utcIsoDateTimeSchema,
  items: z.array(cacheItemIndexSchema),
});

const githubItemCacheSchema = z.strictObject({
  schemaVersion: z.literal(CACHE_DOCUMENT_SCHEMA_VERSION),
  kind: z.literal("github_item"),
  repository: cacheRepositoryIdentitySchema,
  ...cacheItemIndexSchema.shape,
  history: cacheHistorySchema,
  aiCacheReference: aiCacheReferenceSchema,
});

const latestImportanceSchema = z.strictObject({
  significantFeature: z.boolean(),
  explicitDeadline: z.boolean(),
  futureRisk: z.boolean(),
  rationale: z.string().min(1).max(MAX_AI_IMPORTANCE_RATIONALE_LENGTH),
});

const aiMetadataSchema = z.strictObject({
  deterministicRulesVersion: nonEmptyStringSchema,
  model: nonEmptyStringSchema,
  reasoningEffort: reasoningEffortSchema,
  backendVersion: nonEmptyStringSchema,
  promptVersion: nonEmptyStringSchema,
  analysisSchemaVersion: nonEmptyStringSchema,
  executedAt: utcIsoDateTimeSchema,
});

const aiLatestImportanceCacheSchema = z.strictObject({
  schemaVersion: z.literal(CACHE_DOCUMENT_SCHEMA_VERSION),
  kind: z.literal("ai_latest_importance"),
  repository: cacheRepositoryIdentitySchema,
  nodeId: githubNodeIdSchema,
  importance: latestImportanceSchema,
  confidence: z.number().min(0).max(1),
  aiCacheReference: aiCacheReferenceSchema,
  metadata: aiMetadataSchema,
});

const cacheDocumentSchema = z.discriminatedUnion("kind", [
  githubRepositoryCacheSchema,
  githubItemCacheSchema,
  aiLatestImportanceCacheSchema,
]);

type ParsedCacheRepositoryIdentity = z.output<typeof cacheRepositoryIdentitySchema>;
type ParsedCacheLifecycle = z.output<typeof cacheLifecycleSchema>;
type ParsedCacheItemIndex = z.output<typeof cacheItemIndexSchema>;
type ParsedCacheTemporalEvent = z.output<typeof cacheTemporalEventSchema>;
type ParsedCacheHistory = z.output<typeof cacheHistorySchema>;
type ParsedAiCacheReference = z.output<typeof aiCacheReferenceSchema>;

/** キャッシュ文書へ渡すリポジトリ識別情報。公開境界の判定は別のadapterが担当する。 */
export type CacheRepositoryIdentity = ParsedCacheRepositoryIdentity;

/** cache itemのopenまたはterminal lifecycle。 */
export type CacheLifecycle = ParsedCacheLifecycle;

/** raw本文を含まない正規化済みtemporal event。 */
export type CacheTemporalEvent = ParsedCacheTemporalEvent;

/** repository cacheとitem cacheで共有する項目の現在メタデータ。 */
export type CacheItemIndex = ParsedCacheItemIndex;

/** 完全取得済みまたは取得不能な履歴。 */
export type CacheHistory = ParsedCacheHistory;

/** 完全一致AI cacheへの参照または利用不能状態。 */
export type AiCacheReference = ParsedAiCacheReference;

/** キャッシュ文書の公開検証へ渡す秘密値一覧。 */
export type CacheDocumentSafetyInput = Readonly<{
  document: unknown;
  knownSecrets: readonly string[];
}>;

/** repository cacheに保存する文書。 */
export type GitHubRepositoryCacheDocument = z.output<typeof githubRepositoryCacheSchema>;

/** item cacheに保存する文書。 */
export type GitHubItemCacheDocument = z.output<typeof githubItemCacheSchema>;

/** node ID単位の直近重要度cacheに保存する文書。 */
export type AiLatestImportanceCacheDocument = z.output<typeof aiLatestImportanceCacheSchema>;

/** cache-only branchへ保存できる文書のstrict discriminated union。 */
export type CacheDocument = z.output<typeof cacheDocumentSchema>;

/** キャッシュ文書のschema検証に失敗したことを表す。 */
export class CacheDocumentSchemaError extends StatePersistenceError {
  public readonly issueCount: number;

  public constructor(error: ZodError, cause: unknown) {
    super(`cache文書のschema検証に失敗しました。問題件数: ${error.issues.length.toString()}`, {
      cause,
    });
    this.issueCount = error.issues.length;
  }
}

/** キャッシュ文書の意味検証に失敗したことを表す。 */
export class CacheDocumentSemanticError extends StatePersistenceError {
  public constructor(message: string) {
    super(`cache文書の意味検証に失敗しました。${message}`, {});
  }
}

/** キャッシュ文書へ保存できない値を検出したことを表す。 */
export class CacheDocumentPublicSafetyError extends StatePersistenceError {
  public readonly violationCodes: readonly string[];

  public constructor(violationCodes: readonly string[]) {
    const uniqueCodes = [...new Set(violationCodes)].sort();
    super(
      `cache文書の公開安全性違反を検出しました。分類: ${uniqueCodes.join(", ")}。保存を中止しました`,
      {},
    );
    this.violationCodes = Object.freeze(uniqueCodes);
  }
}

function normalizedFieldName(value: string): string {
  return value.replaceAll(/[-_]/gu, "").toLowerCase();
}

function includesKnownValue(value: string, knownValues: readonly string[]): boolean {
  return knownValues.some((knownValue) => value.includes(knownValue));
}

function includesSecretPattern(value: string): boolean {
  return SECRET_PATTERNS.some((pattern) => pattern.test(value));
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function scanUnsafeValues(
  values: readonly unknown[],
  knownSecrets: readonly string[],
): readonly string[] {
  const violationCodes = new Set<string>();
  const pending: unknown[] = [...values];
  const visited = new WeakSet<object>();
  while (pending.length > 0) {
    const value = pending.pop();
    if (typeof value === "string") {
      if (value.length > MAX_CACHE_STRING_LENGTH) {
        violationCodes.add("oversized_string");
      }
      if (includesKnownValue(value, knownSecrets) || includesSecretPattern(value)) {
        violationCodes.add("secret");
      }
      continue;
    }
    if (typeof value !== "object" || value == null || visited.has(value)) {
      continue;
    }
    visited.add(value);
    if (isUnknownArray(value)) {
      pending.push(...value);
      continue;
    }
    for (const [key, propertyValue] of Object.entries(value)) {
      const fieldName = normalizedFieldName(key);
      if (CREDENTIAL_FIELD_NAMES.has(fieldName)) {
        violationCodes.add("credential_field");
      }
      if (FORBIDDEN_FIELD_NAMES.has(fieldName) || fieldName.startsWith("raw")) {
        violationCodes.add("forbidden_content_field");
      }
      if (includesKnownValue(key, knownSecrets) || includesSecretPattern(key)) {
        violationCodes.add("secret");
      }
      pending.push(propertyValue);
    }
  }
  return Object.freeze([...violationCodes]);
}

function assertKnownSecrets(knownSecrets: readonly string[]): void {
  if (knownSecrets.some((secret) => secret.length === 0)) {
    throw new CacheDocumentPublicSafetyError(["empty_known_secret"]);
  }
}

function parseTimestamp(value: UtcIsoDateTime, fieldName: string): number {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new CacheDocumentSemanticError(`${fieldName}が有効な日時ではありません`);
  }
  return timestamp;
}

function compareStrings(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function compareTemporalEvents(
  left: ParsedCacheTemporalEvent,
  right: ParsedCacheTemporalEvent,
): number {
  const occurredAtComparison = compareStrings(left.occurredAt, right.occurredAt);
  if (occurredAtComparison !== 0) {
    return occurredAtComparison;
  }
  if (left.sequence !== right.sequence) {
    return left.sequence - right.sequence;
  }
  return compareStrings(left.sourceId, right.sourceId);
}

function assertRepositoryIdentity(identity: ParsedCacheRepositoryIdentity): void {
  if (identity.owner.includes("/") || identity.name.includes("/")) {
    throw new CacheDocumentSemanticError("repository ownerとnameにslashを指定できません");
  }
}

function assertTerminalRetention(lifecycle: ParsedCacheLifecycle, createdAt: UtcIsoDateTime): void {
  if (lifecycle.kind === "open") {
    return;
  }
  const terminalTimestamp = parseTimestamp(lifecycle.terminalAt, "lifecycle.terminalAt");
  const expiresTimestamp = parseTimestamp(lifecycle.expiresAt, "lifecycle.expiresAt");
  const createdTimestamp = parseTimestamp(createdAt, "createdAt");
  if (terminalTimestamp < createdTimestamp) {
    throw new CacheDocumentSemanticError("terminalAtはcreatedAt以後にしてください");
  }
  if (expiresTimestamp !== terminalTimestamp + TERMINAL_RETENTION_MILLISECONDS) {
    throw new CacheDocumentSemanticError("expiresAtはterminalAtから180日後にしてください");
  }
}

function assertTemporalEvents(events: readonly ParsedCacheTemporalEvent[]): void {
  const sourceIds = new Set<SourceId>();
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (event == null) {
      throw new CacheDocumentSemanticError("temporal eventがありません");
    }
    if (sourceIds.has(event.sourceId)) {
      throw new CacheDocumentSemanticError("temporal eventのsource IDが重複しています");
    }
    sourceIds.add(event.sourceId);
    const previous = events[index - 1];
    if (previous != null && compareTemporalEvents(previous, event) > 0) {
      throw new CacheDocumentSemanticError("temporal eventが決定的な順序で並んでいません");
    }
    const relatedNodeIds = new Set(event.relatedNodeIds);
    if (relatedNodeIds.size !== event.relatedNodeIds.length) {
      throw new CacheDocumentSemanticError("temporal eventのrelated node IDが重複しています");
    }
    for (let index = 1; index < event.relatedNodeIds.length; index += 1) {
      const previousNodeId = event.relatedNodeIds[index - 1];
      const nodeId = event.relatedNodeIds[index];
      if (previousNodeId == null || nodeId == null) {
        throw new CacheDocumentSemanticError("temporal eventのrelated node IDがありません");
      }
      if (compareStrings(previousNodeId, nodeId) > 0) {
        throw new CacheDocumentSemanticError(
          "temporal eventのrelated node IDが決定的な順序で並んでいません",
        );
      }
    }
  }
}

function assertItemIndex(item: ParsedCacheItemIndex): void {
  if (item.type === "issue" && item.draftState !== "not_applicable") {
    throw new CacheDocumentSemanticError("IssueのdraftStateはnot_applicableにしてください");
  }
  if (item.type === "pull_request" && item.draftState === "not_applicable") {
    throw new CacheDocumentSemanticError("Pull RequestのdraftStateがnot_applicableです");
  }
  if (item.state === "open" && item.lifecycle.kind !== "open") {
    throw new CacheDocumentSemanticError("open項目のlifecycleがterminalです");
  }
  if (item.state !== "open" && item.lifecycle.kind !== "terminal") {
    throw new CacheDocumentSemanticError("terminal項目のlifecycleがopenです");
  }
  if (item.state === "merged" && item.type !== "pull_request") {
    throw new CacheDocumentSemanticError("Issueをmerged状態で保存できません");
  }
  if (item.url.toLowerCase().includes("/issues/") !== (item.type === "issue")) {
    throw new CacheDocumentSemanticError("item typeとGitHub URLのpathが一致しません");
  }
  assertTerminalRetention(item.lifecycle, item.createdAt);
  if (Date.parse(item.updatedAt) < Date.parse(item.createdAt)) {
    throw new CacheDocumentSemanticError("updatedAtはcreatedAt以後にしてください");
  }
}

function assertItemUrl(
  item: Readonly<{
    repository: ParsedCacheRepositoryIdentity;
    type: "issue" | "pull_request";
    number: number;
    url: GitHubItemUrl;
  }>,
): void {
  const parsedUrl = new URL(item.url);
  const expectedPath = `/${item.repository.owner}/${item.repository.name}/${item.type === "issue" ? "issues" : "pull"}/${item.number.toString()}`;
  if (
    parsedUrl.hostname !== "github.com" ||
    parsedUrl.pathname.toLowerCase() !== expectedPath.toLowerCase() ||
    parsedUrl.search.length !== 0 ||
    parsedUrl.hash.length !== 0
  ) {
    throw new CacheDocumentSemanticError("GitHub URLがrepository、type、numberと一致しません");
  }
}

function assertRepositoryItems(
  items: readonly ParsedCacheItemIndex[],
  repository: ParsedCacheRepositoryIdentity,
): void {
  const nodeIds = new Set<GitHubNodeId>();
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (item == null) {
      throw new CacheDocumentSemanticError("repository cache内にitemがありません");
    }
    const previousItem = items[index - 1];
    if (previousItem != null && compareStrings(previousItem.nodeId, item.nodeId) > 0) {
      throw new CacheDocumentSemanticError(
        "repository cache内のitem node IDが決定的な順序で並んでいません",
      );
    }
    if (item.repositoryId !== repository.repositoryId) {
      throw new CacheDocumentSemanticError("repository cache内のitem repositoryIdが一致しません");
    }
    if (nodeIds.has(item.nodeId)) {
      throw new CacheDocumentSemanticError("repository cache内のitem node IDが重複しています");
    }
    nodeIds.add(item.nodeId);
    assertItemUrl({
      repository,
      type: item.type,
      number: item.number,
      url: item.url,
    });
    assertItemIndex(item);
  }
}

function assertCacheDocumentSemantics(document: CacheDocument): void {
  switch (document.kind) {
    case "github_repository":
      assertRepositoryIdentity(document.repository);
      assertRepositoryItems(document.items, document.repository);
      return;
    case "github_item":
      assertRepositoryIdentity(document.repository);
      if (document.repository.repositoryId !== document.repositoryId) {
        throw new CacheDocumentSemanticError(
          "item cacheのrepositoryIdがrepository identityと一致しません",
        );
      }
      assertItemUrl(document);
      assertItemIndex(document);
      if (document.history.status === "complete") {
        assertTemporalEvents(document.history.events);
      }
      return;
    case "ai_latest_importance":
      assertRepositoryIdentity(document.repository);
      if (document.repository.repositoryId === "") {
        throw new CacheDocumentSemanticError("latest importanceのrepositoryIdが空です");
      }
      if (document.aiCacheReference.status !== "available") {
        throw new CacheDocumentSemanticError("latest importanceには完全一致AI cache参照が必要です");
      }
      if (document.importance.rationale.trim().length === 0) {
        throw new CacheDocumentSemanticError("latest importanceのrationaleは空にできません");
      }
      if (document.importance.rationale.length > MAX_AI_IMPORTANCE_RATIONALE_LENGTH) {
        throw new CacheDocumentSemanticError(
          "latest importanceのrationaleは120文字以内にしてください",
        );
      }
      return;
  }
}

function parseCacheDocumentValue(value: unknown): CacheDocument {
  const safetyViolations = scanUnsafeValues([value], []);
  if (safetyViolations.length > 0) {
    throw new CacheDocumentPublicSafetyError(safetyViolations);
  }
  const result = cacheDocumentSchema.safeParse(value);
  if (!result.success) {
    throw new CacheDocumentSchemaError(result.error, result.error);
  }
  assertCacheDocumentSemantics(result.data);
  return result.data;
}

/** 未検証の値をstrictなcache文書へ変換する。 */
export function createCacheDocument(value: unknown): CacheDocument {
  return parseCacheDocumentValue(value);
}

/** cache文書を意味検証する。 */
export function assertCacheDocumentSemantic(document: CacheDocument): void {
  assertCacheDocumentSemantics(document);
}

/** cache文書のsecret、credential、全文混入を再帰検査する。 */
export function assertCacheDocumentPublicSafety(input: CacheDocumentSafetyInput): void {
  assertKnownSecrets(input.knownSecrets);
  const violationCodes = scanUnsafeValues([input.document], input.knownSecrets);
  if (violationCodes.length > 0) {
    throw new CacheDocumentPublicSafetyError(violationCodes);
  }
}

/** cache文書を末尾改行付きcanonical JSONへ変換する。 */
export function serializeCacheDocument(document: CacheDocument): string {
  return serializeCanonicalJsonLine(createCacheDocument(document));
}

/** canonical JSONからcache文書を検証して読み取る。 */
export function parseCacheDocument(source: string): CacheDocument {
  let value: unknown;
  try {
    const parseJson: (text: string) => unknown = JSON.parse;
    value = parseJson(source);
  } catch (error: unknown) {
    throw new CacheDocumentSchemaError(
      new z.ZodError([
        {
          code: "custom",
          path: [],
          message: "JSON構文が不正です",
        },
      ]),
      error,
    );
  }
  return createCacheDocument(value);
}

/** terminalAtからcacheの終了期限を計算する。 */
export function createCacheTerminalExpiry(terminalAt: UtcIsoDateTime): UtcIsoDateTime {
  const timestamp = parseTimestamp(terminalAt, "terminalAt");
  const expiresTimestamp = timestamp + TERMINAL_RETENTION_MILLISECONDS;
  if (!Number.isFinite(expiresTimestamp)) {
    throw new CacheDocumentSemanticError("terminalAtからexpiresAtを計算できません");
  }
  return createUtcIsoDateTime(new Date(expiresTimestamp).toISOString());
}
