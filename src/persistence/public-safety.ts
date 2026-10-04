import { type Repository } from "../domain/index.js";
import { containsUrlLikeText } from "../domain/url-like-text.js";
import type { VerifiedExternalReference } from "../domain/verified-external-reference.js";
import {
  containsDisallowedAiTextUrlInValues,
  containsPrivateRepositoryReference,
  containsUnallowlistedGitHubRepositoryUrl,
} from "../github/private-repository-reference.js";
import { isEligiblePublicRepository } from "../github/public-repository-allowlist.js";
import { StateConfigurationError, StatePublicSafetyError } from "./errors.js";
import { type StateSnapshot } from "./snapshot-v23.js";

const MAX_PERSISTED_STRING_LENGTH = 4096;
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

/** state公開安全性検証へ渡すrun内の独立入力。 */
export type StatePublicSafetyInput = Readonly<{
  snapshot: StateSnapshot;
  repositoryInventory: readonly Repository[];
  repositoryAllowlist: readonly Pick<Repository, "id" | "owner" | "name">[];
  additionalValues: readonly unknown[];
  knownSecrets: readonly string[];
}>;

function assertKnownSecrets(knownSecrets: readonly string[]): void {
  for (const secret of knownSecrets) {
    if (secret.length === 0) {
      throw new StateConfigurationError("knownSecretsに空文字は指定できません");
    }
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

function scanValues(
  values: readonly unknown[],
  repositoryInventory: readonly Repository[],
  repositoryAllowlist: readonly Pick<Repository, "owner" | "name">[],
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
      if (includesKnownValue(value, knownSecrets) || includesSecretPattern(value)) {
        violationCodes.add("secret");
      }
      if (value.length > MAX_PERSISTED_STRING_LENGTH) {
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
      if (includesKnownValue(key, knownSecrets) || includesSecretPattern(key)) {
        violationCodes.add("secret");
      }
      pending.push(propertyValue);
    }
  }

  if (containsDisallowedAiTextUrlInValues(aiValues, repositoryAllowlist, externalReferences)) {
    violationCodes.add("ai_text_url_not_allowed");
  }

  return Object.freeze([...violationCodes]);
}

/** 直列化直前に公開allowlistとsecret・全文転載制約を独立検証する。 */
export function assertStatePublicSafety(input: StatePublicSafetyInput): void {
  assertKnownSecrets(input.knownSecrets);

  const violationCodes: string[] = [];
  const eligibleRepositories = input.repositoryInventory.filter(isEligiblePublicRepository);
  const allowlist = new Map(
    input.repositoryAllowlist.map((repository) => [repository.id, repository]),
  );
  if (
    allowlist.size !== input.repositoryAllowlist.length ||
    allowlist.size !== eligibleRepositories.length ||
    eligibleRepositories.some((repository) => {
      const entry = allowlist.get(repository.id);
      return entry?.owner !== repository.owner || entry.name !== repository.name;
    })
  ) {
    violationCodes.push("repository_allowlist_mismatch");
  }
  for (const repository of input.snapshot.repositories) {
    const entry = allowlist.get(repository.id);
    if (entry == null) {
      violationCodes.push("repository_not_allowlisted");
    } else if (entry.owner !== repository.owner || entry.name !== repository.name) {
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
      [input.snapshot, ...input.additionalValues],
      input.repositoryInventory,
      input.repositoryAllowlist,
      input.snapshot.verifiedExternalReferences,
      input.knownSecrets,
    ),
  );

  if (violationCodes.length > 0) {
    throw new StatePublicSafetyError(violationCodes);
  }
}

/** snapshotを伴わないstate更新値のsecretと不要な全文を検査する。 */
export function assertStateValuesPublicSafety(
  values: readonly unknown[],
  repositoryAllowlist: readonly Pick<Repository, "owner" | "name">[],
  externalReferences: readonly VerifiedExternalReference[],
  knownSecrets: readonly string[],
): void {
  assertKnownSecrets(knownSecrets);
  const violationCodes = scanValues(
    values,
    [],
    repositoryAllowlist,
    externalReferences,
    knownSecrets,
  );
  if (violationCodes.length > 0) {
    throw new StatePublicSafetyError(violationCodes);
  }
}

/** 既存stateから運用通知へ渡す値を公開境界で検査する。 */
export function assertExistingStatePublicSafety(
  snapshot: StateSnapshot | undefined,
  historyRecords: readonly unknown[],
  notificationLedger: unknown,
  plannedValues: readonly unknown[],
  knownSecrets: readonly string[],
): void {
  assertKnownSecrets(knownSecrets);
  const violationCodes: string[] = [];
  if (snapshot != null) {
    const repositoryIds = new Set(snapshot.repositories.map((repository) => repository.id));
    if (snapshot.repositories.some((repository) => !isEligiblePublicRepository(repository))) {
      violationCodes.push("repository_not_public");
    }
    if (snapshot.items.some((item) => !repositoryIds.has(item.repositoryId))) {
      violationCodes.push("repository_not_allowlisted");
    }
  }
  violationCodes.push(
    ...scanValues(
      [snapshot, ...historyRecords, notificationLedger, ...plannedValues],
      snapshot?.repositories ?? [],
      snapshot?.repositories ?? [],
      snapshot?.verifiedExternalReferences ?? [],
      knownSecrets,
    ),
  );
  if (violationCodes.length > 0) {
    throw new StatePublicSafetyError(violationCodes);
  }
}
