import type { ModelVersionMetrics, RegistryVersion } from "../types";

/** Champion-vs-challenger comparison and the fragile-threshold rule. */

/** The realistic profile is served at a threshold near 0.01. Below this a
 * small score shift swings which components alert, so it is flagged. */
export const FRAGILE_THRESHOLD_BELOW = 0.05;

export function isFragileThreshold(threshold: number | null | undefined): boolean {
  return typeof threshold === "number" && threshold < FRAGILE_THRESHOLD_BELOW;
}

export function versionNumber(v: string | number): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : -1;
}

export function championVersion(versions: readonly RegistryVersion[]): RegistryVersion | null {
  return versions.find((v) => v.aliases.includes("champion")) ?? null;
}

/** The newest registered version that is not the champion. */
export function pickChallenger(versions: readonly RegistryVersion[]): RegistryVersion | null {
  return (
    [...versions]
      .filter((v) => !v.aliases.includes("champion"))
      .sort((a, b) => versionNumber(b.version) - versionNumber(a.version))[0] ?? null
  );
}

export type Verdict = "better" | "worse" | "same" | "n/a";

export interface MetricMeta {
  label: string;
  kind: "pct" | "dec";
  better: "higher" | "lower";
}

const META: Record<string, MetricMeta> = {
  test_recall: { label: "Recall", kind: "pct", better: "higher" },
  test_precision: { label: "Precision", kind: "pct", better: "higher" },
  test_alerts_per_100: { label: "Alerts per 100", kind: "dec", better: "lower" },
  brier_post: { label: "Brier score (calibrated)", kind: "dec", better: "lower" },
};

export function metricMeta(key: string): MetricMeta {
  return META[key] ?? { label: key.replace(/^test_/, "").replace(/_/g, " "), kind: "dec", better: "higher" };
}

export function compareMetric(
  champion: number | undefined | null,
  challenger: number | undefined | null,
  better: "higher" | "lower",
): { delta: number | null; verdict: Verdict } {
  if (typeof champion !== "number" || typeof challenger !== "number") return { delta: null, verdict: "n/a" };
  const delta = challenger - champion;
  if (Math.abs(delta) < 1e-9) return { delta, verdict: "same" };
  const improved = better === "higher" ? delta > 0 : delta < 0;
  return { delta, verdict: improved ? "better" : "worse" };
}

export interface ComparisonRow {
  key: string;
  meta: MetricMeta;
  champion: number | null;
  challenger: number | null;
  delta: number | null;
  verdict: Verdict;
}

/** Union of the metric keys either version recorded, in a stable order
 * (known metrics first). A key only one side has shows "n/a", never zero. */
export function compareVersions(champion: ModelVersionMetrics, challenger: ModelVersionMetrics): ComparisonRow[] {
  const keys = new Set([...Object.keys(champion.test_metrics), ...Object.keys(challenger.test_metrics)]);
  const known = Object.keys(META).filter((k) => keys.has(k));
  const extra = [...keys].filter((k) => !(k in META)).sort();
  return [...known, ...extra].map((key) => {
    const meta = metricMeta(key);
    const c = champion.test_metrics[key];
    const h = challenger.test_metrics[key];
    const { delta, verdict } = compareMetric(c, h, meta.better);
    return {
      key,
      meta,
      champion: typeof c === "number" ? c : null,
      challenger: typeof h === "number" ? h : null,
      delta,
      verdict,
    };
  });
}

/** One-line honest read of the comparison, so the table is never mistaken
 * for "challenger wins" when the trade-off is recall versus alert volume. */
export function comparisonSummary(rows: readonly ComparisonRow[]): string {
  const better = rows.filter((r) => r.verdict === "better").length;
  const worse = rows.filter((r) => r.verdict === "worse").length;
  if (better === 0 && worse === 0) return "No measurable difference on the shared metrics.";
  if (worse === 0) return `Challenger is better on ${better} metric${better === 1 ? "" : "s"} and worse on none.`;
  if (better === 0) return `Challenger is worse on ${worse} metric${worse === 1 ? "" : "s"} and better on none.`;
  return `Mixed: better on ${better}, worse on ${worse}. Decide which trade-off matters before promoting.`;
}
