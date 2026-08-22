import { type ComponentChildren } from "preact";

import { UnreachableError } from "../../src/util/index.js";

type AriaSort = "ascending" | "descending" | "none" | "other" | undefined;

export type ResponsiveTableColumn<Row> = Readonly<{
  ariaSort: AriaSort;
  cellClassName: string;
  cellKind: "data" | "row_header";
  headerClassName: string;
  key: string;
  label: string;
  onSort?: () => void;
  renderCell: (row: Row) => ComponentChildren;
  widthClassName: string;
}>;

export type ResponsiveCardField<Row> = Readonly<{
  className: string;
  key: string;
  label: string;
  renderValue: (row: Row) => ComponentChildren;
  valueClassName: string;
}>;

export type ResponsiveListRowPresentation = Readonly<{
  cardClassName: string;
  dataAttributes: Readonly<Record<string, string>>;
  key: string;
  tableClassName: string;
}>;

type ResponsiveBreakpoint = "md" | "lg";

type BreakpointClassNames = Readonly<{
  cardList: string;
  tableRegion: string;
}>;

type ResponsiveTableCardListProps<Row> = Readonly<{
  breakpoint: ResponsiveBreakpoint;
  cardAriaLabel: string;
  cardFields: readonly ResponsiveCardField<Row>[];
  cardListClassName: string;
  columns: readonly ResponsiveTableColumn<Row>[];
  getRowPresentation: (row: Row, index: number) => ResponsiveListRowPresentation;
  renderCardFooter: (row: Row) => ComponentChildren;
  renderCardHeading: (row: Row) => ComponentChildren;
  rows: readonly Row[];
  tableCaption: string;
  tableClassName: string;
}>;

const BREAKPOINT_CLASS_NAMES = {
  md: {
    cardList: "md:hidden",
    tableRegion: "md:block",
  },
  lg: {
    cardList: "lg:hidden",
    tableRegion: "lg:block",
  },
} satisfies Readonly<Record<ResponsiveBreakpoint, BreakpointClassNames>>;

function TableCell<Row>({
  column,
  row,
}: Readonly<{
  column: ResponsiveTableColumn<Row>;
  row: Row;
}>) {
  const className = `p-3 text-left align-top ${column.cellClassName}`;
  switch (column.cellKind) {
    case "data":
      return <td class={className}>{column.renderCell(row)}</td>;
    case "row_header":
      return (
        <th class={`${className} font-semibold`} scope="row">
          {column.renderCell(row)}
        </th>
      );
    default:
      throw new UnreachableError(column.cellKind);
  }
}

/** 同じ行データを広い画面では表、狭い画面ではカード一覧として表示する。 */
export function ResponsiveTableCardList<Row>({
  breakpoint,
  cardAriaLabel,
  cardFields,
  cardListClassName,
  columns,
  getRowPresentation,
  renderCardFooter,
  renderCardHeading,
  rows,
  tableCaption,
  tableClassName,
}: ResponsiveTableCardListProps<Row>) {
  const breakpointClassNames = BREAKPOINT_CLASS_NAMES[breakpoint];
  return (
    <>
      <div
        class={`items-table-region hidden min-w-0 overflow-hidden rounded-2xl border border-border-default bg-surface-card shadow-[0_8px_24px_rgba(34,52,45,0.04)] ${breakpointClassNames.tableRegion}`}
      >
        <table class={`w-full table-fixed border-collapse ${tableClassName}`}>
          <caption class="visually-hidden sr-only">{tableCaption}</caption>
          <colgroup>
            {columns.map((column) => (
              <col key={column.key} class={column.widthClassName} />
            ))}
          </colgroup>
          <thead>
            <tr>
              {columns.map((column) => (
                <th
                  key={column.key}
                  class={`sticky top-0 border-b border-border-subtle bg-surface-sunken p-3 text-left align-middle text-sm font-bold text-text-secondary ${column.headerClassName}`}
                  scope="col"
                  aria-sort={column.ariaSort}
                >
                  {column.onSort == null ? (
                    column.label
                  ) : (
                    <button
                      class="inline-flex min-h-11 cursor-pointer items-center gap-1 rounded-xl bg-transparent px-2 py-1 text-left text-sm font-bold text-text-secondary hover:bg-surface-emphasis hover:text-text-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-focus-ring"
                      type="button"
                      onClick={column.onSort}
                    >
                      <span>{column.label}</span>
                      {column.ariaSort === "ascending" && <span aria-hidden="true">↑</span>}
                      {column.ariaSort === "descending" && <span aria-hidden="true">↓</span>}
                    </button>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => {
              const presentation = getRowPresentation(row, index);
              return (
                <tr
                  {...presentation.dataAttributes}
                  key={presentation.key}
                  class={`border-b border-border-subtle last:border-b-0 hover:bg-surface-page/60 ${presentation.tableClassName}`}
                >
                  {columns.map((column) => (
                    <TableCell key={column.key} column={column} row={row} />
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <ol
        class={`items-card-list m-0 grid list-none overflow-hidden rounded-2xl border border-border-default bg-surface-card p-0 shadow-[0_8px_24px_rgba(34,52,45,0.04)] ${breakpointClassNames.cardList} ${cardListClassName}`}
        aria-label={cardAriaLabel}
      >
        {rows.map((row, index) => {
          const presentation = getRowPresentation(row, index);
          return (
            <li
              {...presentation.dataAttributes}
              key={presentation.key}
              class={`border-b border-border-subtle last:border-b-0 hover:bg-surface-page/60 ${presentation.cardClassName}`}
            >
              <article class="grid gap-3 p-4">
                <div class="item-card-heading min-w-0">{renderCardHeading(row)}</div>
                <dl class="item-card-summary m-0 grid grid-cols-2 gap-x-4 gap-y-3">
                  {cardFields.map((field) => (
                    <div key={field.key} class={`min-w-0 ${field.className}`}>
                      <dt class="text-xs font-bold text-text-muted">{field.label}</dt>
                      <dd class={`mt-1 mb-0 min-w-0 wrap-anywhere ${field.valueClassName}`}>
                        {field.renderValue(row)}
                      </dd>
                    </div>
                  ))}
                </dl>
                {renderCardFooter(row)}
              </article>
            </li>
          );
        })}
      </ol>
    </>
  );
}
