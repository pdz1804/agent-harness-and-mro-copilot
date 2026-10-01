import { useMemo, useState } from "react";
import { useRetrainJob } from "../hooks/useRetrainJob";
import { RETRAIN_USER } from "../lib/retrain";
import { ConfirmDialog, humanError, useToast } from "../components/ui/feedback";
import { getDrift, getDriftHistory, getPerformance, getRegistryStatus } from "../lib/api";
import { useAsync } from "../hooks/useAsync";
import { PSI_BANDS, driftTimelineNote, monitoredLookup, normalizeDrift, normalizeDriftHistory } from "../lib/drift";
import { driftLabel, driftTone } from "../lib/labels";
import { formatDecimal, formatPct, humanizeFeatureName } from "../lib/format";
import { championVersion } from "../lib/models";
import { hrefFor } from "../lib/routes";
import { asLiveOutcomes } from "../lib/risk";
import { DriftTimelineChart } from "../components/charts/charts";
import { RetrainPanel } from "../components/RetrainPanel";
import { DataTable, type Column } from "../components/ui/data-table";
import { Button, ButtonLink, Chip, PageHead, Panel, StatBar, Switch } from "../components/ui/primitives";
import { EmptyState, LoadingRows, Notice, ServiceStatusBanner } from "../components/ui/states";
import { ActivityIcon, ChartIcon, FileIcon, GaugeIcon, RefreshIcon, ZapIcon } from "../components/ui/icons";
import type { DashboardData, DriftReport, RegistryVersion } from "../types";

/** PSI bar scale: 0 .. PSI_MAX. The warn/alert bands are drawn on the track. */
const PSI_MAX = 0.4;

function barClass(status: string): string {
  return status === "alert" ? "is-bad" : status === "warn" ? "is-warn" : "";
}

/** Monitoring: drift snapshot and its timeline, feature PSI, the live
 * outcome loop, the retrain gate and the model registry. */
