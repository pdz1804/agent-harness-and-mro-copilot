import { useEffect, useMemo, useState } from "react";
import { getFleetTopRisk, getModelCard, scoreComponent } from "../lib/api";
import { ServiceStatusBanner } from "./ServiceStatusBanner";
import { StatusBadge } from "./StatusBadge";
import { formatSignedDecimal, formatPct, humanizeFeatureName } from "../lib/format";
import type { ComponentFeatures, FleetRiskItem, ModelCardResponse, ScoreResponse } from "../types";

const PICKER_SIZE = 50;

function ShapBar({ feature, shapValue, maxAbs }: { feature: string; shapValue: number; maxAbs: number }) {
  const widthPct = maxAbs === 0 ? 0 : (Math.abs(shapValue) / maxAbs) * 100;
  const positive = shapValue >= 0;
  return (
    <div className="factor-row">
      <div>
        <div className="factor-row__name">{humanizeFeatureName(feature)}</div>
        <div className="factor-bar-track">
          <div
            className="factor-bar-fill"
            style={{
              width: `${widthPct}%`,
              left: positive ? "0" : undefined,
              right: positive ? undefined : "0",
              background: positive ? "var(--status-bad-fg)" : "var(--series-lr)",
            }}
          />
        </div>
      </div>
      <div className="factor-row__value">{formatSignedDecimal(shapValue)}</div>
    </div>
  );
}

/** Live scoring page: pick a real fleet component (prefills the form from
 * GET /fleet/top-risk) or hand-edit the feature values, then POST /score
 * against the deployed model, live -- score, alert decision, and SHAP
 * factors are all computed by the service on this request, not looked up
 * from a static report. */
