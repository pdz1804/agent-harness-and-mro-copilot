import type {
  Agent,
  AgentStats,
  Automation,
  AutomationTriggeredRun,
  ChatSession,
  Dashboard,
  DashboardTemplate,
  DashboardWidget,
  EvalAgreement,
  EvalOverview,
  EvalRun,
  EvalRunDetail,
  EvalRunSummary,
  FeedbackRating,
  Guardrail,
  GuardrailKind,
  GuardrailTestResult,
  GuardrailTrigger,
  HealthResponse,
  Incident,
  IncidentDetail,
  IncidentStatus,
  Integration,
  IntegrationDetail,
  CreatedPromptVersion,
  KBDoc,
  KBDocDetail,
  KBReindexResult,
  KBRetrieveResult,
  KBSearchResult,
  Memory,
  PlaygroundSpec,
  PromptVerification,
  RetrievalMode,
  StarterPrompt,
  Me,
  PendingApprovalItem,
  PreviewRouteResult,
  PromptDetail,
  PromptKind,
  PromptSummary,
  PromptVersion,
  RouteTestResult,
  RunFeedback,
  RunMemories,
  RunSnapshot,
  RunSummary,
  RunTokenTotals,
  Service,
  ServiceStatus,
  SessionDetail,
  SessionFilters,
  StartEvalRunRequest,
  Skill,
  SkillCommand,
  SkillMode,
  StartRunResponse,
  ToolCatalogEntry,
  UsageToday,
  User,
  WidgetConfig,
  WidgetKind,
  WidgetQueryResult,
} from './api-types'
import { getCurrentUserId } from './identity'

/** The single source of the API location: `<origin><prefix>`.
 * - origin: same-origin by default (api.py serves the built console); in
 *   `npm run dev` (Vite's own dev server) the documented local uvicorn port.
 *   Override with VITE_API_BASE_URL.
 * - prefix: every API route lives under `/api/v1`. Override with
 *   VITE_API_PREFIX (e.g. `VITE_API_PREFIX=` for an older unprefixed server).
 * Both `request()` and the SSE `eventsUrl` build on this one constant. */
const DEV_DEFAULT_API_ORIGIN = 'http://127.0.0.1:8000'
const API_ORIGIN = (import.meta.env.VITE_API_BASE_URL ?? (import.meta.env.DEV ? DEV_DEFAULT_API_ORIGIN : '')).replace(/\/$/, '')
const API_PREFIX = (import.meta.env.VITE_API_PREFIX ?? '/api/v1').replace(/\/$/, '')
export const API_BASE = `${API_ORIGIN}${API_PREFIX}`

export class ApiError extends Error {
  status: number
  /** Structured `detail` when the server sent an object (e.g. a failed prompt
   * verification), so callers can render it instead of a flat message. */
  detail: unknown

  constructor(status: number, message: string, detail?: unknown) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.detail = detail
  }
}

/** FastAPI's `detail` is a string, an object, or a list of validation
 * errors; reduce it to a readable message and keep the raw value. */
export function describeErrorDetail(detail: unknown, fallback: string): string {
  if (typeof detail === 'string' && detail) return detail
  if (Array.isArray(detail)) {
    const parts = detail
      .map((d) => (d && typeof d === 'object' && 'msg' in d ? String((d as { msg: unknown }).msg) : ''))
      .filter(Boolean)
    if (parts.length) return parts.join('; ')
  }
  if (detail && typeof detail === 'object' && 'message' in detail) {
    const message = (detail as { message: unknown }).message
    if (typeof message === 'string' && message) return message
  }
  return fallback
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response
  try {
    response = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        // Local "identity switcher" (phase 01 RBAC) — see lib/identity.ts's
        // module docstring for the honest "not authentication" framing.
        'X-User-Id': getCurrentUserId(),
        ...init?.headers,
      },
    })
  } catch {
    throw new ApiError(0, 'Could not reach the Agent Harness API. Is the backend running?')
  }

  if (!response.ok) {
    let message = response.statusText
    let rawDetail: unknown
    try {
      const body = (await response.json()) as { detail?: unknown }
      rawDetail = body?.detail
      message = describeErrorDetail(body?.detail, message)
    } catch {
      // Non-JSON error body — fall back to statusText already set above.
    }
    throw new ApiError(response.status, message, rawDetail)
  }

  // 204 No Content (every DELETE): there is no body to parse.
  if (response.status === 204) return undefined as T
  return (await response.json()) as T
}

