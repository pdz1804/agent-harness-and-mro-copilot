import { useMemo } from "react";
import { getAircraft, getComponentHistory, getFleetComponent, getModelCard, listAlerts, listWorkOrders, scoreComponent, searchKb } from "../../lib/api";
import { useAsync } from "../../hooks/useAsync";
import { formatPct, humanizeFeatureName } from "../../lib/format";
import { hrefFor } from "../../lib/routes";
import { ageLabel, alertTone, componentTypeFromId, humanizeType, STAGE_LABEL } from "../../lib/risk";
import { historySummary, toLifeEvents, toRiskPoints } from "../../lib/history";
import { Button, ButtonLink, Chip, PageHead, Panel } from "../../components/ui/primitives";
import { FactorBars, RiskMeter } from "../../components/ui/widgets";
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

interface Props {
  componentId: string | undefined;
  onAskCopilot: (prompt: string) => void;
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

  return (
    <div className="page">
      <PageHead
        crumbs={[{ label: "Fleet", href: hrefFor("ops/fleet") }, { label: id }]}
        title={<span className="mono break">{id}</span>}
        description={`${humanizeType(type)} on ${aircraftId}`}
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
              {hist.data && points.length === 0 && (
                <EmptyState title="No scans logged for this component">{historySummary(points)}</EmptyState>
              )}
            </Panel>
          </div>

          <div className="grid-2">
            <Panel title="Why it scores this" sub="Live SHAP from the deployed model.">
              {why.loading && <LoadingRows rows={5} height={16} label="Explaining…" />}
              {why.error && <ServiceStatusBanner message={why.error} onRetry={why.reload} />}
              {why.data && <FactorBars factors={why.data.top_factors.map((f) => ({ feature: f.feature, value: f.shap_value }))} />}
            </Panel>

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
                  <a key={w.id} className="row-item" href={hrefFor("ops/work-orders")}>
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
          </div>

          <Panel title="Maintenance life" sub="Checks and removals along this component's cycle count (maintenance_events).">
            {hist.data && lifeEvents.length > 0 ? (
              <LifeTimeline events={lifeEvents} currentCycle={c.cycle} />
            ) : hist.data ? (
              <EmptyState title="No maintenance events recorded">The events log has nothing for this component.</EmptyState>
            ) : (
              <LoadingRows rows={1} height={48} />
            )}
          </Panel>

          <Panel title="Sensor snapshot the model saw" sub="Latest reading per feature. “Not reported” means the sensor does not apply or dropped out.">
            <div className="grid-3">
              <SensorGroup title="Sensors" keys={SENSOR_KEYS} features={c.features} />
              <SensorGroup title="Fault and inspection history" keys={HISTORY_KEYS} features={c.features} />
              <SensorGroup title="Component and aircraft context" keys={CONTEXT_KEYS} features={c.features} />
            </div>
          </Panel>

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
        </>
      )}
    </div>
  );
}
