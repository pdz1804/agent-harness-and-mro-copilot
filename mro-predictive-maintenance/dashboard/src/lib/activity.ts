/** Small pure helpers for the Overview's approvals card. */

const APPROVAL_KEYS: [string, string][] = [
  ["component_id", "Component"],
  ["aircraft_id", "Aircraft"],
  ["task_ref", "Task ref"],
  ["priority", "Priority"],
  ["status", "Status"],
  ["alert_id", "Alert"],
];

export interface ApprovalField {
  key: string;
  label: string;
  value: string;
}

/** The few args an approver needs at a glance, in a fixed order; nulls and
 * anything not listed are left out (the copilot page shows the full call). */
export function approvalFields(args: Record<string, unknown> | null | undefined, max = 3): ApprovalField[] {
  if (!args) return [];
  const out: ApprovalField[] = [];
  for (const [key, label] of APPROVAL_KEYS) {
    const v = args[key];
    if (v === null || v === undefined || v === "") continue;
    out.push({ key, label, value: typeof v === "object" ? JSON.stringify(v) : String(v) });
    if (out.length >= max) break;
  }
  return out;
}
