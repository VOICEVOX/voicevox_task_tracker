import { createAiCacheEntry, type AiCacheEntry } from "../codex/cache.js";
import { validateCodexAnalysisSchema } from "../codex/schema-validation.js";
import {
  createUtcIsoDateTime,
  type GitHubNodeId,
  type Repository,
  type UtcIsoDateTime,
} from "../domain/index.js";
import {
  assertCacheItemRelationPublicBoundary,
  PublicRepositoryAllowlist,
} from "../github/public-repository-allowlist.js";
import { GitHubPublicBoundaryViolationError } from "../github/errors.js";
import {
  assertCacheDocumentPublicSafety,
  createCacheDocument,
  parseCacheDocument,
  serializeCacheDocument,
  type AiLatestImportanceCacheDocument,
  type CacheDocument,
  type GitHubItemCacheDocument,
  type GitHubRepositoryCacheDocument,
  CacheDocumentSemanticError,
} from "./cache-documents.js";
import {
  hashCanonicalJson,
  serializeCanonicalJson,
  serializeCanonicalJsonLine,
} from "./canonical-json.js";
import {
  assertValidStatePath,
  joinStatePath,
  type StateBranchAdapter,
  type StateBranchCommitResult,
  type StateBranchHead,
  type StateFileReadResult,
  type StateFileUpdate,
} from "./branch-adapter.js";
import { StateConfigurationError, StateFormatError } from "./errors.js";

const CACHE_ONLY_BRANCH = "tracker-state-v3";
const STATE_ROOT_DIRECTORY = "state";
const JSON_FILE_PATTERN = /^[A-Za-z0-9._-]+\.json$/u;
const CACHE_FILE_KEY_PATTERN = /^[A-Za-z0-9._-]+$/u;
const SHA256_FILE_KEY_PATTERN = /^[0-9a-f]{64}$/u;
const CACHE_ONLY_VERIFICATION_DIRECTORIES = Object.freeze({
  repositoryCaches: "state/github-repositories",
  itemCaches: "state/github-items",
  latestImportanceCaches: "state/ai-latest-importance",
  aiCacheEntries: "state/ai-results",
});

/** cache-only永続化が利用する保存先。 */
export type CacheOnlyPersistenceConfiguration = Readonly<{
  branch: string;
  repositoryCacheDirectory: string;
  itemCacheDirectory: string;
  latestImportanceDirectory: string;
  aiCacheDirectory: string;
}>;

/** cache-only sessionの読み取り時に固定する検証時刻と秘密値。 */
export type CacheOnlyLoadInput = Readonly<{
  evaluatedAt: UtcIsoDateTime;
  knownSecrets: readonly string[];
}>;

/** cache-only sessionへ渡す未検証のcache文書とAI cache。 */
export type CacheOnlyPersistenceInput = Readonly<{
  evaluatedAt: UtcIsoDateTime;
  repositoryCaches: readonly unknown[];
  itemCaches: readonly unknown[];
  latestImportanceCaches: readonly unknown[];
  aiCacheEntries: readonly unknown[];
  knownSecrets: readonly string[];
}>;

/** cache-only branchから読み取った検証済みcache集合。 */
export type CacheOnlyLoadedState =
  | Readonly<{
      status: "missing_branch";
    }>
  | Readonly<{
      status: "available";
      repositoryCaches: readonly GitHubRepositoryCacheDocument[];
      itemCaches: readonly GitHubItemCacheDocument[];
      latestImportanceCaches: readonly AiLatestImportanceCacheDocument[];
      aiCacheEntries: readonly AiCacheEntry[];
    }>;

/** cache-only commitのrevisionと置換したファイル一覧。 */
export type CacheOnlyPersistenceResult = StateBranchCommitResult &
  Readonly<{
    updatedPaths: readonly string[];
    deletedPaths: readonly string[];
  }>;

/** cache-only検証へ渡すstate内のJSON文書と相対path。 */
export type CacheOnlyStateFile = Readonly<{
  path: string;
  value: unknown;
}>;

/** cache-onlyの4種類の文書を分類した入力。 */
export type CacheOnlyStateFiles = Readonly<{
  repositoryCaches: readonly CacheOnlyStateFile[];
  itemCaches: readonly CacheOnlyStateFile[];
  latestImportanceCaches: readonly CacheOnlyStateFile[];
  aiCacheEntries: readonly CacheOnlyStateFile[];
}>;

/** cache-only文書を検証した結果。 */
export type CacheOnlyValidatedDocuments = Readonly<{
  repositoryCaches: readonly GitHubRepositoryCacheDocument[];
  itemCaches: readonly GitHubItemCacheDocument[];
  latestImportanceCaches: readonly AiLatestImportanceCacheDocument[];
  aiCacheEntries: readonly AiCacheEntry[];
}>;

type CacheOnlyDocumentSet = CacheOnlyValidatedDocuments;

type StoredCacheOnlyState = CacheOnlyDocumentSet &
  Readonly<{
    allPaths: readonly string[];
  }>;

type CachePathKind = "repository" | "item" | "latest_importance" | "ai";

