import { useEffect, useMemo, useState } from "react";
import { getAlert, listAlerts, transitionAlert } from "../lib/api";
import { useAsync } from "../hooks/useAsync";
import { formatPct } from "../lib/format";
import { hrefFor } from "../lib/routes";
import { ALERT_STAGES, STAGE_LABEL, ageLabel, alertTone, componentTypeFromId, humanizeType, parseTopFactors } from "../lib/risk";
import { DataTable, type Column } from "../components/ui/data-table";
import { Button, ButtonLink, Chip, PageHead, Panel } from "../components/ui/primitives";
import { AlertStepper, FactorBars, RiskMeter, Segmented, Sheet, StagePips } from "../components/ui/widgets";
import { EmptyState, LoadingRows, ServiceStatusBanner } from "../components/ui/states";
import type { Alert } from "../types";

type Filter = "all" | (typeof ALERT_STAGES)[number];

const NEXT_ACTIONS: Record<string, { action: string; label: string }[]> = {
  open: [{ action: "acknowledge", label: "Acknowledge" }],
  acknowledged: [{ action: "raise_wo", label: "Mark WO raised" }],
  wo_raised: [{ action: "close", label: "Close alert" }],
  closed: [],
};

interface AlertsPageProps {
  /** Route param: `#/ops/alerts/<id>` opens that alert's sheet. */
  alertId?: string;
  onAskCopilot: (prompt: string, alertId?: number) => void;
}

/** Alert inbox and lifecycle. The selected alert lives in the URL so any alert
 * is linkable. A transition returns the full alert, which the sheet shows
 * immediately instead of refetching. */