export function MonitoringPage({ data }: { data: DashboardData }) {
  const [simulate, setSimulate] = useState(false);
  const driftReq = useAsync(() => getDrift(30, simulate ? "shift" : undefined), [simulate]);
  const histReq = useAsync(() => getDriftHistory(30, 50), []);
  const perfReq = useAsync(() => getPerformance(), []);
  const regReq = useAsync(() => getRegistryStatus(), []);
  const retrain = useRetrainJob();
  const toast = useToast();
  const [checking, setChecking] = useState(false);
  const [confirmRetrain, setConfirmRetrain] = useState(false);

  /** A real (never simulated) check: `GET /monitoring/drift` records a PSI
   * snapshot, then the timeline and the summary reload. */
  const runDriftCheck = async () => {
    setChecking(true);
    try {
      const raw = await getDrift(30);
      const report = normalizeDrift(raw);
      setChecked(raw);
      histReq.reload();
      toast.show({
        tone: report.overall === "alert" ? "warn" : report.overall === "warn" ? "info" : "good",
        message: `Drift check recorded: ${driftLabel(report.overall)}`,
        detail: `score PSI ${report.scorePsi !== null ? formatDecimal(report.scorePsi, 4) : "n/a"} · ${report.nCurrent ?? 0} current rows`,
      });
    } catch (err) {
      toast.show({ tone: "error", message: "Drift check failed.", detail: humanError(err) });
    } finally {
      setChecking(false);
    }
  };

  // A manual check's report replaces the page-load one (real data only; the
  // simulated view always comes from its own request).
  const [checked, setChecked] = useState<DriftReport | null>(null);
  const shown = !simulate && checked ? checked : driftReq.data;
  const drift = useMemo(() => (shown ? normalizeDrift(shown) : null), [shown]);
  const timeline = useMemo(() => normalizeDriftHistory(histReq.data, monitoredLookup(drift?.rows)), [histReq.data, drift]);
  const outcomes = asLiveOutcomes(perfReq.data?.live_outcomes);
  const primary = data.models.find((m) => m.is_primary) ?? data.models[0];
  const registry = regReq.data;

  const monitored = drift?.rows.filter((r) => r.monitored) ?? [];
  const unmonitored = drift?.rows.filter((r) => !r.monitored) ?? [];
  const warnAt = drift?.warnAt ?? PSI_BANDS.warn;
  const alertAt = drift?.alertAt ?? PSI_BANDS.alert;
  const inspected = outcomes ? outcomes.confirmed_failure + outcomes.nff : 0;
  const champion = registry ? championVersion(registry.versions) : null;

  const regColumns: Column<RegistryVersion>[] = [
    { key: "v", header: "Version", numeric: false, sortValue: (v) => Number(v.version), render: (v) => <span className="mono">v{v.version}</span> },
    { key: "run", header: "Run ID", hideSm: true, render: (v) => <span className="mono" title={v.run_id}>{v.run_id.slice(0, 12)}…</span> },
    { key: "status", header: "Status", render: (v) => v.status },
    {
      key: "alias",
      header: "Aliases",
      render: (v) => (v.aliases.includes("champion") ? <Chip tone="good">champion</Chip> : v.aliases.length ? v.aliases.join(", ") : <span className="muted">none</span>),
    },
  ];

  return (
    <div className="page">
      <PageHead
        title="Monitoring"
        description="Input and score drift, the live outcome loop, the retrain gate and the model registry."
        actions={
          <>
            <Switch checked={simulate} onChange={setSimulate}>Simulate shift <code>?simulate=shift</code></Switch>
            <Button onClick={runDriftCheck} loading={checking}>
              <RefreshIcon />
              {checking ? "Checking…" : "Run drift check"}
            </Button>
            <Button
              variant="primary"
              onClick={() => setConfirmRetrain(true)}
              loading={retrain.starting}
              disabled={!retrain.allowed || retrain.running}
              title={retrain.allowed ? undefined : `Only ${RETRAIN_USER} can start a retrain. You are acting as ${retrain.user}.`}
            >
              <ZapIcon />
              {retrain.running ? `Retraining… ${retrain.elapsed}s` : "Retrain"}
            </Button>
          </>
        }
      />

      {driftReq.error && <ServiceStatusBanner message={driftReq.error} onRetry={driftReq.reload} />}
      {driftReq.loading && !drift && <LoadingRows rows={4} height={32} label="Loading drift…" />}

      {drift && (
        <>
          {drift.simulated && (
            <Notice tone="warn" role="note">
              A synthetic shift is applied to the current window to prove the detector fires. This is not real drift, and it is never recorded in the timeline.
            </Notice>
          )}
          <StatBar
            label="Drift summary"
            items={[
              { icon: <GaugeIcon />, label: "Overall", value: <Chip tone={driftTone(drift.overall)}>{driftLabel(drift.overall)}</Chip>, sub: `Watch from ${warnAt}, Drift from ${alertAt}` },
              {
                icon: <ActivityIcon />,
                label: "Score PSI",
                value: drift.scorePsi !== null ? formatDecimal(drift.scorePsi, 3) : "n/a",
                sub: driftLabel(drift.scoreStatus ?? "ok"),
                trend: timeline.map((p) => p.scorePsi).filter((v): v is number => v !== null),
              },
              { icon: <FileIcon />, label: "Reference rows", value: drift.nReference ?? "n/a", sub: "training profile" },
              { icon: <ChartIcon />, label: "Current rows", value: drift.nCurrent ?? "n/a", sub: `source: ${drift.source.replace(/_/g, " ")}` },
            ]}
          />
        </>
      )}

      <Panel title="Drift timeline" sub="PSI at each recorded snapshot; status follows monitored features only. A fleet scan or opening this page records one.">
        {histReq.error && <ServiceStatusBanner message={histReq.error} onRetry={histReq.reload} />}
        {histReq.loading && !histReq.data && <LoadingRows rows={1} height={220} label="Loading timeline…" />}
        {histReq.data && (drift || driftReq.error) && timeline.length > 0 && (
          <>
            <DriftTimelineChart points={timeline} warnAt={warnAt} alertAt={alertAt} />
            <p className="muted" style={{ marginTop: 8 }}>{driftTimelineNote(timeline)}</p>
          </>
        )}
        {histReq.data && timeline.length === 0 && <EmptyState title="No snapshots yet">{driftTimelineNote(timeline)}</EmptyState>}
      </Panel>

      {drift && (
        <Panel title="Feature drift (PSI)" sub="Population stability index of each input against the training reference.">
          <div className="psi" role="list" aria-label="Feature drift">
            {monitored.map((f) => (
              <div className="psi-row" role="listitem" key={f.feature}>
                <span className="psi-name" title={f.feature}>{humanizeFeatureName(f.feature)}</span>
                <div className="psi-track" aria-hidden="true">
                  <span className="psi-band is-warn" style={{ left: `${(warnAt / PSI_MAX) * 100}%`, width: `${((alertAt - warnAt) / PSI_MAX) * 100}%` }} />
                  <span className="psi-band is-bad" style={{ left: `${(alertAt / PSI_MAX) * 100}%`, right: 0 }} />
                  <span className={`psi-fill ${barClass(f.status)}`} style={{ width: `${Math.min(100, (f.psi / PSI_MAX) * 100)}%` }} />
                </div>
                <span className="psi-val">{formatDecimal(f.psi, 3)}</span>
                <Chip tone={driftTone(f.status)}>{driftLabel(f.status)}</Chip>
              </div>
            ))}
          </div>
          <div className="legend" style={{ marginTop: 12 }}>
            <span>Bar scale 0 to {PSI_MAX}</span>
            <span><i className="swatch" style={{ background: "var(--warn-tint)", border: "1px solid var(--warn-border)" }} />Warn band</span>
            <span><i className="swatch" style={{ background: "var(--bad-tint)", border: "1px solid var(--bad-border)" }} />Alert band</span>
          </div>
          {unmonitored.length > 0 && (
            <details style={{ marginTop: 16 }}>
              <summary className="muted" style={{ cursor: "pointer" }}>{unmonitored.length} feature(s) excluded from alerting</summary>
              <dl className="kv is-compact" style={{ marginTop: 8 }}>
                {unmonitored.map((f) => (
                  <div key={f.feature} style={{ display: "contents" }}>
                    <dt>{humanizeFeatureName(f.feature)}</dt>
                    <dd className="muted">{f.unmonitoredReason ?? "not monitored"}</dd>
                  </div>
                ))}
              </dl>
            </details>
          )}
        </Panel>
      )}

      <div className="grid-2">
        <Panel
          title="Live outcomes"
          sub="Precision and no-fault-found from work orders closed with an outcome."
          actions={<ButtonLink size="sm" href={hrefFor("ops/work-orders")}>Close work orders</ButtonLink>}
        >
          {perfReq.error && <ServiceStatusBanner message={perfReq.error} onRetry={perfReq.reload} />}
          {perfReq.loading && !outcomes && <LoadingRows rows={2} />}
          {perfReq.data && !perfReq.data.available && <p className="muted">{perfReq.data.reason}</p>}
          {outcomes && (
            <div className="stack">
              <dl className="kv">
                <dt>Live precision</dt>
                <dd>{outcomes.live_precision !== null ? formatPct(outcomes.live_precision, 0) : "n/a"} <span className="muted">(offline test {formatPct(primary.test_precision, 0)})</span></dd>
                <dt>No-fault-found rate</dt>
                <dd>{outcomes.nff_rate !== null ? formatPct(outcomes.nff_rate, 0) : "n/a"} <span className="muted">({outcomes.nff} of {inspected} inspected)</span></dd>
              </dl>
              {outcomes.closed_with_outcome > 0 ? (
                <>
                  <div className="split-bar" role="img" aria-label="Outcome mix">
                    <span style={{ width: `${(outcomes.confirmed_failure / outcomes.closed_with_outcome) * 100}%`, background: "var(--good)" }} />
                    <span style={{ width: `${(outcomes.nff / outcomes.closed_with_outcome) * 100}%`, background: "var(--series-warn)" }} />
                    <span style={{ width: `${(outcomes.not_inspected / outcomes.closed_with_outcome) * 100}%`, background: "var(--border-strong)" }} />
                  </div>
                  <div className="legend">
                    <span><i className="swatch" style={{ background: "var(--good)" }} />Confirmed {outcomes.confirmed_failure}</span>
                    <span><i className="swatch" style={{ background: "var(--series-warn)" }} />NFF {outcomes.nff}</span>
                    <span><i className="swatch" style={{ background: "var(--border-strong)" }} />Not inspected {outcomes.not_inspected}</span>
                  </div>
                </>
              ) : (
                <p className="muted">No work order has been closed with an outcome yet, so live precision is undefined. Closing one starts the loop.</p>
              )}
            </div>
          )}
        </Panel>

        <RetrainPanel retrain={retrain} />
      </div>

      <Panel
        flush
        title={<>Model registry <code>{registry?.registered_model}</code></>}
        sub={champion ? `Champion is v${champion.version}. Compare versions on Performance.` : "MLflow versions and the champion alias."}
        actions={<ButtonLink size="sm" href={hrefFor("model/performance")}>Champion vs challenger</ButtonLink>}
      >
        {regReq.error && <div style={{ padding: 16 }}><ServiceStatusBanner message={regReq.error} onRetry={regReq.reload} /></div>}
        {regReq.loading && !registry && <LoadingRows rows={3} />}
        {registry && !registry.tracking_enabled && <EmptyState title="MLflow tracking is disabled">Enable tracking to list registered versions.</EmptyState>}
        {registry && registry.tracking_enabled && registry.versions.length === 0 && <EmptyState title="No versions registered">{registry.note ?? "Run the pipeline to register one."}</EmptyState>}
        {registry && registry.versions.length > 0 && (
          <DataTable label="Model registry versions" rows={registry.versions} columns={regColumns} rowKey={(v) => String(v.version)} defaultSort={{ key: "v", dir: "desc" }} />
        )}
      </Panel>

      {confirmRetrain && (
        <ConfirmDialog
          title="Retrain the realistic profile?"
          confirmLabel="Yes, retrain"
          onCancel={() => setConfirmRetrain(false)}
          onConfirm={() => {
            setConfirmRetrain(false);
            void retrain.start(false);
          }}
        >
          This retrains the realistic profile and checks the challenger against the champion. It rewrites <code>reports/realistic</code> and never promotes from
          here (use the Retrain gate below to opt in). The served model does not change until the service restarts.
        </ConfirmDialog>
      )}
    </div>
  );
}