export function LiveScoringPage() {
  const [modelCard, setModelCard] = useState<ModelCardResponse | null>(null);
  const [fleet, setFleet] = useState<FleetRiskItem[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedComponentId, setSelectedComponentId] = useState<string>("");
  const [features, setFeatures] = useState<ComponentFeatures>({});
  const [result, setResult] = useState<ScoreResponse | null>(null);
  const [scoring, setScoring] = useState(false);
  const [scoreError, setScoreError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([getModelCard(), getFleetTopRisk(PICKER_SIZE)])
      .then(([card, fleetResp]) => {
        if (cancelled) return;
        setModelCard(card);
        setFleet(fleetResp.items);
        if (fleetResp.items.length > 0) {
          setSelectedComponentId(fleetResp.items[0].component_id);
          setFeatures(fleetResp.items[0].features);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const categoricalOptions = useMemo(() => {
    const options: Record<string, Set<string>> = {};
    for (const field of modelCard?.categorical_features ?? []) options[field] = new Set();
    for (const item of fleet) {
      for (const field of modelCard?.categorical_features ?? []) {
        const value = item.features[field];
        if (typeof value === "string") options[field].add(value);
      }
    }
    return options;
  }, [fleet, modelCard]);

  function handlePickComponent(componentId: string) {
    setSelectedComponentId(componentId);
    const item = fleet.find((f) => f.component_id === componentId);
    if (item) setFeatures(item.features);
    setResult(null);
    setScoreError(null);
  }

  function handleFieldChange(field: string, rawValue: string, isNumeric: boolean) {
    setFeatures((prev) => ({
      ...prev,
      [field]: isNumeric ? (rawValue === "" ? null : Number(rawValue)) : rawValue,
    }));
  }

  async function handleSubmit() {
    setScoring(true);
    setScoreError(null);
    try {
      const resp = await scoreComponent(features, selectedComponentId || undefined);
      setResult(resp);
    } catch (err) {
      setScoreError(err instanceof Error ? err.message : String(err));
    } finally {
      setScoring(false);
    }
  }

  if (loadError) {
    return (
      <section className="section">
        <div className="section__heading">
          <h2 className="section__title">Live scoring</h2>
        </div>
        <ServiceStatusBanner message={loadError} />
      </section>
    );
  }

  if (!modelCard) {
    return (
      <section className="section">
        <div className="section__heading">
          <h2 className="section__title">Live scoring</h2>
        </div>
        <p className="section__note">Loading model card and fleet list...</p>
      </section>
    );
  }

  const maxAbsFactor = Math.max(
    ...(result?.top_factors.map((f) => Math.abs(f.shap_value)) ?? [1e-9]),
    1e-9,
  );

  return (
    <section className="section">
      <div className="section__heading">
        <h2 className="section__title">Live scoring</h2>
        <span className="section__note">
          {modelCard.model_id} &middot; threshold {modelCard.threshold.toFixed(4)}
        </span>
      </div>

      <div className="panel" style={{ marginBottom: 16 }}>
        <label style={{ display: "block", marginBottom: 6, fontSize: 12, color: "var(--text-secondary)" }}>
          Pick a fleet component (prefills the form below from its real latest snapshot)
        </label>
        <select
          value={selectedComponentId}
          onChange={(e) => handlePickComponent(e.target.value)}
          style={{
            width: "100%",
            padding: "8px 10px",
            background: "var(--bg-elevated)",
            border: "1px solid var(--panel-border-strong)",
            borderRadius: "var(--radius-sm)",
            color: "var(--text-primary)",
            fontFamily: "var(--font-mono)",
            fontSize: 12.5,
          }}
        >
          {fleet.map((item) => (
            <option key={item.component_id} value={item.component_id}>
              {item.component_id} (cycle {item.cycle.toFixed(0)}, risk {item.risk_score.toFixed(3)})
            </option>
          ))}
        </select>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <div className="panel">
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            {modelCard.numeric_features.map((field) => (
              <label key={field} style={{ fontSize: 11.5 }}>
                <div style={{ color: "var(--text-tertiary)", marginBottom: 3 }}>
                  {humanizeFeatureName(field)}
                </div>
                <input
                  type="number"
                  step="any"
                  value={features[field] ?? ""}
                  placeholder="missing"
                  onChange={(e) => handleFieldChange(field, e.target.value, true)}
                  style={{
                    width: "100%",
                    padding: "6px 8px",
                    background: "var(--bg-elevated)",
                    border: "1px solid var(--panel-border)",
                    borderRadius: "var(--radius-sm)",
                    color: "var(--text-primary)",
                    fontFamily: "var(--font-mono)",
                  }}
                />
              </label>
            ))}
            {modelCard.categorical_features.map((field) => (
              <label key={field} style={{ fontSize: 11.5 }}>
                <div style={{ color: "var(--text-tertiary)", marginBottom: 3 }}>
                  {humanizeFeatureName(field)}
                </div>
                <select
                  value={(features[field] as string) ?? ""}
                  onChange={(e) => handleFieldChange(field, e.target.value, false)}
                  style={{
                    width: "100%",
                    padding: "6px 8px",
                    background: "var(--bg-elevated)",
                    border: "1px solid var(--panel-border)",
                    borderRadius: "var(--radius-sm)",
                    color: "var(--text-primary)",
                    fontFamily: "var(--font-mono)",
                  }}
                >
                  {[...categoricalOptions[field]].sort().map((v) => (
                    <option key={v} value={v}>
                      {v}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>
          <button
            onClick={handleSubmit}
            disabled={scoring}
            style={{
              marginTop: 14,
              padding: "8px 16px",
              background: "var(--accent-dim)",
              border: "1px solid var(--accent)",
              borderRadius: "var(--radius-sm)",
              color: "var(--accent-strong)",
              fontWeight: 600,
              cursor: scoring ? "wait" : "pointer",
            }}
          >
            {scoring ? "Scoring..." : "Score live"}
          </button>
          {scoreError && (
            <div style={{ marginTop: 10 }}>
              <ServiceStatusBanner message={scoreError} />
            </div>
          )}
        </div>

        <div className="panel">
          {!result && <p className="section__note">Submit the form to call POST /score live.</p>}
          {result && (
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
                <span className="risk-score-pill">{formatPct(result.risk_score, 3)}</span>
                <StatusBadge tone={result.alert ? "bad" : "good"}>
                  {result.alert ? "alert" : "no alert"}
                </StatusBadge>
                <span className="section__note">
                  threshold {formatPct(result.threshold)} &middot; {result.explanation_method}
                </span>
              </div>
              <div>
                {result.top_factors.map((f) => (
                  <ShapBar key={f.feature} feature={f.feature} shapValue={f.shap_value} maxAbs={maxAbsFactor} />
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
