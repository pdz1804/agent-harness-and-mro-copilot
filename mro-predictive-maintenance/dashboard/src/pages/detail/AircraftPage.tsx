import { useEffect, useMemo, useState } from "react";
import { getAircraft, setAircraftStatus } from "../../lib/api";
import { getWholeFleet } from "../../lib/fleet-cache";
import { useAsync } from "../../hooks/useAsync";
import { formatDecimal } from "../../lib/format";
import { hrefFor } from "../../lib/routes";
import { ageLabel, alertTone, componentTypeFromId, humanizeType, STAGE_LABEL } from "../../lib/risk";
import { IDENTITY_CHANGE_EVENT, canApprove, getCurrentUser } from "../../lib/identity";
import { DataTable, type Column } from "../../components/ui/data-table";
import { Button, Chip, PageHead, Panel, StatBar } from "../../components/ui/primitives";
import { RiskMeter } from "../../components/ui/widgets";
import { EmptyState, LoadingRows, Notice, ServiceStatusBanner } from "../../components/ui/states";

const STATUSES = ["serviceable", "restricted", "aog"] as const;
type Status = (typeof STATUSES)[number];

function statusChip(s: string) {
  if (s === "serviceable") return <Chip tone="good">Serviceable</Chip>;
  if (s === "restricted") return <Chip tone="warn">Restricted</Chip>;
  return <Chip tone="bad">{s === "aog" ? "AOG" : s}</Chip>;
}

interface Props {
  aircraftId: string | undefined;
  onAskCopilot: (prompt: string) => void;
}

interface Row {
  componentId: string;
  type: string;
  risk: number;
  threshold: number;
  alert: boolean;
  cycle: number;
}

/** One aircraft: serviceability (changeable by an engineer), components
 * ranked by risk, open alerts and work orders. */
