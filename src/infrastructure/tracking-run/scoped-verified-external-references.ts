import { isGitHubHost, urlInputText } from "../../domain/url-like-candidates.js";
import { scanUrlLikeText } from "../../domain/url-like-text.js";
import {
  verifiedExternalUrls,
  type VerifiedExternalReference,
} from "../../domain/verified-external-reference.js";

function normalizedGitHubReferenceUrl(value: string): string | undefined {
  const input = urlInputText(value);
  const absolute = input.startsWith("//")
    ? `https:${input}`
    : /^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(input)
      ? input
      : `https://${input}`;
  if (!URL.canParse(absolute)) {
    return undefined;
  }
  const url = new URL(absolute);
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    !isGitHubHost(url.hostname) ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== ""
  ) {
    return undefined;
  }
  url.protocol = "https:";
  url.hostname = "github.com";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/u, "").toLowerCase();
}

function referencedGitHubUrls(values: readonly unknown[]): ReadonlySet<string> {
  const urls = new Set<string>();
  const pending: unknown[] = [...values];
  const visitedObjects = new WeakSet<object>();
  const visitedStrings = new Set<string>();
  while (pending.length > 0) {
    const value = pending.pop();
    if (typeof value === "string") {
      if (visitedStrings.has(value)) {
        continue;
      }
      visitedStrings.add(value);
      const scan = scanUrlLikeText(value);
      if (scan.status === "invalid") {
        throw new TypeError("Codex入力の参照URLを解析できません");
      }
      for (const candidate of scan.candidates) {
        const url = normalizedGitHubReferenceUrl(candidate);
        if (url != null) {
          urls.add(url);
        }
      }
      continue;
    }
    if (typeof value !== "object" || value == null || visitedObjects.has(value)) {
      continue;
    }
    visitedObjects.add(value);
    for (const propertyValue of Object.values(value)) {
      pending.push(propertyValue);
    }
  }
  return urls;
}

/** 項目入力に現れる外部項目とrepositoryの証明を今回の検証済み集合から選ぶ。 */
export function scopedVerifiedExternalReferences(
  references: readonly VerifiedExternalReference[],
  values: readonly unknown[],
): Readonly<{
  references: readonly VerifiedExternalReference[];
  repositoryUrls: readonly string[];
}> {
  if (verifiedExternalUrls(references) == null) {
    throw new TypeError("Codex入力の検証済み外部参照URLが不正です");
  }
  const urls = referencedGitHubUrls(values);
  return Object.freeze({
    references: Object.freeze(
      references.filter((reference) => urls.has(reference.url.toLowerCase())),
    ),
    repositoryUrls: Object.freeze(
      [
        ...new Set(
          references.map((reference) =>
            `https://github.com/${reference.repositoryFullName}`.toLowerCase(),
          ),
        ),
      ]
        .filter((url) => urls.has(url))
        .sort(),
    ),
  });
}