function compareStrings(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function validateConfiguration(configuration: CacheOnlyPersistenceConfiguration): void {
  if (configuration.branch !== CACHE_ONLY_BRANCH) {
    throw new StateConfigurationError(`${CACHE_ONLY_BRANCH} branchだけを使用できます`);
  }
  const directories = [
    configuration.repositoryCacheDirectory,
    configuration.itemCacheDirectory,
    configuration.latestImportanceDirectory,
    configuration.aiCacheDirectory,
  ];
  for (const directory of directories) {
    assertValidStatePath(directory);
  }
  for (let index = 0; index < directories.length; index += 1) {
    const directory = directories[index];
    if (directory == null) {
      throw new StateConfigurationError("cache保存先がありません");
    }
    for (let otherIndex = index + 1; otherIndex < directories.length; otherIndex += 1) {
      const otherDirectory = directories[otherIndex];
      if (otherDirectory == null) {
        throw new StateConfigurationError("cache保存先がありません");
      }
      if (
        directory === otherDirectory ||
        directory.startsWith(`${otherDirectory}/`) ||
        otherDirectory.startsWith(`${directory}/`)
      ) {
        throw new StateConfigurationError("cache保存先directoryが重複または入れ子になっています");
      }
    }
  }
}

function validateKnownSecrets(knownSecrets: readonly string[]): void {
  assertCacheDocumentPublicSafety({
    document: Object.freeze({}),
    knownSecrets,
  });
}

function createFormatError(kind: string, cause: unknown): StateFormatError {
  return new StateFormatError(kind, {
    cause,
  });
}

function decodeFile(result: StateFileReadResult, path: string): string {
  if (result.status === "missing") {
    throw createFormatError(
      "cache-only",
      new TypeError(`一覧にあるcache fileを読み取れません。対象: ${path}`),
    );
  }
  try {
    return new TextDecoder("utf-8", {
      fatal: true,
    }).decode(result.bytes);
  } catch (error: unknown) {
    throw createFormatError(
      "cache-only",
      new TypeError("cache fileがUTF-8ではありません", {
        cause: error,
      }),
    );
  }
}

function pathUnder(directory: string, path: string): boolean {
  return path.startsWith(`${directory}/`);
}

function classifyPath(
  path: string,
  configuration: CacheOnlyPersistenceConfiguration,
): CachePathKind | undefined {
  if (pathUnder(configuration.repositoryCacheDirectory, path)) {
    return "repository";
  }
  if (pathUnder(configuration.itemCacheDirectory, path)) {
    return "item";
  }
  if (pathUnder(configuration.latestImportanceDirectory, path)) {
    return "latest_importance";
  }
  if (pathUnder(configuration.aiCacheDirectory, path)) {
    return "ai";
  }
  return undefined;
}

function pathFileKey(path: string, directory: string): string {
  const prefix = `${directory}/`;
  if (!path.startsWith(prefix)) {
    throw createFormatError("cache-only", new TypeError("cache fileのdirectoryが不正です"));
  }
  const fileName = path.slice(prefix.length);
  if (!JSON_FILE_PATTERN.test(fileName)) {
    throw createFormatError("cache-only", new TypeError("cache file名が不正です"));
  }
  const key = fileName.slice(0, -".json".length);
  if (!CACHE_FILE_KEY_PATTERN.test(key)) {
    throw createFormatError("cache-only", new TypeError("cache fileのkeyが不正です"));
  }
  return key;
}

function pathForKey(directory: string, key: string): string {
  if (!CACHE_FILE_KEY_PATTERN.test(key)) {
    throw new StateConfigurationError("cache fileのkeyにpathで使えない文字があります");
  }
  return joinStatePath(directory, `${key}.json`);
}

function identityFileKey(kind: string, identifier: string): string {
  return hashCanonicalJson({ identifier, kind }).slice("sha256:".length);
}

function pathForIdentity(directory: string, kind: string, identifier: string): string {
  return pathForKey(directory, identityFileKey(kind, identifier));
}

function assertRepositoryAllowlisted(
  allowlist: PublicRepositoryAllowlist,
  repositoryId: GitHubRepositoryCacheDocument["repository"]["repositoryId"],
  owner: string,
  name: string,
): void {
  const publicRepository = allowlist.require(repositoryId);
  if (publicRepository.owner !== owner || publicRepository.name !== name) {
    throw new GitHubPublicBoundaryViolationError({
      scope: "generic",
      violationKind: "cache_repository_identity_mismatch",
      violationCount: 1,
    });
  }
}

function assertDocumentSafety(document: CacheDocument, knownSecrets: readonly string[]): void {
  assertCacheDocumentPublicSafety({
    document,
    knownSecrets,
  });
}

function parseRepositoryCache(
  value: unknown,
  allowlist: PublicRepositoryAllowlist,
  knownSecrets: readonly string[],
): GitHubRepositoryCacheDocument {
  const document = createCacheDocument(value);
  if (document.kind !== "github_repository") {
    throw createFormatError("repository cache", new TypeError("repository cacheのkindが不正です"));
  }
  assertRepositoryAllowlisted(
    allowlist,
    document.repository.repositoryId,
    document.repository.owner,
    document.repository.name,
  );
  assertDocumentSafety(document, knownSecrets);
  return document;
}

function parseItemCache(
  value: unknown,
  allowlist: PublicRepositoryAllowlist,
  knownSecrets: readonly string[],
): GitHubItemCacheDocument {
  const document = createCacheDocument(value);
  if (document.kind !== "github_item") {
    throw createFormatError("item cache", new TypeError("item cacheのkindが不正です"));
  }
  assertRepositoryAllowlisted(
    allowlist,
    document.repository.repositoryId,
    document.repository.owner,
    document.repository.name,
  );
  assertCacheItemRelationPublicBoundary(allowlist, {
    sourceItemNodeId: document.nodeId,
    relationCandidates: document.relationCandidates,
    relationMutations: document.relationMutations,
  });
  assertDocumentSafety(document, knownSecrets);
  return document;
}

function parseLatestImportanceCache(
  value: unknown,
  allowlist: PublicRepositoryAllowlist,
  knownSecrets: readonly string[],
): AiLatestImportanceCacheDocument {
  const document = createCacheDocument(value);
  if (document.kind !== "ai_latest_importance") {
    throw createFormatError(
      "latest importance cache",
      new TypeError("latest importance cacheのkindが不正です"),
    );
  }
  assertRepositoryAllowlisted(
    allowlist,
    document.repository.repositoryId,
    document.repository.owner,
    document.repository.name,
  );
  assertDocumentSafety(document, knownSecrets);
  return document;
}

function parseAiCache(
  value: unknown,
  allowlist: PublicRepositoryAllowlist,
  knownSecrets: readonly string[],
): AiCacheEntry {
  const entry = createAiCacheEntry(value);
  assertRepositoryAllowlisted(
    allowlist,
    entry.repository.repositoryId,
    entry.repository.owner,
    entry.repository.name,
  );
  assertCacheDocumentPublicSafety({
    document: entry,
    knownSecrets,
  });
  return entry;
}

function parseJson(source: string, kind: string): unknown {
  try {
    const parseJsonValue: (text: string) => unknown = JSON.parse;
    return parseJsonValue(source);
  } catch (error: unknown) {
    throw createFormatError(
      kind,
      new SyntaxError("JSON構文が不正です", {
        cause: error,
      }),
    );
  }
}

function assertCacheFileIdentity(path: string, directory: string, expectedKey: string): void {
  const actualKey = pathFileKey(path, directory);
  if (actualKey !== expectedKey) {
    throw createFormatError(
      "cache-only",
      new TypeError("cache fileのpathと文書の識別子が一致しません"),
    );
  }
}

function assertUniqueKeys(keys: readonly string[], kind: string): void {
  if (new Set(keys).size !== keys.length) {
    throw createFormatError(kind, new TypeError("cache文書の識別子が重複しています"));
  }
}

function sortDocuments(documents: CacheOnlyDocumentSet): CacheOnlyDocumentSet {
  return Object.freeze({
    repositoryCaches: Object.freeze(
      [...documents.repositoryCaches].sort((left, right) =>
        compareStrings(left.repository.repositoryId, right.repository.repositoryId),
      ),
    ),
    itemCaches: Object.freeze(
      [...documents.itemCaches].sort((left, right) => compareStrings(left.nodeId, right.nodeId)),
    ),
    latestImportanceCaches: Object.freeze(
      [...documents.latestImportanceCaches].sort((left, right) =>
        compareStrings(left.nodeId, right.nodeId),
      ),
    ),
    aiCacheEntries: Object.freeze(
      [...documents.aiCacheEntries].sort((left, right) =>
        compareStrings(left.cacheKey, right.cacheKey),
      ),
    ),
  });
}

function assertNoFutureTimestamps(
  documents: CacheOnlyDocumentSet,
  evaluatedAt: UtcIsoDateTime,
): void {
  const evaluatedAtTimestamp = Date.parse(evaluatedAt);
  if (!Number.isFinite(evaluatedAtTimestamp)) {
    throw new StateFormatError("cache-only", {
      cause: new TypeError("cacheの評価日時が不正です"),
    });
  }
  const assertNotFuture = (value: UtcIsoDateTime, context: string): void => {
    if (Date.parse(value) > evaluatedAtTimestamp) {
      throw new CacheDocumentSemanticError(`${context}はevaluatedAt以後にできません`);
    }
  };
  for (const repository of documents.repositoryCaches) {
    assertNotFuture(repository.successfulAt, "repository successfulAt");
  }
  for (const item of documents.itemCaches) {
    assertNotFuture(item.observedAt, "item observedAt");
  }
  for (const latest of documents.latestImportanceCaches) {
    assertNotFuture(latest.metadata.executedAt, "latest importance executedAt");
  }
  for (const entry of documents.aiCacheEntries) {
    assertNotFuture(entry.metadata.executedAt, "AI cache entry executedAt");
  }
}

function referencedAiCacheKeys(documents: CacheOnlyDocumentSet): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const item of documents.itemCaches) {
    if (item.aiCacheReference.status === "available") {
      keys.add(item.aiCacheReference.cacheKey);
    }
  }
  for (const latest of documents.latestImportanceCaches) {
    keys.add(latest.aiCacheReference.cacheKey);
  }
  return keys;
}

