import { useEffect, useMemo, useState } from "react";
import { getModelCard, scoreComponent } from "../lib/api";
import { getWholeFleet } from "../lib/fleet-cache";
import { useAsync } from "../hooks/useAsync";
import { formatPct, formatSignedDecimal, humanizeFeatureName } from "../lib/format";
import { hrefFor } from "../lib/routes";
import { Button, ButtonLink, Chip, PageHead, Panel } from "../components/ui/primitives";
import { FactorBars, RiskMeter } from "../components/ui/widgets";
import { EmptyState, LoadingRows, ServiceStatusBanner } from "../components/ui/states";
import type { ComponentFeatures, ScoreResponse } from "../types";

const PICKER_SIZE = 60;
const SENSOR = ["vibration_mm_s", "temperature_delta_c", "pressure_delta_psi", "current_draw_amp", "stroke_time_s", "airflow_cfm"];
const HISTORY = ["fault_count_last_500cyc", "fault_count_last_1500cyc", "max_severity_last_500cyc", "cycles_since_last_check", "check_count_last_1500cyc"];

function sameValue(a: unknown, b: unknown): boolean {
  return (a ?? null) === (b ?? null);
}

/** What-if scoring: pick a real component, edit its sensor and history
 * values, compare live risk and SHAP factors against its own baseline. Both
 * scores come from POST /score on the deployed model. */
