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

type ResponsiveTableCardListProps<Row> = Readonly<{
  cardAriaLabel: string;
  cardFields: readonly ResponsiveCardField<Row>[];
  cardListClassName: string;
  columns: readonly ResponsiveTableColumn<Row>[];
  getRowPresentation: (row: Row) => ResponsiveListRowPresentation;
  renderCardFooter: (row: Row) => ComponentChildren;
  renderCardHeading: (row: Row) => ComponentChildren;
  rows: readonly Row[];
  tableCaption: string;
  tableClassName: string;
}>;

function TableCell<Row>({
  column,
  row,
}: Readonly<{
  column: ResponsiveTableColumn<Row>;
  row: Row;
}>) {
  const className = `border-b border-border-subtle p-3 text-left align-top ${column.cellClassName}`;
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
  return (
    <>
      <div class="items-table-region hidden min-w-0 md:block">
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
                  class={`border-b border-border-subtle bg-surface-sunken p-3 text-left align-middle text-sm font-bold text-text-secondary ${column.headerClassName}`}
                  scope="col"
                  aria-sort={column.ariaSort}
                >
                  {column.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const presentation = getRowPresentation(row);
              return (
                <tr
                  {...presentation.dataAttributes}
                  key={presentation.key}
                  class={presentation.tableClassName}
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
        class={`items-card-list m-0 grid list-none gap-3 p-0 md:hidden ${cardListClassName}`}
        aria-label={cardAriaLabel}
      >
        {rows.map((row) => {
          const presentation = getRowPresentation(row);
          return (
            <li
              {...presentation.dataAttributes}
              key={presentation.key}
              class={`overflow-hidden rounded-xl border border-border-subtle ${presentation.cardClassName}`}
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