function itemIndexFromDocument(
  document: GitHubItemCacheDocument,
): GitHubRepositoryCacheDocument["items"][number] {
  return {
    nodeId: document.nodeId,
    repositoryId: document.repositoryId,
    type: document.type,
    number: document.number,
    url: document.url,
    state: document.state,
    draftState: document.draftState,
    bodyFingerprint: document.bodyFingerprint,
    itemFingerprint: document.itemFingerprint,
    analysisRulesFingerprint: document.analysisRulesFingerprint,
    deterministicRulesVersion: document.deterministicRulesVersion,
    aiAnalysisStatus: document.aiAnalysisStatus,
    createdAt: document.createdAt,
    updatedAt: document.updatedAt,
    observedAt: document.observedAt,
    lifecycle: document.lifecycle,
  };
}

function assertAiCacheReferenceMatches(
  reference:
    | GitHubItemCacheDocument["aiCacheReference"]
    | AiLatestImportanceCacheDocument["aiCacheReference"],
  aiCachesByKey: ReadonlyMap<string, AiCacheEntry>,
): AiCacheEntry | undefined {
  if (reference.status !== "available") {
    return undefined;
  }
  const entry = aiCachesByKey.get(reference.cacheKey);
  if (entry == null) {
    throw new CacheDocumentSemanticError("availableなAI cache参照に対応するentryがありません");
  }
  const identityHash = hashCanonicalJson({
    backendVersion: entry.metadata.backendVersion,
    deterministicRulesVersion: entry.metadata.deterministicRulesVersion,
    model: entry.metadata.model,
    promptVersion: entry.metadata.promptVersion,
    reasoningEffort: entry.metadata.reasoningEffort,
    schemaVersion: entry.metadata.schemaVersion,
  });
  if (
    entry.sourceHash !== reference.sourceHash ||
    entry.metadata.inputHash !== reference.inputHash ||
    identityHash !== reference.identityHash
  ) {
    throw new CacheDocumentSemanticError("AI cache entryと参照のfingerprintが一致しません");
  }
  if (
    "graphNeighborhoodHash" in reference &&
    entry.graphNeighborhoodHash !== reference.graphNeighborhoodHash
  ) {
    throw new CacheDocumentSemanticError("AI cache entryと参照のgraph近傍hashが一致しません");
  }
  return entry;
}

