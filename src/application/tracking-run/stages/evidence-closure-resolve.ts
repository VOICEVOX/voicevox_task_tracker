import { serializeCanonicalJson } from "../../../canonical-json/value.js";
import { parseSourceId } from "../../../domain/source-id.js";
import { isProductionSourceIdKind } from "../../../github/production-source-id.js";
import type { CurrentSourceFact } from "../contracts/evidence-catalog.js";
import type {
  EvidenceClosureContext,
  EvidenceUse,
  OwnedHistoricalEvidence,
  ResolvedEvidenceUse,
} from "../contracts/evidence-closure.js";
import {
  aiResultSourceIds,
  matchingHistoricalAiResults,
  type AiResultSlot,
} from "./evidence-ai-results.js";
import { RunCompletenessError } from "./run-completeness-error.js";

function historyEventKinds(kind: string): readonly string[] {
  if (kind === "comment") return ["github_issue_comment", "github_pull_request_review_comment"];
  if (kind === "push") return ["github_timeline_event", "github_pull_request_commit"];
  if (kind === "review") return ["github_pull_request_review"];
  if (kind === "relation") {
    return [
      "github_timeline_event",
      "github_native_dependency",
      "github_native_hierarchy",
      "github_native_closing_issue",
    ];
  }
  return ["github_timeline_event"];
}

function assertCurrentFact(
  use: EvidenceUse,
  fact: CurrentSourceFact,
  context: EvidenceClosureContext,
): void {
  const repositoryIds = new Set<string>(
    context.approvedRepositories.map((repository) => repository.id),
  );
  if (
    fact.immutable.repositoryId != null &&
    !repositoryIds.has(fact.immutable.repositoryId) &&
    !(fact.sourceKind === "github_item" && fact.origin === "item_detail")
  ) {
    throw new RunCompletenessError("private_source", use.sourceId, use.path, use);
  }
  if (fact.scope === "item" && !use.allowedOwnerNodeIds.includes(fact.itemNodeId)) {
    throw new RunCompletenessError("wrong_owner", use.sourceId, use.path, use);
  }
  for (const occurredAt of [fact.immutable.occurredAt, fact.immutable.committedAt]) {
    if (occurredAt != null && occurredAt > context.evaluatedAt) {
      throw new RunCompletenessError("future_source", use.sourceId, use.path, use);
    }
  }
  if (use.purpose.startsWith("history_")) {
    const kind = use.purpose.slice("history_".length);
    if (!historyEventKinds(kind).includes(fact.sourceKind)) {
      throw new RunCompletenessError("kind_mismatch", use.sourceId, use.path, use);
    }
  }
}

function historicalOwnerMatches(use: EvidenceUse, value: OwnedHistoricalEvidence): boolean {
  if (value.owner.kind === "item") {
    return use.allowedOwnerNodeIds.includes(value.owner.itemNodeId);
  }
  return (
    use.allowedRelationIds.includes(value.owner.relationId) &&
    use.allowedOwnerNodeIds.includes(value.owner.fromNodeId) &&
    use.allowedOwnerNodeIds.includes(value.owner.toNodeId)
  );
}

function assertHistoricalRecord(
  use: EvidenceUse,
  value: OwnedHistoricalEvidence,
  context: EvidenceClosureContext,
): void {
  if (value.owner.kind !== "item") return;
  const repositoryIds = new Set<string>(
    context.approvedRepositories.map((repository) => repository.id),
  );
  if (!repositoryIds.has(value.owner.repositoryId)) {
    throw new RunCompletenessError("private_source", use.sourceId, use.path, use);
  }
}

/** 一つの利用を現行事実か所有位置を証明できる履歴recordへ解決する。 */
export function resolveEvidenceUse(
  use: EvidenceUse,
  currentById: ReadonlyMap<string, readonly CurrentSourceFact[]>,
  historicalById: ReadonlyMap<string, readonly OwnedHistoricalEvidence[]>,
  context: EvidenceClosureContext,
  annotation?: Readonly<{ supports: string; summary: string }>,
  aiSlot?: Readonly<{ slot: AiResultSlot; origin: "current" | "historical" }>,
): Readonly<{ resolved: ResolvedEvidenceUse; historical: readonly OwnedHistoricalEvidence[] }> {
  const sourceKind = parseSourceId(use.sourceId).kind;
  if (!isProductionSourceIdKind(sourceKind)) {
    throw new RunCompletenessError("kind_mismatch", use.sourceId, use.path, use);
  }
  if (aiSlot != null) {
    const { slot, origin } = aiSlot;
    if (
      !use.allowedOwnerNodeIds.includes(slot.owner.itemNodeId) ||
      !aiResultSourceIds(slot.element, slot.result).includes(use.sourceId)
    ) {
      throw new RunCompletenessError("wrong_owner", use.sourceId, use.path, use);
    }
    if (origin === "historical") {
      if (use.requiredCurrentness === "current")
        throw new RunCompletenessError("missing_source", use.sourceId, use.path, use);
      const repositories = new Set<string>(
        context.approvedRepositories.map((repository) => repository.id),
      );
      if (!repositories.has(slot.owner.repositoryId))
        throw new RunCompletenessError("private_source", use.sourceId, use.path, use);
      const matched = matchingHistoricalAiResults(slot, context.historicalAiResults);
      return Object.freeze({
        resolved: Object.freeze({
          use,
          resolution: "historical",
          recordIdentity: serializeCanonicalJson({
            matched,
            ...(annotation == null ? {} : { annotation }),
          }),
        }),
        historical: Object.freeze([]),
      });
    }
  }
  const previousNotification = use.purpose === "previous_notification_pending";
  const facts = previousNotification ? [] : (currentById.get(use.sourceId) ?? []);
  if (facts.length > 0) {
    for (const fact of facts) {
      if (fact.sourceKind !== sourceKind) {
        throw new RunCompletenessError("kind_mismatch", use.sourceId, use.path, use);
      }
      assertCurrentFact(use, fact, context);
    }
    return Object.freeze({
      resolved: Object.freeze({
        use,
        resolution: "current",
        recordIdentity: serializeCanonicalJson({
          facts,
          ...(annotation == null ? {} : { annotation }),
        }),
      }),
      historical: Object.freeze([]),
    });
  }
  const historical = historicalById.get(use.sourceId) ?? [];
  if (use.requiredCurrentness === "current" || historical.length === 0) {
    throw new RunCompletenessError("missing_source", use.sourceId, use.path, use);
  }
  const owned = historical.filter((value) => historicalOwnerMatches(use, value));
  if (owned.length === 0) {
    throw new RunCompletenessError("wrong_owner", use.sourceId, use.path, use);
  }
  const matched = owned.filter(
    (value) =>
      annotation == null ||
      (value.record.evidence.supports === annotation.supports &&
        value.record.evidence.summary === annotation.summary),
  );
  if (matched.length === 0) {
    throw new RunCompletenessError("missing_source", use.sourceId, use.path, use);
  }
  for (const value of matched) assertHistoricalRecord(use, value, context);
  return Object.freeze({
    resolved: Object.freeze({
      use,
      resolution: "historical",
      recordIdentity: serializeCanonicalJson({
        matched,
        ...(annotation == null ? {} : { annotation }),
      }),
    }),
    historical: Object.freeze(matched),
  });
}