export interface StartRunInput {
  objective: string
  max_steps?: number
  max_wall_clock_seconds?: number
  session_id?: string
  agent_id?: string
  playground?: PlaygroundSpec
  /** Mark the new session as an agent test chat ("[Test] ..."). */
  agent_test?: boolean
}

export const api = {
  health: () => request<HealthResponse>('/health'),

  me: () => request<Me>('/me'),

  listUsers: () => request<User[]>('/users'),

  listServices: () => request<Service[]>('/services'),

  setServiceStatus: (name: string, status: ServiceStatus) =>
    request<Service>(`/services/${encodeURIComponent(name)}/status`, {
      method: 'POST',
      body: JSON.stringify({ status }),
    }),

  listIncidents: (params?: { status?: IncidentStatus; service?: string }) => {
    const search = new URLSearchParams()
    if (params?.status) search.set('status', params.status)
    if (params?.service) search.set('service', params.service)
    const qs = search.toString()
    return request<Incident[]>(`/incidents${qs ? `?${qs}` : ''}`)
  },

  getIncident: (incidentId: string) => request<IncidentDetail>(`/incidents/${encodeURIComponent(incidentId)}`),

  acknowledgeIncident: (incidentId: string) =>
    request<Incident>(`/incidents/${encodeURIComponent(incidentId)}/acknowledge`, { method: 'POST' }),

  resolveIncident: (incidentId: string, note: string) =>
    request<Incident>(`/incidents/${encodeURIComponent(incidentId)}/resolve`, {
      method: 'POST',
      body: JSON.stringify({ note }),
    }),

  listKbDocs: () => request<KBDoc[]>('/kb'),

  getKbDoc: (docId: string, query?: string) =>
    request<KBDocDetail>(`/kb/${encodeURIComponent(docId)}${query ? `?q=${encodeURIComponent(query)}` : ''}`),

  createKbDoc: (input: { title?: string; content: string }) =>
    request<KBDocDetail>('/kb', { method: 'POST', body: JSON.stringify(input) }),

  deleteKbDoc: (docId: string) => request<void>(`/kb/${encodeURIComponent(docId)}`, { method: 'DELETE' }),

  reindexKb: () => request<KBReindexResult>('/kb/reindex', { method: 'POST' }),

  retrieveKb: (query: string, mode: RetrievalMode, topK = 10) =>
    request<KBRetrieveResult>('/kb/retrieve', {
      method: 'POST',
      body: JSON.stringify({ query, mode, top_k: topK }),
    }),

  searchKb: (query: string, topK = 5) =>
    request<KBSearchResult[]>('/kb/search', {
      method: 'POST',
      body: JSON.stringify({ query, top_k: topK }),
    }),

  startRun: (input: StartRunInput) =>
    request<StartRunResponse>('/runs', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  getRun: (runId: string) => request<RunSnapshot>(`/runs/${encodeURIComponent(runId)}`),

  listRuns: () => request<RunSummary[]>('/runs'),

  approveRun: (runId: string, approved: boolean) =>
    request<RunSnapshot>(`/runs/${encodeURIComponent(runId)}/approve`, {
      method: 'POST',
      body: JSON.stringify({ approved }),
    }),

  cancelRun: (runId: string) =>
    request<RunSnapshot>(`/runs/${encodeURIComponent(runId)}/cancel`, { method: 'POST' }),

  exportRun: (runId: string) => request<RunSnapshot>(`/runs/${encodeURIComponent(runId)}/export`),

  /** Base URL for the SSE endpoint — used directly by `useRunStream` since
   * `EventSource` doesn't go through this module's `fetch`-based `request`
   * (and can't set the `X-User-Id` header every other call uses — identity
   * travels as `?as_user=` instead, see `current_user` in api.py). */
  eventsUrl: (runId: string) =>
    `${API_BASE}/runs/${encodeURIComponent(runId)}/events?as_user=${encodeURIComponent(getCurrentUserId())}`,

  listSessions: (filters?: SessionFilters) => {
    const search = new URLSearchParams()
    if (filters?.q) search.set('q', filters.q)
    if (filters?.status) search.set('status', filters.status)
    if (filters?.agent_id) search.set('agent_id', filters.agent_id)
    if (filters?.since) search.set('since', filters.since)
    if (filters?.until) search.set('until', filters.until)
    if (filters?.archived && filters.archived !== 'exclude') search.set('archived', filters.archived)
    const qs = search.toString()
    return request<ChatSession[]>(`/sessions${qs ? `?${qs}` : ''}`)
  },

  updateSession: (sessionId: string, patch: { title?: string; archived?: boolean }) =>
    request<ChatSession>(`/sessions/${encodeURIComponent(sessionId)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),

  deleteSession: (sessionId: string) =>
    request<void>(`/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' }),

  listPendingApprovals: () => request<PendingApprovalItem[]>('/approvals/pending'),

  getRunMemories: (runId: string) => request<RunMemories>(`/runs/${encodeURIComponent(runId)}/memories`),

  getRunFeedback: (runId: string) => request<RunFeedback>(`/runs/${encodeURIComponent(runId)}/feedback`),

  putRunFeedback: (runId: string, rating: FeedbackRating, note: string) =>
    request<RunFeedback>(`/runs/${encodeURIComponent(runId)}/feedback`, {
      method: 'PUT',
      body: JSON.stringify({ rating, note }),
    }),

  deleteRunFeedback: (runId: string) =>
    request<RunFeedback>(`/runs/${encodeURIComponent(runId)}/feedback`, { method: 'DELETE' }),

  getEvalAgreement: () => request<EvalAgreement>('/eval-metrics/agreement'),

  listMemories: (params?: { q?: string; scope?: 'mine' | 'all' }) => {
    const search = new URLSearchParams()
    if (params?.q) search.set('q', params.q)
    if (params?.scope === 'all') search.set('scope', 'all')
    const qs = search.toString()
    return request<Memory[]>(`/memories${qs ? `?${qs}` : ''}`)
  },

  createMemory: (input: { fact: string; tags?: string[] }) =>
    request<Memory>('/memories', { method: 'POST', body: JSON.stringify(input) }),

  updateMemory: (memoryId: string, patch: { fact?: string; tags?: string[] }) =>
    request<Memory>(`/memories/${encodeURIComponent(memoryId)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),

  deleteMemory: (memoryId: string) =>
    request<void>(`/memories/${encodeURIComponent(memoryId)}`, { method: 'DELETE' }),

  createSession: (title?: string, agentId?: string) =>
    request<ChatSession>('/sessions', {
      method: 'POST',
      body: JSON.stringify({ title, agent_id: agentId }),
    }),

  getSession: (sessionId: string) => request<SessionDetail>(`/sessions/${encodeURIComponent(sessionId)}`),

  getRunTokens: (runId: string) => request<RunTokenTotals>(`/runs/${encodeURIComponent(runId)}/tokens`),

  getUsageToday: () => request<UsageToday>('/usage/today'),

  listIntegrations: () => request<Integration[]>('/integrations'),

  getIntegration: (toolName: string) =>
    request<IntegrationDetail>(`/integrations/${encodeURIComponent(toolName)}`),

  setIntegrationEnabled: (toolName: string, enabled: boolean) =>
    request<Integration>(`/integrations/${encodeURIComponent(toolName)}`, {
      method: 'PATCH',
      body: JSON.stringify({ enabled }),
    }),

  /** Set a tool's own timeout / retry count; `null` clears one back to the global default. */
  updateIntegrationLimits: (toolName: string, limits: { timeout_seconds?: number | null; max_retries?: number | null }) =>
    request<Integration>(`/integrations/${encodeURIComponent(toolName)}`, {
      method: 'PATCH',
      body: JSON.stringify(limits),
    }),

  listPrompts: (params?: { kind?: PromptKind; q?: string }) => {
    const search = new URLSearchParams()
    if (params?.kind) search.set('kind', params.kind)
    if (params?.q) search.set('q', params.q)
    const qs = search.toString()
    return request<PromptSummary[]>(`/prompts${qs ? `?${qs}` : ''}`)
  },

  getPrompt: (promptId: string) => request<PromptDetail>(`/prompts/${encodeURIComponent(promptId)}`),

  createPrompt: (input: {
    slug: string
    name: string
    description?: string
    kind: PromptKind
    visibility?: 'private' | 'shared'
    tags?: string[]
    required_placeholders?: string[]
    llm_review?: boolean
    content: string
  }) =>
    request<PromptDetail>('/prompts', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  updatePrompt: (
    promptId: string,
    patch: {
      name?: string
      description?: string
      visibility?: 'private' | 'shared'
      tags?: string[]
      required_placeholders?: string[]
    },
  ) =>
    request<PromptDetail>(`/prompts/${encodeURIComponent(promptId)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),

  deletePrompt: (promptId: string) =>
    request<void>(`/prompts/${encodeURIComponent(promptId)}`, { method: 'DELETE' }),

  createPromptVersion: (
    promptId: string,
    input: { content: string; change_note?: string; activate?: boolean; llm_review?: boolean },
  ) =>
    request<CreatedPromptVersion>(`/prompts/${encodeURIComponent(promptId)}/versions`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  verifyPromptDraft: (input: {
    content: string
    kind: PromptKind
    required_placeholders?: string[]
    llm_review?: boolean
  }) =>
    request<PromptVerification>('/prompts/verify', { method: 'POST', body: JSON.stringify(input) }),

  verifyPromptVersion: (promptId: string, versionId: string, llmReview: boolean) =>
    request<PromptVersion>(
      `/prompts/${encodeURIComponent(promptId)}/versions/${encodeURIComponent(versionId)}/verify`,
      { method: 'POST', body: JSON.stringify({ llm_review: llmReview }) },
    ),

  activatePromptVersion: (promptId: string, versionId: string) =>
    request<PromptDetail>(
      `/prompts/${encodeURIComponent(promptId)}/versions/${encodeURIComponent(versionId)}/activate`,
      { method: 'POST' },
    ),

  listGuardrails: () => request<Guardrail[]>('/guardrails'),

  createGuardrail: (input: { name: string; kind: GuardrailKind; config: Record<string, unknown>; enabled?: boolean }) =>
    request<Guardrail>('/guardrails', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  setGuardrailEnabled: (guardrailId: string, enabled: boolean) =>
    request<Guardrail>(`/guardrails/${encodeURIComponent(guardrailId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ enabled }),
    }),

  listGuardrailTriggers: () => request<GuardrailTrigger[]>('/guardrails/triggers'),

  testGuardrails: (input: { text: string; severity?: string; evidence_status?: string }) =>
    request<GuardrailTestResult>('/guardrails/test', { method: 'POST', body: JSON.stringify(input) }),

  listAutomations: () => request<Automation[]>('/automations'),

  createAutomation: (input: {
    name: string
    trigger_service_name: string
    trigger_status: ServiceStatus
    objective_template: string
    enabled?: boolean
  }) =>
    request<Automation>('/automations', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  setAutomationEnabled: (automationId: string, enabled: boolean) =>
    request<Automation>(`/automations/${encodeURIComponent(automationId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ enabled }),
    }),

  listAutomationRuns: () => request<AutomationTriggeredRun[]>('/automations/runs'),

  listDashboardTemplates: () => request<DashboardTemplate[]>('/dashboard-templates'),

  listDashboards: () => request<Dashboard[]>('/dashboards'),

  getDashboard: (dashboardId: string) => request<Dashboard>(`/dashboards/${encodeURIComponent(dashboardId)}`),

  createDashboard: (input: { name: string; template_key: string; description?: string; visibility?: 'private' | 'shared' }) =>
    request<Dashboard>('/dashboards', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  updateDashboard: (
    dashboardId: string,
    patch: {
      name?: string
      description?: string
      visibility?: 'private' | 'shared'
      auto_refresh_seconds?: number
    },
  ) =>
    request<Dashboard>(`/dashboards/${encodeURIComponent(dashboardId)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),

  duplicateDashboard: (dashboardId: string, name?: string) =>
    request<Dashboard>(`/dashboards/${encodeURIComponent(dashboardId)}/duplicate`, {
      method: 'POST',
      body: JSON.stringify({ name }),
    }),

  deleteDashboard: (dashboardId: string) =>
    request<void>(`/dashboards/${encodeURIComponent(dashboardId)}`, { method: 'DELETE' }),

  createWidget: (
    dashboardId: string,
    input: { kind: WidgetKind; title: string; sql_query: string; config: WidgetConfig; col_span?: 3 | 4 | 6 | 12 },
  ) =>
    request<DashboardWidget>(`/dashboards/${encodeURIComponent(dashboardId)}/widgets`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  updateWidget: (
    dashboardId: string,
    widgetId: string,
    patch: { title?: string; sql_query?: string; config?: WidgetConfig; col_span?: 3 | 4 | 6 | 12 },
  ) =>
    request<DashboardWidget>(
      `/dashboards/${encodeURIComponent(dashboardId)}/widgets/${encodeURIComponent(widgetId)}`,
      { method: 'PATCH', body: JSON.stringify(patch) },
    ),

  deleteWidget: (dashboardId: string, widgetId: string) =>
    request<void>(`/dashboards/${encodeURIComponent(dashboardId)}/widgets/${encodeURIComponent(widgetId)}`, {
      method: 'DELETE',
    }),

  reorderWidgets: (dashboardId: string, ids: string[]) =>
    request<Dashboard>(`/dashboards/${encodeURIComponent(dashboardId)}/widgets/reorder`, {
      method: 'POST',
      body: JSON.stringify({ ids }),
    }),

  refreshDashboard: (dashboardId: string) =>
    request<Dashboard>(`/dashboards/${encodeURIComponent(dashboardId)}/refresh`, { method: 'POST' }),

  refreshWidget: (dashboardId: string, widgetId: string) =>
    request<DashboardWidget>(
      `/dashboards/${encodeURIComponent(dashboardId)}/widgets/${encodeURIComponent(widgetId)}/refresh`,
      { method: 'POST' },
    ),

  previewQuery: (input: { sql_query: string; kind: WidgetKind; config: WidgetConfig }) =>
    request<WidgetQueryResult>('/queries/preview', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  listEvals: () => request<EvalRun[]>('/evals'),

  startEvalRun: (input: StartEvalRunRequest) =>
    request<EvalRunSummary>('/eval-runs', { method: 'POST', body: JSON.stringify(input) }),

  listEvalRuns: () => request<EvalRunSummary[]>('/eval-runs'),

  getEvalRun: (evalRunId: string, params?: { metric?: string; agent_id?: string; failed_only?: boolean }) => {
    const search = new URLSearchParams()
    if (params?.metric) search.set('metric', params.metric)
    if (params?.agent_id) search.set('agent_id', params.agent_id)
    if (params?.failed_only) search.set('failed_only', 'true')
    const qs = search.toString()
    return request<EvalRunDetail>(`/eval-runs/${encodeURIComponent(evalRunId)}${qs ? `?${qs}` : ''}`)
  },

  getEvalMetricsOverview: (params?: { days?: number; agent_id?: string }) => {
    const search = new URLSearchParams()
    if (params?.days) search.set('days', String(params.days))
    if (params?.agent_id) search.set('agent_id', params.agent_id)
    const qs = search.toString()
    return request<EvalOverview>(`/eval-metrics/overview${qs ? `?${qs}` : ''}`)
  },

  listTools: () => request<ToolCatalogEntry[]>('/tools'),

  listSkills: (params?: { q?: string; enabled?: boolean }) => {
    const search = new URLSearchParams()
    if (params?.q) search.set('q', params.q)
    if (params?.enabled !== undefined) search.set('enabled', String(params.enabled))
    const qs = search.toString()
    return request<Skill[]>(`/skills${qs ? `?${qs}` : ''}`)
  },

  getSkill: (skillId: string) => request<Skill>(`/skills/${encodeURIComponent(skillId)}`),

  createSkill: (input: {
    slug: string
    name: string
    description: string
    instructions?: string
    allowed_tools: string[]
    examples?: string[]
    visibility?: 'private' | 'shared'
    enabled?: boolean
  }) =>
    request<Skill>('/skills', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  updateSkill: (
    skillId: string,
    patch: {
      name?: string
      description?: string
      instructions?: string
      allowed_tools?: string[]
      examples?: string[]
      visibility?: 'private' | 'shared'
      enabled?: boolean
    },
  ) =>
    request<Skill>(`/skills/${encodeURIComponent(skillId)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),

  deleteSkill: (skillId: string) =>
    request<void>(`/skills/${encodeURIComponent(skillId)}`, { method: 'DELETE' }),

  listAgents: () => request<Agent[]>('/agents'),

  getAgentStarters: (agentId: string) =>
    request<StarterPrompt[]>(`/agents/${encodeURIComponent(agentId)}/starters`),

  getAgent: (agentId: string) => request<Agent>(`/agents/${encodeURIComponent(agentId)}`),

  createAgent: (input: {
    slug: string
    name: string
    description?: string
    avatar_color?: string
    prompt_id: string
    prompt_version_id?: string | null
    skill_mode?: SkillMode
    skill_ids?: string[]
    base_tools?: string[]
    max_steps?: number | null
    visibility?: 'private' | 'shared'
  }) =>
    request<Agent>('/agents', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  updateAgent: (
    agentId: string,
    patch: {
      name?: string
      description?: string
      avatar_color?: string
      prompt_id?: string
      prompt_version_id?: string | null
      skill_mode?: SkillMode
      skill_ids?: string[]
      base_tools?: string[]
      max_steps?: number | null
      visibility?: 'private' | 'shared'
    },
  ) =>
    request<Agent>(`/agents/${encodeURIComponent(agentId)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),

  deleteAgent: (agentId: string) =>
    request<void>(`/agents/${encodeURIComponent(agentId)}`, { method: 'DELETE' }),

  cloneAgent: (agentId: string) =>
    request<Agent>(`/agents/${encodeURIComponent(agentId)}/clone`, { method: 'POST' }),

  getAgentStats: (agentId: string) => request<AgentStats>(`/agents/${encodeURIComponent(agentId)}/stats`),

  testSkillRouting: (input: { objective: string; agent_id?: string }) =>
    request<RouteTestResult>('/skills/route-test', { method: 'POST', body: JSON.stringify(input) }),

  previewRoute: (agentId: string, objective: string) =>
    request<PreviewRouteResult>(`/agents/${encodeURIComponent(agentId)}/preview-route`, {
      method: 'POST',
      body: JSON.stringify({ objective }),
    }),

  listSkillCommands: () => request<SkillCommand[]>('/skills/commands'),
}
