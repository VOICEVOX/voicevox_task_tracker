import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { ContentDigestPort } from "../../application/tracking-run/contracts/content-digest-port.js";
import { serializeCanonicalJson } from "../../canonical-json/value.js";

/** 指定したsource列の内容を正規化してdigestを計算する。 */
export async function hashSources(
  repositoryPath: string,
  paths: readonly string[],
  digest: ContentDigestPort,
): Promise<ReturnType<ContentDigestPort["sha256Utf8"]>> {
  const entries = await Promise.all(
    paths.map(async (path) => ({
      path,
      digest: digest.sha256Bytes(await readFile(resolve(repositoryPath, path))),
    })),
  );
  return digest.sha256Utf8(serializeCanonicalJson(entries));
}
