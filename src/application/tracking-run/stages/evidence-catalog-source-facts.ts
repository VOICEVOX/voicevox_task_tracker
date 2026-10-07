import type { CurrentSourceFact } from "../contracts/evidence-catalog.js";
import { buildProductionSourceId } from "../../../github/production-source-id.js";
import type { EnumeratedGitHubItem } from "../../../github/item-enumeration.js";
import type { GitHubItemDetail } from "../../../github/item-detail-types.js";
import type { FreshObservedGitHubItem } from "../../../github/item-normalization.js";
import { createCollectionSourceCatalog } from "./collection-source-catalog.js";
import { EvidenceCatalog } from "./evidence-catalog.js";
import { addItemDetailSources } from "./evidence-catalog-detail-sources.js";
import { addNormalizedSourceFacts } from "./evidence-catalog-normalized-sources.js";

/** 現行source factを構築するために必要な収集record。 */
export type CurrentSourceRecords = Readonly<{
  enumeratedItems: readonly EnumeratedGitHubItem[];
  details: readonly GitHubItemDetail[];
  observedItems: readonly FreshObservedGitHubItem[];
}>;

function addEnumeratedItem(catalog: EvidenceCatalog, item: EnumeratedGitHubItem): void {
  catalog.registerCurrentSource({
    scope: "shared",
    sourceKind: "github_item",
    sourceId: buildProductionSourceId("github_item", item.nodeId),
    origin: "enumerated_item",
    immutable: {
      nodeId: item.nodeId,
      repositoryId: item.repositoryId,
      itemType: item.type,
      itemNumber: item.number,
    },
  });
  if (
    item.bodyLocator.itemNodeId !== item.nodeId ||
    item.bodyLocator.repositoryId !== item.repositoryId ||
    item.bodyLocator.number !== item.number
  ) {
    throw new TypeError(`列挙結果の本文locatorが項目と一致しません。対象: ${item.nodeId}`);
  }
  catalog.registerCurrentSource({
    scope: "item",
    sourceKind: "github_item_body",
    sourceId: buildProductionSourceId("github_item_body", item.nodeId),
    itemNodeId: item.nodeId,
    origin: "enumerated_item",
    immutable: { repositoryId: item.repositoryId, itemNumber: item.number },
  });
}

/** T12で保持した収集recordから現行source事実を抽出する。 */
export function collectCurrentSourceFacts(
  records: CurrentSourceRecords,
): readonly CurrentSourceFact[] {
  const catalog = new EvidenceCatalog();
  for (const item of records.enumeratedItems) addEnumeratedItem(catalog, item);
  for (const detail of records.details) addItemDetailSources(catalog, detail);
  for (const item of records.observedItems) addNormalizedSourceFacts(catalog, item);
  const facts = catalog.snapshot().currentSources;
  const factIds = new Set(facts.map((fact) => fact.sourceId));
  for (const sourceId of createCollectionSourceCatalog(records)) {
    if (!factIds.has(sourceId)) {
      throw new TypeError(`収集source IDに対応するrecordがありません。対象: ${sourceId}`);
    }
  }
  return facts;
}
