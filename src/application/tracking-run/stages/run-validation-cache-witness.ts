import { serializeCanonicalJson } from "../../../canonical-json/value.js";
import type { Sha256Hash } from "../../../canonical-json/sha256.js";
import type {
  AiAnalysisElement,
  AiAnalysisElementGeneration,
} from "../../../domain/ai-analysis-elements.js";
import type { PersonalReminderAiGeneration } from "../../../domain/personal-reminder-causes.js";
import type { TrackedItemAiAnalysis } from "../../../domain/tracked-item-ai-analysis.js";
import type { EvidenceClosureAdditions } from "./evidence-closure.js";
import type { ContentDigestPort } from "../contracts/content-digest-port.js";
import { RunCompletenessError } from "./run-completeness-error.js";
import { assertRunValueMatches, runValuesById } from "./run-validation-compare.js";

/** 保存cacheに対応する公開可能な項目所有情報。 */
export type CacheOwnerWitness = Readonly<{
  generic: readonly Readonly<{
    cacheKey: string;
    itemNodeId: string;
    element: string;
    generationDigest: Sha256Hash;
  }>[];
  personalReminder: readonly Readonly<{
    cacheKey: string;
    itemNodeId: string;
    causeId: string;
    generationDigest: Sha256Hash;
  }>[];
}>;

/** 再証明で読む汎用AI cacheの公開field。 */
export type RunAiCacheAddition = Readonly<{
  cacheKey: string;
  element: AiAnalysisElement;
  generation: AiAnalysisElementGeneration;
}>;

/** 再証明で読む個人催促AI cacheの公開field。 */
export type RunPersonalCacheAddition = Readonly<{
  cacheKey: string;
  causeId: string;
  generation: PersonalReminderAiGeneration;
}>;

type CacheValues = Readonly<{
  aiCacheAdditions: readonly RunAiCacheAddition[];
  personalReminderAiCacheAdditions: readonly RunPersonalCacheAddition[];
  snapshot: Readonly<{
    items: readonly Readonly<{
      nodeId: string;
      aiAnalysis: TrackedItemAiAnalysis;
      personalReminderCauses: readonly Readonly<{ causeId: string }>[];
    }>[];
  }>;
}>;

function generationDigest(value: unknown, digest: ContentDigestPort): Sha256Hash {
  return digest.sha256Utf8(serializeCanonicalJson(value));
}

/** 実outward追加と保存cacheの一対一対応から所有witnessを作る。 */
export function createCacheOwnerWitness(
  outward: Pick<EvidenceClosureAdditions, "aiCacheAdditions" | "personalReminderAiCacheAdditions">,
  values: CacheValues,
  digest: ContentDigestPort,
): CacheOwnerWitness {
  if (
    outward.aiCacheAdditions.length !== values.aiCacheAdditions.length ||
    outward.personalReminderAiCacheAdditions.length !==
      values.personalReminderAiCacheAdditions.length
  ) {
    throw new RunCompletenessError("missing_value", "cache", ["cacheOwners"], undefined);
  }
  const items = runValuesById(values.snapshot.items, (item) => item.nodeId, ["snapshot", "items"]);
  const generic = values.aiCacheAdditions.map((entry, index) => {
    const addition = outward.aiCacheAdditions[index];
    if (addition == null || !items.has(addition.itemNodeId)) {
      throw new RunCompletenessError(
        "wrong_owner",
        entry.cacheKey,
        ["aiCacheAdditions", index],
        undefined,
      );
    }
    assertRunValueMatches(
      addition.element,
      entry.element,
      ["aiCacheAdditions", index, "element"],
      entry.cacheKey,
    );
    assertRunValueMatches(
      addition.result,
      entry.generation.result,
      ["aiCacheAdditions", index, "result"],
      entry.cacheKey,
    );
    assertRunValueMatches(
      entry.generation,
      items.get(addition.itemNodeId)?.aiAnalysis.elements[entry.element]?.generation,
      ["snapshot", "items", addition.itemNodeId, "aiAnalysis", "elements", entry.element],
      entry.cacheKey,
    );
    return Object.freeze({
      cacheKey: entry.cacheKey,
      itemNodeId: addition.itemNodeId,
      element: entry.element,
      generationDigest: generationDigest(entry.generation, digest),
    });
  });
  const personalReminder = values.personalReminderAiCacheAdditions.map((entry, index) => {
    const addition = outward.personalReminderAiCacheAdditions[index];
    const item = addition == null ? undefined : items.get(addition.itemNodeId);
    if (
      addition == null ||
      item?.personalReminderCauses.some((cause) => cause.causeId === entry.causeId) !== true
    ) {
      throw new RunCompletenessError(
        "wrong_owner",
        entry.cacheKey,
        ["personalReminderAiCacheAdditions", index],
        undefined,
      );
    }
    assertRunValueMatches(
      addition.result,
      entry.generation.result,
      ["personalReminderAiCacheAdditions", index, "result"],
      entry.cacheKey,
    );
    return Object.freeze({
      cacheKey: entry.cacheKey,
      itemNodeId: addition.itemNodeId,
      causeId: entry.causeId,
      generationDigest: generationDigest(entry.generation, digest),
    });
  });
  return Object.freeze({
    generic: Object.freeze(generic),
    personalReminder: Object.freeze(personalReminder),
  });
}

