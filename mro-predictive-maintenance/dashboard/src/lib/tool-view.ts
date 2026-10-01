import type { CopilotResolution } from "./api";
import type { CopilotMessage, CopilotResolvedItem } from "../types";

/** Parse a tool payload the server may send as a JSON string or an object. */
export function parsePayload(value: unknown): unknown {
  if (typeof value !== "string") return value ?? null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

const KEY_LABELS: Record<string, string> = {
  task_ref: "Task ref",
  aircraft_id: "Aircraft",
  component_id: "Component",
  component_type: "Component type",
  mel_item: "MEL item",
  alert_id: "Alert",
  doc_id: "Document",
  doc_type: "Document type",
  top_n: "Top N",
  risk_score: "Risk",
  model_version: "Model version",
  approved_by: "Approved by",
  created_at: "Created",
  created_by: "Created by",
};

/** "task_ref" -> "Task ref", "aircraftId" -> "Aircraft id". */
export function humanizeKey(key: string): string {
  if (KEY_LABELS[key]) return KEY_LABELS[key];
  const words = key.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").trim().toLowerCase();
  return words ? words[0].toUpperCase() + words.slice(1) : key;
}

export type FieldKind = "chip" | "prose" | "mono" | "text";
export interface FieldRow {
  key: string;
  label: string;
  kind: FieldKind;
  value: string;
}

const CHIP_KEYS = new Set(["priority", "status", "decision", "doc_type", "kind"]);
const PROSE_KEYS = new Set(["justification", "reason", "note", "question", "message", "snippet", "query"]);
const MONO_KEYS = /(_id|_ref|^id)$|^mel_item$/;

function display(v: unknown): string {
  if (v === null || v === undefined || v === "") return "—";
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (Array.isArray(v) && v.every((x) => typeof x !== "object")) return v.join(", ");
  return typeof v === "object" ? JSON.stringify(v) : String(v);
}

/** Label/value rows for a flat args/result object (nested values fall back to compact JSON). */
export function describeFields(value: unknown): FieldRow[] {
  const obj = parsePayload(value);
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return [];
  return Object.entries(obj as Record<string, unknown>).map(([key, v]) => {
    const long = typeof v === "string" && v.length > 60;
    const kind: FieldKind =
      CHIP_KEYS.has(key) && typeof v === "string" && v.length <= 24
        ? "chip"
        : PROSE_KEYS.has(key) || long
          ? "prose"
          : MONO_KEYS.test(key)
            ? "mono"
            : "text";
    return { key, label: humanizeKey(key), kind, value: display(v) };
  });
}

export interface ScoreView {
  kind: "score";
  componentId: string;
  risk: number;
  threshold: number;
  alert: boolean;
  factors: { feature: string; value: number }[];
}
export interface ManualsView {
  kind: "manuals";
  hits: { docId: string; title: string; docType: string; snippet: string }[];
}
export interface WorkOrderView {
  kind: "work_order";
  id: string;
  rows: FieldRow[];
}
export type ResultView =
  | ScoreView
  | ManualsView
  | WorkOrderView
  | { kind: "fields"; rows: FieldRow[] }
  | { kind: "text"; text: string };

/** Pick a readable rendering for a tool result; unknown shapes become label/value rows or plain text. */
export function describeResult(toolName: string, content: unknown): ResultView {
  const c = parsePayload(content);
  if (typeof c === "string") return { kind: "text", text: c };
  if (!c || typeof c !== "object" || Array.isArray(c)) return { kind: "text", text: JSON.stringify(c) };
  const o = c as Record<string, unknown>;
  if (typeof o.risk_score === "number" && typeof o.threshold === "number") {
    const factors = Array.isArray(o.top_factors)
      ? (o.top_factors as Record<string, unknown>[])
          .filter((f) => typeof f?.feature === "string")
          .map((f) => ({ feature: String(f.feature), value: Number(f.shap_value ?? 0) }))
      : [];
    return { kind: "score", componentId: String(o.component_id ?? ""), risk: o.risk_score, threshold: o.threshold, alert: !!o.alert, factors };
  }
  if (Array.isArray(o.hits)) {
    return {
      kind: "manuals",
      hits: (o.hits as Record<string, unknown>[]).map((h) => ({
        docId: String(h.doc_id ?? ""),
        title: String(h.title ?? h.doc_id ?? ""),
        docType: String(h.doc_type ?? ""),
        snippet: String(h.snippet ?? ""),
      })),
    };
  }
  if (toolName === "create_work_order" && typeof o.id === "string" && /^WO-/.test(o.id)) {
    return { kind: "work_order", id: o.id, rows: describeFields(Object.fromEntries(Object.entries(o).filter(([k]) => k !== "id"))) };
  }
  return { kind: "fields", rows: describeFields(o) };
}

/**
 * The resolution list actually sent on Submit: the note is read NOW (at
 * submit), not when Approve/Deny was clicked, so a note typed after the
 * click is never dropped. An empty note keeps whatever the draft had.
 */
export function finalizeResolutions(
  pendingIds: string[],
  drafts: Record<string, CopilotResolution | null>,
  notes: Record<string, string>,
): CopilotResolution[] {
  return pendingIds.map((id) => {
    const d = drafts[id] as CopilotResolution;
    const note = notes[id]?.trim();
    return note ? { ...d, answer_text: note } : d;
  });
}

/** The server's resolved record for a tool call: exact tool_call_id match, else the latest for that tool. */
export function resolutionFor(
  call: CopilotMessage | null,
  toolName: string,
  resolved: CopilotResolvedItem[] | undefined,
): CopilotResolvedItem | null {
  if (!resolved?.length) return null;
  const id = call?.tool_call_id;
  if (id) {
    const exact = resolved.find((r) => r.tool_call_id === id);
    if (exact) return exact;
    if (resolved.some((r) => r.tool_call_id)) return null;
  }
  const byTool = resolved.filter((r) => r.tool_name === toolName);
  return byTool.length ? byTool[byTool.length - 1] : null;
}
