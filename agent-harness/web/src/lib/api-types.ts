/** Mirrors `agent_harness.schemas` and `agent_harness.run_registry` on the
 * backend. Keep in sync with `api.py`'s pydantic response models. */

/** Mirrors `agent_harness.rbac.Role`. */
export type Role = 'admin' | 'editor' | 'viewer'

/** Mirrors `agent_harness.rbac.Action` (the global, non-resource-scoped
 * permission names). */
export type Action =
  | 'chat'
  | 'mutate_integrations'
  | 'mutate_guardrails'
  | 'mutate_prompts'
  | 'mutate_skills'
  | 'mutate_agents'
  | 'mutate_automations'
  | 'mutate_artifacts'
  | 'mutate_services'
  | 'mutate_kb'
  | 'mutate_incidents'
  | 'run_evals'

/** Mirrors `api.UserView` — one seeded RBAC identity. */
export interface User {
  id: string
  display_name: string
  role: Role
}

/** Mirrors `api.MeView`: the resolved caller identity plus which global
 * actions their role permits. */
export interface Me extends User {
  permissions: Action[]
}

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
  | 'approval_timed_out'
  | 'final_answer'
  | 'step_limit_exceeded'
  | 'time_limit_exceeded'
  | 'llm_token_delta'
  | 'context_compacted'
  | 'guardrail_blocked'
  | 'guardrail_severity_downgraded'
  | 'skill_invoked'
  | 'skills_assigned'
  | 'skill_routed'
  | 'skill_routing_failed'
  | 'no_tools_available'
  | 'run_cancelled'

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
  | 'guardrail_blocked'
  | 'cancelled'

export const TERMINAL_STATUSES: ReadonlySet<RunStatus> = new Set([
  'completed',
  'step_limit_exceeded',
  'time_limit_exceeded',
  'llm_error_exceeded',
  'failed',
  'guardrail_blocked',
  'cancelled',
])

/** One widget in a dashboard approval preview: the SQL the agent wrote plus
 * the result of the live read-only dry run (columns, row count, sample rows). */
export interface ApprovalPreviewWidget {
  kind: WidgetKind
  title: string
  sql_query: string
  config: WidgetConfig
  col_span: number
  columns: string[]
  row_count: number
  sample_rows: Record<string, unknown>[]
  error: string | null
}

/** Mirrors the `preview` a tool attaches to its approval request
 * (`Tool.precheck`): what will happen if the human approves. */
export interface ApprovalPreview {
  kind: 'dashboard' | 'widget'
  name: string
  description?: string
  visibility?: 'private' | 'shared'
  dashboard_id?: string
  widgets: ApprovalPreviewWidget[]
}

export interface PendingApproval {
  tool_name: string
  tool_args: Record<string, unknown>
  preview?: ApprovalPreview | null
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
  session_id: string | null
  prompt_version_id: string | null
  triggered_by_automation_id: string | null
  owner_id: string
  agent_id: string | null
  skill_ids: string[]
}

export interface RunSummary {
  run_id: string
  objective: string
  status: RunStatus
  started_at: number
  session_id: string | null
  prompt_version_id: string | null
  triggered_by_automation_id: string | null
  owner_id: string
  agent_id: string | null
  skill_ids: string[]
}

export interface StartRunResponse {
  run_id: string
  status: RunStatus
  session_id: string
}

/** Mirrors `run_registry.AsyncRunStatus` plus the one status that only ever
 * exists on a session with no run yet. */
export type SessionStatus = RunStatus | 'idle'

export interface ChatSession {
  id: string
  title: string
  created_at: string
  last_active_at: string | null
  status: SessionStatus
  last_run_id: string | null
  owner_id: string
  agent_id: string | null
  archived_at: string | null
}

export interface SessionDetail extends ChatSession {
  runs: RunSummary[]
}

export interface RunTokenTotals {
  run_id: string
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
  llm_calls: number
}

