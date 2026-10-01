/** CSV export helpers (RFC 4180 quoting) shared by Fleet and Work orders. */
import type { WorkOrder } from "../types";

export function csvCell(v: string | number | boolean | null | undefined): string {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(head: string[], rows: (string | number | boolean | null | undefined)[][]): string {
  return [head.map(csvCell).join(","), ...rows.map((r) => r.map(csvCell).join(","))].join("\n");
}

export function workOrdersCsv(orders: readonly WorkOrder[]): string {
  const head = ["id", "status", "outcome", "priority", "aircraft_id", "component_id", "alert_id", "task_ref", "created_by", "approved_by", "created_at", "closed_at", "notes"];
  return toCsv(
    head,
    orders.map((w) => [w.id, w.status, w.outcome, w.priority, w.aircraft_id, w.component_id, w.alert_id, w.task_ref, w.created_by, w.approved_by, w.created_at, w.closed_at, w.notes]),
  );
}

/** Browser download of a text file. */
export function downloadText(filename: string, text: string, type = "text/csv"): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
