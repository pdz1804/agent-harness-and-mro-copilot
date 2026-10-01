/** Confusion counts at the served threshold, read from a stored evaluation
 * artifact (`model_card.json` -> `test_at_threshold`). */
export interface Confusion {
  threshold: number;
  tp: number;
  fp: number;
  fn: number;
  tn: number;
}

/** Validates the artifact record; null when any count is missing or not a
 * non-negative integer (never guessed or back-filled). */
export function confusionFrom(rec: Record<string, unknown> | null | undefined): Confusion | null {
  if (!rec) return null;
  const keys = ["tp", "fp", "fn", "tn"] as const;
  for (const k of keys) {
    const v = rec[k];
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0) return null;
  }
  const threshold = typeof rec.threshold === "number" ? rec.threshold : NaN;
  if (!Number.isFinite(threshold)) return null;
  return { threshold, tp: rec.tp as number, fp: rec.fp as number, fn: rec.fn as number, tn: rec.tn as number };
}

export function confusionTotals(c: Confusion): { rows: number; positives: number; recall: number | null; precision: number | null } {
  const positives = c.tp + c.fn;
  const predicted = c.tp + c.fp;
  return {
    rows: c.tp + c.fp + c.fn + c.tn,
    positives,
    recall: positives > 0 ? c.tp / positives : null,
    precision: predicted > 0 ? c.tp / predicted : null,
  };
}
