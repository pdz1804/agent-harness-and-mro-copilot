import { getFleetTopRisk } from "./api";
import type { FleetRiskResponse } from "../types";

/** Detail pages need one component's latest features, which only
 * `GET /fleet/top-risk` returns. Ask for the whole scored fleet once and
 * share it for a short window, so opening several components in a row costs
 * one request, not one each. */
const WHOLE_FLEET = 500;
const TTL_MS = 30_000;

let cached: { at: number; promise: Promise<FleetRiskResponse> } | null = null;

export function getWholeFleet(): Promise<FleetRiskResponse> {
  const now = Date.now();
  if (cached && now - cached.at < TTL_MS) return cached.promise;
  const promise = getFleetTopRisk(WHOLE_FLEET);
  cached = { at: now, promise };
  promise.catch(() => {
    if (cached?.promise === promise) cached = null;
  });
  return promise;
}

export function clearFleetCache(): void {
  cached = null;
}
