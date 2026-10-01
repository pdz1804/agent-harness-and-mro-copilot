/** Small, pure helpers shared by the ops pages. */

export type Tone = "good" | "bad" | "warn" | "neutral" | "info";

export const ALERT_STAGES = ["open", "acknowledged", "wo_raised", "closed"] as const;

export const STAGE_LABEL: Record<string, string> = {
  open: "Open",
  acknowledged: "Acknowledged",
  wo_raised: "WO raised",
  closed: "Closed",
  dismissed: "Dismissed",
};

export function alertTone(status: string): Tone {
  if (status === "closed") return "good";
  if (status === "open") return "bad";
  if (status === "acknowledged") return "warn";
  if (status === "dismissed") return "neutral";
  return "info";
}

/** Risk relative to the operating threshold. */
export function riskTone(score: number, threshold: number): Tone {
  if (score >= threshold) return "bad";
  if (score >= threshold * 0.6) return "warn";
  return "good";
}

/** "3d", "5h", "12m", "just now": coarse age for alert/WO aging. */
export function ageLabel(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return "-";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "-";
  const mins = Math.max(0, Math.floor((now - t) / 60000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/** Component ids look like "AC-113-HYD_PUMP"; the type is the last segment. */
export function componentTypeFromId(componentId: string): string {
  const idx = componentId.lastIndexOf("-");
  return idx >= 0 ? componentId.slice(idx + 1) : componentId;
}

const TYPE_WORDS: Record<string, string> = {
  hyd: "Hydraulic",
  lg: "Landing gear",
  apu: "APU",
  ecs: "ECS",
};

/** "HYD_PUMP" -> "Hydraulic pump", "APU_STARTER" -> "APU starter". */
export function humanizeType(type: string): string {
  const words = type.toLowerCase().split("_").filter(Boolean);
  const out = words.map((w) => TYPE_WORDS[w] ?? w);
  const s = out.join(" ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export interface TopFactor {
  feature: string;
  shap_value: number;
}

/** Alerts persist their SHAP factors as a JSON string (`top_factors_json`). */
export function parseTopFactors(json: string | null | undefined): TopFactor[] {
  if (!json) return [];
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (f): f is TopFactor =>
        !!f && typeof (f as TopFactor).feature === "string" && typeof (f as TopFactor).shap_value === "number",
    );
  } catch {
    return [];
  }
}

/** Live outcome counts from `GET /monitoring/performance`. */
export interface LiveOutcomes {
  closed_with_outcome: number;
  confirmed_failure: number;
  nff: number;
  not_inspected: number;
  live_precision: number | null;
  nff_rate: number | null;
}

export function asLiveOutcomes(raw: Record<string, unknown> | null | undefined): LiveOutcomes | null {
  if (!raw) return null;
  const n = (k: string) => (typeof raw[k] === "number" ? (raw[k] as number) : 0);
  const f = (k: string) => (typeof raw[k] === "number" ? (raw[k] as number) : null);
  return {
    closed_with_outcome: n("closed_with_outcome"),
    confirmed_failure: n("confirmed_failure"),
    nff: n("nff"),
    not_inspected: n("not_inspected"),
    live_precision: f("live_precision"),
    nff_rate: f("nff_rate"),
  };
}

/** The three outcomes `POST /ops/work-orders/{id}/close` accepts. */
export const WO_OUTCOMES = [
  {
    id: "confirmed_failure",
    label: "Confirmed fault",
    hint: "The inspection found the predicted defect. Counts toward live precision.",
  },
  {
    id: "nff",
    label: "No fault found",
    hint: "Inspected, nothing wrong. Counts against precision and raises the NFF rate.",
  },
  {
    id: "not_inspected",
    label: "Not inspected",
    hint: "Closed without inspection. Excluded from precision and NFF.",
  },
] as const;

/** Fleet risk band used in headers and chips: over the alert threshold is
 * "Alert", at or above 50% is "Watch", anything lower is "Normal". */
export type RiskBand = { label: "Alert" | "Watch" | "Normal"; tone: "bad" | "warn" | "good" };
export const WATCH_FLOOR = 0.5;
export function riskBand(score: number, overThreshold: boolean): RiskBand {
  if (overThreshold) return { label: "Alert", tone: "bad" };
  if (score >= WATCH_FLOOR) return { label: "Watch", tone: "warn" };
  return { label: "Normal", tone: "good" };
}
