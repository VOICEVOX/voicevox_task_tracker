import type { Sha256Hash } from "../../../canonical-json/sha256.js";

/** canonical bytesのSHA-256計算を副作用層へ委ねる。 */
export type ContentDigestPort = Readonly<{
  sha256Utf8: (value: string) => Sha256Hash;
  sha256Utf8Chunks: (values: Iterable<string>) => Sha256Hash;
  sha256Bytes: (value: Uint8Array) => Sha256Hash;
}>;
