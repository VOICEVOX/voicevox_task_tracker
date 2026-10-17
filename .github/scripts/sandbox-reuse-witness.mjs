import { hashCanonicalJson, parseSha256Hash } from "../../dist/canonical-json/index.js";
import { createAiCacheKey } from "../../dist/codex/cache.js";

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value != null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function verifiedSnapshotReuses(firstItems, secondItems, firstGeneratedAt) {
  const firstByNodeId = new Map(firstItems.map((item) => [item.nodeId, item]));
  const matches = [];
  for (const secondItem of secondItems) {
    const firstItem = firstByNodeId.get(secondItem.nodeId);
    if (firstItem == null) {
      continue;
    }
    for (const [element, secondApplication] of Object.entries(secondItem.aiAnalysis.applications)) {
      if (
        secondApplication.status !== "current_ai" ||
        secondApplication.origin !== "verified_reuse" ||
        firstItem.aiAnalysis.applications[element]?.status !== "current_ai" ||
        firstItem.aiAnalysis.applications[element].origin !== "executed"
      ) {
        continue;
      }
      const firstAdopted = firstItem.aiAnalysis.adoptedElements[element];
      const firstEvaluated = firstItem.aiAnalysis.elements[element];
      const secondAdopted = secondItem.aiAnalysis.adoptedElements[element];
      if (
        firstAdopted?.origin !== "current" ||
        firstEvaluated == null ||
        secondAdopted?.origin !== "current" ||
        firstAdopted.reuseProof.status !== "verified" ||
        secondAdopted.reuseProof.status !== "verified" ||
        firstAdopted.generation.metadata.generatedAt !== firstGeneratedAt ||
        canonicalJson(firstAdopted.generation) !== canonicalJson(firstEvaluated.generation) ||
        firstAdopted.generation.metadata.inputFingerprint !==
          secondAdopted.generation.metadata.inputFingerprint ||
        firstAdopted.reuseProof.inputFingerprint !==
          firstAdopted.generation.metadata.inputFingerprint ||
        canonicalJson(firstAdopted.reuseProof) !== canonicalJson(secondAdopted.reuseProof) ||
        canonicalJson(firstAdopted.generation) !== canonicalJson(secondAdopted.generation) ||
        canonicalJson(firstAdopted.result) !== canonicalJson(secondAdopted.result)
      ) {
        throw new TypeError("second runのsnapshot再利用証拠がfirstの採用結果と一致しません");
      }
      matches.push({
        nodeId: secondItem.nodeId,
        element,
        inputFingerprint: firstAdopted.reuseProof.inputFingerprint,
      });
    }
  }
  return matches;
}

/** secondの実計画と保存結果から別nodeのsnapshot再利用証人を選ぶ。 */
export function plannedSnapshotReuseWitness(
  firstItems,
  secondItems,
  firstGeneratedAt,
  choices,
  cacheNodeId,
) {
  const plannedChoices = new Map(
    choices.map((choice) => [JSON.stringify([choice.nodeId, choice.element]), choice]),
  );
  const snapshotReuses = verifiedSnapshotReuses(firstItems, secondItems, firstGeneratedAt).filter(
    (reuse) => {
      const planned = plannedChoices.get(JSON.stringify([reuse.nodeId, reuse.element]));
      return (
        planned?.choice === "snapshot_reuse" && planned.inputFingerprint === reuse.inputFingerprint
      );
    },
  );
  const plannedWitness = snapshotReuses.find((reuse) => reuse.nodeId !== cacheNodeId);
  if (plannedWitness == null) {
    throw new TypeError("second runの別nodeで計画済みsnapshot再利用を確認できません");
  }
  return {
    snapshotReuses,
    snapshotReuseWitness: { ...plannedWitness, choice: "snapshot_reuse" },
  };
}

/** firstの実AI採用値がsecondで指定どおりcache採用されたことを照合する。 */
export function verifyCacheProbeAdoption(firstItems, secondItems, probe) {
  const firstCacheItem = firstItems.find((item) => item.nodeId === probe.nodeId);
  const secondCacheItem = secondItems.find((item) => item.nodeId === probe.nodeId);
  if (
    firstCacheItem == null ||
    secondCacheItem == null ||
    probe.elements.length < 1 ||
    new Set(probe.elements.map((entry) => entry.element)).size !== probe.elements.length
  ) {
    throw new TypeError("second runのcache probe対象が不正です");
  }
  for (const expected of probe.elements) {
    const firstEvaluated = firstCacheItem.aiAnalysis.elements[expected.element];
    const secondEvaluated = secondCacheItem.aiAnalysis.elements[expected.element];
    const firstAdopted = firstCacheItem.aiAnalysis.adoptedElements[expected.element];
    const secondAdopted = secondCacheItem.aiAnalysis.adoptedElements[expected.element];
    const firstApplication = firstCacheItem.aiAnalysis.applications[expected.element];
    const secondApplication = secondCacheItem.aiAnalysis.applications[expected.element];
    if (
      firstEvaluated == null ||
      secondEvaluated == null ||
      firstAdopted?.origin !== "current" ||
      secondAdopted?.origin !== "current" ||
      firstAdopted.reuseProof.status !== "verified" ||
      secondAdopted.reuseProof.status !== "verified" ||
      firstApplication?.status !== "current_ai" ||
      firstApplication.origin !== "executed" ||
      secondApplication?.status !== "current_ai" ||
      secondApplication.origin !== "cache" ||
      firstEvaluated.generation.metadata.inputFingerprint !== expected.inputFingerprint ||
      secondEvaluated.generation.metadata.inputFingerprint !== expected.inputFingerprint ||
      firstAdopted.reuseProof.inputFingerprint !== expected.inputFingerprint ||
      secondAdopted.reuseProof.inputFingerprint !== expected.inputFingerprint ||
      hashCanonicalJson(firstEvaluated.generation) !== expected.generationDigest ||
      canonicalJson(firstEvaluated.generation) !== canonicalJson(firstAdopted.generation) ||
      canonicalJson(firstEvaluated.generation) !== canonicalJson(secondEvaluated.generation) ||
      canonicalJson(secondEvaluated.generation) !== canonicalJson(secondAdopted.generation) ||
      canonicalJson(firstAdopted.result) !== canonicalJson(secondAdopted.result)
    ) {
      throw new TypeError("second runのcache結果がfirstの生成値と一致しません");
    }
    const metadata = firstEvaluated.generation.metadata;
    const cacheKey = createAiCacheKey({
      element: expected.element,
      revision: metadata.revision,
      model: metadata.model,
      reasoningEffort: metadata.reasoningEffort,
      backendVersion: metadata.backendVersion,
      schemaVersion: metadata.schemaVersion,
      inputFingerprint: parseSha256Hash(metadata.inputFingerprint),
      executionFingerprint: parseSha256Hash(metadata.executionFingerprint),
    });
    if (cacheKey !== expected.cacheKey) {
      throw new TypeError("second runのcache keyがfirstの生成値と一致しません");
    }
  }
  return probe.elements.length;
}