export function WhatIfPage({ componentId }: { componentId?: string }) {
  const boot = useAsync(async () => {
    const [card, fleet] = await Promise.all([getModelCard(), getWholeFleet()]);
    return { card, fleet };
  }, []);

  const [selectedId, setSelectedId] = useState<string>("");
  const [features, setFeatures] = useState<ComponentFeatures>({});
  const [baseline, setBaseline] = useState<ScoreResponse | null>(null);
  const [scenario, setScenario] = useState<ScoreResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fleet = boot.data?.fleet;
  const card = boot.data?.card;

  const picker = useMemo(() => {
    const items = fleet?.items ?? [];
    const top = items.slice(0, PICKER_SIZE);
    const routed = componentId ? items.find((i) => i.component_id === componentId) : undefined;
    return routed && !top.includes(routed) ? [routed, ...top] : top;
  }, [fleet, componentId]);

  const selected = picker.find((i) => i.component_id === selectedId);

  useEffect(() => {
    if (!fleet || selectedId) return;
    const start = (componentId && picker.find((i) => i.component_id === componentId)) || picker[0];
    if (start) setSelectedId(start.component_id);
  }, [fleet, picker, componentId, selectedId]);

  useEffect(() => {
    if (!selected) return;
    let cancelled = false;
    setFeatures(selected.features);
    setScenario(null);
    setBaseline(null);
    setError(null);
    scoreComponent(selected.features, selected.component_id)
      .then((r) => !cancelled && setBaseline(r))
      .catch((err: unknown) => !cancelled && setError(err instanceof Error ? err.message : String(err)));
    return () => {
      cancelled = true;
    };
  }, [selected]);

  const categoricalOptions = useMemo(() => {
    const options: Record<string, Set<string>> = {};
    for (const field of card?.categorical_features ?? []) options[field] = new Set();
    for (const item of fleet?.items ?? []) {
      for (const field of card?.categorical_features ?? []) {
        const v = item.features[field];
        if (typeof v === "string") options[field].add(v);
      }
    }
    return options;
  }, [fleet, card]);

  const baselineFeatures = selected?.features ?? {};
  const changed = Object.keys(features).filter((k) => !sameValue(features[k], baselineFeatures[k]));

  const setField = (field: string, raw: string, numeric: boolean) => {
    setFeatures((prev) => ({ ...prev, [field]: numeric ? (raw === "" ? null : Number(raw)) : raw }));
    setScenario(null);
  };

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      setScenario(await scoreComponent(features, selectedId || undefined));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const reset = () => {
    if (selected) setFeatures(selected.features);
    setScenario(null);
  };

  const delta = scenario && baseline ? scenario.risk_score - baseline.risk_score : null;

  const factorRows = useMemo(() => {
    if (!scenario || !baseline) return [];
    const map = new Map<string, { base: number; what: number }>();
    for (const f of baseline.top_factors) map.set(f.feature, { base: f.shap_value, what: 0 });
    for (const f of scenario.top_factors) map.set(f.feature, { base: map.get(f.feature)?.base ?? 0, what: f.shap_value });
    return [...map.entries()].map(([feature, v]) => ({ feature, ...v, d: v.what - v.base })).sort((a, b) => Math.abs(b.d) - Math.abs(a.d));
  }, [scenario, baseline]);

  const renderNumeric = (field: string) => (
    <label key={field} className="field">
      <span className="field-label">{humanizeFeatureName(field)}</span>
      <input
        className={`input${sameValue(features[field], baselineFeatures[field]) ? "" : " is-changed"}`}
        type="number"
        inputMode="decimal"
        name={field}
        autoComplete="off"
        step="any"
        value={features[field] ?? ""}
        placeholder="missing"
        onChange={(e) => setField(field, e.target.value, true)}
      />
    </label>
  );

  return (
    <div className="page">
      <PageHead
        crumbs={[{ label: "Model" }, { label: "What-if" }]}
        title="What-if scoring"
        description="Edit a component's sensor values and see the live risk and factor shift versus its baseline."
        actions={selected && <ButtonLink href={hrefFor(`ops/component/${selected.component_id}`)}>Open component</ButtonLink>}
      />
      {boot.error && <ServiceStatusBanner message={boot.error} onRetry={boot.reload} />}
      {boot.loading && !boot.data && <LoadingRows rows={6} height={32} label="Loading components…" />}

      {card && fleet && (
        <>
          <Panel>
            <label className="field" style={{ maxWidth: 520 }}>
              <span className="field-label">Start from a real component (loads its latest snapshot as the baseline)</span>
              <select id="whatif-picker" className="select" style={{ width: "100%" }} value={selectedId} onChange={(e) => setSelectedId(e.target.value)}>
                {picker.map((item) => (
                  <option key={item.component_id} value={item.component_id}>
                    {item.component_id} (cycle {item.cycle.toFixed(0)}, risk {formatPct(item.risk_score, 1)})
                  </option>
                ))}
              </select>
            </label>
          </Panel>

          <div className="grid-main-side" style={{ gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)" }}>
            <Panel
              title="Edit the inputs"
              sub="Changed fields are highlighted. Clear a number to send it as missing."
              actions={<Chip tone={changed.length > 0 ? "info" : "neutral"} icon={null}>{changed.length} changed</Chip>}
            >
              <div className="form-section">
                <h3 className="form-section-title">Sensors</h3>
                <div className="form-grid">{SENSOR.filter((f) => card.numeric_features.includes(f)).map(renderNumeric)}</div>
              </div>
              <div className="form-section">
                <h3 className="form-section-title">Fault and inspection history</h3>
                <div className="form-grid">{HISTORY.filter((f) => card.numeric_features.includes(f)).map(renderNumeric)}</div>
              </div>
              <div className="form-section">
                <h3 className="form-section-title">Component and aircraft context</h3>
                <div className="form-grid">
                  {card.numeric_features.filter((f) => !SENSOR.includes(f) && !HISTORY.includes(f)).map(renderNumeric)}
                  {card.categorical_features.map((field) => (
                    <label key={field} className="field">
                      <span className="field-label">{humanizeFeatureName(field)}</span>
                      <select
                        className={`select${sameValue(features[field], baselineFeatures[field]) ? "" : " is-changed"}`}
                        style={{ width: "100%" }}
                        value={(features[field] as string) ?? ""}
                        onChange={(e) => setField(field, e.target.value, false)}
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
              </div>
              <div className="form-actions">
                <Button variant="primary" onClick={run} loading={busy} disabled={changed.length === 0}>
                  {busy ? "Scoring…" : "Run what-if"}
                </Button>
                <Button onClick={reset} disabled={changed.length === 0}>
                  Reset to baseline
                </Button>
                <span className="muted">POST /score, live</span>
              </div>
              {error && (
                <div style={{ marginTop: 12 }}>
                  <ServiceStatusBanner message={error} />
                </div>
              )}
            </Panel>

            <Panel title="Result">
              <div aria-live="polite" className="stack">
                {!baseline && !error && <LoadingRows rows={3} height={40} label="Scoring baseline…" />}
                {baseline && (
                  <>
                    <div className="statbar" role="group" aria-label="Baseline against what-if">
                      <div className="stat">
                        <div className="stat-label">Baseline</div>
                        <div className="stat-value">{formatPct(baseline.risk_score, 1)}</div>
                        <div className="stat-sub">{baseline.alert ? <Chip tone="bad">alert</Chip> : <Chip tone="good">no alert</Chip>}</div>
                      </div>
                      <div className="stat">
                        <div className="stat-label">What-if</div>
                        <div className="stat-value">{scenario ? formatPct(scenario.risk_score, 1) : "…"}</div>
                        <div className="stat-sub">{scenario ? scenario.alert ? <Chip tone="bad">alert</Chip> : <Chip tone="good">no alert</Chip> : "not run yet"}</div>
                      </div>
                      <div className="stat">
                        <div className="stat-label">Change</div>
                        <div className="stat-value">{delta === null ? "…" : `${delta > 0 ? "+" : delta < 0 ? "−" : ""}${Math.abs(delta * 100).toFixed(1)} pp`}</div>
                        <div className="stat-sub">{scenario && scenario.alert !== baseline.alert ? <Chip tone="warn">alert decision flips</Chip> : " "}</div>
                      </div>
                    </div>

                    <div className="stack" style={{ gap: 8 }}>
                      <div>
                        <div className="field-label">Baseline</div>
                        <RiskMeter score={baseline.risk_score} threshold={baseline.threshold} large />
                      </div>
                      {scenario && (
                        <div>
                          <div className="field-label">What-if</div>
                          <RiskMeter score={scenario.risk_score} threshold={scenario.threshold} large />
                        </div>
                      )}
                      <p className="muted">Dark notch = alert threshold {formatPct(baseline.threshold, 2)}.</p>
                    </div>

                    {!scenario && <EmptyState title="Change a value, then run what-if">The baseline factors are shown below until you do.</EmptyState>}

                    {scenario && factorRows.length > 0 && (
                      <div className="table-scroll">
                        <table className="dt" aria-label="How the factors moved">
                          <thead>
                            <tr>
                              <th scope="col">Factor (SHAP)</th>
                              <th scope="col" className="num">Baseline</th>
                              <th scope="col" className="num">What-if</th>
                              <th scope="col" className="num">Delta</th>
                            </tr>
                          </thead>
                          <tbody>
                            {factorRows.map((r) => (
                              <tr key={r.feature}>
                                <td>{humanizeFeatureName(r.feature)}</td>
                                <td className="num">{formatSignedDecimal(r.base)}</td>
                                <td className="num">{formatSignedDecimal(r.what)}</td>
                                <td className="num" style={{ color: r.d > 0 ? "var(--bad)" : "var(--accent-ink)", fontWeight: 600 }}>
                                  {r.d > 0 ? "▲ " : "▼ "}
                                  {formatSignedDecimal(r.d)}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}

                    {!scenario && (
                      <div>
                        <h3 className="form-section-title">Baseline factors ({baseline.explanation_method.toUpperCase()})</h3>
                        <FactorBars factors={baseline.top_factors.map((f) => ({ feature: f.feature, value: f.shap_value }))} />
                      </div>
                    )}
                  </>
                )}
              </div>
            </Panel>
          </div>
        </>
      )}
    </div>
  );
}