export interface UsageToday {
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
  llm_calls: number
  run_count: number
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

export type IncidentStatus = 'open' | 'acknowledged' | 'resolved'

/** Mirrors `routers.incidents.IncidentView`. */
export interface Incident {
  id: string
  title: string
  description: string
  severity: IncidentSeverity
  status: IncidentStatus | string
  created_at: string
  run_id: string | null
  service_name: string | null
  created_by: string | null
  acknowledged_by: string | null
  acknowledged_at: string | null
  resolved_by: string | null
  resolved_at: string | null
  resolution_note: string | null
}

export interface IncidentTimelineEntry {
  event: 'opened' | 'acknowledged' | 'resolved'
  at: string
  actor_id: string | null
  actor_name: string | null
  note: string | null
}

export interface IncidentOriginRun {
  run_id: string
  objective: string
  status: RunStatus
  session_id: string | null
}

export interface IncidentDetail extends Incident {
  timeline: IncidentTimelineEntry[]
  run: IncidentOriginRun | null
  related_open: Incident[]
}

export interface KBDoc {
  id: string
  title: string
  source?: 'seed' | 'upload'
  chars?: number
  chunk_count?: number
}

export interface KBChunk {
  index: number
  text: string
  chars: number
  char_start: number | null
  matched_terms: string[]
  bm25_score: number | null
}

/** Mirrors `routers.kb.KBDocDetail`. */
export interface KBDocDetail {
  id: string
  title: string
  source: 'seed' | 'upload'
  filename: string | null
  created_by: string | null
  created_at: string | null
  chars: number
  words: number
  chunk_count: number
  content: string
  chunks: KBChunk[]
  query: string | null
  matched_terms: string[]
}

export type RetrievalMode = 'bm25' | 'dense' | 'hybrid'

export interface KBRetrievedChunk {
  doc_id: string
  title: string
  chunk_index: number
  text: string
  bm25_score: number | null
  bm25_rank: number | null
  dense_score: number | null
  dense_rank: number | null
  fused_score: number | null
  would_return: boolean
}

export interface KBRetrieveResult {
  mode: string
  effective_mode: string
  dense_available: boolean
  hits: KBRetrievedChunk[]
}

export interface KBReindexResult {
  documents: number
  chunks: number
  dense_ready: boolean
  took_ms: number
}

export interface KBSearchResult {
  id: string
  title: string
  snippet: string
  score: number
}

export interface Integration {
  tool_name: string
  enabled: boolean
  updated_at: string
  /** Per-tool override of the loop's tool timeout; null = global default. */
  timeout_seconds: number | null
  /** Per-tool override of the retry count; null = global default. */
  max_retries: number | null
}

export interface ToolStats {
  calls: number
  errors: number
  error_rate: number | null
  avg_latency_ms: number | null
}

export interface ToolCallRow {
  run_id: string
  step: number
  outcome: 'ok' | 'error' | 'timeout'
  timestamp: number
  latency_ms: number | null
  attempt: number | null
  args: Record<string, unknown> | null
  error: string | null
}

export interface EffectiveLimits {
  timeout_seconds: number
  max_retries: number
  timeout_overridden: boolean
  retries_overridden: boolean
}

/** Mirrors `routers.integrations.IntegrationDetail`. */
export interface IntegrationDetail extends Integration {
  description: string
  requires_approval: boolean
  input_schema: Record<string, unknown> | null
  output_schema: Record<string, unknown> | null
  effective: EffectiveLimits
  stats: ToolStats
  recent_calls: ToolCallRow[]
}

/** Mirrors `agent_harness.routers.prompts.PromptKind`. */
export type PromptKind = 'system' | 'skill_router' | 'judge'

export interface PromptVersionSummary {
  id: string
  version: number
  created_at: string
}

/** Mirrors `routers.prompts.PromptVersionView`: one immutable version's
 * full content. Versions are never edited or deleted — a "new version" is
 * always a fresh row; `prompts.active_version_id` is the only pointer that
 * moves (`POST /prompts/{id}/versions/{version_id}/activate`). */
export interface PromptVersion extends PromptVersionSummary {
  content: string
  change_note: string | null
  created_by: string
  verification?: PromptVerification | null
  run_count?: number
  pinned_agents?: number
}

export type LintSeverity = 'error' | 'warning' | 'info'

export interface LintIssue {
  rule: string
  severity: LintSeverity
  message: string
  line?: number | null
}

export interface LintResult {
  status: 'pass' | 'warn' | 'fail'
  issues: LintIssue[]
  checked_at: string
  char_count: number
}

export interface LlmReviewIssue {
  severity: LintSeverity
  message: string
  suggestion: string
}

export interface LlmReviewResult {
  status: 'ok' | 'unavailable' | 'error'
  summary: string
  issues: LlmReviewIssue[]
  model: string | null
  reviewed_at: string
  error: string | null
}

/** Mirrors `agent_harness.prompt_verification.Verification`: persisted per
 * prompt version; activation is gated on `lint.status !== 'fail'`. */
export interface PromptVerification {
  lint: LintResult
  llm_review: LlmReviewResult | null
  verified_at: string
}

export interface CreatedPromptVersion extends PromptVersion {
  activated: boolean
  activation_blocked: string | null
}

/** Mirrors `routers.prompts.PromptSummary` — the prompt library list view. */
export interface PromptSummary {
  id: string
  slug: string
  name: string
  description: string | null
  kind: PromptKind
  owner_id: string
  visibility: 'private' | 'shared'
  tags: string[]
  required_placeholders?: string[]
  active_version: PromptVersionSummary | null
  version_count: number
  used_by_agents: number
  created_at: string
  updated_at: string
}

/** Mirrors `routers.prompts.PromptDetail` — full versions list included. */
export interface PromptDetail extends PromptSummary {
  versions: PromptVersion[]
}

/** Mirrors `routers.skills.ToolCatalogEntry` — backs the Skills page's tool
 * picker (`GET /tools`, reuses the same `integrations` enabled state the
 * Integrations tab reads). */
export interface ToolCatalogEntry {
  name: string
  description: string
  requires_approval: boolean
  enabled: boolean
}

/** Mirrors `routers.skills.SkillView`. Skills are not versioned (unlike
 * prompts) — `updated_at`/`updated_by` are the only edit history kept. */
export interface Skill {
  id: string
  slug: string
  name: string
  description: string
  instructions: string
  allowed_tools: string[]
  examples: string[]
  owner_id: string
  visibility: 'private' | 'shared'
  enabled: boolean
  created_at: string
  updated_at: string
  updated_by: string
}

export type GuardrailKind = 'objective_pattern_block' | 'severity_upgrade_block'

export interface Guardrail {
  id: string
  name: string
  kind: GuardrailKind
  config: Record<string, unknown>
  enabled: boolean
  created_at: string
}

export interface GuardrailTrigger {
  run_id: string
  step: number
  event_type: string
  timestamp: number
  data: Record<string, unknown>
  /** The objective of the run the rule fired on. */
  objective: string | null
}

export interface GuardrailRuleCheck {
  guardrail_id: string
  name: string
  kind: GuardrailKind
  enabled: boolean
  fired: boolean
  reason: string
  matched_pattern: string | null
}

/** Mirrors `routers.guardrails.GuardrailTestResult` (the test sandbox). */
export interface GuardrailTestResult {
  blocked: boolean
  severity_downgraded_to: string | null
  checks: GuardrailRuleCheck[]
}

/** Mirrors `api.AutomationView` (12d): a real, enforced event-driven rule
 * — when `trigger_service_name` (or every service, if 'any') flips to
 * `trigger_status`, `objective_template` starts a real new run through the
 * same `RunRegistry.start_run` code path a manual run uses. */
export interface Automation {
  id: string
  name: string
  trigger_service_name: string
  trigger_status: ServiceStatus
  objective_template: string
  enabled: boolean
  created_at: string
  owner_id: string
}

export interface AutomationTriggeredRun {
  run_id: string
  objective: string
  status: string
  started_at: number
  triggered_by_automation_id: string
}

/** Mirrors `agent_harness.widget_config.WidgetKind` / `routers.dashboards`. */
export type WidgetKind = 'stat' | 'line' | 'bar' | 'area' | 'pie' | 'table' | 'list'

export type StatFormat = 'number' | 'percent' | 'duration_ms' | 'currency'

/** Discriminated-ish union of every widget's `config` shape (phase 06).
 * The backend validates the exact shape per `kind` via
 * `agent_harness.widget_config`; the frontend keeps this loose
 * (`Record<string, unknown>` fields read defensively) since a given widget
 * row's `config` always matches its own `kind`. */
export interface WidgetConfig {
  // stat
  value_col?: string
  format?: StatFormat
  delta_col?: string | null
  suffix?: string | null
  // line/bar/area
  x_col?: string
  y_cols?: string[]
  stacked?: boolean
  // pie
  label_col?: string
  // table
  columns?: string[] | null
  page_size?: number
  // list
  title_col?: string
  subtitle_col?: string | null
  badge_col?: string | null
}

export interface WidgetQueryResult {
  columns: string[]
  rows: Record<string, unknown>[]
  truncated: boolean
}

/** Mirrors `routers.dashboards.WidgetView`. */
export interface DashboardWidget {
  id: string
  dashboard_id: string
  kind: WidgetKind
  title: string
  sql_query: string
  config: WidgetConfig
  position: number
  col_span: 3 | 4 | 6 | 12
  last_result: WidgetQueryResult | null
  last_error: string | null
  last_run_ms: number | null
  refreshed_at: string | null
}

/** Mirrors `routers.dashboards.DashboardView`. */
export interface Dashboard {
  id: string
  name: string
  description: string
  template_key: string
  owner_id: string
  visibility: 'private' | 'shared'
  layout_cols: number
  last_refreshed_at: string | null
  created_by_run_id?: string | null
  auto_refresh_seconds?: number | null
  created_at: string
  updated_at: string
  widgets: DashboardWidget[]
}

/** Mirrors `routers.dashboards.DashboardTemplateView`. */
export interface DashboardTemplate {
  key: string
  name: string
  description: string
  widget_kinds: WidgetKind[]
}

/** Mirrors `api.EvalScorerResult`/`api.EvalRunView` (12e): real MLflow
 * `mlflow.genai.evaluate()` results from the phase 11c eval suite, read via
 * MlflowClient rather than requiring the reviewer to open the MLflow UI. */
export interface EvalScorerResult {
  name: string
  mean_score: number
}

export interface EvalRun {
  run_id: string
  run_name: string
  status: string
  start_time: string | null
  scorers: EvalScorerResult[]
  mlflow_url: string | null
}

/** Mirrors `routers.evals` (phase 07 part B): the in-app LLM-as-judge eval
 * agent, distinct from the offline `EvalRun`/`mlflow.genai.evaluate()` suite
 * above — "Score my sessions" starts an `EvalRunSummary` job that scores
 * real persisted chat runs and is polled for progress. */
export type EvalRunStatus = 'queued' | 'running' | 'completed' | 'failed'
export type EvalRunScope = 'mine' | 'all'

export interface EvalRunSummary {
  id: string
  triggered_by: string
  scope: string
  judge_version: string
  judge_model: string
  status: EvalRunStatus
  total: number
  done: number
  started_at: string | null
  finished_at: string | null
  summary: { scored: number; skipped_already_scored: number; errors: string[]; requested: number } | null
  mlflow_run_id: string | null
  mlflow_url: string | null
  error: string | null
  created_at: string
}

export interface EvalResultRow {
  id: string
  eval_run_id: string
  run_id: string
  session_id: string | null
  agent_id: string | null
  metric: string
  score: number | null
  passed: boolean | null
  rationale: string | null
  judge_version: string
  created_at: string
}

export interface EvalRunDetail extends EvalRunSummary {
  results: EvalResultRow[]
}

export interface StartEvalRunRequest {
  scope?: EvalRunScope
  since?: string
  limit?: number
  force?: boolean
}

export interface EvalMetricOverviewRow {
  metric: string
  latest_mean: number | null
  prev_mean: number | null
  delta: number | null
  n: number
}

export interface EvalSeriesPoint {
  date: string
  metric: string
  mean: number
  n: number
}

export interface EvalWorstRunRow {
  run_id: string
  session_id: string | null
  agent_id: string | null
  score: number
  rationale: string | null
  created_at: string
}

export interface EvalAgentBreakdownRow {
  agent_id: string | null
  metric: string
  mean: number
  n: number
}

export interface EvalOverview {
  days: number
  judge_available: boolean
  metrics: EvalMetricOverviewRow[]
  series: EvalSeriesPoint[]
  worst_runs: EvalWorstRunRow[]
  by_agent: EvalAgentBreakdownRow[]
}

/** Mirrors `routers.agents.SkillMode`. */
export type SkillMode = 'none' | 'assigned' | 'auto'

/** Mirrors `routers.agents.AgentView` (phase 04). */
export interface Agent {
  id: string
  slug: string
  name: string
  description: string
  avatar_color: string
  prompt_id: string
  prompt_version_id: string | null
  skill_mode: SkillMode
  skill_ids: string[]
  base_tools: string[]
  max_steps: number | null
  owner_id: string
  visibility: 'private' | 'shared'
  is_default: boolean
  created_at: string
  updated_at: string
}

/** Mirrors `routers.agents.PreviewRouteResponse` — a router dry-run. */
export interface PreviewRouteResult {
  selected: string[]
  rationale: string
  confidence: number
  candidates: string[]
}

/** Mirrors `routers.agents.list_skill_commands`'s shape — backs the chat
 * composer's `/` slash-command autocomplete (phase 05). */
export interface SkillCommand {
  slug: string
  name: string
  description: string
  examples: string[]
}

/** Prompt Playground run spec (`POST /runs` `playground`): an unsaved draft
 * (`system_prompt`) or a saved version (`prompt_id` + `prompt_version_id`). */
export interface PlaygroundSpec {
  system_prompt?: string
  prompt_id?: string
  prompt_version_id?: string
}

export interface StarterPrompt {
  text: string
  skill_slug: string
}

/** Mirrors `routers.memories.MemoryView`: a fact kept in long-term memory. */
export interface Memory {
  id: string
  owner_id: string
  owner_name: string
  fact: string
  tags: string[]
  source_run_id: string | null
  created_at: string
  updated_at: string
  last_used_at: string | null
  use_count: number
}

export interface UsedMemory {
  id: string
  fact: string
  tags: string[]
  /** False when the memory was deleted after the run used it. */
  exists: boolean
}

/** Mirrors `routers.runs.RunMemories`. */
export interface RunMemories {
  used: UsedMemory[]
  saved: UsedMemory[]
}

export type FeedbackRating = 'up' | 'down'

export interface FeedbackView {
  run_id: string
  user_id: string
  user_name: string
  rating: FeedbackRating
  note: string
  updated_at: string
}

/** Mirrors `routers.runs.RunFeedback`: human votes next to the judge's score. */
export interface RunFeedback {
  mine: FeedbackView | null
  others: FeedbackView[]
  judge_score: number | null
  judge_passed: boolean | null
  judge_rationale: string | null
}

/** Mirrors `routers.evals.AgreementView`: judge-vs-human agreement. */
export interface EvalAgreement {
  human_votes: number
  compared: number
  agree: number
  agreement_rate: number | null
  both_up: number
  both_down: number
  judge_up_human_down: number
  judge_down_human_up: number
}

/** Mirrors `routers.agents.AgentStats`. */
export interface AgentStats {
  runs: number
  by_status: Record<string, number>
  avg_steps: number | null
  scored_runs: number
  success_rate: number | null
}

export interface RouteCandidate {
  slug: string
  name: string
  description: string
  selected: boolean
}

/** Mirrors `routers.agents.RouteTestResult`: the skill routing tester. */
export interface RouteTestResult {
  mode: 'slash' | 'router'
  selected: string[]
  confidence: number
  threshold: number
  rationale: string
  raw_picks: string[]
  candidates: RouteCandidate[]
  latency_ms: number | null
}

/** Mirrors `api_models.PendingApprovalItem`: a run waiting on a human decision. */
export interface PendingApprovalItem {
  run_id: string
  objective: string
  session_id: string | null
  owner_id: string
  tool_name: string
  started_at: number
}

export type ArchivedFilter = 'exclude' | 'include' | 'only'

export interface SessionFilters {
  q?: string
  status?: string
  agent_id?: string
  since?: string
  until?: string
  archived?: ArchivedFilter
}