function assertAiOutputItemMatches(
  entry: AiCacheEntry,
  nodeId: GitHubNodeId,
  context: string,
): ReturnType<typeof validateCodexAnalysisSchema> {
  const output = validateCodexAnalysisSchema(entry.output);
  if (entry.nodeId !== nodeId || output.item.nodeId !== nodeId) {
    throw new CacheDocumentSemanticError(`${context}のnode IDがAI cache entryと一致しません`);
  }
  return output;
}

function assertAiOutputImportanceMatches(
  output: ReturnType<typeof validateCodexAnalysisSchema>,
  latest: AiLatestImportanceCacheDocument,
): void {
  if (
    output.importance.significantFeature !== latest.importance.significantFeature ||
    output.importance.explicitDeadline !== latest.importance.explicitDeadline ||
    output.importance.futureRisk !== latest.importance.futureRisk ||
    output.importance.rationale !== latest.importance.rationale
  ) {
    throw new CacheDocumentSemanticError(
      "latest importanceがAI cache entryのimportanceと一致しません",
    );
  }
  if (output.confidence !== latest.confidence) {
    throw new CacheDocumentSemanticError(
      "latest importanceがAI cache entryのconfidenceと一致しません",
    );
  }
}

function assertLatestImportanceMetadataMatches(
  latest: AiLatestImportanceCacheDocument,
  entry: AiCacheEntry,
): void {
  if (
    latest.metadata.deterministicRulesVersion !== entry.metadata.deterministicRulesVersion ||
    latest.metadata.model !== entry.metadata.model ||
    latest.metadata.reasoningEffort !== entry.metadata.reasoningEffort ||
    latest.metadata.backendVersion !== entry.metadata.backendVersion ||
    latest.metadata.promptVersion !== entry.metadata.promptVersion ||
    latest.metadata.analysisSchemaVersion !== entry.metadata.schemaVersion ||
    latest.metadata.executedAt !== entry.metadata.executedAt
  ) {
    throw new CacheDocumentSemanticError(
      "latest importanceのmetadataがAI cache entryと一致しません",
    );
  }
}

function assertDocumentSetConsistency(documents: CacheOnlyDocumentSet): void {
  const repositoryIndexes = new Map<GitHubNodeId, GitHubRepositoryCacheDocument["items"][number]>();
  const repositoryIdsByItemNodeId = new Map<string, string>();
  const repositoryCachesById = new Map(
    documents.repositoryCaches.map((document) => [document.repository.repositoryId, document]),
  );
  for (const repository of documents.repositoryCaches) {
    for (const item of repository.items) {
      const previousRepositoryId = repositoryIdsByItemNodeId.get(item.nodeId);
      if (previousRepositoryId != null && previousRepositoryId !== item.repositoryId) {
        throw new CacheDocumentSemanticError("同じitem node IDが複数repositoryにあります");
      }
      const previousIndex = repositoryIndexes.get(item.nodeId);
      if (
        previousIndex != null &&
        serializeCanonicalJson(previousIndex) !== serializeCanonicalJson(item)
      ) {
        throw new CacheDocumentSemanticError("repository cache内のitem indexが重複しています");
      }
      repositoryIdsByItemNodeId.set(item.nodeId, item.repositoryId);
      repositoryIndexes.set(item.nodeId, item);
    }
  }
  const itemCachesByNodeId = new Map(
    documents.itemCaches.map((document) => [document.nodeId, document]),
  );
  for (const item of documents.itemCaches) {
    const repository = repositoryCachesById.get(item.repositoryId);
    const repositoryIndex = repositoryIndexes.get(item.nodeId);
    if (repository == null || repositoryIndex == null) {
      throw new CacheDocumentSemanticError("item cacheに対応するrepository indexがありません");
    }
    if (
      !repository.items.some(
        (repositoryItem) =>
          repositoryItem.nodeId === item.nodeId &&
          repositoryItem.repositoryId === item.repositoryId,
      ) ||
      serializeCanonicalJson(repositoryIndex) !==
        serializeCanonicalJson(itemIndexFromDocument(item))
    ) {
      throw new CacheDocumentSemanticError("repository indexとitem documentが一致しません");
    }
  }
  for (const repositoryIndex of repositoryIndexes.keys()) {
    if (!itemCachesByNodeId.has(repositoryIndex)) {
      throw new CacheDocumentSemanticError("repository indexに対応するitem documentがありません");
    }
  }
  const aiCachesByKey = new Map(documents.aiCacheEntries.map((entry) => [entry.cacheKey, entry]));
  const referencedKeys = referencedAiCacheKeys(documents);
  for (const item of documents.itemCaches) {
    const aiCacheEntry = assertAiCacheReferenceMatches(item.aiCacheReference, aiCachesByKey);
    if (aiCacheEntry != null) {
      assertAiOutputItemMatches(aiCacheEntry, item.nodeId, "item cache");
      if (
        aiCacheEntry.repository.repositoryId !== item.repository.repositoryId ||
        aiCacheEntry.repository.owner !== item.repository.owner ||
        aiCacheEntry.repository.name !== item.repository.name
      ) {
        throw new CacheDocumentSemanticError(
          "item cacheのrepositoryがAI cache entryと一致しません",
        );
      }
    }
  }
  for (const latest of documents.latestImportanceCaches) {
    const repository = repositoryCachesById.get(latest.repository.repositoryId);
    const repositoryIndex = repositoryIndexes.get(latest.nodeId);
    const item = itemCachesByNodeId.get(latest.nodeId);
    if (
      repository == null ||
      repositoryIndex == null ||
      item?.repositoryId !== latest.repository.repositoryId ||
      repositoryIndex.repositoryId !== latest.repository.repositoryId
    ) {
      throw new CacheDocumentSemanticError(
        "latest importanceに対応するrepositoryとitemがありません",
      );
    }
    const aiCacheEntry = assertAiCacheReferenceMatches(latest.aiCacheReference, aiCachesByKey);
    if (aiCacheEntry == null) {
      throw new CacheDocumentSemanticError("latest importanceには利用可能なAI cache参照が必要です");
    }
    const output = assertAiOutputItemMatches(aiCacheEntry, latest.nodeId, "latest importance");
    if (
      aiCacheEntry.repository.repositoryId !== latest.repository.repositoryId ||
      aiCacheEntry.repository.owner !== latest.repository.owner ||
      aiCacheEntry.repository.name !== latest.repository.name
    ) {
      throw new CacheDocumentSemanticError(
        "latest importanceのrepositoryがAI cache entryと一致しません",
      );
    }
    assertAiOutputImportanceMatches(output, latest);
    assertLatestImportanceMetadataMatches(latest, aiCacheEntry);
  }
  for (const entry of documents.aiCacheEntries) {
    const item = itemCachesByNodeId.get(entry.nodeId);
    const repository = repositoryCachesById.get(entry.repository.repositoryId);
    if (
      !referencedKeys.has(entry.cacheKey) &&
      (item == null ||
        repository == null ||
        item.repositoryId !== entry.repository.repositoryId ||
        repository.repository.owner !== entry.repository.owner ||
        repository.repository.name !== entry.repository.name)
    ) {
      throw new CacheDocumentSemanticError("保持対象itemに属さない未参照AI cache entryがあります");
    }
  }
}

