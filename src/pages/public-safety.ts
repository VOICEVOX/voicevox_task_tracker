import { type Repository } from "../domain/index.js";
import { type StateHistoryRecord, type StateSnapshot } from "../persistence/index.js";
import { PagesPublicSafetyError } from "./errors.js";

const MAX_PUBLIC_SOURCE_STRING_LENGTH = 4096;
const SECRET_PATTERNS: readonly RegExp[] = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/iu,
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
  "appid",
  "appprivatekey",
  "authorization",
  "credential",
  "credentials",
  "discordwebhookurl",
  "githubappid",
  "githubappprivatekey",
  "githubtoken",
  "installationid",
  "installationtoken",
  "openaiapikey",
  "password",
  "privatekey",
  "rawtoken",
  "secret",
  "token",
  "webhookurl",
]);
const FULL_CONTENT_FIELD_NAMES = new Set([
  "apiresponse",
  "body",
  "bodytext",
  "comment",
  "commentbody",
  "comments",
  "content",
  "rawbody",
  "rawcontent",
  "rawresponse",
  "responsetext",
  "text",
]);
const URL_FIELD_NAMES = new Set(["sourceurl", "url"]);

/** Pages公開allowlistに含めるリポジトリの識別情報。 */
export type PagesRepositoryAllowlistEntry = Readonly<{
  id: Repository["id"];
  owner: Repository["owner"];
  name: Repository["name"];
}>;

/** Pages公開allowlist検証へ渡す永続化済み入力とrun内情報。 */
export type PagesPublicSafetyInput = Readonly<{
  snapshot: StateSnapshot;
  historyRecords: readonly StateHistoryRecord[];
  repositoryAllowlist: readonly PagesRepositoryAllowlistEntry[];
  repositoryInventory: readonly Repository[];
  knownSecrets: readonly string[];
}>;

function normalizedFieldName(value: string): string {
  return value.replaceAll(/[-_]/gu, "").toLowerCase();
}

function containsValue(value: string, candidates: readonly string[]): boolean {
  return candidates.some((candidate) => value.includes(candidate));
}

function containsSecretPattern(value: string): boolean {
  return SECRET_PATTERNS.some((pattern) => pattern.test(value));
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function isSafeGitHubUrl(value: string): boolean {
  if (!URL.canParse(value)) {
    return false;
  }
  const url = new URL(value);
  return (
    url.protocol === "https:" &&
    url.hostname === "github.com" &&
    url.port === "" &&
    url.username === "" &&
    url.password === ""
  );
}

function privateRepositorySentinels(inventory: readonly Repository[]): readonly string[] {
  return Object.freeze(
    inventory
      .filter((repository) => repository.visibility !== "public")
      .flatMap((repository) => [
        repository.id,
        `${repository.owner}/${repository.name}`,
        `https://github.com/${repository.owner}/${repository.name}`,
      ]),
  );
}

function createRepositoryAllowlist(
  entries: readonly PagesRepositoryAllowlistEntry[],
): ReadonlyMap<Repository["id"], PagesRepositoryAllowlistEntry> {
  const allowlist = new Map(entries.map((repository) => [repository.id, repository]));
  if (allowlist.size !== entries.length) {
    throw new PagesPublicSafetyError(["invalid_repository_allowlist"]);
  }
  return allowlist;
}

function scanValues(
  values: readonly unknown[],
  privateSentinels: readonly string[],
  knownSecrets: readonly string[],
): readonly string[] {
  const violationCodes = new Set<string>();
  const pending: unknown[] = [...values];
  const visited = new WeakSet<object>();

  while (pending.length > 0) {
    const value = pending.pop();
    if (typeof value === "string") {
      if (containsValue(value, privateSentinels)) {
        violationCodes.add("private_repository_data");
      }
      if (containsValue(value, knownSecrets) || containsSecretPattern(value)) {
        violationCodes.add("secret");
      }
      if (value.length > MAX_PUBLIC_SOURCE_STRING_LENGTH) {
        violationCodes.add("unnecessary_full_content");
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
      if (FULL_CONTENT_FIELD_NAMES.has(fieldName)) {
        violationCodes.add("unnecessary_full_content");
      }
      if (containsValue(key, knownSecrets) || containsSecretPattern(key)) {
        violationCodes.add("secret");
      }
      if (
        URL_FIELD_NAMES.has(fieldName) &&
        typeof propertyValue === "string" &&
        !isSafeGitHubUrl(propertyValue)
      ) {
        violationCodes.add("non_github_url");
      }
      pending.push(propertyValue);
    }
  }

  return Object.freeze([...violationCodes]);
}

/** DTO生成直前に永続化層とは独立した公開allowlist検証を行う。 */
export function assertPagesPublicSafety(input: PagesPublicSafetyInput): void {
  if (input.knownSecrets.some((secret) => secret.length === 0)) {
    throw new PagesPublicSafetyError(["invalid_known_secret_configuration"]);
  }

  const allowlist = createRepositoryAllowlist(input.repositoryAllowlist);
  const violationCodes: string[] = [];
  for (const repository of input.snapshot.repositories) {
    const allowlistedRepository = allowlist.get(repository.id);
    if (allowlistedRepository == null) {
      violationCodes.push("repository_not_allowlisted");
      continue;
    }
    if (
      allowlistedRepository.owner !== repository.owner ||
      allowlistedRepository.name !== repository.name
    ) {
      violationCodes.push("repository_identity_mismatch");
    }
  }
  for (const item of input.snapshot.items) {
    if (!allowlist.has(item.repositoryId)) {
      violationCodes.push("repository_not_allowlisted");
    }
  }

  violationCodes.push(
    ...scanValues(
      [input.snapshot, ...input.historyRecords],
      privateRepositorySentinels(input.repositoryInventory),
      input.knownSecrets,
    ),
  );

  if (violationCodes.length > 0) {
    throw new PagesPublicSafetyError(violationCodes);
  }
}
