// Client for the live scoring service (src/service/app.py). Reached via CORS
// (not a Vite dev proxy) -- see src/service/app.py's module docstring for why.
// Base URL is overridable via VITE_SERVICE_BASE_URL (e.g. a deployed service
// URL); defaults to the documented local port, 8100.
import type {
  ActivityItem,
  AircraftIndexRow,
  AircraftOverview,
  Alert,
  ComponentHistory,
  DriftHistory,
  FleetRiskItem,
  ModelVersionMetrics,
  RetrainJob,
  ComponentFeatures,
  CopilotAutomation,
  CopilotMeta,
  CopilotPendingItem,
  CopilotRunDetail,
  CopilotRunSummary,
  DriftReport,
  FleetPageResponse,
  FleetRiskResponse,
  FleetScanResult,
  HealthResponse,
  KbDocSummary,
  KbSearchHit,
  ModelCardResponse,
  PerformanceReport,
  RegistryStatus,
  ReliabilityKpis,
  ScoreResponse,
  WorkOrder,
} from "../types";
import { getCurrentUser } from "./identity";

export const SERVICE_BASE_URL: string =
  (import.meta.env.VITE_SERVICE_BASE_URL as string | undefined) ?? "http://localhost:8100";

export class ServiceUnreachableError extends Error {
  constructor(cause: unknown) {
    super(
      `Could not reach the scoring service at ${SERVICE_BASE_URL}. Start it with ` +
        "`uvicorn src.service.app:app --port 8100` from mro-predictive-maintenance/, then reload.",
    );
    this.name = "ServiceUnreachableError";
    console.debug("ServiceUnreachableError cause:", cause);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${SERVICE_BASE_URL}${path}`, init);
  } catch (err) {
    throw new ServiceUnreachableError(err);
  }
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`${response.status} ${response.statusText}: ${body}`);
  }
  return (await response.json()) as T;
}

export function getHealth(): Promise<HealthResponse> {
  return request<HealthResponse>("/health");
}

export function getModelCard(): Promise<ModelCardResponse> {
  return request<ModelCardResponse>("/model-card");
}

export function getFleetTopRisk(n: number): Promise<FleetRiskResponse> {
  return request<FleetRiskResponse>(`/fleet/top-risk?n=${n}`);
}

export interface FleetPageQuery {
  offset?: number;
  limit?: number;
  band?: string;
  componentType?: string;
  q?: string;
  sort?: string;
  dir?: "asc" | "desc";
}

/** The whole scored fleet, filtered, sorted and paginated server-side. */
export function getFleetPage(query: FleetPageQuery = {}): Promise<FleetPageResponse> {
  const params = new URLSearchParams();
  if (query.offset) params.set("offset", String(query.offset));
  if (query.limit) params.set("limit", String(query.limit));
  if (query.band && query.band !== "all") params.set("band", query.band);
  if (query.componentType && query.componentType !== "all") params.set("component_type", query.componentType);
  if (query.q) params.set("q", query.q);
  if (query.sort) params.set("sort", query.sort);
  if (query.dir) params.set("dir", query.dir);
  const qs = params.toString();
  return request<FleetPageResponse>(`/fleet/components${qs ? `?${qs}` : ""}`);
}

/** One scored component (with features). 404 when it is not in the scored fleet. */
export function getFleetComponent(componentId: string): Promise<FleetRiskItem> {
  return request<FleetRiskItem>(`/fleet/components/${encodeURIComponent(componentId)}`);
}

export function scoreComponent(
  features: ComponentFeatures,
  componentId?: string,
): Promise<ScoreResponse> {
  return request<ScoreResponse>("/score", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...features, component_id: componentId ?? null }),
  });
}

// ---------------------------------------------------------------------------
// Ops domain: /ops/*
// ---------------------------------------------------------------------------

/** `X-User` is read fresh on every call (never cached at module load) so the
 * header picker's selection (persisted via `lib/identity.ts`) takes effect
 * immediately on the very next request -- the fix for `approved_by` always
 * being the hard-coded literal `"dashboard.user"` regardless of who was
 * actually at the keyboard. */
function authHeaders(): { "Content-Type": string; "X-User": string } {
  return { "Content-Type": "application/json", "X-User": getCurrentUser() };
}

export function fleetScan(windowDays = 30): Promise<FleetScanResult> {
  return request<FleetScanResult>("/ops/fleet-scan", {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ window_days: windowDays }),
  });
}

export function listAlerts(status?: string, aircraftId?: string): Promise<Alert[]> {
  const params = new URLSearchParams();
  if (status) params.set("status", status);
  if (aircraftId) params.set("aircraft_id", aircraftId);
  const qs = params.toString();
  return request<Alert[]>(`/ops/alerts${qs ? `?${qs}` : ""}`);
}

export function getAlert(alertId: number): Promise<Alert> {
  return request<Alert>(`/ops/alerts/${alertId}`);
}

export function transitionAlert(
  alertId: number,
  action: string,
  note?: string,
): Promise<Alert> {
  return request<Alert>(`/ops/alerts/${alertId}/transition`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ action, note: note ?? null }),
  });
}

export function listWorkOrders(status?: string, aircraftId?: string): Promise<WorkOrder[]> {
  const params = new URLSearchParams();
  if (status) params.set("status", status);
  if (aircraftId) params.set("aircraft_id", aircraftId);
  const qs = params.toString();
  return request<WorkOrder[]>(`/ops/work-orders${qs ? `?${qs}` : ""}`);
}

export function createWorkOrder(body: {
  aircraft_id: string;
  component_id: string;
  approved_by: string;
  alert_id?: number | null;
  task_ref?: string | null;
  priority?: string;
  notes?: string | null;
}): Promise<WorkOrder> {
  return request<WorkOrder>("/ops/work-orders", {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(body),
  });
}

export function closeWorkOrder(
  woId: string,
  outcome: string,
  notes?: string,
): Promise<WorkOrder> {
  return request<WorkOrder>(`/ops/work-orders/${woId}/close`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ outcome, notes: notes ?? null }),
  });
}

export function getAircraft(aircraftId: string): Promise<AircraftOverview> {
  return request<AircraftOverview>(`/ops/aircraft/${aircraftId}`);
}

export function setAircraftStatus(
  aircraftId: string,
  status: string,
  melItem?: string,
  reason?: string,
): Promise<AircraftStatusResponse> {
  return request<AircraftStatusResponse>(`/ops/aircraft/${aircraftId}/status`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ status, mel_item: melItem ?? null, reason: reason ?? null }),
  });
}
type AircraftStatusResponse = Record<string, unknown>;

export function listAircraft(): Promise<AircraftIndexRow[]> {
  return request<AircraftIndexRow[]>("/ops/aircraft");
}

export function getComponentHistory(componentId: string): Promise<ComponentHistory> {
  return request<ComponentHistory>(`/ops/components/${encodeURIComponent(componentId)}/history`);
}

export function getActivity(limit = 20): Promise<ActivityItem[]> {
  return request<ActivityItem[]>(`/ops/activity?limit=${limit}`);
}

export function getReliability(): Promise<ReliabilityKpis> {
  return request<ReliabilityKpis>("/ops/reliability");
}

// ---------------------------------------------------------------------------
// Monitoring / registry: /monitoring/*, /models
// ---------------------------------------------------------------------------

export function getDrift(windowDays = 30, simulate?: "shift"): Promise<DriftReport> {
  const params = new URLSearchParams({ window_days: String(windowDays) });
  if (simulate) params.set("simulate", simulate);
  return request<DriftReport>(`/monitoring/drift?${params.toString()}`);
}

export function getPerformance(): Promise<PerformanceReport> {
  return request<PerformanceReport>("/monitoring/performance");
}

export function getRegistryStatus(): Promise<RegistryStatus> {
  return request<RegistryStatus>("/models");
}

export function getDriftHistory(windowDays = 30, points = 50): Promise<DriftHistory> {
  return request<DriftHistory>(`/monitoring/drift/history?window_days=${windowDays}&points=${points}`);
}

export function getModelMetrics(version: string | number): Promise<ModelVersionMetrics> {
  return request<ModelVersionMetrics>(`/models/${encodeURIComponent(String(version))}/metrics`);
}

/** Lead engineer only (403 otherwise). 409 while another job is running. */
export function startRetrain(body: { promote_if_better: boolean; seed?: number | null }): Promise<RetrainJob> {
  return request<RetrainJob>("/models/retrain", {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(body),
  });
}

export function getRetrainJob(runId: string): Promise<RetrainJob> {
  return request<RetrainJob>(`/models/retrain/${encodeURIComponent(runId)}`);
}

// ---------------------------------------------------------------------------
// Copilot: /copilot/*
// ---------------------------------------------------------------------------

export function getCopilotMeta(): Promise<CopilotMeta> {
  return request<CopilotMeta>("/copilot/meta");
}

export function listCopilotRuns(status?: string): Promise<CopilotRunSummary[]> {
  const qs = status ? `?status=${encodeURIComponent(status)}` : "";
  return request<CopilotRunSummary[]>(`/copilot/runs${qs}`);
}

export function getCopilotRun(runId: string): Promise<CopilotRunDetail> {
  return request<CopilotRunDetail>(`/copilot/runs/${runId}`);
}

export function startCopilotRun(prompt: string, alertId?: number): Promise<{ run_id: string }> {
  return request<{ run_id: string }>("/copilot/runs", {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ prompt, alert_id: alertId ?? null }),
  });
}

export function sendCopilotFollowUp(runId: string, prompt: string): Promise<{ run_id: string }> {
  return request<{ run_id: string }>(`/copilot/runs/${runId}/messages`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ prompt }),
  });
}

export interface CopilotResolution {
  pending_id: string;
  decision: "approve" | "deny" | "answer";
  override_args?: Record<string, unknown> | null;
  answer_text?: string | null;
  option_id?: string | null;
}

export function resolveCopilotRun(
  runId: string,
  resolutions: CopilotResolution[],
): Promise<{ run_id: string }> {
  return request<{ run_id: string }>(`/copilot/runs/${runId}/resolve`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ resolutions }),
  });
}

export function cancelCopilotRun(runId: string): Promise<{ run_id: string; status: string }> {
  return request<{ run_id: string; status: string }>(`/copilot/runs/${runId}/cancel`, {
    method: "POST",
    headers: authHeaders(),
  });
}

export function getGlobalPending(): Promise<CopilotPendingItem[]> {
  return request<CopilotPendingItem[]>("/copilot/pending");
}

export function listAutomations(): Promise<CopilotAutomation[]> {
  return request<CopilotAutomation[]>("/copilot/automations");
}

export function setAutomationEnabled(id: number, enabled: boolean): Promise<CopilotAutomation> {
  return request<CopilotAutomation>(`/copilot/automations/${id}`, {
    method: "PATCH",
    headers: authHeaders(),
    body: JSON.stringify({ enabled }),
  });
}

export function copilotFleetScan(windowDays = 30): Promise<{
  scored: number;
  new_alerts: number[];
  existing: number;
  automation_runs: { automation_id: number; alert_id: number; run_id: string }[];
}> {
  return request(`/copilot/fleet-scan`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ window_days: windowDays }),
  });
}

/** SSE events URL for a run -- consumed via EventSource in useCopilotStream,
 * not via the generic `request()` helper (streaming body, not JSON).
 * `lastEventId` (when > 0) is forwarded as `?last_event_id=` so a
 * reconnect on the SAME run (e.g. after a resolve/follow-up schedules a
 * new turn) replays only events the client hasn't already seen -- a plain
 * `new EventSource(url)` never sends the browser's automatic
 * `Last-Event-ID` header (that only happens on the browser's own
 * auto-retry of the SAME connection), so without this the server's replay
 * would resend the PREVIOUS turn's already-seen terminal `run_status`
 * event first, and the client would treat that stale event as the new
 * turn's completion and close the stream before the real new events ever
 * arrive. */
export function copilotEventsUrl(runId: string, lastEventId = 0): string {
  const qs = lastEventId > 0 ? `?last_event_id=${lastEventId}` : "";
  return `${SERVICE_BASE_URL}/copilot/runs/${runId}/events${qs}`;
}

// ---------------------------------------------------------------------------
// KB: /kb, /kb/search
// ---------------------------------------------------------------------------

export function listKbDocs(): Promise<KbDocSummary[]> {
  return request<KbDocSummary[]>("/kb");
}

export function getKbDoc(docId: string): Promise<KbDocSummary> {
  return request<KbDocSummary>(`/kb/${encodeURIComponent(docId)}`);
}

export function searchKb(
  query: string,
  k = 5,
  componentType?: string,
  docType?: string,
): Promise<KbSearchHit[]> {
  return request<KbSearchHit[]>("/kb/search", {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({
      query,
      k,
      component_type: componentType ?? null,
      doc_type: docType ?? null,
    }),
  });
}
