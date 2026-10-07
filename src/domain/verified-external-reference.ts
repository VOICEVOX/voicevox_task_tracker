/** GitHubで公開状態を検証して保存した外部IssueまたはPull Request。 */
export type VerifiedExternalReference = Readonly<{
  repositoryFullName: string;
  number: number;
  url: string;
}>;

const GITHUB_OWNER_PATTERN = /^[a-z\d](?:[a-z\d-]{0,38})$/iu;
const GITHUB_REPOSITORY_PATTERN = /^[a-z\d_.-]+$/iu;

/** 検証済みの外部項目から許可する項目URLとrepository URLを作る。 */
export function verifiedExternalUrls(
  references: readonly VerifiedExternalReference[],
): ReadonlySet<string> | undefined {
  const urls = new Set<string>();
  for (const reference of references) {
    const [owner, name, extra] = reference.repositoryFullName.split("/");
    if (
      owner == null ||
      name == null ||
      extra != null ||
      !GITHUB_OWNER_PATTERN.test(owner) ||
      !GITHUB_REPOSITORY_PATTERN.test(name) ||
      owner.toLowerCase() === "voicevox" ||
      !Number.isSafeInteger(reference.number) ||
      reference.number <= 0 ||
      !URL.canParse(reference.url)
    ) {
      return undefined;
    }
    const url = new URL(reference.url);
    const path = url.pathname.split("/");
    const [, urlOwner, urlName, itemKind, itemNumber, trailing] = path;
    if (
      url.protocol !== "https:" ||
      url.hostname !== "github.com" ||
      url.port !== "" ||
      url.username !== "" ||
      url.password !== "" ||
      url.search !== "" ||
      url.hash !== "" ||
      urlOwner?.toLowerCase() !== owner.toLowerCase() ||
      urlName?.toLowerCase() !== name.toLowerCase() ||
      (itemKind !== "issues" && itemKind !== "pull") ||
      itemNumber !== reference.number.toString() ||
      trailing != null
    ) {
      return undefined;
    }
    urls.add(url.toString().toLowerCase());
    urls.add(`https://github.com/${owner}/${name}`.toLowerCase());
  }
  return urls;
}

/** 検証済み外部参照の同一性を確認し、保存順序を固定する。 */
export function normalizeVerifiedExternalReferences(
  references: readonly VerifiedExternalReference[],
): readonly VerifiedExternalReference[] {
  const byUrl = new Map<string, VerifiedExternalReference>();
  for (const reference of references) {
    if (verifiedExternalUrls([reference]) == null) {
      throw new TypeError("検証済み外部参照のURLとrepository情報が一致しません");
    }
    const existing = byUrl.get(reference.url.toLowerCase());
    if (
      existing != null &&
      (existing.repositoryFullName.toLowerCase() !== reference.repositoryFullName.toLowerCase() ||
        existing.number !== reference.number)
    ) {
      throw new TypeError("同じ外部参照URLに異なる項目が指定されています");
    }
    byUrl.set(reference.url.toLowerCase(), Object.freeze({ ...reference }));
  }
  return Object.freeze(
    [...byUrl.values()].sort((left, right) => left.url.localeCompare(right.url)),
  );
}
