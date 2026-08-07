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
import { ContentState, PageSection } from "./layout.js";
import { createItemDetailsMap } from "./model.js";
import { ActionButton } from "./ui.js";
import { type ItemRouteTarget } from "./url-state.js";

type ItemDetailsPageProps = Readonly<{
  clearSelectionHref: string;
  createItemHref: (nodeId: string) => string;
  loadDetails: PublicDetailsLoader;
  locale: string;
  now: Date;
  onClearSelection: () => void;
  onSelectItem: (nodeId: string) => void;
  showHeadingFocusRing: boolean;
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
  showHeadingFocusRing,
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
        <ContentState
          className="item-details-placeholder"
          message="選択した項目の詳細を読み込んでいます。"
          status="loading"
        />
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
          showHeadingFocusRing={showHeadingFocusRing}
          summary={summary}
        />
      );
      break;
    }
    case "failed":
      content = (
        <ContentState
          className="item-details-placeholder"
          message="選択した項目の詳細を取得できませんでした。"
          status="failed"
        >
          <ActionButton
            type="button"
            onClick={() => {
              setDetailsState({
                status: "not_requested",
              });
            }}
          >
            再取得
          </ActionButton>
        </ContentState>
      );
      break;
    default:
      throw new UnreachableError(detailsState);
  }

  return (
    <PageSection
      className="item-workspace scroll-mt-4"
      heading="項目詳細"
      headingId="item-details-page-heading"
    >
      <div id="item-details" class="item-details-region min-w-0 scroll-mt-4" aria-live="polite">
        {content}
      </div>
    </PageSection>
  );
}
