/** Pure sorting helpers for DataTable. Kept DOM-free so they are unit-tested. */

export type SortDir = "asc" | "desc";
export interface SortState {
  key: string;
  dir: SortDir;
}
export type SortValue = string | number | boolean | null | undefined;

function isMissing(v: SortValue): boolean {
  return v === null || v === undefined || (typeof v === "number" && Number.isNaN(v));
}

export function compareValues(a: NonNullable<SortValue>, b: NonNullable<SortValue>): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "boolean" && typeof b === "boolean") return Number(a) - Number(b);
  return String(a).localeCompare(String(b), "en", { numeric: true, sensitivity: "base" });
}

/** Stable sort. Missing values (null, undefined, NaN) always sort last, in
 * either direction, so "not scanned" rows never lead a descending list. */
export function sortRows<T>(rows: readonly T[], getValue: (row: T) => SortValue, dir: SortDir): T[] {
  const sign = dir === "asc" ? 1 : -1;
  return rows
    .map((row, index) => ({ row, index, value: getValue(row) }))
    .sort((x, y) => {
      const xm = isMissing(x.value);
      const ym = isMissing(y.value);
      if (xm || ym) return xm === ym ? x.index - y.index : xm ? 1 : -1;
      const c = compareValues(x.value as NonNullable<SortValue>, y.value as NonNullable<SortValue>);
      return c !== 0 ? sign * c : x.index - y.index;
    })
    .map((x) => x.row);
}

/** Header click: same column flips direction, a new column starts at its default. */
export function nextSort(current: SortState | null, key: string, defaultDir: SortDir = "asc"): SortState {
  if (current && current.key === key) return { key, dir: current.dir === "asc" ? "desc" : "asc" };
  return { key, dir: defaultDir };
}

export function ariaSort(state: SortState | null, key: string): "ascending" | "descending" | "none" {
  if (!state || state.key !== key) return "none";
  return state.dir === "asc" ? "ascending" : "descending";
}

/** Whole-row click must not fire when the user clicked a control inside the
 * row, or finished selecting text. */
export function shouldIgnoreRowClick(
  target: { closest?: (selector: string) => unknown } | null,
  selectedText: string,
): boolean {
  if (selectedText.trim().length > 0) return true;
  if (!target || typeof target.closest !== "function") return false;
  return !!target.closest("a, button, input, select, textarea, label, summary, [data-row-ignore]");
}
