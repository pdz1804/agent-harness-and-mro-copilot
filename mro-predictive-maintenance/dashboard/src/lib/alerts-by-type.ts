/** Group not-yet-closed alerts by component type for the Overview card. */
import type { Alert } from "../types";
import { componentTypeFromId } from "./risk";

export interface TypeCount {
  type: string;
  count: number;
}

/**
 * Count active (not closed) alerts per component type. Every type in
 * `knownTypes` appears, even with zero alerts, so the card lists the whole
 * fleet mix. Sorted by count descending, then by type name.
 */
export function alertsByType(alerts: Alert[], knownTypes: string[] = []): TypeCount[] {
  const counts = new Map<string, number>(knownTypes.map((t) => [t, 0]));
  for (const a of alerts) {
    if (a.status === "closed") continue;
    const type = a.component_type ?? componentTypeFromId(a.component_id);
    counts.set(type, (counts.get(type) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => b.count - a.count || a.type.localeCompare(b.type));
}
