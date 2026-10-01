import type { RetrainJob } from "../types";

/** Pure logic for the retrain gate panel: who may start it, how a job reads,
 * and how to poll it. The service contract is in the backend endpoints report. */

export const RETRAIN_USER = "lead.engineer";

export function canStartRetrain(userId: string): boolean {
  return userId === RETRAIN_USER;
}

export function isTerminal(status: string): boolean {
  return status === "succeeded" || status === "failed";
}

/** 1.5s first, easing to 5s so a long retrain does not hammer the service. */
export function nextPollDelay(attempt: number): number {
  return Math.min(5000, 1500 + attempt * 500);
}

export type VerdictTone = "good" | "bad" | "warn" | "neutral";

export interface GateVerdict {
  tone: VerdictTone;
  label: string;
  detail: string;
}

/** Read the job honestly. `gate.promote` says the challenger would be
 * eligible; `promoted` says whether anything actually changed. They differ
 * whenever no champion baseline is recorded, and the UI must say so. */
export function gateVerdict(job: RetrainJob): GateVerdict {
  if (job.status === "queued" || job.status === "running") {
    return { tone: "neutral", label: job.status === "queued" ? "Queued" : "Running", detail: "Retraining the realistic profile." };
  }
  if (job.status === "failed") {
    return {
      tone: "bad",
      label: "Retrain failed",
      detail: job.error ?? job.result?.note ?? "The job reported a failure with no message.",
    };
  }
  const result = job.result;
  const gate = result?.gate;
  if (!gate) {
    return { tone: "warn", label: "No gate decision", detail: "The job finished but returned no gate result." };
  }
  if (!gate.promote) {
    return {
      tone: "bad",
      label: "Gate failed: challenger not promoted",
      detail: gate.reasons.join(" ") || "The challenger missed at least one target.",
    };
  }
  if (result?.promoted) {
    return {
      tone: "good",
      label: "Gate passed: challenger promoted",
      detail: result.served_model_changed
        ? "The served model changed."
        : "The registry alias moved, but the running service still serves the old model until it restarts.",
    };
  }
  return {
    tone: "warn",
    label: "Gate passed, but nothing was promoted",
    detail: result?.note ?? "Promotion was not requested or no baseline was recorded.",
  };
}

export interface MetricRow {
  key: string;
  label: string;
  challenger: number | null;
  champion: number | null;
  target: number | null;
  kind: "pct" | "dec";
  /** Which direction counts as a pass against the target. */
  passes: "higher" | "lower" | null;
}

const METRIC_META: Record<string, { label: string; kind: "pct" | "dec"; passes: "higher" | "lower"; target?: string }> = {
  recall_ci_low: { label: "Recall, lower confidence bound", kind: "pct", passes: "higher" },
  component_window_alerts_per_100: { label: "Alerts per 100 components", kind: "dec", passes: "lower", target: "max_alerts_per_100" },
  brier: { label: "Brier score", kind: "dec", passes: "lower" },
};

function numOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Challenger vs champion rows for the gate table. A missing champion is
 * shown as "none recorded", never as zero. */
export function retrainMetricRows(job: RetrainJob): MetricRow[] {
  const result = job.result;
  if (!result?.challenger_metrics) return [];
  const targets = result.targets ?? {};
  return Object.entries(result.challenger_metrics).map(([key, value]) => {
    const meta = METRIC_META[key];
    const targetKey = meta?.target;
    return {
      key,
      label: meta?.label ?? key.replace(/_/g, " "),
      challenger: numOrNull(value),
      champion: numOrNull(result.champion_metrics?.[key]),
      target: targetKey ? numOrNull(targets[targetKey]) : null,
      kind: meta?.kind ?? "dec",
      passes: meta?.passes ?? null,
    };
  });
}

/** A 409 body names the running job; keep polling that one instead of failing. */
export function extractRunId(body: string): string | null {
  try {
    const parsed: unknown = JSON.parse(body.slice(body.indexOf("{")));
    const found = findRunId(parsed);
    if (found) return found;
  } catch {
    /* not JSON: fall through to the pattern match */
  }
  const m = body.match(/\b[0-9a-f]{12}\b/);
  return m ? m[0] : null;
}

function findRunId(value: unknown, depth = 0): string | null {
  if (depth > 4 || value === null || typeof value !== "object") return null;
  const obj = value as Record<string, unknown>;
  if (typeof obj.run_id === "string") return obj.run_id;
  for (const v of Object.values(obj)) {
    const hit = findRunId(v, depth + 1);
    if (hit) return hit;
  }
  return null;
}
