export function formatPct(value: number, digits = 1): string {
  return `${(value * 100).toFixed(digits)}%`;
}

export function formatNumber(value: number): string {
  return value.toLocaleString("en-US");
}

export function formatDecimal(value: number, digits = 2): string {
  return value.toFixed(digits);
}

export function formatSignedDecimal(value: number, digits = 2): string {
  const sign = value >= 0 ? "+" : "";
  return `${sign}${value.toFixed(digits)}`;
}

/** Title-cases a snake_case feature/column name for display, e.g.
 * "cycles_since_last_check" -> "Cycles since last check". */
export function humanizeFeatureName(raw: string): string {
  const stripped = raw.replace(/^(num__|cat__)/, "");
  const withSpaces = stripped.replace(/_/g, " ");
  return withSpaces.charAt(0).toUpperCase() + withSpaces.slice(1);
}
