import type { DriftHistory, DriftReport, FeatureDrift } from "../types";

/** `GET /monitoring/drift` returns `{status, features: {name: {psi, status,
 * type, monitored, ...}}, score_psi, score_status, thresholds}`. An older
 * client shape used `{overall_status, feature_drift: []}`; the page used to
 * read only that and crashed on the live response. This accepts both and
 * returns rows sorted worst-first, with unmonitored features last. */
export interface DriftRow extends FeatureDrift {
  type?: string;
  monitored: boolean;
  unmonitoredReason?: string;
  missingRateDelta?: number;
}

export interface NormalizedDrift {
  overall: string;
  scoreStatus: string | null;
  scorePsi: number | null;
  rows: DriftRow[];
  nReference: number | null;
  nCurrent: number | null;
  source: string;
  simulated: boolean;
  warnAt: number;
  alertAt: number;
}

const STATUS_RANK: Record<string, number> = { alert: 3, warn: 2, ok: 1 };

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export function normalizeDrift(raw: DriftReport): NormalizedDrift {
  const r = raw as Record<string, unknown>;
  const rows: DriftRow[] = [];

  const features = r.features;
  if (features && typeof features === "object" && !Array.isArray(features)) {
    for (const [feature, v] of Object.entries(features as Record<string, Record<string, unknown>>)) {
      rows.push({
        feature,
        psi: num(v.psi) ?? 0,
        status: typeof v.status === "string" ? v.status : "ok",
        type: typeof v.type === "string" ? v.type : undefined,
        monitored: v.monitored !== false,
        unmonitoredReason: typeof v.unmonitored_reason === "string" ? v.unmonitored_reason : undefined,
        missingRateDelta: num(v.missing_rate_delta) ?? undefined,
      });
    }
  } else if (Array.isArray(r.feature_drift)) {
    for (const f of r.feature_drift as FeatureDrift[]) {
      rows.push({ feature: f.feature, psi: num(f.psi) ?? 0, status: f.status, monitored: true });
    }
  }

  rows.sort((a, b) => {
    if (a.monitored !== b.monitored) return a.monitored ? -1 : 1;
    const byStatus = (STATUS_RANK[b.status] ?? 0) - (STATUS_RANK[a.status] ?? 0);
    return byStatus !== 0 ? byStatus : b.psi - a.psi;
  });

  const thresholds = (r.thresholds ?? {}) as Record<string, unknown>;
  return {
    overall: String(r.status ?? r.overall_status ?? "ok"),
    scoreStatus: typeof r.score_status === "string" ? r.score_status : null,
    scorePsi: num(r.score_psi),
    rows,
    nReference: num(r.n_reference),
    nCurrent: num(r.n_current),
    source: String(r.current_source ?? "unknown"),
    simulated: r.simulated_shift_applied === true,
    warnAt: num(thresholds.warn) ?? num(thresholds.psi_warn) ?? 0.1,
    alertAt: num(thresholds.alert) ?? num(thresholds.psi_alert) ?? 0.25,
  };
}

/** One snapshot on the drift timeline. */
export interface DriftTimelinePoint {
  ts: number;
  scorePsi: number | null;
  /** Worst MONITORED feature: the only kind the backend rolls into `overall`. */
  maxFeaturePsi: number | null;
  maxFeature: string | null;
  /** Worst feature the backend excludes from the status rollup (calendar/age). */
  maxUnmonitoredPsi: number | null;
  maxUnmonitoredFeature: string | null;
  overall: string;
  trigger: string;
  nCurrent: number;
}

/** `GET /monitoring/drift/history` -> chart-ready points, oldest first.
 * Rows with an unparseable timestamp are dropped; null PSI stays null. */
export function monitoredLookup(rows: readonly DriftRow[] | undefined): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const r of rows ?? []) out[r.feature] = r.monitored;
  return out;
}

/** Splits one snapshot's per-feature PSI into the worst monitored and the worst
 * unmonitored feature. History rows carry no monitored flag, so it comes from
 * the live drift report; a feature absent from `monitored` counts as monitored
 * (the safe side: it can only make the chart look worse, never better). */
export function selectDriftSeries(
  features: Record<string, number | null> | undefined,
  monitored: Record<string, boolean>,
): Pick<DriftTimelinePoint, "maxFeature" | "maxFeaturePsi" | "maxUnmonitoredFeature" | "maxUnmonitoredPsi"> {
  const res = {
    maxFeature: null as string | null,
    maxFeaturePsi: null as number | null,
    maxUnmonitoredFeature: null as string | null,
    maxUnmonitoredPsi: null as number | null,
  };
  for (const [name, psi] of Object.entries(features ?? {})) {
    if (typeof psi !== "number" || !Number.isFinite(psi)) continue;
    if (monitored[name] === false) {
      if (res.maxUnmonitoredPsi === null || psi > res.maxUnmonitoredPsi) {
        res.maxUnmonitoredPsi = psi;
        res.maxUnmonitoredFeature = name;
      }
    } else if (res.maxFeaturePsi === null || psi > res.maxFeaturePsi) {
      res.maxFeaturePsi = psi;
      res.maxFeature = name;
    }
  }
  return res;
}

export function normalizeDriftHistory(
  raw: DriftHistory | null | undefined,
  monitored: Record<string, boolean> = {},
): DriftTimelinePoint[] {
  const out: DriftTimelinePoint[] = [];
  for (const p of raw?.points ?? []) {
    const ts = Date.parse(p.at);
    if (Number.isNaN(ts)) continue;
    out.push({
      ts,
      scorePsi: num(p.score_psi),
      ...selectDriftSeries(p.features, monitored),
      overall: p.overall,
      trigger: p.trigger,
      nCurrent: p.n_current,
    });
  }
  return out.sort((a, b) => a.ts - b.ts);
}

export function triggerLabel(trigger: string): string {
  if (trigger === "fleet_scan") return "Fleet scan";
  if (trigger === "drift_call") return "Monitoring view";
  return trigger.replace(/_/g, " ");
}

/** Honest caption: a timeline of one or two snapshots is not a trend. */
export function driftTimelineNote(points: readonly DriftTimelinePoint[]): string {
  if (points.length === 0) return "No snapshots yet. Opening this page or running a fleet scan records one.";
  if (points.length < 4) {
    return `${points.length} snapshot${points.length === 1 ? "" : "s"} so far: too few to call a trend. Each fleet scan adds one.`;
  }
  return `${points.length} snapshots. A simulated shift is never recorded here.`;
}
