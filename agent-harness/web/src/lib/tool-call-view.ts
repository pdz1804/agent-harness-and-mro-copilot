/** Pure presentation helpers for the one tool-call component (`ToolCallBlock`)
 * and the session Workspace: a one-line argument summary, the lifecycle label,
 * which artifact (if any) a finished call produced, and run-stall detection.
 * No React, no DOM. */
import type { ToolCallStatus, ToolCallSummary } from './trace-model'

const MAX_PART = 48

function scalar(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() || null
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return null
}

/** "payments-api · severity medium" — up to three scalar argument values in
 * argument order; `severity`/`status`-like keys keep their name for clarity.
 * Long values are truncated; objects/arrays are skipped. */
export function summarizeArgs(args: Record<string, unknown> | null, maxParts = 3): string {
  if (!args) return ''
  const parts: string[] = []
  for (const [key, value] of Object.entries(args)) {
    const text = scalar(value)
    if (text === null) continue
    const clipped = text.length > MAX_PART ? `${text.slice(0, MAX_PART - 1)}…` : text
    parts.push(/^(severity|status|visibility|kind|mode|limit)$/.test(key) ? `${key} ${clipped}` : clipped)
    if (parts.length >= maxParts) break
  }
  return parts.join(' · ')
}

export type LifecycleTone = 'running' | 'attention' | 'success' | 'danger' | 'muted'

export const LIFECYCLE: Record<ToolCallStatus, { label: string; tone: LifecycleTone }> = {
  awaiting_approval: { label: 'Needs approval', tone: 'attention' },
  started: { label: 'Running', tone: 'running' },
  retry: { label: 'Retrying', tone: 'attention' },
  ok: { label: 'Succeeded', tone: 'success' },
  timeout: { label: 'Timed out', tone: 'danger' },
  error: { label: 'Failed', tone: 'danger' },
  denied: { label: 'Denied', tone: 'muted' },
  invalid: { label: 'Invalid arguments', tone: 'danger' },
}

export type ArtifactKind = 'dashboard' | 'incident' | 'memory'

export interface ArtifactRef {
  kind: ArtifactKind
  id: string
  label: string
}

function str(obj: Record<string, unknown> | null, key: string): string | null {
  const v = obj?.[key]
  return typeof v === 'string' && v ? v : null
}

/** The artifact a *successful* call produced, read from its real result
 * payload (`create_dashboard`/`add_widget` → dashboard_id, `create_incident`
 * → incident_id, `remember` → memory_id). Null for read-only tools. */
export function artifactOf(call: ToolCallSummary): ArtifactRef | null {
  if (call.status !== 'ok') return null
  const result = call.result && typeof call.result === 'object' ? (call.result as Record<string, unknown>) : null
  switch (call.toolName) {
    case 'create_dashboard':
    case 'add_widget': {
      const id = str(result, 'dashboard_id')
      return id ? { kind: 'dashboard', id, label: str(result, 'name') ?? str(call.args, 'name') ?? 'Dashboard' } : null
    }
    case 'create_incident': {
      const id = str(result, 'incident_id') ?? str(result, 'id')
      return id ? { kind: 'incident', id, label: str(result, 'title') ?? str(call.args, 'title') ?? id } : null
    }
    case 'remember': {
      const id = str(result, 'memory_id')
      return id ? { kind: 'memory', id, label: str(result, 'fact') ?? str(call.args, 'fact') ?? 'Memory' } : null
    }
    default:
      return null
  }
}

/** Seconds since the newest event once a live, non-paused run has gone quiet
 * for at least `thresholdSeconds`; null while it is healthy. A run waiting on
 * a human approval is not stalled — it is waiting on purpose. Timestamps are
 * Unix seconds (as on `AgentEvent.timestamp`); `nowMs` is `Date.now()`. */
export function stalledFor(
  lastActivityAt: number | null,
  nowMs: number,
  status: string,
  thresholdSeconds = 60,
): number | null {
  if (status !== 'running' || lastActivityAt === null) return null
  const idle = Math.floor(nowMs / 1000 - lastActivityAt)
  return idle >= thresholdSeconds ? idle : null
}
