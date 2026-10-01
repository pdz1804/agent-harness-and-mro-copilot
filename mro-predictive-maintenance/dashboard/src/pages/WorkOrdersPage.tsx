import { useMemo, useState } from "react";
import { closeWorkOrder, getPerformance, listWorkOrders } from "../lib/api";
import { useAsync } from "../hooks/useAsync";
import { formatPct } from "../lib/format";
import { hrefFor } from "../lib/routes";
import { WO_OUTCOMES, ageLabel, asLiveOutcomes } from "../lib/risk";
import { DataTable, type Column } from "../components/ui/data-table";
import { Button, ButtonLink, Chip, PageHead, Panel, StatBar } from "../components/ui/primitives";
import { Segmented, Sheet } from "../components/ui/widgets";
import { EmptyState, Notice, ServiceStatusBanner } from "../components/ui/states";
import type { DashboardData, WorkOrder } from "../types";

type Filter = "all" | "open" | "in_progress" | "closed";

const OUTCOME_LABEL: Record<string, string> = {
  confirmed_failure: "Confirmed fault",
  nff: "No fault found",
  not_inspected: "Not inspected",
};

function priorityChip(p: string) {
  if (p === "aog") return <Chip tone="bad">AOG</Chip>;
  if (p === "urgent") return <Chip tone="warn">Urgent</Chip>;
  return <Chip>{p}</Chip>;
}

/** Work orders and the outcome loop. Creation happens only through the
 * copilot's approval-gated tool; this page lists and closes them. Closing
 * records an outcome, which turns into live precision and the no-fault-found
 * rate: the feedback loop that tells you whether alerts are real. */
