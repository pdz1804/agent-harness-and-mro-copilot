/** What-if helpers: slider ranges taken from the real fleet distribution. */

export interface FeatureRange {
  min: number;
  max: number;
  step: number;
}

/** Range covering every observed value (and the current one), padded 10%,
 * with a step that gives ~200 slider positions on a "nice" decimal. */
export function featureRange(values: (number | null | undefined)[], current?: number | null): FeatureRange | null {
  const xs = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  if (typeof current === "number" && Number.isFinite(current)) xs.push(current);
  if (xs.length === 0) return null;
  let min = Math.min(...xs);
  let max = Math.max(...xs);
  if (min === max) {
    const pad = Math.abs(min) > 0 ? Math.abs(min) * 0.5 : 1;
    min -= pad;
    max += pad;
  } else {
    const pad = (max - min) * 0.1;
    min = min >= 0 && min - pad < 0 ? 0 : min - pad;
    max += pad;
  }
  const raw = (max - min) / 200;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const allInts = xs.every((x) => Number.isInteger(x));
  const finalStep = allInts ? Math.max(1, Math.round(step)) : step;
  return { min: roundTo(Math.floor(min / finalStep) * finalStep, finalStep), max: roundTo(Math.ceil(max / finalStep) * finalStep, finalStep), step: finalStep };
}

function roundTo(x: number, step: number): number {
  const decimals = Math.max(0, -Math.floor(Math.log10(step)));
  return Number(x.toFixed(decimals));
}

/** Value shown in a what-if number field: raw snapshot floats such as
 * 4.1203663902815375 read as 4.1204. Integers and missing values pass through. */
export function displayNumber(v: unknown): number | string {
  if (typeof v !== "number" || !Number.isFinite(v)) return v === null || v === undefined ? "" : String(v);
  return Number.isInteger(v) ? v : Number(v.toFixed(4));
}

/** A what-if scenario in the URL: `?s=vibration_mm_s:6.5,region:EU`.
 * Only the changed fields travel; values are URI-encoded; a missing value
 * is the literal `null`. */
export type ScenarioValue = number | string | null;

export function encodeScenario(changes: Record<string, ScenarioValue>): string {
  return Object.keys(changes)
    .sort()
    .map((k) => `${k}:${changes[k] === null ? "null" : encodeURIComponent(String(changes[k]))}`)
    .join(",");
}

/** Parses `?s=`; drops unknown fields and numeric fields that do not parse
 * (a shared link must never inject a field the model does not take). */
export function decodeScenario(raw: string | undefined, numericFields: readonly string[], categoricalFields: readonly string[]): Record<string, ScenarioValue> {
  const out: Record<string, ScenarioValue> = {};
  if (!raw) return out;
  const numeric = new Set(numericFields);
  const categorical = new Set(categoricalFields);
  for (const part of raw.split(",")) {
    const i = part.indexOf(":");
    if (i <= 0) continue;
    const key = part.slice(0, i);
    let value: string;
    try {
      value = decodeURIComponent(part.slice(i + 1));
    } catch {
      continue;
    }
    if (numeric.has(key)) {
      if (value === "null") out[key] = null;
      else if (value.trim() !== "" && Number.isFinite(Number(value))) out[key] = Number(value);
    } else if (categorical.has(key) && value !== "") {
      out[key] = value === "null" ? null : value;
    }
  }
  return out;
}
