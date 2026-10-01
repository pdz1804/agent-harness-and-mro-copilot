import { useEffect, useState } from "react";
import { getHealth } from "../lib/api";

export interface HealthState {
  online: boolean | null;
  label: string;
}

/** Polls GET /health so the shell can say, at a glance, whether the scoring
 * service is reachable and which model version is serving. */
export function useHealth(intervalMs = 30_000): HealthState {
  const [state, setState] = useState<HealthState>({ online: null, label: "Checking service" });

  useEffect(() => {
    let cancelled = false;
    const poll = () => {
      getHealth()
        .then((h) => {
          if (cancelled) return;
          setState({
            online: h.model_loaded,
            label: h.model_loaded
              ? `${h.model_id ?? "model"}${h.model_version ? ` v${h.model_version}` : ""}`
              : "Model not loaded",
          });
        })
        .catch(() => {
          if (!cancelled) setState({ online: false, label: "Service offline" });
        });
    };
    poll();
    const id = setInterval(poll, intervalMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [intervalMs]);

  return state;
}
