import type { GenericAiCacheLookupPort } from "../../../../application/tracking-run/stages/generic-ai-cache-plan.js";
import { parseSha256Hash } from "../../../../canonical-json/sha256.js";
import {
  createAiCacheKey,
  determineAiCacheReuse,
  type AiCacheStore,
} from "../../../../codex/cache.js";
import { GENERIC_AI_ELEMENT_DEFINITIONS } from "../../../../codex/generic-ai-definition.js";

/** 要素別cacheを現行入力と実行条件で照合する。 */
export function createGenericAiCacheLookup(cache: AiCacheStore): GenericAiCacheLookupPort {
  return async (identity, planning, element) => {
    const candidate = planning.candidates[element];
    const cacheIdentity = Object.freeze({
      ...identity,
      element,
      revision: GENERIC_AI_ELEMENT_DEFINITIONS[element].revision,
      inputFingerprint: parseSha256Hash(candidate.inputFingerprint),
      executionFingerprint: parseSha256Hash(candidate.executionFingerprint),
    });
    const cached = await cache.read(createAiCacheKey(cacheIdentity));
    if (cached.status === "miss") {
      return Object.freeze({ status: "miss" });
    }
    const reuse = determineAiCacheReuse(cached.entry, cacheIdentity);
    return reuse.status === "reusable"
      ? Object.freeze({ status: "hit", entry: reuse.entry })
      : Object.freeze({ status: "stale" });
  };
}
