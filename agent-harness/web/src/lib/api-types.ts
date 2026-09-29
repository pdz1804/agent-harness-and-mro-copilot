/** Mirrors `agent_harness.schemas` and `agent_harness.run_registry` on the
 * backend. Keep in sync with `api.py`'s pydantic response models. */

export type EventType =
  | 'llm_decision'
  | 'llm_malformed_response'
  | 'llm_retry_exhausted'
  | 'tool_validation_error'
  | 'tool_call_started'
  | 'tool_call_result'
  | 'tool_call_error'
  | 'tool_call_timeout'
  | 'tool_call_retry'
  | 'tool_call_retries_exhausted'
  | 'approval_requested'
  | 'approval_granted'
  | 'approval_denied'
  | 'final_answer'
  | 'step_limit_exceeded'
  | 'time_limit_exceeded'

export interface AgentEvent {
  run_id: string
  step: number
  event_type: EventType
  timestamp: number
  latency_ms: number | null
  data: Record<string, unknown>
}

/** Mirrors `run_registry.AsyncRunStatus`. */
export type RunStatus =
  | 'running'
  | 'pending_approval'
  | 'completed'
  | 'step_limit_exceeded'
  | 'time_limit_exceeded'
  | 'llm_error_exceeded'
  | 'failed'

export const TERMINAL_STATUSES: ReadonlySet<RunStatus> = new Set([
  'completed',
  'step_limit_exceeded',
  'time_limit_exceeded',
  'llm_error_exceeded',
  'failed',
])

export interface PendingApproval {
  tool_name: string
  tool_args: Record<string, unknown>
}

export interface RunSnapshot {
  run_id: string
  objective: string
  status: RunStatus
  started_at: number
  steps_taken: number
  final_answer: string | null
  pending_approval: PendingApproval | null
  history: AgentEvent[]
  trace_path: string | null
  error: string | null
}

export interface RunSummary {
  run_id: string
  objective: string
  status: RunStatus
  started_at: number
}

export interface StartRunResponse {
  run_id: string
  status: RunStatus
}

export interface HealthResponse {
  status: string
  llm_configured: boolean
  llm_model: string | null
  llm_last_error: string | null
}

export type ServiceStatus = 'operational' | 'degraded' | 'down'

export interface Service {
  name: string
  status: ServiceStatus
  latency_ms: number | null
  error_rate: number | null
  last_deploy: string | null
  owner: string | null
  last_checked: string | null
}

export type IncidentSeverity = 'low' | 'medium' | 'high' | 'critical'

export interface Incident {
  id: string
  title: string
  description: string
  severity: IncidentSeverity
  status: string
  created_at: string
  run_id: string | null
}

export interface KBDoc {
  id: string
  title: string
}

export interface KBSearchResult {
  id: string
  title: string
  snippet: string
  score: number
}
