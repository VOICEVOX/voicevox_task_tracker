import { useEffect, useState } from "preact/hooks";

import {
  type PublicDetailsDto,
  type PublicGraphNodeDto,
  type PublicItemDetailsDto,
  type PublicSummaryDto,
} from "../../src/pages/public-dto.js";
import { assertNonNullable, UnreachableError } from "../../src/util/index.js";
import { type PublicDetailsLoader } from "./details-loader.js";
import { createItemGraphView } from "./graph-model.js";
import { ItemDetailsContent } from "./item-details.js";
import { createItemDetailsMap } from "./model.js";
import { type ItemRouteTarget } from "./url-state.js";

type ItemDetailsPageProps = Readonly<{
  clearSelectionHref: string;
  createItemHref: (nodeId: string) => string;
  loadDetails: PublicDetailsLoader;
  locale: string;
  now: Date;
  onClearSelection: () => void;
  onSelectItem: (nodeId: string) => void;
  summary: PublicSummaryDto;
  target: ItemRouteTarget;
}>;

type DetailsState =
  | Readonly<{
      status: "not_requested";
    }>
  | Readonly<{
      status: "loading";
    }>
  | Readonly<{
      status: "loaded";
      details: PublicDetailsDto;
      itemsByNodeId: ReadonlyMap<string, PublicItemDetailsDto>;
      graphNodesByNodeId: ReadonlyMap<string, PublicGraphNodeDto>;
    }>
  | Readonly<{
      status: "failed";
    }>;

/** pathで選択した項目の詳細を遅延取得して表示する。 */
export function ItemDetailsPage({
  clearSelectionHref,
  createItemHref,
  loadDetails,
  locale,
  now,
  onClearSelection,
  onSelectItem,
  summary,
  target,
}: ItemDetailsPageProps) {
  const [detailsState, setDetailsState] = useState<DetailsState>({
    status: "not_requested",
  });

  useEffect(() => {
    if (detailsState.status !== "not_requested") {
      return;
    }
    setDetailsState({
      status: "loading",
    });
    void loadDetails()
      .then((details) => {
        setDetailsState({
          status: "loaded",
          details,
          itemsByNodeId: createItemDetailsMap(summary, details),
          graphNodesByNodeId: new Map(details.graph.nodes.map((node) => [node.nodeId, node])),
        });
      })
      .catch((error: unknown) => {
        console.error("項目詳細の公開データ取得に失敗しました", error);
        setDetailsState({
          status: "failed",
        });
      });
  }, [detailsState.status, loadDetails, summary]);

  let content;
  switch (detailsState.status) {
    case "not_requested":
    case "loading":
      content = (
        <p class="item-details-placeholder" role="status" aria-live="polite">
          選択した項目の詳細を読み込んでいます。
        </p>
      );
      break;
    case "loaded": {
      const details = detailsState.itemsByNodeId.get(target.nodeId);
      assertNonNullable(details, `選択項目 ${target.nodeId} のdetailsがありません`);
      content = (
        <ItemDetailsContent
          clearSelectionHref={clearSelectionHref}
          createItemHref={createItemHref}
          dependencyGraphView={createItemGraphView(
            summary,
            detailsState.details,
            target.nodeId,
            now,
          )}
          details={details}
          graphNodesByNodeId={detailsState.graphNodesByNodeId}
          locale={locale}
          now={now}
          onClearSelection={onClearSelection}
          onSelectItem={onSelectItem}
          summary={summary}
        />
      );
      break;
    }
    case "failed":
      content = (
        <div class="item-details-placeholder" role="alert">
          <p>選択した項目の詳細を取得できませんでした。</p>
          <button
            type="button"
            onClick={() => {
              setDetailsState({
                status: "not_requested",
              });
            }}
          >
            再取得
          </button>
        </div>
      );
      break;
    default:
      throw new UnreachableError(detailsState);
  }

  return (
    <section aria-labelledby="item-details-page-heading" class="section-card item-workspace">
      <div class="section-heading">
        <div>
          <p class="eyebrow">Item details</p>
          <h2 id="item-details-page-heading">項目詳細</h2>
        </div>
        <p>公開済みデータだけを使い、項目の判定根拠と変更履歴まで確認できます。</p>
      </div>
      <div id="item-details" class="item-details-region" aria-live="polite">
        {content}
      </div>
    </section>
  );
}
