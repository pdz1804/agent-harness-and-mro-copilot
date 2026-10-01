import { useEffect, useMemo, useState } from "react";
import { getAircraft, getComponentHistory, getFleetComponent, getFleetPage, getModelCard, listAlerts, listWorkOrders, scoreComponent, searchKb } from "../../lib/api";
import { useAsync } from "../../hooks/useAsync";
import { useUrlQuery } from "../../hooks/useHashRoute";
import { formatPct, formatSignedDecimal, humanizeFeatureName } from "../../lib/format";
import { BAND_LABEL, BAND_TONE } from "../../lib/fleet-list";
import { hrefFor } from "../../lib/routes";
import { ageLabel, alertTone, componentTypeFromId, humanizeType, riskBand, STAGE_LABEL } from "../../lib/risk";
import { historySummary, toLifeEvents, toRiskPoints } from "../../lib/history";
import { Button, ButtonLink, Chip, PageHead, Panel } from "../../components/ui/primitives";
import { FactorBars, RiskMeter, Segmented } from "../../components/ui/widgets";
import { CopyId, RelTime } from "../../components/ui/feedback";
import { SendIcon } from "../../components/ui/icons";
import { EmptyState, LoadingRows, Notice, ServiceStatusBanner } from "../../components/ui/states";
import { LifeTimeline, RiskHistoryChart } from "../../components/charts/charts";
import type { ComponentFeatures } from "../../types";

const SENSOR_KEYS = ["vibration_mm_s", "temperature_delta_c", "pressure_delta_psi", "current_draw_amp", "stroke_time_s", "airflow_cfm"];
const HISTORY_KEYS = ["fault_count_last_500cyc", "fault_count_last_1500cyc", "max_severity_last_500cyc", "cycles_since_last_check", "check_count_last_1500cyc"];
const CONTEXT_KEYS = ["component_age_cycles", "cumulative_flight_hours", "aircraft_age_years", "cycles_per_day", "avg_flight_hours_per_cycle", "aircraft_type", "region"];

function fmt(v: unknown): string {
  if (v === null || v === undefined) return "not reported";
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : v.toFixed(2);
  return String(v);
}

function SensorGroup({ title, keys, features }: { title: string; keys: string[]; features: ComponentFeatures }) {
  return (
    <div>
      <h3 className="form-section-title">{title}</h3>
      <dl className="kv is-compact">
        {keys.map((k) => {
          const missing = features[k] === null || features[k] === undefined;
          return (
            <div key={k} style={{ display: "contents" }}>
              <dt>{humanizeFeatureName(k)}</dt>
              <dd className={missing ? "muted" : "mono"}>{fmt(features[k])}</dd>
            </div>
          );
        })}
      </dl>
    </div>
  );
}

type ComponentTab = "overview" | "history" | "related" | "raw";
const TABS: ComponentTab[] = ["overview", "history", "related", "raw"];

interface Props {
  componentId: string | undefined;
  onAskCopilot: (prompt: string, alertId?: number, context?: string) => void;
}

/** One component: risk now against its threshold, the real per-scan risk
 * history and maintenance life (GET /ops/components/{id}/history), why it
 * scores this (live SHAP), its alerts and work orders, the sensor snapshot
 * and the procedures that apply. */