/** 保存cacheと所有witnessをkey、生成値、項目所属まで再照合する。 */
export function assertCacheOwnerWitness(
  witness: CacheOwnerWitness,
  values: CacheValues,
  digest: ContentDigestPort,
): void {
  if (
    witness.generic.length !== values.aiCacheAdditions.length ||
    witness.personalReminder.length !== values.personalReminderAiCacheAdditions.length
  ) {
    throw new RunCompletenessError("missing_value", "cache", ["cacheOwners"], undefined);
  }
  runValuesById(witness.generic, (entry) => entry.cacheKey, ["cacheOwners", "generic"]);
  runValuesById(witness.personalReminder, (entry) => entry.cacheKey, [
    "cacheOwners",
    "personalReminder",
  ]);
  const items = runValuesById(values.snapshot.items, (item) => item.nodeId, ["snapshot", "items"]);
  for (const [index, entry] of values.aiCacheAdditions.entries()) {
    const owner = witness.generic[index];
    if (owner == null || !items.has(owner.itemNodeId)) {
      throw new RunCompletenessError(
        "wrong_owner",
        entry.cacheKey,
        ["cacheOwners", "generic", index],
        undefined,
      );
    }
    assertRunValueMatches(
      {
        cacheKey: entry.cacheKey,
        element: entry.element,
        generationDigest: generationDigest(entry.generation, digest),
      },
      {
        cacheKey: owner.cacheKey,
        element: owner.element,
        generationDigest: owner.generationDigest,
      },
      ["cacheOwners", "generic", index],
      entry.cacheKey,
    );
    assertRunValueMatches(
      entry.generation,
      items.get(owner.itemNodeId)?.aiAnalysis.elements[entry.element]?.generation,
      ["snapshot", "items", owner.itemNodeId, "aiAnalysis", "elements", entry.element],
      entry.cacheKey,
    );
  }
  for (const [index, entry] of values.personalReminderAiCacheAdditions.entries()) {
    const owner = witness.personalReminder[index];
    const item = owner == null ? undefined : items.get(owner.itemNodeId);
    if (
      owner == null ||
      item?.personalReminderCauses.some((cause) => cause.causeId === entry.causeId) !== true
    ) {
      throw new RunCompletenessError(
        "wrong_owner",
        entry.cacheKey,
        ["cacheOwners", "personalReminder", index],
        undefined,
      );
    }
    assertRunValueMatches(
      {
        cacheKey: entry.cacheKey,
        causeId: entry.causeId,
        generationDigest: generationDigest(entry.generation, digest),
      },
      {
        cacheKey: owner.cacheKey,
        causeId: owner.causeId,
        generationDigest: owner.generationDigest,
      },
      ["cacheOwners", "personalReminder", index],
      entry.cacheKey,
    );
  }
}