export function AircraftPage({ aircraftId, onAskCopilot }: Props) {
  const id = aircraftId ?? "";
  const overview = useAsync(() => getAircraft(id), [id]);
  const fleet = useAsync(() => getWholeFleet(), []);

  const [status, setStatus] = useState<Status>("serviceable");
  const [mel, setMel] = useState("");
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [, tick] = useState(0);

  useEffect(() => {
    const on = () => tick((t) => t + 1);
    window.addEventListener(IDENTITY_CHANGE_EVENT, on);
    return () => window.removeEventListener(IDENTITY_CHANGE_EVENT, on);
  }, []);

  useEffect(() => {
    const s = overview.data?.status.status;
    if (s && (STATUSES as readonly string[]).includes(s)) setStatus(s as Status);
    setMel(overview.data?.status.mel_item ?? "");
  }, [overview.data]);

  const rows: Row[] = useMemo(() => {
    const live = (fleet.data?.items ?? []).filter((i) => i.aircraft_id === id);
    if (live.length > 0) {
      return live.map((i) => ({
        componentId: i.component_id,
        type: i.component_type,
        risk: i.risk_score,
        threshold: fleet.data!.threshold,
        alert: i.alert,
        cycle: i.cycle,
      }));
    }
    return (overview.data?.components ?? []).map((c) => ({
      componentId: String(c.component_id),
      type: componentTypeFromId(String(c.component_id)),
      risk: Number(c.risk_score),
      threshold: Number(c.threshold),
      alert: Boolean(c.alert),
      cycle: Number(c.cycle),
    }));
  }, [fleet.data, overview.data, id]);

  const allowed = canApprove();

  const save = async () => {
    setSaving(true);
    setSaveError(null);
    setSaved(null);
    try {
      await setAircraftStatus(id, status, mel.trim() || undefined, reason.trim() || undefined);
      setSaved(`Status set to ${status} by ${getCurrentUser()}.`);
      setReason("");
      overview.reload();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const o = overview.data;

  const columns: Column<Row>[] = [
    {
      key: "component",
      header: "Component",
      grow: true,
      truncate: true,
      sortValue: (r) => r.componentId,
      render: (r) => (
        <>
          <a className="id-link" href={hrefFor(`ops/component/${r.componentId}`)} title={r.componentId}>
            {humanizeType(r.type)}
          </a>
          <span className="dt-sub mono">{r.componentId}</span>
        </>
      ),
    },
    { key: "cycle", header: "Cycle", numeric: true, fit: true, hideSm: true, sortValue: (r) => r.cycle, render: (r) => formatDecimal(r.cycle, 0) },
    { key: "risk", header: "Risk", numeric: true, sortValue: (r) => r.risk, render: (r) => <RiskMeter score={r.risk} threshold={r.threshold} /> },
    {
      key: "status",
      header: "Status",
      fit: true,
      hideSm: true,
      sortValue: (r) => r.alert,
      render: (r) => (r.alert ? <Chip tone="bad">Alert</Chip> : <Chip>Below threshold</Chip>),
    },
  ];

  return (
    <div className="page">
      <PageHead
        crumbs={[{ label: "Fleet", href: hrefFor("ops/fleet/aircraft") }, { label: id }]}
        title={<span className="mono break">{id}</span>}
        description="Serviceability, component risk ranking, open alerts and work orders."
        actions={
          <Button variant="primary" onClick={() => onAskCopilot(`Give me a status overview for aircraft ${id}.`)}>
            Ask copilot
          </Button>
        }
      />
      {overview.error && <ServiceStatusBanner message={overview.error} onRetry={overview.reload} />}
      {overview.loading && !o && <LoadingRows rows={5} height={40} label="Loading aircraft…" />}

      {o && (
        <>
          <StatBar
            label="Aircraft summary"
            items={[
              {
                label: "Serviceability",
                value: statusChip(o.status.status),
                sub: o.status.mel_item ? `MEL ${o.status.mel_item}` : o.status.updated_by ? `set by ${o.status.updated_by}` : "default",
              },
              { label: "Components over threshold", value: `${rows.filter((r) => r.alert).length} / ${rows.length}`, sub: "of those scored" },
              { label: "Open alerts", value: o.open_alerts.length },
              { label: "Open work orders", value: o.open_work_orders.length },
            ]}
          />

          <Panel title="Components by risk" sub="Highest risk first. Click a row to see why." flush>
            <DataTable
              label={`Components on ${id}`}
              rows={rows}
              columns={columns}
              rowKey={(r) => r.componentId}
              rowHref={(r) => hrefFor(`ops/component/${r.componentId}`)}
              defaultSort={{ key: "risk", dir: "desc" }}
              empty={
                <EmptyState title="No scored components for this aircraft" center>
                  Run a fleet scan to score it.
                </EmptyState>
              }
            />
          </Panel>

          <div className="grid-2">
            <Panel title="Open alerts and work orders" flush>
              <div className="rows">
                {o.open_alerts.map((a) => (
                  <a key={a.id} className="row-item" href={hrefFor(`ops/alerts/${a.id}`)}>
                    <Chip tone={alertTone(a.status)}>{STAGE_LABEL[a.status] ?? a.status}</Chip>
                    <span className="row-main">
                      <span className="row-title">
                        #{a.id} <span className="mono">{a.component_id}</span>
                      </span>
                      <span className="row-sub">opened {ageLabel(a.opened_at)} ago</span>
                    </span>
                  </a>
                ))}
                {o.open_work_orders.map((w) => (
                  <a key={w.id} className="row-item" href={hrefFor("ops/work-orders")}>
                    <Chip tone="info">{w.status}</Chip>
                    <span className="row-main">
                      <span className="row-title mono">{w.id}</span>
                      <span className="row-sub">
                        {w.component_id} · {w.priority}
                      </span>
                    </span>
                  </a>
                ))}
              </div>
              {o.open_alerts.length === 0 && o.open_work_orders.length === 0 && (
                <EmptyState title="Nothing open">No open alerts or work orders on this aircraft.</EmptyState>
              )}
            </Panel>

            <Panel title="Change serviceability" sub={`Recorded against ${getCurrentUser()}. Takes effect immediately in the ops store.`}>
              <div className="stack">
                {!allowed && <Notice tone="plain">You are acting as a read-only viewer. Switch to an engineer identity in the top bar to change status.</Notice>}
                {saveError && <ServiceStatusBanner message={saveError} />}
                {saved && (
                  <div className="toast" role="status">
                    {saved}
                  </div>
                )}
                <label className="field">
                  <span className="field-label">Status</span>
                  <select className="select" value={status} disabled={!allowed} onChange={(e) => setStatus(e.target.value as Status)}>
                    {STATUSES.map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span className="field-label">MEL item (optional)</span>
                  <input className="input" name="mel-item" autoComplete="off" value={mel} disabled={!allowed} onChange={(e) => setMel(e.target.value)} />
                </label>
                <label className="field">
                  <span className="field-label">Reason (optional)</span>
                  <input className="input" name="reason" autoComplete="off" value={reason} disabled={!allowed} onChange={(e) => setReason(e.target.value)} />
                </label>
                <div>
                  <Button
                    variant="primary"
                    loading={saving}
                    disabled={!allowed}
                    title={!allowed ? "Read-only identity: switch to an engineer to change status" : undefined}
                    onClick={save}
                  >
                    {saving ? "Saving…" : "Update status"}
                  </Button>
                </div>
              </div>
            </Panel>
          </div>
        </>
      )}
    </div>
  );
}