export function ComponentDetailPage({ componentId, onAskCopilot }: Props) {
  const id = componentId ?? "";
  const aircraftId = id.includes("-") ? id.slice(0, id.lastIndexOf("-")) : id;
  const type = componentTypeFromId(id);

  const core = useAsync(async () => {
    try {
      const [hit, card] = await Promise.all([getFleetComponent(id), getModelCard()]);
      return {
        threshold: card.threshold,
        riskScore: hit.risk_score,
        alert: hit.alert,
        features: hit.features,
        cycle: hit.cycle,
        snapshot: hit.snapshot_date,
        trueLabel: hit.true_label as number | null,
      };
    } catch (err) {
      // Not in the held-out fleet (404): fall back to its latest logged scan.
      if (!(err instanceof Error) || !/^404\b/.test(err.message)) throw err;
    }
    const overview = await getAircraft(aircraftId);
    const row = overview.components.find((c) => c.component_id === id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      threshold: Number(row.threshold),
      riskScore: Number(row.risk_score),
      alert: Boolean(row.alert),
      features: JSON.parse(String(row.features_json)) as ComponentFeatures,
      cycle: Number(row.cycle),
      snapshot: String(row.snapshot_date),
      trueLabel: null as number | null,
    };
  }, [id]);

  const why = useAsync(() => (core.data ? scoreComponent(core.data.features, id) : Promise.resolve(null)), [core.data, id]);
  const hist = useAsync(() => getComponentHistory(id), [id]);
  const work = useAsync(async () => {
    const [alerts, wos] = await Promise.all([listAlerts(undefined, aircraftId), listWorkOrders(undefined, aircraftId)]);
    return { alerts: alerts.filter((a) => a.component_id === id), wos: wos.filter((w) => w.component_id === id) };
  }, [id]);
  const kb = useAsync(() => searchKb(`${humanizeType(type)} inspection fault`, 4, type), [type]);
  const siblings = useAsync(() => getFleetPage({ q: aircraftId, limit: 20 }), [aircraftId]);
  const [query, setQuery] = useUrlQuery({ tab: "overview" });
  const tab: ComponentTab = TABS.includes(query.tab as ComponentTab) ? (query.tab as ComponentTab) : "overview";

  const c = core.data;
  const alerts = work.data?.alerts ?? [];
  const wos = work.data?.wos ?? [];
  const openAlert = alerts.find((a) => a.status !== "closed");
  const points = useMemo(() => toRiskPoints(hist.data?.predictions ?? []), [hist.data]);
  const lifeEvents = useMemo(() => toLifeEvents(hist.data?.maintenance_events ?? []), [hist.data]);
  const historyThreshold = points.length > 0 ? points[points.length - 1].threshold : c?.threshold ?? 0;

  const askPrompt = c
    ? `Tell me about component ${id} on aircraft ${aircraftId} (current risk score ${c.riskScore.toFixed(4)}). Should we raise a work order?`
    : `Tell me about component ${id}.`;
  const [draft, setDraft] = useState(askPrompt);
  // Re-seed the inline prompt when the component (or its first score) changes.
  useEffect(() => setDraft(askPrompt), [askPrompt]);
  const siblingRows = (siblings.data?.items ?? []).filter((r) => r.aircraft_id === aircraftId && r.component_id !== id);
  const rawJson = useMemo(
    () =>
      JSON.stringify(
        {
          component_id: id,
          scored: c && { risk_score: c.riskScore, threshold: c.threshold, alert: c.alert, cycle: c.cycle, snapshot_date: c.snapshot, true_label: c.trueLabel, features: c.features },
          explanation: why.data,
        },
        null,
        2,
      ),
    [id, c, why.data],
  );

  return (
    <div className="page">
      <PageHead
        crumbs={[{ label: "Fleet", href: hrefFor("ops/fleet") }, { label: aircraftId, href: hrefFor(`ops/aircraft/${aircraftId}`) }, { label: id }]}
        title={
          <span className="title-with-chips">
            <span className="mono break">{id}</span>
            {c && (
              <Chip tone={riskBand(c.riskScore, c.alert).tone}>
                {riskBand(c.riskScore, c.alert).label} · {formatPct(c.riskScore, 2)}
              </Chip>
            )}
          </span>
        }
        description={
          <>
            {humanizeType(type)} on {aircraftId}
            {c && (
              <span className="page-facts">
                <span>
                  Cycle <strong className="tnum">{Math.round(c.cycle)}</strong>
                </span>
                <span>
                  Snapshot <strong className="mono">{c.snapshot.split(" ")[0]}</strong>
                </span>
                <span>
                  Threshold <strong className="tnum">{formatPct(c.threshold, 2)}</strong>
                </span>
                {openAlert && (
                  <span>
                    Open alert <a href={hrefFor(`ops/alerts/${openAlert.id}`)}>#{openAlert.id}</a>
                  </span>
                )}
              </span>
            )}
          </>
        }
        actions={
          <>
            <ButtonLink href={hrefFor(`ops/aircraft/${aircraftId}`)}>Aircraft {aircraftId}</ButtonLink>
            <ButtonLink href={hrefFor(`model/what-if/${id}`)}>What-if</ButtonLink>
            {openAlert ? (
              <>
                <Button onClick={() => onAskCopilot(askPrompt)}>Ask copilot</Button>
                <ButtonLink variant="primary" href={hrefFor(`ops/alerts/${openAlert.id}`)}>
                  Work alert #{openAlert.id}
                </ButtonLink>
              </>
            ) : (
              <Button variant="primary" onClick={() => onAskCopilot(askPrompt)}>
                Ask copilot
              </Button>
            )}
          </>
        }
      />

      {core.error && <ServiceStatusBanner message={core.error} onRetry={core.reload} />}
      {core.loading && !c && <LoadingRows rows={5} height={40} label="Loading component…" />}
      {!core.loading && !core.error && !c && (
        <Panel>
          <EmptyState title="Component not found">
            <span className="mono break">{id}</span> is not in the scored fleet and has no logged prediction. Check the id, or{" "}
            <a href={hrefFor("ops/fleet")}>pick one from the Fleet</a>.
          </EmptyState>
        </Panel>
      )}

      {c && (
        <>
          <div className="row row-between">
            <Segmented<ComponentTab>
              label="Component sections"
              value={tab}
              onChange={(v) => setQuery({ tab: v })}
              options={[
                { id: "overview", label: "Overview" },
                { id: "history", label: "History", count: hist.data && work.data ? lifeEvents.length + alerts.length + wos.length : undefined },
                { id: "related", label: "Related", count: kb.data && siblings.data ? kb.data.length + siblingRows.length : undefined },
                { id: "raw", label: "Raw" },
              ]}
            />
          </div>

          {tab === "overview" && (
            <>
              <div className="grid-side-main">
                <Panel title="Risk now">
                  <div className="stack">
                    <div className="row row-between">
                      <span className="display" style={{ fontSize: "1.75rem", fontWeight: 650, fontVariantNumeric: "tabular-nums", lineHeight: 1.1 }}>
                        {formatPct(c.riskScore, 2)}
                      </span>
                      {c.alert ? <Chip tone="bad">Above threshold</Chip> : <Chip tone="good">Below threshold</Chip>}
                    </div>
                    <RiskMeter score={c.riskScore} threshold={c.threshold} hideValue large />
                    <dl className="kv">
                      <dt>Alert threshold</dt>
                      <dd>{formatPct(c.threshold, 2)}</dd>
                      <dt>Margin</dt>
                      <dd className="tnum">{formatSignedDecimal((c.riskScore - c.threshold) * 100, 2)} pts</dd>
                      <dt>Cycle</dt>
                      <dd>{Math.round(c.cycle)}</dd>
                      <dt>Snapshot</dt>
                      <dd className="mono">{c.snapshot.split(" ")[0]}</dd>
                      {c.trueLabel !== null && (
                        <>
                          <dt>Held-out label</dt>
                          <dd>{c.trueLabel === 1 ? "removed within 30 cycles" : "no removal in the window"}</dd>
                        </>
                      )}
                    </dl>
                    {work.data && !openAlert && c.alert && (
                      <Notice tone="warn">
                        Above threshold but no alert is open. A <a href={hrefFor("ops/fleet")}>fleet scan</a> raises it.
                      </Notice>
                    )}
                    {work.data && !openAlert && !c.alert && <p className="muted">Below threshold and no open alert. Nothing to do now.</p>}
                  </div>
                </Panel>

                <Panel title="Risk history" sub="One point per logged fleet scan, drawn against the alert threshold.">
                  {hist.loading && !hist.data && <LoadingRows rows={1} height={220} label="Loading risk history…" />}
                  {hist.error && <ServiceStatusBanner message={hist.error} onRetry={hist.reload} />}
                  {hist.data && points.length > 0 && (
                    <>
                      <RiskHistoryChart points={points} threshold={historyThreshold} />
                      <p className="muted" style={{ marginTop: 8 }}>
                        {historySummary(points)}
                      </p>
                    </>
                  )}
                  {hist.data && points.length === 0 && <EmptyState title="No scans logged for this component">{historySummary(points)}</EmptyState>}
                </Panel>
              </div>

              <div className="grid-2">
                <Panel title="Why it scores this" sub="Live SHAP from the deployed model.">
                  {why.loading && <LoadingRows rows={5} height={16} label="Explaining…" />}
                  {why.error && <ServiceStatusBanner message={why.error} onRetry={why.reload} />}
                  {why.data && <FactorBars factors={why.data.top_factors.map((f) => ({ feature: f.feature, value: f.shap_value }))} />}
                </Panel>

                <Panel title="Ask copilot" sub="Context is attached to the run.">
                  <form
                    className="stack"
                    onSubmit={(e) => {
                      e.preventDefault();
                      if (draft.trim()) onAskCopilot(draft.trim(), openAlert?.id, openAlert ? `Alert #${openAlert.id} · ${id}` : id);
                    }}
                  >
                    <div className="row" aria-label="Attached context">
                      <Chip plain icon={null}>
                        <span className="mono">{id}</span>
                      </Chip>
                      {openAlert && (
                        <Chip tone="warn" icon={null}>
                          alert #{openAlert.id}
                        </Chip>
                      )}
                      <Chip tone={riskBand(c.riskScore, c.alert).tone} icon={null}>
                        risk {formatPct(c.riskScore, 2)}
                      </Chip>
                    </div>
                    <textarea
                      className="textarea"
                      name="component-copilot-prompt"
                      aria-label="Question for the copilot"
                      rows={3}
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                    />
                    <div className="row row-between">
                      <span className="muted">Opens the copilot with this question; any action still needs approval.</span>
                      <Button type="submit" variant="primary" size="sm" disabled={!draft.trim()}>
                        <SendIcon />
                        Ask copilot
                      </Button>
                    </div>
                  </form>
                </Panel>
              </div>

              <Panel title="Sensor snapshot the model saw" sub="Latest reading per feature. “Not reported” means the sensor does not apply or dropped out.">
                <div className="grid-3">
                  <SensorGroup title="Sensors" keys={SENSOR_KEYS} features={c.features} />
                  <SensorGroup title="Fault and inspection history" keys={HISTORY_KEYS} features={c.features} />
                  <SensorGroup title="Component and aircraft context" keys={CONTEXT_KEYS} features={c.features} />
                </div>
              </Panel>
            </>
          )}

          {tab === "history" && (
            <>
              <Panel title="Maintenance life" sub="Checks and removals along this component's cycle count (maintenance_events).">
                {hist.error && <ServiceStatusBanner message={hist.error} onRetry={hist.reload} />}
                {hist.data && lifeEvents.length > 0 ? (
                  <LifeTimeline events={lifeEvents} currentCycle={c.cycle} />
                ) : hist.data ? (
                  <EmptyState title="No maintenance events recorded">The events log has nothing for this component.</EmptyState>
                ) : (
                  <LoadingRows rows={1} height={48} />
                )}
              </Panel>

              <div className="grid-2">
                <Panel title="Alerts and work orders" flush>
                  {work.loading && !work.data && <LoadingRows rows={3} height={32} />}
                  {work.error && (
                    <div style={{ padding: 16 }}>
                      <ServiceStatusBanner message={work.error} onRetry={work.reload} />
                    </div>
                  )}
                  {work.data && alerts.length === 0 && wos.length === 0 && (
                    <EmptyState title="Nothing raised yet">Alerts and work orders for this component will list here.</EmptyState>
                  )}
                  <div className="rows">
                    {alerts.map((a) => (
                      <a key={a.id} className="row-item" href={hrefFor(`ops/alerts/${a.id}`)}>
                        <Chip tone={alertTone(a.status)}>{STAGE_LABEL[a.status] ?? a.status}</Chip>
                        <span className="row-main">
                          <span className="row-title">Alert #{a.id}</span>
                          <span className="row-sub">opened {new Date(a.opened_at).toLocaleString()}</span>
                        </span>
                        <span className="row-end mono">{formatPct(a.risk_score, 1)}</span>
                      </a>
                    ))}
                    {wos.map((w) => (
                      <a key={w.id} className="row-item" href={hrefFor(`ops/work-orders/${w.id}`)}>
                        <Chip tone={w.status === "closed" ? "good" : "info"}>{w.status}</Chip>
                        <span className="row-main">
                          <span className="row-title mono">{w.id}</span>
                          <span className="row-sub">
                            {w.priority}
                            {w.outcome ? `, ${w.outcome.replace(/_/g, " ")}` : ""}
                          </span>
                        </span>
                        <span className="row-end muted">{ageLabel(w.created_at)}</span>
                      </a>
                    ))}
                  </div>
                </Panel>

                <Panel title="Scan log" sub="Every logged prediction for this component, newest first." flush>
                  {hist.data && hist.data.predictions.length === 0 && <EmptyState title="No scans logged">A fleet scan logs one row per component.</EmptyState>}
                  {hist.data && hist.data.predictions.length > 0 && (
                    <div className="table-scroll">
                      <table className="dt" aria-label="Scan log">
                        <thead>
                          <tr>
                            <th scope="col">Scored</th>
                            <th scope="col" className="num">Cycle</th>
                            <th scope="col" className="num">Risk</th>
                            <th scope="col">Alert</th>
                          </tr>
                        </thead>
                        <tbody>
                          {[...hist.data.predictions].reverse().slice(0, 20).map((p, i) => (
                            <tr key={`${p.scored_at}-${i}`}>
                              <td>
                                <RelTime iso={p.scored_at} />
                              </td>
                              <td className="num">{Math.round(p.cycle)}</td>
                              <td className="num">{formatPct(p.risk_score, 2)}</td>
                              <td>{p.alert ? <Chip tone="bad">Alert</Chip> : <span className="muted">no</span>}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </Panel>
              </div>
            </>
          )}

          {tab === "related" && (
            <div className="grid-2">
              <Panel
                title="Related procedures"
                sub={`Knowledge-base documents for ${humanizeType(type).toLowerCase()}.`}
                flush
                actions={
                  <ButtonLink size="sm" href={hrefFor("ops/knowledge-base")}>
                    Search KB
                  </ButtonLink>
                }
              >
                {kb.loading && <LoadingRows rows={3} height={32} />}
                {kb.error && (
                  <div style={{ padding: 16 }}>
                    <Notice tone="plain">Knowledge-base search is unavailable right now.</Notice>
                  </div>
                )}
                <div className="rows">
                  {kb.data?.map((h) => (
                    <a key={h.doc_id} className="row-item" href={hrefFor(`ops/knowledge-base/${h.doc_id}`)}>
                      <Chip plain icon={null}>
                        {h.doc_type}
                      </Chip>
                      <span className="row-main">
                        <span className="row-title">{h.title}</span>
                        <span className="row-sub mono">{h.doc_id}</span>
                      </span>
                    </a>
                  ))}
                </div>
                {kb.data && kb.data.length === 0 && <EmptyState title="No matching documents">Try the Knowledge page for a broader search.</EmptyState>}
              </Panel>

              <Panel title={`Other components on ${aircraftId}`} sub="Live scores from the same fleet ranking." flush>
                {siblings.loading && !siblings.data && <LoadingRows rows={3} height={32} />}
                {siblings.error && (
                  <div style={{ padding: 16 }}>
                    <ServiceStatusBanner message={siblings.error} onRetry={siblings.reload} />
                  </div>
                )}
                {siblings.data && siblingRows.length === 0 && <EmptyState title="No other scored components">This aircraft has no other component in the scored fleet.</EmptyState>}
                <div className="rows">
                  {siblingRows.map((r) => (
                    <a key={r.component_id} className="row-item" href={hrefFor(`ops/component/${r.component_id}`)}>
                      <Chip tone={BAND_TONE[r.band]}>{BAND_LABEL[r.band]}</Chip>
                      <span className="row-main">
                        <span className="row-title mono">{r.component_id}</span>
                        <span className="row-sub">
                          {humanizeType(r.component_type)} · rank {r.rank}
                        </span>
                      </span>
                      <span className="row-end mono">{formatPct(r.risk_score, 2)}</span>
                    </a>
                  ))}
                </div>
              </Panel>
            </div>
          )}

          {tab === "raw" && (
            <Panel
              title="Raw"
              sub="Exactly what the service returned for this component: the scored snapshot and the live explanation."
              actions={<CopyId value={rawJson} label="Copy JSON" />}
            >
              <pre className="raw-json" tabIndex={0} aria-label="Raw component JSON">
                {rawJson}
              </pre>
            </Panel>
          )}
        </>
      )}
    </div>
  );
}
