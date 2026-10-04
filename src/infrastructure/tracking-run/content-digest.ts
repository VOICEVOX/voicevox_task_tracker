import { createHash } from "node:crypto";

import type { ContentDigestPort } from "../../application/tracking-run/contracts/content-digest-port.js";
import { parseSha256Hash, type Sha256Hash } from "../../canonical-json/sha256.js";
import { canonicalJsonPieces } from "../../canonical-json/value.js";

/** Node.jsでcanonical bytesのSHA-256を計算する。 */
export const nodeContentDigestPort: ContentDigestPort = {
  sha256Utf8(value: string): Sha256Hash {
    return parseSha256Hash(`sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`);
  },
  sha256Utf8Chunks(values: Iterable<string>): Sha256Hash {
    const hash = createHash("sha256");
    for (const value of values) hash.update(value, "utf8");
    return parseSha256Hash(`sha256:${hash.digest("hex")}`);
  },
  sha256Bytes(value: Uint8Array): Sha256Hash {
    return parseSha256Hash(`sha256:${createHash("sha256").update(value).digest("hex")}`);
  },
};

/** JSON値のcanonical表現からSHA-256 hashを生成する。 */
export function hashCanonicalJson(value: unknown): Sha256Hash {
  return nodeContentDigestPort.sha256Utf8Chunks(canonicalJsonPieces(value));
}
