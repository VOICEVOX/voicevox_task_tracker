import { parseSourceId } from "../../../domain/source-id.js";
import type { NormalizedEvent } from "../../../domain/index.js";
import type { FreshObservedGitHubItem } from "../../../github/item-normalization.js";
import type {
  CurrentItemSourceFact,
  ItemSourceKind,
  SourceImmutableFields,
} from "../contracts/evidence-catalog.js";
import { EvidenceCatalog } from "./evidence-catalog.js";

const normalizedEventSourceKinds = new Set<string>([
  "github_issue_comment",
  "github_pull_request_review_comment",
  "github_pull_request_review",
  "github_timeline_event",
  "github_pull_request_commit",
  "github_native_dependency",
  "github_native_hierarchy",
  "github_native_closing_issue",
]);

function isNormalizedEventSourceKind(kind: string): kind is ItemSourceKind {
  return normalizedEventSourceKinds.has(kind);
}

function eventSourceKind(event: NormalizedEvent): ItemSourceKind {
  const { kind } = parseSourceId(event.sourceId);
  if (!isNormalizedEventSourceKind(kind)) {
    throw new TypeError(
      `正規化イベントに収集対象外のsource種別があります。対象: ${event.sourceId}`,
    );
  }
  const expected = (() => {
    if (event.kind === "comment") {
      return ["github_issue_comment", "github_pull_request_review_comment"];
    }
    if (event.kind === "review") return ["github_pull_request_review"];
    if (event.kind === "push") {
      return ["github_timeline_event", "github_pull_request_commit"];
    }
    if (event.kind === "relation") {
      return [
        "github_timeline_event",
        "github_native_dependency",
        "github_native_hierarchy",
        "github_native_closing_issue",
      ];
    }
    return ["github_timeline_event"];
  })();
  if (!expected.includes(kind)) {
    throw new TypeError(`正規化イベントとsource種別が一致しません。対象: ${event.sourceId}`);
  }
  return kind;
}

function eventImmutableFields(
  event: NormalizedEvent,
  sourceKind: ItemSourceKind,
): SourceImmutableFields {
  if (
    sourceKind === "github_native_dependency" ||
    sourceKind === "github_native_hierarchy" ||
    sourceKind === "github_native_closing_issue"
  ) {
    return {};
  }
  if (sourceKind === "github_pull_request_commit") return {};
  return {
    occurredAt: event.occurredAt,
    ...(event.actor.type === "system" ? {} : { actorNodeId: event.actor.nodeId }),
  };
}

/** 正規化済み観測値と詳細recordが示す不変fieldを照合する。 */
export function addNormalizedSourceFacts(
  catalog: EvidenceCatalog,
  item: FreshObservedGitHubItem,
): void {
  catalog.registerCurrentSource({
    scope: "item",
    sourceKind: "github_item_detail",
    sourceId: item.sourceId,
    itemNodeId: item.nodeId,
    origin: "normalized_item",
    immutable: { repositoryId: item.repositoryId, itemType: item.type, itemNumber: item.number },
  });
  catalog.registerCurrentSource({
    scope: "item",
    sourceKind: "github_item_body",
    sourceId: item.bodySourceId,
    itemNodeId: item.nodeId,
    origin: "normalized_item",
    immutable: { repositoryId: item.repositoryId, itemNumber: item.number },
  });
  for (const event of item.events) {
    if (event.itemNodeId !== item.nodeId) {
      throw new TypeError(
        `正規化イベントの所有項目が観測値と一致しません。対象: ${event.sourceId}`,
      );
    }
    const sourceKind = eventSourceKind(event);
    const fact: CurrentItemSourceFact = Object.freeze({
      scope: "item",
      sourceKind,
      sourceId: event.sourceId,
      itemNodeId: item.nodeId,
      origin: "normalized_item",
      immutable: eventImmutableFields(event, sourceKind),
    });
    catalog.registerCurrentSource(fact);
  }
}