function terminalItemExpired(
  item: GitHubItemCacheDocument["lifecycle"],
  evaluatedAt: number,
  protectedNodeIds: ReadonlySet<string>,
  nodeId: string,
): boolean {
  return (
    item.kind === "terminal" &&
    evaluatedAt > Date.parse(item.expiresAt) &&
    !protectedNodeIds.has(nodeId)
  );
}

function itemIndexExpired(
  item: GitHubRepositoryCacheDocument["items"][number],
  evaluatedAt: number,
  protectedNodeIds: ReadonlySet<string>,
): boolean {
  return terminalItemExpired(item.lifecycle, evaluatedAt, protectedNodeIds, item.nodeId);
}

function relationReferenceKey(
  reference: Readonly<{
    repositoryOwner: string;
    repositoryName: string;
    number: number;
  }>,
): string {
  return `${reference.repositoryOwner.toLowerCase()}/${reference.repositoryName.toLowerCase()}#${reference.number.toString()}`;
}

function addRelationCandidateNodeIds(
  candidate: GitHubItemCacheDocument["relationCandidates"][number],
  protectedNodeIds: Set<string>,
): void {
  switch (candidate.relation.type) {
    case "blocks":
      protectedNodeIds.add(candidate.relation.blocker.nodeId);
      protectedNodeIds.add(candidate.relation.blocked.nodeId);
      return;
    case "parent_of":
      protectedNodeIds.add(candidate.relation.parent.nodeId);
      protectedNodeIds.add(candidate.relation.subtask.nodeId);
      return;
    case "implements":
      protectedNodeIds.add(candidate.relation.implementation.nodeId);
      protectedNodeIds.add(candidate.relation.target.nodeId);
      return;
    case "unclassified":
      protectedNodeIds.add(candidate.relation.referencing.nodeId);
      protectedNodeIds.add(candidate.relation.referenced.nodeId);
      return;
  }
}

function createProtectedNodeIds(documents: CacheOnlyDocumentSet): ReadonlySet<string> {
  const protectedNodeIds = new Set<string>();
  const nodeIdsByReferenceKey = new Map<string, string>();
  for (const repository of documents.repositoryCaches) {
    for (const item of repository.items) {
      nodeIdsByReferenceKey.set(
        relationReferenceKey({
          repositoryOwner: repository.repository.owner,
          repositoryName: repository.repository.name,
          number: item.number,
        }),
        item.nodeId,
      );
    }
  }
  for (const item of documents.itemCaches) {
    if (item.state !== "open") {
      continue;
    }
    for (const candidate of item.relationCandidates) {
      addRelationCandidateNodeIds(candidate, protectedNodeIds);
    }
    for (const mutationResult of item.relationMutations) {
      if (mutationResult.status !== "available") {
        continue;
      }
      for (const reference of mutationResult.currentReferences) {
        const nodeId = nodeIdsByReferenceKey.get(relationReferenceKey(reference));
        if (nodeId != null) {
          protectedNodeIds.add(nodeId);
        }
      }
    }
  }
  return protectedNodeIds;
}

function filterRepositoryCache(
  document: GitHubRepositoryCacheDocument,
  evaluatedAt: number,
  protectedNodeIds: ReadonlySet<string>,
): GitHubRepositoryCacheDocument {
  const items = document.items.filter(
    (item) => !itemIndexExpired(item, evaluatedAt, protectedNodeIds),
  );
  if (items.length === document.items.length) {
    return document;
  }
  const filtered = createCacheDocument({
    ...document,
    items,
  });
  if (filtered.kind !== "github_repository") {
    throw new TypeError("repository cacheのfilter結果が不正です");
  }
  return filtered;
}

