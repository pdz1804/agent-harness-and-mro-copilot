// Client for the live scoring service (src/service/app.py). Reached via CORS
// (not a Vite dev proxy) -- see src/service/app.py's module docstring for why.
// Base URL is overridable via VITE_SERVICE_BASE_URL (e.g. a deployed service
// URL); defaults to the documented local port, 8100.
import type {
  ComponentFeatures,
  FleetRiskResponse,
  HealthResponse,
  ModelCardResponse,
  ScoreResponse,
} from "../types";

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
