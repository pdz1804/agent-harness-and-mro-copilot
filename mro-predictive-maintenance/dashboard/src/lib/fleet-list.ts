/** Pure helpers for the paginated fleet list (`GET /fleet/components`). */
import type { FleetBand, FleetListItem } from "../types";
import type { SortSpec } from "./url-state";
import { toCsv } from "./csv";

export const FLEET_PAGE_SIZE = 20;

/** URL defaults: `#/ops/fleet?band=watch&page=2&sort=cycle:asc`. */
export const FLEET_DEFAULTS = { band: "all", type: "all", q: "", sort: "rank:asc", page: "1" };

export const BAND_LABEL: Record<FleetBand, string> = { alert: "Alert", watch: "Watch", normal: "Normal" };
export const BAND_TONE: Record<FleetBand, "bad" | "warn" | "good"> = { alert: "bad", watch: "warn", normal: "good" };

/** Table column key -> server sort key. Rank ascending is risk descending. */
const SERVER_SORT: Record<string, string> = {
  rank: "risk",
  risk: "risk",
  component: "component_id",
  aircraft: "aircraft_id",
  type: "component_type",
  cycle: "cycle",
};

export function toServerSort(sort: SortSpec | null): { sort: string; dir: "asc" | "desc" } {
  if (!sort || !SERVER_SORT[sort.key]) return { sort: "risk", dir: "desc" };
  if (sort.key === "rank") return { sort: "risk", dir: sort.dir === "asc" ? "desc" : "asc" };
  return { sort: SERVER_SORT[sort.key], dir: sort.dir };
}

export function pageCount(total: number, size: number = FLEET_PAGE_SIZE): number {
  return Math.max(1, Math.ceil(total / size));
}

/** Clamp a URL page param to 1..pages (bad input -> 1). */
export function clampPage(raw: string | undefined, pages: number): number {
  const n = Number.parseInt(raw ?? "1", 10);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(n, pages);
}

/** "21–40 of 312"; "0 of 0" when empty. */
export function pageRangeLabel(page: number, total: number, size: number = FLEET_PAGE_SIZE): string {
  if (total === 0) return "0 of 0";
  const from = (page - 1) * size + 1;
  const to = Math.min(total, page * size);
  return `${from}–${to} of ${total}`;
}

export function fleetCsv(items: readonly FleetListItem[]): string {
  const head = ["rank", "component_id", "aircraft_id", "aircraft_type", "component_type", "cycle", "risk_score", "band", "alert"];
  const rows = items.map((i) =>
    [i.rank, i.component_id, i.aircraft_id, i.aircraft_type, i.component_type, i.cycle, i.risk_score.toFixed(6), i.band, i.alert],
  );
  return toCsv(head, rows);
}

/** The copilot prompt for "Ask copilot to triage N": the ids are the context. */
export function triagePrompt(items: readonly FleetListItem[]): string {
  const lines = items.map((i) => `- ${i.component_id} (aircraft ${i.aircraft_id}, risk ${i.risk_score.toFixed(4)}, ${i.band})`);
  return `Triage these ${items.length} components. For each, say whether to inspect now, watch, or leave, and why:\n${lines.join("\n")}`;
}
