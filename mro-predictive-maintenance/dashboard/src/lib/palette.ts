/** Command palette model: pages plus actions, and "open by id" entries
 * derived from what was typed (alert #12, WO-2026-0007, AC-005-HYD_PUMP). */
import { AREAS } from "./routes";

export type PaletteKind = "action" | "open" | "page";

export interface PaletteEntry {
  id: string;
  kind: PaletteKind;
  label: string;
  group: string;
  description: string;
  /** Hash path for "page"/"open" entries. */
  path?: string;
  /** Action key for "action" entries. */
  action?: "scan" | "new-run" | "ask" | "shortcuts";
  keywords?: string;
}

export const PAGE_ENTRIES: PaletteEntry[] = AREAS.flatMap((a) =>
  a.pages.map((p) => ({
    id: `page:${p.id}`,
    kind: "page" as const,
    label: `Go to ${p.title.charAt(0).toLowerCase()}${p.title.slice(1)}`,
    group: a.label,
    description: p.description,
    path: p.id,
    keywords: p.label,
  })),
);

export const ACTION_ENTRIES: PaletteEntry[] = [
  { id: "act:scan", kind: "action", action: "scan", label: "Scan fleet", group: "Actions", description: "Score every component now and raise alerts above threshold.", keywords: "fleet scan alerts run" },
  { id: "act:new-run", kind: "action", action: "new-run", label: "New copilot run", group: "Actions", description: "Start a fresh copilot conversation.", keywords: "copilot ask chat agent" },
  { id: "act:shortcuts", kind: "action", action: "shortcuts", label: "Show keyboard shortcuts", group: "Actions", description: "Every shortcut in one sheet.", keywords: "keys help ?" },
];

/** Entries derived from the typed text: open an id directly, or ask. */
export function derivedEntries(query: string): PaletteEntry[] {
  const q = query.trim();
  const out: PaletteEntry[] = [];
  const alert = /^#?(\d{1,6})$/.exec(q);
  if (alert) out.push({ id: `open:alert:${alert[1]}`, kind: "open", label: `Open alert #${alert[1]}`, group: "Open", description: "Alert detail sheet", path: `ops/alerts/${alert[1]}` });
  const wo = /^wo-\d{4}-\d+$/i.exec(q);
  if (wo) out.push({ id: `open:wo:${q}`, kind: "open", label: `Open work order ${q.toUpperCase()}`, group: "Open", description: "Work order detail sheet", path: `ops/work-orders/${q.toUpperCase()}` });
  const comp = /^ac-\d{3}-[a-z_]+$/i.exec(q);
  if (comp) out.push({ id: `open:comp:${q}`, kind: "open", label: `Open component ${q.toUpperCase()}`, group: "Open", description: "Component detail page", path: `ops/component/${q.toUpperCase()}` });
  const ac = /^ac-\d{3}$/i.exec(q);
  if (ac) out.push({ id: `open:ac:${q}`, kind: "open", label: `Open aircraft ${q.toUpperCase()}`, group: "Open", description: "Aircraft detail page", path: `ops/aircraft/${q.toUpperCase()}` });
  if (q.length >= 3 && !alert)
    out.push({ id: "act:ask", kind: "action", action: "ask", label: `Ask copilot: “${q}”`, group: "Actions", description: "Start a new run with this question.", keywords: q });
  return out;
}

export function searchPalette(query: string): PaletteEntry[] {
  const q = query.trim().toLowerCase();
  const all = [...ACTION_ENTRIES, ...PAGE_ENTRIES];
  const base = q
    ? all.filter((e) => `${e.label} ${e.group} ${e.description} ${e.keywords ?? ""}`.toLowerCase().includes(q))
    : all;
  const derived = derivedEntries(query);
  // Exact "open by id" first, real matches next, free-text "Ask copilot" last.
  return [...derived.filter((e) => e.kind === "open"), ...base, ...derived.filter((e) => e.kind !== "open")];
}