function pruneExpired(
  documents: CacheOnlyDocumentSet,
  evaluatedAtValue: UtcIsoDateTime,
): CacheOnlyDocumentSet {
  const evaluatedAt = Date.parse(evaluatedAtValue);
  if (!Number.isFinite(evaluatedAt)) {
    throw new StateFormatError("cache-only", {
      cause: new TypeError("cacheの評価日時が不正です"),
    });
  }
  const protectedNodeIds = createProtectedNodeIds(documents);
  const expiredNodeIds = new Set<GitHubNodeId>();
  const repositoryCaches = documents.repositoryCaches.map((document) => {
    for (const item of document.items) {
      if (itemIndexExpired(item, evaluatedAt, protectedNodeIds)) {
        expiredNodeIds.add(item.nodeId);
      }
    }
    return filterRepositoryCache(document, evaluatedAt, protectedNodeIds);
  });
  const itemCaches = documents.itemCaches.filter((document) => {
    const expired = terminalItemExpired(
      document.lifecycle,
      evaluatedAt,
      protectedNodeIds,
      document.nodeId,
    );
    if (expired) {
      expiredNodeIds.add(document.nodeId);
    }
    return !expired;
  });
  const latestImportanceCaches = documents.latestImportanceCaches.filter(
    (document) => !expiredNodeIds.has(document.nodeId),
  );
  const retainedItemsByNodeId = new Map(itemCaches.map((document) => [document.nodeId, document]));
  return sortDocuments({
    repositoryCaches,
    itemCaches,
    latestImportanceCaches,
    aiCacheEntries: documents.aiCacheEntries.filter((entry) => {
      const item = retainedItemsByNodeId.get(entry.nodeId);
      if (item?.repository.repositoryId !== entry.repository.repositoryId) {
        return false;
      }
      return (
        item.repository.owner === entry.repository.owner &&
        item.repository.name === entry.repository.name
      );
    }),
  });
}

function parseEvaluatedAt(value: UtcIsoDateTime): UtcIsoDateTime {
  try {
    return createUtcIsoDateTime(value);
  } catch (error: unknown) {
    throw createFormatError("cache-only", error);
  }
}

function parseRepositoryCaches(
  values: readonly unknown[],
  allowlist: PublicRepositoryAllowlist,
  knownSecrets: readonly string[],
): readonly GitHubRepositoryCacheDocument[] {
  const documents = values.map((value) => parseRepositoryCache(value, allowlist, knownSecrets));
  assertUniqueKeys(
    documents.map((document) => document.repository.repositoryId),
    "repository cache",
  );
  return Object.freeze(documents);
}

function parseItemCaches(
  values: readonly unknown[],
  allowlist: PublicRepositoryAllowlist,
  knownSecrets: readonly string[],
): readonly GitHubItemCacheDocument[] {
  const documents = values.map((value) => parseItemCache(value, allowlist, knownSecrets));
  assertUniqueKeys(
    documents.map((document) => document.nodeId),
    "item cache",
  );
  return Object.freeze(documents);
}

function parseLatestImportanceCaches(
  values: readonly unknown[],
  allowlist: PublicRepositoryAllowlist,
  knownSecrets: readonly string[],
): readonly AiLatestImportanceCacheDocument[] {
  const documents = values.map((value) =>
    parseLatestImportanceCache(value, allowlist, knownSecrets),
  );
  assertUniqueKeys(
    documents.map((document) => document.nodeId),
    "latest importance cache",
  );
  return Object.freeze(documents);
}

function parseAiCaches(
  values: readonly unknown[],
  allowlist: PublicRepositoryAllowlist,
  knownSecrets: readonly string[],
): readonly AiCacheEntry[] {
  const entries = values.map((value) => parseAiCache(value, allowlist, knownSecrets));
  assertUniqueKeys(
    entries.map((entry) => entry.cacheKey),
    "AI cache",
  );
  return Object.freeze(entries);
}

function createVerificationAllowlist(
  files: readonly CacheOnlyStateFile[],
  knownSecrets: readonly string[],
): PublicRepositoryAllowlist {
  const repositories: Repository[] = files.map((file) => {
    const document = createCacheDocument(file.value);
    if (document.kind !== "github_repository") {
      throw createFormatError(
        "repository cache",
        new TypeError("repository cacheのkindが不正です"),
      );
    }
    assertDocumentSafety(document, knownSecrets);
    return {
      id: document.repository.repositoryId,
      owner: document.repository.owner,
      name: document.repository.name,
      visibility: "public",
      archived: false,
      disabled: false,
      observedAt: document.successfulAt,
    };
  });
  return PublicRepositoryAllowlist.create(repositories);
}

function validateStateFilePaths(
  files: CacheOnlyStateFiles,
  documents: CacheOnlyValidatedDocuments,
): void {
  const validatePaths = (
    filesToValidate: readonly CacheOnlyStateFile[],
    directory: string,
    expectedKeys: readonly string[],
  ): void => {
    const remainingKeys = new Set(expectedKeys);
    for (const file of filesToValidate) {
      const key = pathFileKey(file.path, directory);
      if (!remainingKeys.delete(key)) {
        throw createFormatError(
          "cache-only",
          new TypeError("cache fileのpathと文書の識別子が一致しません"),
        );
      }
    }
    if (remainingKeys.size > 0) {
      throw createFormatError(
        "cache-only",
        new TypeError("cache文書に対応するcache fileがありません"),
      );
    }
  };
  validatePaths(
    files.repositoryCaches,
    CACHE_ONLY_VERIFICATION_DIRECTORIES.repositoryCaches,
    documents.repositoryCaches.map((document) =>
      identityFileKey("github_repository", document.repository.repositoryId),
    ),
  );
  validatePaths(
    files.itemCaches,
    CACHE_ONLY_VERIFICATION_DIRECTORIES.itemCaches,
    documents.itemCaches.map((document) => identityFileKey("github_item", document.nodeId)),
  );
  validatePaths(
    files.latestImportanceCaches,
    CACHE_ONLY_VERIFICATION_DIRECTORIES.latestImportanceCaches,
    documents.latestImportanceCaches.map((document) =>
      identityFileKey("ai_latest_importance", document.nodeId),
    ),
  );
  validatePaths(
    files.aiCacheEntries,
    CACHE_ONLY_VERIFICATION_DIRECTORIES.aiCacheEntries,
    documents.aiCacheEntries.map((entry) => entry.cacheKey.slice("sha256:".length)),
  );
}

