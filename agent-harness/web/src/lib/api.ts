import type {
  HealthResponse,
  Incident,
  KBDoc,
  KBSearchResult,
  RunSnapshot,
  RunSummary,
  Service,
  ServiceStatus,
  StartRunResponse,
} from './api-types'

/** Same-origin by default (the built console is served by api.py at "/",
 * see agent-harness/README.md "Run the app"). In `npm run dev` (Vite's own
 * dev server, default port 5173) there is no same-origin API to call, so
 * default to the documented local uvicorn port instead; override with
 * VITE_API_BASE_URL if the backend runs elsewhere. */
const DEV_DEFAULT_API_BASE = 'http://127.0.0.1:8000'
const API_BASE = (
  import.meta.env.VITE_API_BASE_URL ?? (import.meta.env.DEV ? DEV_DEFAULT_API_BASE : '')
).replace(/\/$/, '')

export class ApiError extends Error {
  status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response
  try {
    response = await fetch(`${API_BASE}${path}`, {
      headers: { 'Content-Type': 'application/json' },
      ...init,
    })
  } catch {
    throw new ApiError(0, 'Could not reach the Agent Harness API. Is the backend running?')
  }

  if (!response.ok) {
    let detail = response.statusText
    try {
      const body = (await response.json()) as { detail?: string }
      if (body?.detail) detail = body.detail
    } catch {
      // Non-JSON error body — fall back to statusText already set above.
    }
    throw new ApiError(response.status, detail)
  }

  return (await response.json()) as T
}

export interface StartRunInput {
  objective: string
  max_steps?: number
  max_wall_clock_seconds?: number
}

export const api = {
  health: () => request<HealthResponse>('/health'),

  listServices: () => request<Service[]>('/services'),

  setServiceStatus: (name: string, status: ServiceStatus) =>
    request<Service>(`/services/${encodeURIComponent(name)}/status`, {
      method: 'POST',
      body: JSON.stringify({ status }),
    }),

  listIncidents: () => request<Incident[]>('/incidents'),

  listKbDocs: () => request<KBDoc[]>('/kb'),

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

  exportRun: (runId: string) => request<RunSnapshot>(`/runs/${encodeURIComponent(runId)}/export`),

  /** Base URL for the SSE endpoint — used directly by `useRunStream` since
   * `EventSource` doesn't go through this module's `fetch`-based `request`. */
  eventsUrl: (runId: string) => `${API_BASE}/runs/${encodeURIComponent(runId)}/events`,
}
