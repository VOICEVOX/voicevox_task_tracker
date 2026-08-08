import { assertNonNullable } from "../../src/util/index.js";
import { type ItemSort } from "./model.js";
import { ITEM_SORT_OPTIONS } from "./sort-controls.js";

type ListCountSummaryProps = Readonly<{
  className: string;
  count: number;
  locale: string;
  sort: ItemSort;
}>;

/** 一覧の件数と現在の並び順を表示する。 */
export function ListCountSummary({ className, count, locale, sort }: ListCountSummaryProps) {
  const selectedSortOption = ITEM_SORT_OPTIONS.find((option) => option.key === sort.key);
  assertNonNullable(selectedSortOption, "選択中の並び順がありません");

  return (
    <p
      class={`${className} m-0 grid justify-items-end text-right max-shell:justify-items-start max-shell:text-left`}
      aria-live="polite"
    >
      <strong class="text-xl leading-tight text-text-primary">
        {count.toLocaleString(locale)}件
      </strong>
      <span class="text-xs">{selectedSortOption.label}</span>
    </p>
  );
}