/** cache-only stateの4種類の文書と文書間整合性を検証する。 */
export function validateCacheOnlyStateFiles(
  input: Readonly<{
    evaluatedAt: UtcIsoDateTime;
    files: CacheOnlyStateFiles;
    knownSecrets: readonly string[];
  }>,
): CacheOnlyValidatedDocuments {
  const allowlist = createVerificationAllowlist(input.files.repositoryCaches, input.knownSecrets);
  const documents = validateCacheOnlyPersistenceInput(
    {
      evaluatedAt: input.evaluatedAt,
      repositoryCaches: input.files.repositoryCaches.map((file) => file.value),
      itemCaches: input.files.itemCaches.map((file) => file.value),
      latestImportanceCaches: input.files.latestImportanceCaches.map((file) => file.value),
      aiCacheEntries: input.files.aiCacheEntries.map((file) => file.value),
      knownSecrets: input.knownSecrets,
    },
    allowlist,
  );
  validateStateFilePaths(input.files, documents);
  return documents;
}

function parseInput(
  input: CacheOnlyPersistenceInput,
  allowlist: PublicRepositoryAllowlist,
): CacheOnlyDocumentSet {
  validateKnownSecrets(input.knownSecrets);
  const evaluatedAt = parseEvaluatedAt(input.evaluatedAt);
  const documents = sortDocuments({
    repositoryCaches: parseRepositoryCaches(input.repositoryCaches, allowlist, input.knownSecrets),
    itemCaches: parseItemCaches(input.itemCaches, allowlist, input.knownSecrets),
    latestImportanceCaches: parseLatestImportanceCaches(
      input.latestImportanceCaches,
      allowlist,
      input.knownSecrets,
    ),
    aiCacheEntries: parseAiCaches(input.aiCacheEntries, allowlist, input.knownSecrets),
  });
  assertNoFutureTimestamps(documents, evaluatedAt);
  assertDocumentSetConsistency(documents);
  return documents;
}

/** cache-only persistence payloadをschemaと文書間整合性まで検証する。 */
export function validateCacheOnlyPersistenceInput(
  input: CacheOnlyPersistenceInput,
  allowlist: PublicRepositoryAllowlist,
): CacheOnlyValidatedDocuments {
  return parseInput(input, allowlist);
}

function createDocumentUpdate(path: string, document: CacheDocument): StateFileUpdate {
  return {
    path,
    bytes: new TextEncoder().encode(serializeCacheDocument(document)),
  };
}

function createAiCacheUpdate(path: string, entry: AiCacheEntry): StateFileUpdate {
  return {
    path,
    bytes: new TextEncoder().encode(serializeCanonicalJsonLine(entry)),
  };
}

function createUpdates(
  documents: CacheOnlyDocumentSet,
  configuration: CacheOnlyPersistenceConfiguration,
): readonly StateFileUpdate[] {
  const updates: StateFileUpdate[] = [];
  for (const document of documents.repositoryCaches) {
    updates.push(
      createDocumentUpdate(
        pathForIdentity(
          configuration.repositoryCacheDirectory,
          "github_repository",
          document.repository.repositoryId,
        ),
        document,
      ),
    );
  }
  for (const document of documents.itemCaches) {
    updates.push(
      createDocumentUpdate(
        pathForIdentity(configuration.itemCacheDirectory, "github_item", document.nodeId),
        document,
      ),
    );
  }
  for (const document of documents.latestImportanceCaches) {
    updates.push(
      createDocumentUpdate(
        pathForIdentity(
          configuration.latestImportanceDirectory,
          "ai_latest_importance",
          document.nodeId,
        ),
        document,
      ),
    );
  }
  for (const entry of documents.aiCacheEntries) {
    updates.push(
      createAiCacheUpdate(
        pathForKey(configuration.aiCacheDirectory, entry.cacheKey.slice("sha256:".length)),
        entry,
      ),
    );
  }
  updates.sort((left, right) => compareStrings(left.path, right.path));
  return Object.freeze(updates);
}

/** tracker-state-v3をcache-onlyとして読み書きするsessionを生成する。 */
export class CacheOnlyPersistenceSession {
  readonly #adapter: StateBranchAdapter;
  readonly #configuration: CacheOnlyPersistenceConfiguration;
  readonly #allowlist: PublicRepositoryAllowlist;
  #head: StateBranchHead;

  private constructor(
    adapter: StateBranchAdapter,
    configuration: CacheOnlyPersistenceConfiguration,
    allowlist: PublicRepositoryAllowlist,
    head: StateBranchHead,
  ) {
    this.#adapter = adapter;
    this.#configuration = Object.freeze({ ...configuration });
    this.#allowlist = allowlist;
    this.#head = head;
  }

  /** tracker-state-v3のheadを固定してcache-only sessionを開始する。 */
  public static async open(
    adapter: StateBranchAdapter,
    configuration: CacheOnlyPersistenceConfiguration,
    allowlist: PublicRepositoryAllowlist,
  ): Promise<CacheOnlyPersistenceSession> {
    validateConfiguration(configuration);
    const head = await adapter.resolveHead(configuration.branch);
    return new CacheOnlyPersistenceSession(adapter, configuration, allowlist, head);
  }

