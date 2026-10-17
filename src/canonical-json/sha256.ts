const SHA256_HASH_PATTERN = /^sha256:[0-9a-f]{64}$/u;

/** SHA-256で生成したcanonical JSONのhash。 */
export type Sha256Hash = `sha256:${string}`;

/** SHA-256 hash文字列を検証する。 */
export function parseSha256Hash(value: string): Sha256Hash {
  if (!SHA256_HASH_PATTERN.test(value)) {
    throw new TypeError("SHA-256 hashはsha256:に続く64桁の小文字16進数にしてください");
  }
  return `sha256:${value.slice("sha256:".length)}`;
}
