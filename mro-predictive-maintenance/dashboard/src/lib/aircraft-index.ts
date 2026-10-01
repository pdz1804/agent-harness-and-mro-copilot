import type { AircraftIndexRow } from "../types";

/** Aggregates for the aircraft index. */

export interface AircraftSummary {
  total: number;
  serviceable: number;
  restricted: number;
  aog: number;
  openAlerts: number;
  openWorkOrders: number;
  scanned: number;
}

export function summarizeAircraft(rows: readonly AircraftIndexRow[]): AircraftSummary {
  const s: AircraftSummary = {
    total: rows.length,
    serviceable: 0,
    restricted: 0,
    aog: 0,
    openAlerts: 0,
    openWorkOrders: 0,
    scanned: 0,
  };
  for (const r of rows) {
    if (r.status === "serviceable") s.serviceable++;
    else if (r.status === "restricted") s.restricted++;
    else if (r.status === "aog") s.aog++;
    s.openAlerts += r.n_open_alerts;
    s.openWorkOrders += r.n_open_wos;
    if (r.max_risk !== null) s.scanned++;
  }
  return s;
}

/** Sort rank so the worst status leads when sorting "status" descending. */
export function statusSeverity(status: string): number {
  if (status === "aog") return 3;
  if (status === "restricted") return 2;
  if (status === "serviceable") return 1;
  return 0;
}

export function filterAircraft(rows: readonly AircraftIndexRow[], query: string, status: string): AircraftIndexRow[] {
  const q = query.trim().toLowerCase();
  return rows.filter((r) => (status === "all" || r.status === status) && (!q || r.aircraft_id.toLowerCase().includes(q)));
}