  async #readStoredState(
    knownSecrets: readonly string[],
    evaluatedAt: UtcIsoDateTime,
  ): Promise<StoredCacheOnlyState> {
    validateKnownSecrets(knownSecrets);
    if (this.#head.status === "missing") {
      return Object.freeze({
        allPaths: Object.freeze([]),
        repositoryCaches: Object.freeze([]),
        itemCaches: Object.freeze([]),
        latestImportanceCaches: Object.freeze([]),
        aiCacheEntries: Object.freeze([]),
      });
    }
    const allPaths = Object.freeze(
      [...(await this.#adapter.listFiles(this.#head.revision, STATE_ROOT_DIRECTORY))].sort(
        compareStrings,
      ),
    );
    const repositoryCaches: GitHubRepositoryCacheDocument[] = [];
    const itemCaches: GitHubItemCacheDocument[] = [];
    const latestImportanceCaches: AiLatestImportanceCacheDocument[] = [];
    const aiCacheEntries: AiCacheEntry[] = [];
    for (const path of allPaths) {
      const kind = classifyPath(path, this.#configuration);
      if (kind == null) {
        continue;
      }
      const source = decodeFile(await this.#adapter.readFile(this.#head.revision, path), path);
      if (kind === "repository") {
        const document = parseRepositoryCache(
          parseCacheDocument(source),
          this.#allowlist,
          knownSecrets,
        );
        assertCacheFileIdentity(
          path,
          this.#configuration.repositoryCacheDirectory,
          identityFileKey("github_repository", document.repository.repositoryId),
        );
        repositoryCaches.push(document);
        continue;
      }
      if (kind === "item") {
        const document = parseItemCache(parseCacheDocument(source), this.#allowlist, knownSecrets);
        assertCacheFileIdentity(
          path,
          this.#configuration.itemCacheDirectory,
          identityFileKey("github_item", document.nodeId),
        );
        itemCaches.push(document);
        continue;
      }
      if (kind === "latest_importance") {
        const document = parseLatestImportanceCache(
          parseCacheDocument(source),
          this.#allowlist,
          knownSecrets,
        );
        assertCacheFileIdentity(
          path,
          this.#configuration.latestImportanceDirectory,
          identityFileKey("ai_latest_importance", document.nodeId),
        );
        latestImportanceCaches.push(document);
        continue;
      }
      const key = pathFileKey(path, this.#configuration.aiCacheDirectory);
      if (!SHA256_FILE_KEY_PATTERN.test(key)) {
        throw createFormatError("AI cache", new TypeError("AI cacheのpath keyが不正です"));
      }
      const entry = parseAiCache(parseJson(source, "AI cache"), this.#allowlist, knownSecrets);
      if (entry.cacheKey.slice("sha256:".length) !== key) {
        throw createFormatError("AI cache", new TypeError("AI cacheのpath keyが一致しません"));
      }
      aiCacheEntries.push(entry);
    }
    const documents = sortDocuments({
      repositoryCaches,
      itemCaches,
      latestImportanceCaches,
      aiCacheEntries,
    });
    assertUniqueKeys(
      documents.repositoryCaches.map((document) => document.repository.repositoryId),
      "repository cache",
    );
    assertUniqueKeys(
      documents.itemCaches.map((document) => document.nodeId),
      "item cache",
    );
    assertUniqueKeys(
      documents.latestImportanceCaches.map((document) => document.nodeId),
      "latest importance cache",
    );
    assertUniqueKeys(
      documents.aiCacheEntries.map((entry) => entry.cacheKey),
      "AI cache",
    );
    assertNoFutureTimestamps(documents, evaluatedAt);
    assertDocumentSetConsistency(documents);
    return Object.freeze({
      ...documents,
      allPaths,
    });
  }

  /** session開始時点のcache-only branchを評価時刻で読み取る。 */
  public async load(input: CacheOnlyLoadInput): Promise<CacheOnlyLoadedState> {
    const evaluatedAt = parseEvaluatedAt(input.evaluatedAt);
    const stored = await this.#readStoredState(input.knownSecrets, evaluatedAt);
    if (this.#head.status === "missing") {
      return Object.freeze({
        status: "missing_branch",
      });
    }
    const documents = pruneExpired(stored, evaluatedAt);
    assertDocumentSetConsistency(documents);
    return Object.freeze({
      status: "available",
      ...documents,
    });
  }

  /** 検証済みcache-only集合でbranchを完全置換するcommitを作成する。 */
  public async persist(input: CacheOnlyPersistenceInput): Promise<CacheOnlyPersistenceResult> {
    const evaluatedAt = parseEvaluatedAt(input.evaluatedAt);
    const stored = await this.#readStoredState(input.knownSecrets, evaluatedAt);
    const validated = validateCacheOnlyPersistenceInput(input, this.#allowlist);
    const documents = pruneExpired(validated, evaluatedAt);
    const updates = createUpdates(documents, this.#configuration);
    const updatePaths = new Set(updates.map((update) => update.path));
    const deletedPaths = Object.freeze(
      stored.allPaths.filter((path) => !updatePaths.has(path)).sort(compareStrings),
    );
    if (updates.length === 0 && deletedPaths.length === 0) {
      throw createFormatError("cache-only", new TypeError("保存するcacheがありません"));
    }
    const result = await this.#adapter.commit({
      branch: this.#configuration.branch,
      expectedHead: this.#head,
      updates,
      deletions: deletedPaths,
      message: `tracker cache-only ${evaluatedAt}`,
      committedAt: evaluatedAt,
    });
    this.#head = Object.freeze({
      status: "present",
      revision: result.revision,
    });
    return Object.freeze({
      ...result,
      updatedPaths: Object.freeze(updates.map((update) => update.path)),
      deletedPaths,
    });
  }
}
