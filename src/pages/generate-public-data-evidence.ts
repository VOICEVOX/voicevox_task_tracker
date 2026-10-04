import type { Evidence, SourceId, TrackedItem } from "../domain/index.js";
import type { StateSnapshot } from "../persistence/index.js";
import { PublicDtoSemanticError } from "./errors.js";
import {
  resolveEvidenceSourceUrlForItem,
  type EvidenceSourceUrlMap,
} from "./evidence-source-url.js";
import type {
  PublicDetailsDto,
  PublicPersonalReminderResponseDto,
} from "./public-dto-contracts.js";
import { compareStrings } from "./public-dto-primitives.js";

export type EvidenceSourceItem = Readonly<Pick<TrackedItem, "nodeId" | "url">>;
type PublicPersonalReminderResponse = PublicPersonalReminderResponseDto;

function createPublicEvidenceEntry(
  entry: Evidence,
  currentSourceItem: EvidenceSourceItem,
  allSourceItems: readonly EvidenceSourceItem[],
  sourceOwnersById: EvidenceSourceUrlMap,
): PublicDetailsDto["items"][number]["evidence"][number] {
  return {
    summary: entry.summary,
    sourceUrl: resolveEvidenceSourceUrlForItem(
      entry.sourceId,
      currentSourceItem,
      allSourceItems,
      sourceOwnersById,
    ),
  };
}

type PublicEvidence = PublicDetailsDto["items"][number]["evidence"][number];

function publicEvidenceIdentity(evidence: PublicEvidence): string {
  return JSON.stringify([evidence.summary, evidence.sourceUrl]);
}

function uniquePublicEvidence(evidence: readonly PublicEvidence[]): PublicEvidence[] {
  const evidenceByIdentity = new Map<string, PublicEvidence>();
  for (const entry of evidence) {
    evidenceByIdentity.set(publicEvidenceIdentity(entry), entry);
  }
  return [...evidenceByIdentity.entries()]
    .sort(([left], [right]) => compareStrings(left, right))
    .map(([, entry]) => entry);
}

/** 根拠を公開URL付きの値へ写す。 */
export function createPublicEvidence(
  evidence: readonly Evidence[],
  currentSourceItem: EvidenceSourceItem,
  allSourceItems: readonly EvidenceSourceItem[],
  sourceOwnersById: EvidenceSourceUrlMap,
): PublicDetailsDto["items"][number]["evidence"] {
  return uniquePublicEvidence(
    evidence.map((entry) =>
      createPublicEvidenceEntry(entry, currentSourceItem, allSourceItems, sourceOwnersById),
    ),
  );
}

/** 個人催促の根拠を公開URL付きの値へ写す。 */
export function createPersonalReminderResponseEvidence(
  sourceIds: readonly SourceId[],
  currentSourceItem: StateSnapshot["items"][number],
  allSourceItems: readonly EvidenceSourceItem[],
  sourceOwnersById: EvidenceSourceUrlMap,
): PublicPersonalReminderResponse["evidence"] {
  const uniqueSourceIds = [...new Set(sourceIds)].sort(compareStrings);
  return uniquePublicEvidence(
    uniqueSourceIds.flatMap((sourceId) => {
      const evidence = currentSourceItem.evidence.filter((entry) => entry.sourceId === sourceId);
      if (evidence.length === 0) {
        throw new PublicDtoSemanticError(
          `personal reminder causeのevidence sourceを公開根拠へ解決できません。対象: ${sourceId}`,
        );
      }
      return evidence.map((entry) =>
        createPublicEvidenceEntry(entry, currentSourceItem, allSourceItems, sourceOwnersById),
      );
    }),
  );
}
