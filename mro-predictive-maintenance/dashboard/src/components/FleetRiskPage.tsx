import { useEffect, useState } from "react";
import { getFleetTopRisk } from "../lib/api";
import { ServiceStatusBanner } from "./ServiceStatusBanner";
import { StatusBadge } from "./StatusBadge";
import { formatDecimal, formatPct } from "../lib/format";
import type { FleetRiskResponse } from "../types";

const FLEET_SIZE = 30;

/** Fleet risk page: GET /fleet/top-risk, scored live against the held-out
 * test split's most recent snapshot per component -- every row here is a
 * real model call against the deployed pipeline, not a copy of reports/. */
export function FleetRiskPage() {
  const [data, setData] = useState<FleetRiskResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getFleetTopRisk(FLEET_SIZE)
      .then((resp) => {
        if (!cancelled) setData(resp);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section className="section">
      <div className="section__heading">
        <h2 className="section__title">Fleet risk</h2>
        <span className="section__note">
          live scored, top {FLEET_SIZE} of {data?.n_scored ?? "?"} active test-split components
        </span>
      </div>

      {loading && <p className="section__note">Scoring the fleet...</p>}
      {error && <ServiceStatusBanner message={error} />}

      {data && (
        <div className="panel">
          <table className="data-table">
            <thead>
              <tr>
                <th>Component</th>
                <th>Aircraft</th>
                <th>Type</th>
                <th>Cycle</th>
                <th>Risk score</th>
                <th>Alert</th>
                <th>Actual outcome</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((item) => (
                <tr key={item.component_id}>
                  <td className="mono">{item.component_id}</td>
                  <td className="mono">{item.aircraft_id}</td>
                  <td>{item.component_type}</td>
                  <td className="mono">{formatDecimal(item.cycle, 1)}</td>
                  <td className="mono">{formatPct(item.risk_score, 3)}</td>
                  <td>
                    <StatusBadge tone={item.alert ? "bad" : "neutral"}>
                      {item.alert ? `alert (>= ${formatPct(data.threshold)})` : "no alert"}
                    </StatusBadge>
                  </td>
                  <td>
                    {item.true_label === 1 ? (
                      <span style={{ color: "var(--status-bad-fg)" }}>unscheduled removal</span>
                    ) : (
                      <span className="section__note">no removal in window</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
