import { assertNonNullable } from "../../src/util/index.js";
import { type ItemSort, type ItemSortKey } from "./model.js";
import { ActionButton, FORM_CONTROL_CLASS_NAME } from "./ui.js";

/** 項目一覧で選べる並び替えキー。 */
export const ITEM_SORT_OPTIONS = [
  {
    key: "attention",
    label: "要対応度",
  },
  {
    key: "importance",
    label: "重要度",
  },
  {
    key: "stall",
    label: "停滞時間",
  },
] satisfies readonly Readonly<{
  key: ItemSortKey;
  label: string;
}>[];

type SortOption<Key extends string> = Readonly<{
  key: Key;
  label: string;
}>;

type SortControlsProps<Key extends string> = Readonly<{
  className: string;
  onSortChange: (key: Key) => void;
  options: readonly SortOption<Key>[];
  selectId: string;
  sort: Readonly<{
    key: Key;
    direction: ItemSort["direction"];
  }>;
}>;

/** 一覧の並び替え操作を表示する。 */
export function SortControls<Key extends string>({
  className,
  onSortChange,
  options,
  selectId,
  sort,
}: SortControlsProps<Key>) {
  return (
    <div class={className}>
      <label class="col-span-full text-sm font-bold text-text-secondary" for={selectId}>
        並び順
      </label>
      <select
        class={`${FORM_CONTROL_CLASS_NAME} w-full`}
        id={selectId}
        value={sort.key}
        onChange={(event) => {
          const selectedOption = options.find((option) => option.key === event.currentTarget.value);
          assertNonNullable(selectedOption, "選択された並び順がありません");
          onSortChange(selectedOption.key);
        }}
      >
        {options.map((option) => (
          <option key={option.key} value={option.key}>
            {option.label}
          </option>
        ))}
      </select>
      <ActionButton
        type="button"
        aria-label={`並び順を${sort.direction === "ascending" ? "降順" : "昇順"}に変更`}
        onClick={() => {
          onSortChange(sort.key);
        }}
      >
        {sort.direction === "ascending" ? "昇順 ↑" : "降順 ↓"}
      </ActionButton>
    </div>
  );
}
