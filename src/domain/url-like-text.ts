const URL_LIKE_START_PATTERN =
  /[A-Za-z][A-Za-z0-9+.-]*:\/\/|(?<![A-Za-z0-9+.-])(?:mailto|javascript|data|urn|tel|blob|about):|(?<![:/])\/\/|(?<![A-Za-z0-9_.@/:%-])(?:[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}(?=[/?#]|\b))/giu;
const URL_LIKE_TEXT_PATTERN = new RegExp(
  `(?:${URL_LIKE_START_PATTERN.source})[^\\s<>"'\\x60]*`,
  "giu",
);
const TRAILING_PUNCTUATION_PATTERN = /[.,;:!?、。！？)\]}）］｝」』]+$/u;
const PERCENT_ENCODED_UTF8_CHARACTER_PATTERN = new RegExp(
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

/** 理由要約にURL形式を含めないschema制約。 */
export const NO_URL_LIKE_TEXT_PATTERN = new RegExp(
  `^(?![\\s\\S]*${URL_LIKE_TEXT_PATTERN.source})[\\s\\S]*$`,
  "iu",
);

type UrlLikeTextScan =
  | Readonly<{ status: "valid"; candidates: readonly string[]; decodedTexts: readonly string[] }>
  | Readonly<{ status: "invalid" }>;

/** URLの全開始位置と有界な復号段階を検査し、候補内の曖昧な符号化を拒否する。 */
export function scanUrlLikeText(value: string): UrlLikeTextScan {
  const candidates = new Set<string>();
  const decodedTexts: string[] = [];
  let current = value;
  let candidateCharacters = 0;
  for (let depth = 0; ; depth += 1) {
    if (current.length > 1_000_000) return Object.freeze({ status: "invalid" });
    decodedTexts.push(current);
    for (const match of current.matchAll(URL_LIKE_START_PATTERN)) {
      const suffix = current.slice(match.index);
      const end = suffix.search(/[\s<>"'`]/u);
      const candidate = (end < 0 ? suffix : suffix.slice(0, end)).replace(
        TRAILING_PUNCTUATION_PATTERN,
        "",
      );
      try {
        decodeURIComponent(candidate);
      } catch (error: unknown) {
        if (!(error instanceof URIError)) throw error;
        return Object.freeze({ status: "invalid" });
      }
      candidateCharacters += candidate.length;
      if (candidateCharacters > 1_000_000) return Object.freeze({ status: "invalid" });
      candidates.add(candidate);
      if (candidates.size > 4096) return Object.freeze({ status: "invalid" });
    }
    const decoded = current.replaceAll(PERCENT_ENCODED_UTF8_CHARACTER_PATTERN, (encoded) =>
      decodeURIComponent(encoded),
    );
    if (decoded === current) {
      return Object.freeze({
        status: "valid",
        candidates: Object.freeze([...candidates]),
        decodedTexts: Object.freeze(decodedTexts),
      });
    }
    if (depth === 4) return Object.freeze({ status: "invalid" });
    current = decoded;
  }
}

/** 自然文にURL形式の候補または解釈不能な符号化があるか判定する。 */
export function containsUrlLikeText(value: string): boolean {
  const scan = scanUrlLikeText(value);
  return scan.status === "invalid" || scan.candidates.length > 0;
}