export function AlertsPage({ alertId, onAskCopilot }: AlertsPageProps) {
  const list = useAsync(() => listAlerts(), []);
  const [filter, setFilter] = useState<Filter>("all");
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [fresh, setFresh] = useState<Alert | null>(null);

  const selectedId = alertId && /^\d+$/.test(alertId) ? Number(alertId) : null;
  const detail = useAsync(() => (selectedId === null ? Promise.resolve(null) : getAlert(selectedId)), [selectedId]);

  useEffect(() => setFresh(null), [selectedId]);

  const all = list.data ?? [];
  const counts = useMemo(() => {
    const c: Record<string, number> = { all: all.length };
    for (const s of ALERT_STAGES) c[s] = all.filter((a) => a.status === s).length;
    return c;
  }, [all]);
  const visible = filter === "all" ? all : all.filter((a) => a.status === filter);

  const close = () => {
    setNote("");
    setActionError(null);
    window.location.hash = "#/ops/alerts";
  };

  const doTransition = async (id: number, action: string) => {
    setBusyAction(action);
    setActionError(null);
    try {
      const updated = await transitionAlert(id, action, note.trim() || undefined);
      setNote("");
      setFresh(updated);
      list.reload();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyAction(null);
    }
  };

  const selected = fresh && fresh.id === selectedId ? fresh : detail.data;
  const factors = parseTopFactors(selected?.top_factors_json).map((f) => ({ feature: f.feature, value: f.shap_value }));

  const columns: Column<Alert>[] = [
    { key: "id", header: "Alert", numeric: true, fit: true, sortValue: (a) => a.id, render: (a) => <span className="mono">#{a.id}</span> },
    {
      key: "component",
      header: "Component",
      grow: true,
      truncate: true,
      sortValue: (a) => a.component_id,
      render: (a) => (
        <>
          <a className="id-link" href={hrefFor(`ops/alerts/${a.id}`)} title={a.component_id}>
            {a.component_id}
          </a>
          <span className="dt-sub">
            {humanizeType(a.component_type ?? componentTypeFromId(a.component_id))} · {a.aircraft_id}
          </span>
        </>
      ),
    },
    {
      key: "stage",
      header: "Stage",
      fit: true,
      sortValue: (a) => ALERT_STAGES.indexOf(a.status as (typeof ALERT_STAGES)[number]),
      render: (a) => (
        <span className="row" style={{ flexWrap: "nowrap" }}>
          <Chip tone={alertTone(a.status)}>{STAGE_LABEL[a.status] ?? a.status}</Chip>
          <span className="hide-sm">
            <StagePips status={a.status} />
          </span>
        </span>
      ),
    },
    { key: "risk", header: "Risk", numeric: true, hideSm: true, sortValue: (a) => a.risk_score, render: (a) => <RiskMeter score={a.risk_score} threshold={a.threshold} /> },
    {
      key: "age",
      header: "Age",
      numeric: true,
      fit: true,
      sortValue: (a) => Date.parse(a.opened_at),
      render: (a) => <span className="muted">{a.status === "closed" ? "closed" : ageLabel(a.opened_at)}</span>,
    },
  ];

  return (
    <div className="page">
      <PageHead
        title="Alerts"
        description="Threshold crossings raised by fleet scan. Acknowledge, raise a work order, close."
        actions={<ButtonLink href={hrefFor("ops/fleet")}>Scan from Fleet</ButtonLink>}
      />
      {list.error && <ServiceStatusBanner message={list.error} onRetry={list.reload} />}

      <Panel flush title="Alert inbox" sub="Click a row to open its lifecycle, SHAP factors and timeline." actions={
        <Segmented<Filter>
          label="Alert stage filter"
          value={filter}
          onChange={setFilter}
          options={[
            { id: "all", label: "All", count: counts.all },
            ...ALERT_STAGES.map((s) => ({ id: s as Filter, label: STAGE_LABEL[s], count: counts[s] })),
          ]}
        />
      }>
        <DataTable
          label="Alerts"
          rows={visible}
          columns={columns}
          rowKey={(a) => String(a.id)}
          rowHref={(a) => hrefFor(`ops/alerts/${a.id}`)}
          selectedKey={selectedId === null ? null : String(selectedId)}
          defaultSort={{ key: "age", dir: "desc" }}
          loading={list.loading && !list.data}
          skeletonRows={5}
          empty={
            <EmptyState title="No alerts in this view" center>
              Run a fleet scan from the Fleet page to raise new ones.
            </EmptyState>
          }
        />
      </Panel>

      {selectedId !== null && (
        <Sheet
          label="Alert detail"
          title={
            <>
              Alert #{selectedId}
              {selected && (
                <>
                  {" "}
                  <span className="mono">{selected.component_id}</span>
                </>
              )}
            </>
          }
          subtitle={selected ? `${selected.aircraft_id} · risk ${formatPct(selected.risk_score, 1)} vs threshold ${formatPct(selected.threshold, 1)}` : undefined}
          onClose={close}
          footer={
            selected && (
              <>
                {(NEXT_ACTIONS[selected.status] ?? []).map((n) => (
                  <Button key={n.action} variant="primary" loading={busyAction === n.action} disabled={busyAction !== null} onClick={() => doTransition(selected.id, n.action)}>
                    {busyAction === n.action ? "Working…" : n.label}
                  </Button>
                ))}
                <ButtonLink href={hrefFor(`ops/component/${selected.component_id}`)}>Open component</ButtonLink>
                <Button
                  variant="ghost"
                  onClick={() =>
                    onAskCopilot(
                      `Please investigate alert #${selected.id} for component ${selected.component_id} on aircraft ${selected.aircraft_id} (risk score ${selected.risk_score.toFixed(4)}).`,
                      selected.id,
                    )
                  }
                >
                  Ask copilot
                </Button>
              </>
            )
          }
        >
          {detail.loading && !selected && <LoadingRows rows={4} />}
          {detail.error && <ServiceStatusBanner message={detail.error} onRetry={detail.reload} />}
          {actionError && <ServiceStatusBanner message={actionError} />}
          {selected && (
            <>
              <section>
                <h3 className="sheet-section-title">Lifecycle</h3>
                <AlertStepper status={selected.status} events={selected.events ?? []} />
              </section>
              {factors.length > 0 && (
                <section>
                  <h3 className="sheet-section-title">Why it alerted (SHAP at alert time)</h3>
                  <FactorBars factors={factors} />
                </section>
              )}
              <section>
                <h3 className="sheet-section-title">Timeline</h3>
                <ul className="timeline">
                  {(selected.events ?? []).map((e) => (
                    <li key={e.id}>
                      <time>{new Date(e.at).toLocaleString()}</time>
                      {e.action.replace(/_/g, " ")} by <strong>{e.actor}</strong>
                      {e.note ? ` (${e.note})` : ""}
                    </li>
                  ))}
                  {(selected.events ?? []).length === 0 && <li className="muted">No events yet.</li>}
                </ul>
              </section>
              {(selected.work_orders ?? []).length > 0 && (
                <section>
                  <h3 className="sheet-section-title">Work orders</h3>
                  <div className="stack" style={{ gap: 6 }}>
                    {selected.work_orders!.map((w) => (
                      <div key={w.id} className="row row-between">
                        <span className="mono">{w.id}</span>
                        <span className="row">
                          <Chip tone={w.status === "closed" ? "good" : "info"}>{w.status}</Chip>
                          <span className="muted">{w.priority}</span>
                        </span>
                      </div>
                    ))}
                  </div>
                </section>
              )}
              {(NEXT_ACTIONS[selected.status] ?? []).length > 0 && (
                <section>
                  <label className="field">
                    <span className="sheet-section-title">Note for the next action (optional)</span>
                    <input className="input" name="alert-note" autoComplete="off" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Recorded in the timeline…" />
                  </label>
                </section>
              )}
            </>
          )}
        </Sheet>
      )}
    </div>
  );
}
