import {
  type UrlInputProjection,
  type UrlLikeCandidate,
  urlInputProjection,
} from "./url-like-candidates.js";

export type UrlTextPart = Readonly<{
  start: number;
  end: number;
  kind: "path" | "query" | "fragment";
}>;

const URL_SCHEME_PATTERN = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//u;
const NON_HIERARCHICAL_SCHEME_PATTERN = /^(?:mailto|javascript|data|urn|tel|blob|about):/iu;

function sourceIndex(projection: UrlInputProjection, index: number): number {
  return projection.sourceIndices?.[index] ?? index;
}

function urlTextPart(
  candidate: UrlLikeCandidate,
  projection: UrlInputProjection,
  start: number,
  end: number,
  kind: UrlTextPart["kind"],
): UrlTextPart | undefined {
  if (start === end) return undefined;
  return {
    start: candidate.start + sourceIndex(projection, start),
    end: candidate.start + sourceIndex(projection, end - 1) + 1,
    kind,
  };
}

/** URL候補のpath、queryの各field、fragmentを原文位置へ対応付ける。 */
export function urlTextParts(
  candidate: UrlLikeCandidate,
  isStructuralDelimiter: (index: number) => boolean,
): readonly UrlTextPart[] {
  const projection = urlInputProjection(candidate.value, () => false);
  const input = projection.value;
  const structural = (index: number): boolean =>
    isStructuralDelimiter(candidate.start + sourceIndex(projection, index));
  const nextDelimiter = (start: number, end: number, delimiter: string): number => {
    for (let index = start; index < end; index += 1) {
      if (input.charAt(index) === delimiter && structural(index)) return index;
    }
    return -1;
  };
  const nonHierarchicalScheme = NON_HIERARCHICAL_SCHEME_PATTERN.exec(input);
  const scheme = URL_SCHEME_PATTERN.exec(input);
  const authorityStart = input.startsWith("//") ? 2 : (scheme?.[0].length ?? 0);
  let componentStart = -1;
  if (nonHierarchicalScheme == null) {
    for (let index = authorityStart; index < input.length; index += 1) {
      const character = input.charAt(index);
      if (
        character === "/" ||
        character === "\\" ||
        ((character === "?" || character === "#") && structural(index))
      ) {
        componentStart = index;
        break;
      }
    }
  } else {
    componentStart = 0;
  }
  if (componentStart < 0) return [];
  const pathStart =
    nonHierarchicalScheme == null ? componentStart : nonHierarchicalScheme[0].length;
  const fragmentStart = nextDelimiter(pathStart, input.length, "#");
  const beforeFragment = fragmentStart < 0 ? input.length : fragmentStart;
  const queryStart = nextDelimiter(pathStart, beforeFragment, "?");
  const hasQuery = queryStart >= 0 && queryStart < beforeFragment;
  const parts: UrlTextPart[] = [];
  const path = urlTextPart(
    candidate,
    projection,
    pathStart,
    hasQuery ? queryStart : beforeFragment,
    "path",
  );
  if (path != null) parts.push(path);
  if (hasQuery) {
    let fieldStart = queryStart + 1;
    while (fieldStart < beforeFragment) {
      const separator = nextDelimiter(fieldStart, beforeFragment, "&");
      const fieldEnd = separator < 0 ? beforeFragment : separator;
      const equals = nextDelimiter(fieldStart, fieldEnd, "=");
      if (equals < 0) {
        const field = urlTextPart(candidate, projection, fieldStart, fieldEnd, "query");
        if (field != null) parts.push(field);
      } else {
        const key = urlTextPart(candidate, projection, fieldStart, equals, "query");
        const value = urlTextPart(candidate, projection, equals + 1, fieldEnd, "query");
        if (key != null) parts.push(key);
        if (value != null) parts.push(value);
      }
      fieldStart = fieldEnd + 1;
    }
  }
  if (fragmentStart >= 0) {
    const fragment = urlTextPart(
      candidate,
      projection,
      fragmentStart + 1,
      input.length,
      "fragment",
    );
    if (fragment != null) parts.push(fragment);
  }
  return parts;
}
