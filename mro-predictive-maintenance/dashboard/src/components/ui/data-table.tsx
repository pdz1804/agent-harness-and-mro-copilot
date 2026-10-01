import { useEffect, useMemo, useState, type CSSProperties, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { ariaSort, nextSort, shouldIgnoreRowClick, sortRows, type SortDir, type SortState, type SortValue } from "../../lib/table-sort";
import { ArrowDownIcon, ArrowUpIcon, SortIcon } from "./icons";
import { EmptyState } from "./states";

export interface Column<T> {
  key: string;
  header: ReactNode;
  /** Plain-text header for screen readers when `header` is an element. */
  headerLabel?: string;
  render: (row: T, index: number) => ReactNode;
  /** Present = the column is sortable by this value. */
  sortValue?: (row: T) => SortValue;
  /** Numeric columns right-align and start descending. */
  numeric?: boolean;
  /** Hide below 768px (tables hide columns instead of scrolling sideways). */
  hideSm?: boolean;
  /** Hide below 1100px. */
  hideMd?: boolean;
  /** Shrink to content. */
  fit?: boolean;
  /** Truncate with an ellipsis (set `title` in render for the full text). */
  truncate?: boolean;
  /** Takes the leftover width. */
  grow?: boolean;
}

interface DataTableProps<T> {
  rows: readonly T[];
  columns: Column<T>[];
  rowKey: (row: T) => string;
  /** Whole-row click target. The real <a> in the first column stays the
   * keyboard and middle-click path; the row click is the mouse shortcut. */
  rowHref?: (row: T) => string | undefined;
  onRowClick?: (row: T) => void;
  selectedKey?: string | null;
  defaultSort?: SortState;
  /** Accessible table name. */
  label: string;
  /** Rendered inside the body when there are no rows. */
  empty?: ReactNode;
  /** Shown instead of rows while the first load is in flight. */
  loading?: boolean;
  skeletonRows?: number;
  footer?: ReactNode;
  /** Controlled sort (e.g. persisted in the URL). */
  sort?: SortState | null;
  onSortChange?: (s: SortState | null) => void;
  /** Multi-select: checkbox column; `canSelect` limits which rows qualify. */
  selection?: ReadonlySet<string>;
  onSelectionChange?: (next: Set<string>) => void;
  canSelect?: (row: T) => boolean;
  /** Actions revealed on row hover / focus (last column). */
  rowActions?: (row: T) => ReactNode;
  /** Rows to highlight briefly (just changed). */
  flashKeys?: ReadonlySet<string>;
  /** Rows in a pending mutation (shimmer). */
  pendingKeys?: ReadonlySet<string>;
  /** Report the rendered order (sheet prev/next follows what you see). */
  onOrderChange?: (keys: string[]) => void;
}

/** The one table for the product: sticky header (to the page scroller),
 * sortable columns with aria-sort, right-aligned tabular numbers, whole-row
 * click, skeleton and empty states in place. */
export function DataTable<T>({
  rows,
  columns,
  rowKey,
  rowHref,
  onRowClick,
  selectedKey,
  defaultSort,
  label,
  empty,
  loading,
  skeletonRows = 8,
  footer,
  sort: sortProp,
  onSortChange,
  selection,
  onSelectionChange,
  canSelect,
  rowActions,
  flashKeys,
  pendingKeys,
  onOrderChange,
}: DataTableProps<T>) {
  const [sortLocal, setSortLocal] = useState<SortState | null>(defaultSort ?? null);
  const sort = sortProp !== undefined ? sortProp ?? defaultSort ?? null : sortLocal;
  const setSort = (fn: (s: SortState | null) => SortState | null) => {
    const next = fn(sort);
    if (onSortChange) onSortChange(next);
    else setSortLocal(next);
  };

  const sorted = useMemo(() => {
    if (!sort) return rows;
    const col = columns.find((c) => c.key === sort.key);
    if (!col?.sortValue) return rows;
    return sortRows(rows, col.sortValue, sort.dir);
  }, [rows, columns, sort]);

  const orderKey = sorted.map(rowKey).join("|");
  useEffect(() => {
    onOrderChange?.(orderKey ? orderKey.split("|") : []);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderKey]);

  const selectable = !!onSelectionChange;
  const eligible = selectable ? sorted.filter((r) => canSelect?.(r) ?? true).map(rowKey) : [];
  const allOn = eligible.length > 0 && eligible.every((k) => selection?.has(k));
  const someOn = eligible.some((k) => selection?.has(k));
  const toggle = (key: string) => {
    const next = new Set(selection ?? []);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    onSelectionChange?.(next);
  };

  const cls = (c: Column<T>) =>
    [c.numeric ? "num" : "", c.hideSm ? "hide-sm" : "", c.hideMd ? "hide-md" : "", c.fit ? "fit" : "", c.grow ? "grow" : "", c.truncate ? "trunc" : ""]
      .filter(Boolean)
      .join(" ");

  const go = (row: T) => {
    const href = rowHref?.(row);
    if (href) window.location.hash = href.startsWith("#") ? href : `#${href}`;
    onRowClick?.(row);
  };

  const clickable = !!rowHref || !!onRowClick;

  const onClick = (e: MouseEvent<HTMLTableRowElement>, row: T) => {
    const selection = typeof window !== "undefined" ? window.getSelection()?.toString() ?? "" : "";
    if (shouldIgnoreRowClick(e.target as Element, selection)) return;
    go(row);
  };

  const onKey = (e: KeyboardEvent<HTMLTableRowElement>, row: T) => {
    // Enter on the row itself (not on a nested control) opens it too.
    if (e.key === "Enter" && e.target === e.currentTarget) go(row);
  };

  return (
    <div className="table-wrap">
      <table className="dt" aria-label={label} aria-busy={loading || undefined}>
        <thead>
          <tr>
            {selectable && (
              <th scope="col" className="fit dt-check">
                <input
                  type="checkbox"
                  className="row-check"
                  aria-label="Select all eligible rows"
                  checked={allOn}
                  ref={(el) => {
                    if (el) el.indeterminate = someOn && !allOn;
                  }}
                  disabled={eligible.length === 0}
                  onChange={() => onSelectionChange?.(allOn ? new Set() : new Set(eligible))}
                />
              </th>
            )}
            {columns.map((c) => {
              const sortable = !!c.sortValue;
              return (
                <th key={c.key} scope="col" className={cls(c)} aria-sort={sortable ? ariaSort(sort, c.key) : undefined}>
                  {sortable ? (
                    <button
                      type="button"
                      className="th-btn"
                      onClick={() => setSort((s) => nextSort(s, c.key, (c.numeric ? "desc" : "asc") as SortDir))}
                    >
                      <span>{c.header}</span>
                      <span className="sort-ico" aria-hidden="true" style={{ display: "inline-flex" }}>
                        {sort?.key === c.key ? sort.dir === "asc" ? <ArrowUpIcon /> : <ArrowDownIcon /> : <SortIcon />}
                      </span>
                      <span className="sr-only">
                        {c.headerLabel ?? ""}
                        {sort?.key === c.key ? `, sorted ${sort.dir === "asc" ? "ascending" : "descending"}` : ", sort"}
                      </span>
                    </button>
                  ) : (
                    c.header
                  )}
                </th>
              );
            })}
            {rowActions && (
              <th scope="col" className="fit dt-actions-h">
                <span className="sr-only">Row actions</span>
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {loading &&
            Array.from({ length: skeletonRows }, (_, i) => (
              <tr key={`sk-${i}`} className="dt-skel" aria-hidden="true">
                {selectable && <td className="fit dt-check" />}
                {columns.map((c) => (
                  <td key={c.key} className={cls(c)}>
                    <div className="skeleton" style={{ height: 12, width: c.numeric ? "50%" : "75%", marginLeft: c.numeric ? "auto" : 0 }} />
                  </td>
                ))}
                {rowActions && <td className="fit" />}
              </tr>
            ))}
          {!loading &&
            sorted.map((row, i) => {
              const key = rowKey(row);
              const rowCls = [
                clickable ? "is-link" : "",
                selectedKey === key ? "is-selected" : "",
                selection?.has(key) ? "is-checked" : "",
                flashKeys?.has(key) ? "is-flash" : "",
                pendingKeys?.has(key) ? "is-pending" : "",
              ]
                .filter(Boolean)
                .join(" ");
              const rowSelectable = selectable && (canSelect?.(row) ?? true);
              return (
                <tr
                  key={key}
                  style={i < 12 ? ({ "--i": i } as CSSProperties) : undefined}
                  className={rowCls}
                  onClick={clickable ? (e) => onClick(e, row) : undefined}
                  onKeyDown={clickable ? (e) => onKey(e, row) : undefined}
                  aria-selected={selectedKey === key ? true : undefined}
                >
                  {selectable && (
                    <td className="fit dt-check" data-row-ignore>
                      {rowSelectable && (
                        <input
                          type="checkbox"
                          className="row-check"
                          aria-label={`Select ${key}`}
                          checked={selection?.has(key) ?? false}
                          onChange={() => toggle(key)}
                        />
                      )}
                    </td>
                  )}
                  {columns.map((c) => (
                    <td key={c.key} className={cls(c)}>
                      {c.render(row, i)}
                    </td>
                  ))}
                  {rowActions && (
                    <td className="fit dt-actions">
                      <div className="dt-actions-inner">{rowActions(row)}</div>
                    </td>
                  )}
                </tr>
              );
            })}
        </tbody>
      </table>
      {!loading && rows.length === 0 && (empty ?? <EmptyState title="Nothing to show" />)}
      {footer && <div className="dt-foot">{footer}</div>}
    </div>
  );
}
