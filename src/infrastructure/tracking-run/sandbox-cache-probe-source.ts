import {
  hashCanonicalJson,
  parseSha256Hash,
  serializeCanonicalJson,
} from "../../canonical-json/index.js";
import { createAiCacheKey, type AiCacheStore } from "../../codex/cache.js";
import {
  AI_ANALYSIS_ELEMENTS,
  AI_ANALYSIS_ELEMENT_SCHEMA_VERSION,
} from "../../domain/ai-analysis-elements.js";
import type { StateSnapshot } from "../../persistence/snapshot-v23.js";
import type {
  GenericAiCacheProbe,
  GenericAiCacheProbeSource,
} from "../../application/tracking-run/stages/generic-ai-cache-plan.js";

/** firstの実行採用値と実file cacheが一致する候補を列挙する。 */
export async function readFirstFileCacheProbeSource(
  snapshot: StateSnapshot,
  cache: Pick<AiCacheStore, "read">,
): Promise<GenericAiCacheProbeSource> {
  const candidates: GenericAiCacheProbe[] = [];
  const items = [...snapshot.items].sort((left, right) =>
    left.nodeId < right.nodeId ? -1 : left.nodeId > right.nodeId ? 1 : 0,
  );
  for (const item of items) {
    const elements: GenericAiCacheProbe["elements"][number][] = [];
    for (const element of AI_ANALYSIS_ELEMENTS) {
      const application = item.aiAnalysis.applications[element];
      const adopted = item.aiAnalysis.adoptedElements[element];
      const evaluated = item.aiAnalysis.elements[element];
      if (
        application.status !== "current_ai" ||
        application.origin !== "executed" ||
        adopted?.origin !== "current" ||
        adopted.reuseProof.status !== "verified" ||
        adopted.generation.metadata.generatedAt !== snapshot.generatedAt ||
        evaluated?.generation.metadata.generatedAt !== snapshot.generatedAt ||
        serializeCanonicalJson(adopted.generation) !== serializeCanonicalJson(evaluated.generation)
      ) {
        continue;
      }
      const generation = evaluated.generation;
      const metadata = generation.metadata;
      if (metadata.schemaVersion !== AI_ANALYSIS_ELEMENT_SCHEMA_VERSION) {
        continue;
      }
      const cacheKey = createAiCacheKey({
        element,
        revision: metadata.revision,
        model: metadata.model,
        reasoningEffort: metadata.reasoningEffort,
        backendVersion: metadata.backendVersion,
        schemaVersion: metadata.schemaVersion,
        inputFingerprint: parseSha256Hash(metadata.inputFingerprint),
        executionFingerprint: parseSha256Hash(metadata.executionFingerprint),
      });
      const cached = await cache.read(cacheKey);
      if (cached.status === "miss") {
        continue;
      }
      if (
        cached.entry.cacheKey !== cacheKey ||
        cached.entry.element !== element ||
        serializeCanonicalJson(cached.entry.generation) !== serializeCanonicalJson(generation)
      ) {
        throw new TypeError("firstの実file cacheがsnapshotの生成結果と一致しません");
      }
      elements.push({
        element,
        inputFingerprint: metadata.inputFingerprint,
        cacheKey,
        generationDigest: hashCanonicalJson(generation),
      });
    }
    if (elements.length > 0) {
      candidates.push({ nodeId: item.nodeId, elements });
    }
  }
  if (candidates.length === 0) {
    throw new TypeError("firstに実AI採用と実file cacheの候補がありません");
  }
  return Object.freeze({
    candidateDigest: hashCanonicalJson(candidates),
    candidates: Object.freeze(candidates),
  });
}
