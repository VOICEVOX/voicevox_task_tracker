import { assertNonNullable } from "../util/index.js";

const SCHEME_FIRST_CHARACTER_PATTERN = /[A-Za-z]/u;
const SCHEME_CHARACTER_PATTERN = /[A-Za-z0-9+.-]/u;
const NON_SLASH_SCHEME_NAME_PATTERN = /^(?:mailto|javascript|data|urn|tel|blob|about)$/iu;
const AUTHORITY_SEPARATOR_PATTERN = /[<>"'`/?#&=;:,()[\]{}、！？）］｝「」『』]/u;
const EXPLICIT_AUTHORITY_END_PATTERN = /[<>/?#\\]/u;
const AUTHORITY_DOT_OR_ESCAPE_PATTERN = /[.．。｡%]/u;
const HOST_FORBIDDEN_DECODED_CHARACTER_PATTERN = /[\p{Cc}<>/?#\\]/u;
const DOMAIN_SUFFIX_PATTERN = /^(?:[a-z]{2,}|xn--[a-z0-9-]+)$/u;
const URL_SCHEME_PATTERN = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//u;
const URL_LIKE_DELIMITER_PATTERN = /[<>"'`]/u;
const TRAILING_PUNCTUATION_CHARACTER_PATTERN = /[.,;:!?、。！？)\]}）］｝」』]/u;
const URL_INPUT_DELETED_PATTERN = /[\t\n\r]/u;
const URL_INPUT_DELETED_GLOBAL_PATTERN = /[\t\n\r]/gu;
const WHITESPACE_PATTERN = /\s/u;
export const PERCENT_ENCODED_UTF8_CHARACTER_PATTERN = new RegExp(
  [
    "%[0-7][0-9a-f]",
    "%(?:c[2-9a-f]|d[0-9a-f])%[89ab][0-9a-f]",
    "%e0%[ab][0-9a-f]%[89ab][0-9a-f]",
    "%e[1-9a-cef](?:%[89ab][0-9a-f]){2}",
    "%ed%[89][0-9a-f]%[89ab][0-9a-f]",
    "%f0%[9ab][0-9a-f](?:%[89ab][0-9a-f]){2}",
    "%f[1-3](?:%[89ab][0-9a-f]){3}",
    "%f4%8[0-9a-f](?:%[89ab][0-9a-f]){2}",
  ].join("|"),
  "giu",
);
const hostIgnoredWhitespace = new Map<string, boolean>();

export type UrlLikeCandidate = Readonly<{ value: string; start: number; end: number }>;
export type UrlInputProjection = Readonly<{
  value: string;
  sourceIndices: readonly number[] | undefined;
}>;

/** WHATWG URL入力で取り除かれるTAB、LF、CRを除いた文字列を返す。 */
export function urlInputText(value: string): string {
  return value.replaceAll(URL_INPUT_DELETED_GLOBAL_PATTERN, "");
}

/** URL入力の削除文字を除き、各文字の元位置を保持する。 */
export function urlInputProjection(
  value: string,
  isHardBoundary: (index: number) => boolean,
): UrlInputProjection {
  if (!URL_INPUT_DELETED_PATTERN.test(value)) return { value, sourceIndices: undefined };
  const characters: string[] = [];
  const sourceIndices: number[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const character = value.charAt(index);
    if (URL_INPUT_DELETED_PATTERN.test(character) && !isHardBoundary(index)) continue;
    characters.push(character);
    sourceIndices.push(index);
  }
  return { value: characters.join(""), sourceIndices };
}

function nextUrlInputIndex(
  value: string,
  start: number,
  isHardBoundary: (index: number) => boolean,
): number {
  let index = start;
  while (
    index < value.length &&
    URL_INPUT_DELETED_PATTERN.test(value.charAt(index)) &&
    !isHardBoundary(index)
  ) {
    index += 1;
  }
  return index;
}

function previousUrlInputIndex(
  value: string,
  start: number,
  isHardBoundary: (index: number) => boolean,
): number {
  let index = start;
  while (
    index >= 0 &&
    URL_INPUT_DELETED_PATTERN.test(value.charAt(index)) &&
    !isHardBoundary(index)
  ) {
    index -= 1;
  }
  return index;
}

function isHostIgnoredWhitespace(character: string): boolean {
  if (!WHITESPACE_PATTERN.test(character)) return false;
  const cached = hostIgnoredWhitespace.get(character);
  if (cached != null) return cached;
  const probe = `https://a${character}b.invalid`;
  const ignored = URL.canParse(probe) && new URL(probe).hostname === "ab.invalid";
  hostIgnoredWhitespace.set(character, ignored);
  return ignored;
}

function isTextWhitespaceBoundary(character: string): boolean {
  return WHITESPACE_PATTERN.test(character) && !isHostIgnoredWhitespace(character);
}

function isAuthoritySeparator(
  value: string,
  index: number,
  isHardBoundary: (index: number) => boolean,
): boolean {
  const character = value.charAt(index);
  return (
    isHardBoundary(index) ||
    AUTHORITY_SEPARATOR_PATTERN.test(character) ||
    isTextWhitespaceBoundary(character)
  );
}

function isCandidateDelimiter(
  value: string,
  index: number,
  isHardBoundary: (index: number) => boolean,
): boolean {
  const character = value.charAt(index);
  return (
    isHardBoundary(index) ||
    URL_LIKE_DELIMITER_PATTERN.test(character) ||
    isTextWhitespaceBoundary(character)
  );
}

function isBareUrlLikeAuthority(authority: string): boolean {
  if (!AUTHORITY_DOT_OR_ESCAPE_PATTERN.test(authority)) return false;
  if (mayHaveGitHubAuthority(authority)) return true;
  let hostname = authority;
  let absoluteUrl = `https://${hostname}`;
  if (!URL.canParse(absoluteUrl)) {
    const percentIndex = hostname.indexOf("%");
    if (percentIndex < 0) return false;
    hostname = hostname.slice(0, percentIndex);
    absoluteUrl = `https://${hostname}`;
    if (!URL.canParse(absoluteUrl)) return false;
  }
  const labels = new URL(absoluteUrl).hostname.replace(/\.$/u, "").split(".");
  const suffix = labels.at(-1);
  return labels.length > 1 && suffix != null && DOMAIN_SUFFIX_PATTERN.test(suffix);
}

type UrlLikeStart = Readonly<{ index: number; authorityEnd: number | undefined }>;

function explicitAuthorityEnd(
  value: string,
  start: number,
  offsets: ReadonlySet<number>,
  isHardBoundary: (index: number) => boolean,
): number {
  let end = start;
  while (
    end < value.length &&
    !offsets.has(end) &&
    !isHardBoundary(end) &&
    !EXPLICIT_AUTHORITY_END_PATTERN.test(value.charAt(end)) &&
    !isTextWhitespaceBoundary(value.charAt(end))
  ) {
    end += 1;
  }
  return end;
}

function* urlLikeStartIndices(
  value: string,
  offsets: ReadonlySet<number>,
  isHardBoundary: (index: number) => boolean,
): Generator<UrlLikeStart> {
  let authorityStart = 0;
  let schemeEnd = 0;
  let coveredSchemeRelativeStart: number | undefined;
  let protectedAuthorityEnd = 0;
  const isStructuralBoundary = (index: number): boolean =>
    isHardBoundary(index) || offsets.has(index);
  for (let index = 0; index < value.length; index += 1) {
    if (offsets.has(index)) authorityStart = index;
    if (index < protectedAuthorityEnd) continue;
    const character = value.charAt(index);
    if (isAuthoritySeparator(value, index, isHardBoundary)) authorityStart = index + 1;
    let startsBareAuthority = false;
    if (index === authorityStart) {
      let authorityEnd = index;
      while (
        authorityEnd < value.length &&
        (authorityEnd === index || !offsets.has(authorityEnd)) &&
        !isAuthoritySeparator(value, authorityEnd, isHardBoundary)
      ) {
        authorityEnd += 1;
      }
      const previous = previousUrlInputIndex(value, index - 1, isStructuralBoundary);
      const beforePrevious = previousUrlInputIndex(value, previous - 1, isStructuralBoundary);
      startsBareAuthority =
        !(value.charAt(previous) === "/" && value.charAt(beforePrevious) === "/") &&
        isBareUrlLikeAuthority(value.slice(index, authorityEnd));
    }
    let startsScheme = false;
    let authorityEnd: number | undefined;
    if (index >= schemeEnd && SCHEME_FIRST_CHARACTER_PATTERN.test(character)) {
      schemeEnd = index + 1;
      while (schemeEnd < value.length) {
        if (offsets.has(schemeEnd)) break;
        if (URL_INPUT_DELETED_PATTERN.test(value.charAt(schemeEnd)) && !isHardBoundary(schemeEnd)) {
          schemeEnd += 1;
          continue;
        }
        if (!SCHEME_CHARACTER_PATTERN.test(value.charAt(schemeEnd))) break;
        schemeEnd += 1;
      }
      const colon = value.charAt(schemeEnd) === ":";
      const firstSlash = nextUrlInputIndex(value, schemeEnd + 1, isStructuralBoundary);
      const secondSlash = nextUrlInputIndex(value, firstSlash + 1, isStructuralBoundary);
      const startsSlashScheme =
        colon && value.charAt(firstSlash) === "/" && value.charAt(secondSlash) === "/";
      if (startsSlashScheme) {
        coveredSchemeRelativeStart = firstSlash;
        authorityEnd = explicitAuthorityEnd(value, secondSlash + 1, offsets, isHardBoundary);
        protectedAuthorityEnd = authorityEnd;
      }
      startsScheme =
        startsSlashScheme ||
        (colon && NON_SLASH_SCHEME_NAME_PATTERN.test(urlInputText(value.slice(index, schemeEnd))));
    }
    let startsSchemeRelative = false;
    if (character === "/") {
      const secondSlash = nextUrlInputIndex(value, index + 1, isStructuralBoundary);
      const previous = previousUrlInputIndex(value, index - 1, isStructuralBoundary);
      startsSchemeRelative =
        value.charAt(secondSlash) === "/" &&
        index !== coveredSchemeRelativeStart &&
        value.charAt(previous) !== "/";
      if (startsSchemeRelative) {
        authorityEnd = explicitAuthorityEnd(value, secondSlash + 1, offsets, isHardBoundary);
        protectedAuthorityEnd = authorityEnd;
      }
    }
    if (startsBareAuthority || startsScheme || startsSchemeRelative) yield { index, authorityEnd };
  }
}

/** URL形式の開始位置からMarkdown境界内の候補を列挙する。 */
export function* urlLikeCandidates(
  value: string,
  offsets: readonly number[],
  literalUrl: boolean,
  isHardBoundary: (index: number) => boolean,
): Generator<UrlLikeCandidate> {
  let boundaryIndex = 0;
  const offsetSet = new Set(offsets);
  for (const { index, authorityEnd } of urlLikeStartIndices(value, offsetSet, isHardBoundary)) {
    let candidateEnd = index;
    while (
      candidateEnd < value.length &&
      (literalUrl ||
        candidateEnd < (authorityEnd ?? index) ||
        !isCandidateDelimiter(value, candidateEnd, isHardBoundary))
    ) {
      candidateEnd += 1;
    }
    while (
      candidateEnd > index &&
      !literalUrl &&
      TRAILING_PUNCTUATION_CHARACTER_PATTERN.test(value.charAt(candidateEnd - 1))
    ) {
      candidateEnd -= 1;
    }
    for (; boundaryIndex < offsets.length; boundaryIndex += 1) {
      const boundary = offsets[boundaryIndex];
      assertNonNullable(boundary, "Markdown境界の位置を取得できません");
      if (boundary > index) break;
    }
    const boundary = offsets[boundaryIndex];
    const crossesBoundary = boundary != null && boundary < candidateEnd;
    let end = crossesBoundary ? boundary : candidateEnd;
    while (
      end > index &&
      !literalUrl &&
      TRAILING_PUNCTUATION_CHARACTER_PATTERN.test(value.charAt(end - 1))
    ) {
      end -= 1;
    }
    yield { value: value.slice(index, end), start: index, end };
  }
}

/** 正規化済みのhostがGitHubか判定する。 */
export function isGitHubHost(hostname: string): boolean {
  return hostname === "github.com" || hostname === "github.com.";
}

function matchesGitHubHostWithMarkers(hostname: string, expected: string): boolean {
  const states = new Uint16Array(hostname.length + 1);
  states[0] = 1;
  for (let index = 0; index < hostname.length; index += 1) {
    const state = states[index];
    assertNonNullable(state, "GitHub host候補の状態を取得できません");
    if (state === 0) continue;
    if (hostname.charAt(index) === "~") {
      for (let skipped = 1; skipped <= 3 && index + skipped <= hostname.length; skipped += 1) {
        const next = states[index + skipped];
        assertNonNullable(next, "GitHub host候補の遷移先を取得できません");
        states[index + skipped] = next | state;
      }
      continue;
    }
    for (let expectedIndex = 0; expectedIndex < expected.length; expectedIndex += 1) {
      if (
        (state & (1 << expectedIndex)) !== 0 &&
        hostname.charAt(index) === expected.charAt(expectedIndex)
      ) {
        const next = states[index + 1];
        assertNonNullable(next, "GitHub host候補の遷移先を取得できません");
        states[index + 1] = next | (1 << (expectedIndex + 1));
      }
    }
  }
  const final = states[hostname.length];
  assertNonNullable(final, "GitHub host候補の終端状態を取得できません");
  return (final & (1 << expected.length)) !== 0;
}

function mayHaveMalformedGitHubHostname(rawHostname: string): boolean {
  const percentIndex = rawHostname.indexOf("%");
  if (percentIndex >= 0) {
    const prefixUrl = `https://${rawHostname.slice(0, percentIndex)}`;
    if (URL.canParse(prefixUrl) && isGitHubHost(new URL(prefixUrl).hostname)) return true;
  }
  const repaired = rawHostname
    .replaceAll(PERCENT_ENCODED_UTF8_CHARACTER_PATTERN, (encoded) => {
      const decoded = decodeURIComponent(encoded);
      return HOST_FORBIDDEN_DECODED_CHARACTER_PATTERN.test(decoded) ? "~" : decoded;
    })
    .replaceAll("%", "~")
    .replaceAll(/[\uD800-\uDFFF]/gu, "~");
  const possibleUrl = `https://${repaired}`;
  if (!URL.canParse(possibleUrl)) return false;
  const hostname = new URL(possibleUrl).hostname;
  return (
    isGitHubHost(hostname) ||
    matchesGitHubHostWithMarkers(hostname, "github.com") ||
    matchesGitHubHostWithMarkers(hostname, "github.com.")
  );
}

/** URL候補のauthorityがGitHubか、解析不能でもGitHubになり得るか判定する。 */
export function mayHaveGitHubAuthority(candidate: string): boolean {
  const parsedInput = urlInputText(candidate);
  let absoluteUrl = parsedInput;
  if (parsedInput.startsWith("//")) absoluteUrl = `https:${parsedInput}`;
  else if (!URL_SCHEME_PATTERN.test(parsedInput)) absoluteUrl = `https://${parsedInput}`;
  if (URL.canParse(absoluteUrl)) {
    return isGitHubHost(new URL(absoluteUrl).hostname);
  }
  const source = parsedInput.replace(URL_SCHEME_PATTERN, "").replace(/^\/\//u, "");
  const [authority] = source.split(/[/?#\\]/u);
  const rawHostname = authority?.split("@").at(-1)?.split(":")[0];
  if (rawHostname == null) return false;
  return mayHaveMalformedGitHubHostname(rawHostname);
}