export function WorkOrdersPage({ data }: { data: DashboardData }) {
  const orders = useAsync(() => listWorkOrders(), []);
  const perf = useAsync(() => getPerformance(), []);
  const [filter, setFilter] = useState<Filter>("all");
  const [closing, setClosing] = useState<WorkOrder | null>(null);
  const [outcome, setOutcome] = useState<string>("confirmed_failure");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const primary = data.models.find((m) => m.is_primary) ?? data.models[0];
  const live = asLiveOutcomes(perf.data?.live_outcomes);

  const all = orders.data ?? [];
  const counts = useMemo(
    () => ({
      all: all.length,
      open: all.filter((w) => w.status === "open").length,
      in_progress: all.filter((w) => w.status === "in_progress").length,
      closed: all.filter((w) => w.status === "closed").length,
    }),
    [all],
  );
  const visible = filter === "all" ? all : all.filter((w) => w.status === filter);

  const startClose = (w: WorkOrder) => {
    setClosing(w);
    setOutcome("confirmed_failure");
    setNotes("");
    setError(null);
  };

  const submitClose = async () => {
    if (!closing) return;
    setBusy(true);
    setError(null);
    try {
      await closeWorkOrder(closing.id, outcome, notes.trim() || undefined);
      setToast(`${closing.id} closed as “${OUTCOME_LABEL[outcome] ?? outcome}”. Live precision and NFF rate updated.`);
      setClosing(null);
      orders.reload();
      perf.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const columns: Column<WorkOrder>[] = [
    { key: "id", header: "Work order", fit: true, sortValue: (w) => w.id, render: (w) => <span className="mono">{w.id}</span> },
    {
      key: "component",
      header: "Component",
      grow: true,
      truncate: true,
      sortValue: (w) => w.component_id,
      render: (w) => (
        <>
          <a className="id-link" href={hrefFor(`ops/component/${w.component_id}`)} title={w.component_id}>
            {w.component_id}
          </a>
          <span className="dt-sub hide-md">{w.aircraft_id}</span>
        </>
      ),
    },
    { key: "priority", header: "Priority", fit: true, sortValue: (w) => w.priority, render: (w) => priorityChip(w.priority) },
    { key: "status", header: "Status", fit: true, hideSm: true, sortValue: (w) => w.status, render: (w) => <Chip tone={w.status === "closed" ? "good" : "info"}>{w.status.replace(/_/g, " ")}</Chip> },
    { key: "by", header: "Approved by", hideMd: true, fit: true, sortValue: (w) => w.approved_by, render: (w) => w.approved_by },
    { key: "age", header: "Age", numeric: true, hideSm: true, fit: true, sortValue: (w) => Date.parse(w.created_at), render: (w) => <span className="muted">{ageLabel(w.created_at)}</span> },
    {
      key: "outcome",
      header: "Outcome",
      fit: true,
      render: (w) =>
        w.status !== "closed" ? (
          <Button size="sm" onClick={() => startClose(w)}>
            Close with outcome
          </Button>
        ) : (
          <Chip tone={w.outcome === "confirmed_failure" ? "good" : w.outcome === "nff" ? "warn" : "neutral"}>
            {OUTCOME_LABEL[w.outcome ?? ""] ?? w.outcome ?? "closed"}
          </Chip>
        ),
    },
  ];

  return (
    <div className="page">
      <PageHead
        title="Work orders"
        description="Close each work order with an outcome: it feeds live precision and the no-fault-found rate."
        actions={<ButtonLink href={hrefFor("ops/copilot")}>Raise via copilot</ButtonLink>}
      />

      {toast && (
        <div className="toast" role="status">
          {toast}
          <Button size="sm" variant="ghost" onClick={() => setToast(null)}>
            Dismiss
          </Button>
        </div>
      )}

      <StatBar
        label="Outcome loop"
        items={[
          {
            label: "Closed with outcome",
            value: live ? live.closed_with_outcome : "…",
            sub: live ? `${live.confirmed_failure} confirmed, ${live.nff} NFF, ${live.not_inspected} not inspected` : undefined,
          },
          { label: "Live precision", value: live?.live_precision != null ? formatPct(live.live_precision, 0) : "n/a", sub: `offline test precision ${formatPct(primary.test_precision, 0)}` },
          { label: "No-fault-found rate", value: live?.nff_rate != null ? formatPct(live.nff_rate, 0) : "n/a", sub: "wasted inspections" },
        ]}
      />
      {live && live.closed_with_outcome === 0 && (
        <Notice tone="plain">
          No outcomes recorded yet, so live precision is not defined. Close a work order below to start the loop.{" "}
          <a href={hrefFor("model/monitoring")}>Model monitoring</a>
        </Notice>
      )}
      {orders.error && <ServiceStatusBanner message={orders.error} onRetry={orders.reload} />}

      <Panel
        flush
        title="Work orders"
        actions={
          <Segmented<Filter>
            label="Work order status filter"
            value={filter}
            onChange={setFilter}
            options={[
              { id: "all", label: "All", count: counts.all },
              { id: "open", label: "Open", count: counts.open },
              { id: "in_progress", label: "In progress", count: counts.in_progress },
              { id: "closed", label: "Closed", count: counts.closed },
            ]}
          />
        }
      >
        <DataTable
          label="Work orders"
          rows={visible}
          columns={columns}
          rowKey={(w) => w.id}
          rowHref={(w) => hrefFor(`ops/component/${w.component_id}`)}
          defaultSort={{ key: "age", dir: "desc" }}
          loading={orders.loading && !orders.data}
          skeletonRows={4}
          empty={
            <EmptyState title="No work orders in this view" center>
              Approve a copilot “raise work order” card to create one.
            </EmptyState>
          }
        />
      </Panel>

      {closing && (
        <Sheet
          label="Close work order"
          title={`Close ${closing.id}`}
          subtitle={`${closing.component_id} on ${closing.aircraft_id}`}
          onClose={() => setClosing(null)}
          footer={
            <>
              <Button variant="primary" loading={busy} onClick={submitClose}>
                {busy ? "Closing…" : "Close work order"}
              </Button>
              <Button onClick={() => setClosing(null)}>Cancel</Button>
            </>
          }
        >
          {error && <ServiceStatusBanner message={error} />}
          <section>
            <h3 className="sheet-section-title">What did the inspection find?</h3>
            <div className="stack" role="radiogroup" aria-label="Work order outcome">
              {WO_OUTCOMES.map((o) => (
                <button key={o.id} type="button" role="radio" aria-checked={outcome === o.id} className="choice" onClick={() => setOutcome(o.id)}>
                  <span className="choice-radio" aria-hidden="true" />
                  <span>
                    <span className="choice-label">{o.label}</span>
                    <span className="choice-hint">{o.hint}</span>
                  </span>
                </button>
              ))}
            </div>
          </section>
          <section>
            <label className="field">
              <span className="sheet-section-title">Findings (optional)</span>
              <textarea className="textarea" name="findings" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="What was inspected, what was found…" />
            </label>
          </section>
          {closing.alert_id != null && <p className="muted">This also closes the linked alert #{closing.alert_id}.</p>}
        </Sheet>
      )}
    </div>
  );
}
