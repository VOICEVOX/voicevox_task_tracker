import { type Repository } from "../domain/index.js";
import { aiAnalysisElementApplicationUsesAiValue } from "../domain/ai-analysis-elements.js";
import { containsUrlLikeText } from "../domain/url-like-text.js";
import type { VerifiedExternalReference } from "../domain/verified-external-reference.js";
import {
  containsDisallowedAiTextUrlInValues,
  containsPrivateRepositoryReference,
  containsUnallowlistedGitHubRepositoryUrl,
} from "../github/private-repository-reference.js";
import { isEligiblePublicRepository } from "../github/public-repository-allowlist.js";
import { type StateHistoryRecord, type StateSnapshot } from "../persistence/index.js";
import { PagesPublicSafetyError } from "./errors.js";
import type {
  PublicDetailsDto,
  PublicNotificationHistoryDto,
  PublicSummaryDto,
} from "./public-dto-contracts.js";

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
  repositoryInventory: readonly Repository[],
  repositoryAllowlist: readonly PagesRepositoryAllowlistEntry[],
  externalReferences: readonly VerifiedExternalReference[],
  knownSecrets: readonly string[],
): readonly string[] {
  const violationCodes = new Set<string>();
  if (containsPrivateRepositoryReference(values, repositoryInventory)) {
    violationCodes.add("private_repository_data");
  }
  if (containsUnallowlistedGitHubRepositoryUrl(values, repositoryAllowlist, externalReferences)) {
    violationCodes.add("repository_url_not_allowlisted");
  }
  const pending: unknown[] = [...values];
  const visited = new WeakSet<object>();
  const aiValues: unknown[] = [];

  while (pending.length > 0) {
    const value = pending.pop();
    if (typeof value === "string") {
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
      for (const element of value) {
        pending.push(element);
      }
      continue;
    }

    const entries: [string, unknown][] = Object.entries(value);
    for (const [key, propertyValue] of entries) {
      const fieldName = normalizedFieldName(key);
      if (fieldName === "aianalysis") {
        aiValues.push(propertyValue);
      }
      if (
        fieldName === "generation" &&
        typeof propertyValue === "object" &&
        propertyValue != null &&
        "result" in propertyValue
      ) {
        aiValues.push(propertyValue.result);
      }
      if (
        fieldName === "references" &&
        typeof propertyValue === "object" &&
        propertyValue != null &&
        "reasonSummary" in propertyValue &&
        typeof propertyValue.reasonSummary === "string" &&
        containsUrlLikeText(propertyValue.reasonSummary)
      ) {
        violationCodes.add("personal_reminder_url_not_allowed");
      }
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

  if (containsDisallowedAiTextUrlInValues(aiValues, repositoryAllowlist, externalReferences)) {
    violationCodes.add("ai_text_url_not_allowed");
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
  const eligibleRepositories = input.repositoryInventory.filter(isEligiblePublicRepository);
  if (
    allowlist.size !== eligibleRepositories.length ||
    eligibleRepositories.some((repository) => {
      const entry = allowlist.get(repository.id);
      return entry?.owner !== repository.owner || entry.name !== repository.name;
    })
  ) {
    violationCodes.push("invalid_repository_allowlist");
  }
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
      input.repositoryInventory,
      input.repositoryAllowlist,
      input.snapshot.verifiedExternalReferences,
      input.knownSecrets,
    ),
  );

  if (violationCodes.length > 0) {
    throw new PagesPublicSafetyError(violationCodes);
  }
}

/** 生成済み公開DTOもsnapshotと同じURL許可集合で検査する。 */
export function assertPagesOutputPublicSafety(
  input: PagesPublicSafetyInput,
  values: readonly [PublicSummaryDto, PublicDetailsDto, PublicNotificationHistoryDto],
): void {
  const violationCodes = [
    ...scanValues(
      values,
      input.repositoryInventory,
      input.repositoryAllowlist,
      input.snapshot.verifiedExternalReferences,
      input.knownSecrets,
    ),
  ];
  const sourceItems = new Map<string, StateSnapshot["items"][number]>(
    input.snapshot.items.map((item) => [item.nodeId, item]),
  );
  const aiValues: string[] = [];
  for (const item of values[0].items) {
    const source = sourceItems.get(item.nodeId);
    if (source == null) {
      violationCodes.push("public_item_without_source");
      continue;
    }
    if (aiAnalysisElementApplicationUsesAiValue(source.aiAnalysis.applications.nextAction)) {
      aiValues.push(item.nextAction);
    }
    if (aiAnalysisElementApplicationUsesAiValue(source.aiAnalysis.applications.waitingOn)) {
      aiValues.push(...item.waitingOn.map((waitingOn) => waitingOn.reasonSummary));
    }
  }
  if (
    containsDisallowedAiTextUrlInValues(
      aiValues,
      input.repositoryAllowlist,
      input.snapshot.verifiedExternalReferences,
    )
  ) {
    violationCodes.push("ai_text_url_not_allowed");
  }
  if (violationCodes.length > 0) {
    throw new PagesPublicSafetyError(violationCodes);
  }
}
