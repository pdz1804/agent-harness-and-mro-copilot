import { useEffect, useMemo, useState } from "react";
import { closeWorkOrder, getPerformance, listWorkOrders } from "../lib/api";
import { useAsync } from "../hooks/useAsync";
import { useCanWrite } from "../hooks/useCanWrite";
import { readOnlyReason } from "../lib/identity";
import { useLiveList } from "../hooks/useLiveList";
import { navigateKeepingQuery, useUrlQuery } from "../hooks/useHashRoute";
import { formatPct } from "../lib/format";
import { hrefFor } from "../lib/routes";
import { buildQuery, formatSort, parseSort } from "../lib/url-state";
import { matchesQuery } from "../lib/row-diff";
import { neighborId, positionOf } from "../lib/keyboard-nav";
import { WO_OUTCOMES, asLiveOutcomes } from "../lib/risk";
import { DataTable, type Column } from "../components/ui/data-table";
import { Button, ButtonLink, Chip, PageHead, Panel, StatBar } from "../components/ui/primitives";
import { Segmented, Sheet, SheetSection } from "../components/ui/widgets";
import { EmptyState, Notice, ReadOnlyNotice, ServiceStatusBanner, SheetSkeleton } from "../components/ui/states";
import { ConfirmDialog, CopyId, LiveStamp, OverflowMenu, RelTime, useToast, type MenuItem } from "../components/ui/feedback";
import { DownloadIcon, SearchIcon } from "../components/ui/icons";
import { downloadText, workOrdersCsv } from "../lib/csv";
import type { DashboardData, WorkOrder } from "../types";

type Filter = "all" | "open" | "in_progress" | "closed";

const DEFAULTS = { status: "all", q: "", sort: "age:desc" };

const OUTCOME_LABEL: Record<string, string> = {
  confirmed_failure: "Confirmed fault",
  nff: "No fault found",
  not_inspected: "Not inspected",
};

const NOTES_MAX = 1000;

function priorityChip(p: string) {
  if (p === "aog") return <Chip tone="bad">AOG</Chip>;
  if (p === "urgent") return <Chip tone="warn">Urgent</Chip>;
  return <Chip>{p.charAt(0).toUpperCase() + p.slice(1)}</Chip>;
}

function outcomeChip(o: string | null) {
  return <Chip tone={o === "confirmed_failure" ? "good" : o === "nff" ? "warn" : "neutral"}>{OUTCOME_LABEL[o ?? ""] ?? o ?? "Closed"}</Chip>;
}

const statusLabel = (s: string) => ({ open: "Open", in_progress: "In progress", closed: "Closed" })[s] ?? s;

const draftKey = (id: string) => `mro:wo-draft:${id}`;
const key = (w: WorkOrder) => w.id;

/** Work orders and the outcome loop. Creation happens only through the
 * copilot's approval-gated tool; this page lists, inspects and closes them.
 * Closing records an outcome, which becomes live precision and the
 * no-fault-found rate. The API has no reopen, so a close is held for the
 * undo window and only then sent. */
export function WorkOrdersPage({ data, woId }: { data: DashboardData; woId?: string }) {
  const toast = useToast();
  const writable = useCanWrite();
  const orders = useLiveList(() => listWorkOrders(), key, (w) => `${w.status}:${w.outcome ?? ""}`);
  const perf = useAsync(() => getPerformance(), []);
  const [query, setQuery] = useUrlQuery(DEFAULTS);
  const [search, setSearch] = useState(query.q);
  const [order, setOrder] = useState<string[]>([]);
  const [pendingClose, setPendingClose] = useState<Map<string, string>>(new Map());
  const [outcome, setOutcome] = useState<string>("");
  const [notes, setNotes] = useState("");
  const [notesError, setNotesError] = useState<string | null>(null);
  const [outcomeError, setOutcomeError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [draftSaved, setDraftSaved] = useState(false);

  useEffect(() => setSearch(query.q), [query.q]);
  useEffect(() => {
    const id = setTimeout(() => {
      if (search !== query.q) setQuery({ q: search || null });
    }, 200);
    return () => clearTimeout(id);
  }, [search, query.q, setQuery]);

  const primary = data.models.find((m) => m.is_primary) ?? data.models[0];
  const live = asLiveOutcomes(perf.data?.live_outcomes);

  const all = useMemo(
    () =>
      (orders.data ?? []).map((w) => {
        const o = pendingClose.get(w.id);
        return o && w.status !== "closed" ? { ...w, status: "closed", outcome: o } : w;
      }),
    [orders.data, pendingClose],
  );
  const filter = query.status as Filter;
  const counts = useMemo(
    () => ({
      all: all.length,
      open: all.filter((w) => w.status === "open").length,
      in_progress: all.filter((w) => w.status === "in_progress").length,
      closed: all.filter((w) => w.status === "closed").length,
    }),
    [all],
  );
  const visible = useMemo(
    () =>
      all.filter(
        (w) => (filter === "all" || w.status === filter) && matchesQuery([w.id, w.component_id, w.aircraft_id, w.task_ref, w.priority, w.approved_by, w.alert_id], query.q),
      ),
    [all, filter, query.q],
  );

  const selected = woId ? all.find((w) => w.id === woId) ?? null : null;
  const qs = buildQuery(query, DEFAULTS);
  const open = (id: string) => navigateKeepingQuery(`ops/work-orders/${id}`, !!woId);
  const closeSheet = () => navigateKeepingQuery("ops/work-orders");

  // Per-WO draft: restore on open, autosave as you type.
  useEffect(() => {
    if (!woId) return;
    let restored: { outcome?: string; notes?: string } = {};
    try {
      restored = JSON.parse(sessionStorage.getItem(draftKey(woId)) ?? "{}");
    } catch {
      /* corrupt draft: start clean */
    }
    setOutcome(restored.outcome ?? "");
    setNotes(restored.notes ?? "");
    setNotesError(null);
    setOutcomeError(null);
    setDraftSaved(!!(restored.outcome || restored.notes));
  }, [woId]);
  useEffect(() => {
    if (!woId) return;
    const id = setTimeout(() => {
      if (outcome || notes) {
        sessionStorage.setItem(draftKey(woId), JSON.stringify({ outcome, notes }));
        setDraftSaved(true);
      } else {
        sessionStorage.removeItem(draftKey(woId));
        setDraftSaved(false);
      }
    }, 400);
    return () => clearTimeout(id);
  }, [woId, outcome, notes]);

  const validateNotes = (v: string) => setNotesError(v.length > NOTES_MAX ? `Keep findings under ${NOTES_MAX} characters (now ${v.length}).` : null);

  const requestClose = () => {
    if (!writable) return;
    if (!outcome) {
      setOutcomeError("Pick what the inspection found.");
      return;
    }
    if (notes.length > NOTES_MAX) {
      validateNotes(notes);
      return;
    }
    setConfirming(true);
  };

  const commitClose = (w: WorkOrder) => {
    setConfirming(false);
    const chosen = outcome;
    const n = notes.trim() || undefined;
    setPendingClose((m) => new Map(m).set(w.id, chosen));
    sessionStorage.removeItem(draftKey(w.id));
    setOutcome("");
    setNotes("");
    toast.mutate(
      {
        id: `wo-close-${w.id}`,
        strategy: "deferred",
        commit: () => closeWorkOrder(w.id, chosen, n),
        onSettled: () => {
          orders.reload();
          perf.reload();
          setTimeout(
            () =>
              setPendingClose((m) => {
                const next = new Map(m);
                next.delete(w.id);
                return next;
              }),
            1500,
          );
          toast.show({ tone: "good", message: "Live precision updated", detail: `${w.id} is now counted in the outcome loop.`, link: { label: "See monitoring", href: hrefFor("model/monitoring") }, durationMs: 4000 });
        },
        onUndone: () => {
          setPendingClose((m) => {
            const next = new Map(m);
            next.delete(w.id);
            return next;
          });
          setOutcome(chosen);
          setNotes(n ?? "");
          toast.show({ tone: "info", message: `${w.id} is open again`, detail: "Nothing was sent.", durationMs: 2500 });
        },
        onError: () => {
          setPendingClose((m) => {
            const next = new Map(m);
            next.delete(w.id);
            return next;
          });
          orders.reload();
        },
      },
      {
        tone: "good",
        message: (
          <>
            <span className="mono">{w.id}</span> closed as {OUTCOME_LABEL[chosen]}
          </>
        ),
        detail: w.alert_id != null ? `Linked alert #${w.alert_id} closes too. Saved when the undo window ends.` : "Saved when the undo window ends.",
      },
    );
  };

  const ids = order;
  const pos = positionOf(ids, woId ?? null);
  const prevId = neighborId(ids, woId ?? null, -1);
  const nextId = neighborId(ids, woId ?? null, 1);
  const dirty = !!selected && selected.status !== "closed" && (!!outcome || !!notes.trim());

  const menuFor = (w: WorkOrder): MenuItem[] => [
    { label: "Open component page", onSelect: () => (window.location.hash = hrefFor(`ops/component/${w.component_id}`).slice(1)) },
    { label: "Open aircraft page", onSelect: () => (window.location.hash = hrefFor(`ops/aircraft/${w.aircraft_id}`).slice(1)) },
    ...(w.alert_id != null ? [{ label: `Open alert #${w.alert_id}`, onSelect: () => (window.location.hash = `/ops/alerts/${w.alert_id}`) }] : []),
    {
      label: "Copy link to this work order",
      onSelect: () =>
        void navigator.clipboard
          ?.writeText(`${location.origin}${location.pathname}#/ops/work-orders/${w.id}`)
          .then(() => toast.show({ tone: "info", message: "Link copied", durationMs: 2000 })),
    },
  ];

  const columns: Column<WorkOrder>[] = [
    {
      key: "id",
      header: "Work order",
      fit: true,
      sortValue: (w) => w.id,
      render: (w) => (
        <a className="id-link mono" href={`#/ops/work-orders/${w.id}${qs}`}>
          {w.id}
        </a>
      ),
    },
    {
      key: "component",
      header: "Component",
      grow: true,
      truncate: true,
      sortValue: (w) => w.component_id,
      render: (w) => (
        <>
          <span className="mono" title={w.component_id}>
            {w.component_id}
          </span>
          <span className="dt-sub">
            {w.aircraft_id}
            {w.task_ref ? ` · ${w.task_ref}` : ""}
          </span>
        </>
      ),
    },
    { key: "priority", header: "Priority", fit: true, sortValue: (w) => ({ aog: 0, urgent: 1 })[w.priority] ?? 2, render: (w) => priorityChip(w.priority) },
    {
      key: "by",
      header: "Created → approved",
      hideMd: true,
      fit: true,
      sortValue: (w) => w.approved_by,
      render: (w) => (
        <span>
          <span className="muted">{w.created_by} →</span> {w.approved_by}
        </span>
      ),
    },
    { key: "age", header: "Created", numeric: true, hideSm: true, fit: true, sortValue: (w) => Date.parse(w.created_at), render: (w) => <RelTime iso={w.created_at} /> },
    {
      key: "status",
      header: "Status",
      fit: true,
      sortValue: (w) => `${w.status}:${w.outcome ?? ""}`,
      render: (w) => (w.status === "closed" ? outcomeChip(w.outcome) : <Chip tone="info">{statusLabel(w.status)}</Chip>),
    },
  ];

  const filtered = query.q !== "" || filter !== "all";
  /** Exports exactly the rows in view (status filter + search). */
  const exportCsv = () => {
    downloadText(`work-orders${filter === "all" ? "" : `-${filter}`}.csv`, workOrdersCsv(visible));
    toast.show({ tone: "info", message: `Exported ${visible.length} work order${visible.length === 1 ? "" : "s"}`, durationMs: 2500 });
  };

  return (
    <div className="page">
      <PageHead
        title="Work orders"
        description="Close each work order with an outcome: it feeds live precision and the no-fault-found rate."
        actions={
          <>
            <Button onClick={exportCsv} disabled={visible.length === 0} title={visible.length === 0 ? "Nothing to export in this view." : undefined}>
              <DownloadIcon />
              Export CSV
            </Button>
            <ButtonLink href={hrefFor("ops/copilot")}>Raise via copilot</ButtonLink>
          </>
        }
      />
      {!writable && <ReadOnlyNotice />}

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
          No outcomes recorded yet, so live precision is not defined. Close a work order below to start the loop. <a href={hrefFor("model/monitoring")}>Model monitoring</a>
        </Notice>
      )}
      {orders.error && <ServiceStatusBanner message={orders.error} onRetry={orders.reload} />}

      <Panel
        flush
        title="Work orders"
        sub={<LiveStamp at={orders.updatedAt} loading={orders.loading && !!orders.data} />}
        actions={
          <div className="list-tools">
            <label className="search-field">
              <SearchIcon />
              <input
                className="input"
                type="search"
                name="wo-search"
                placeholder="Search WO, component, task…"
                aria-label="Search work orders"
                autoComplete="off"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </label>
            <Segmented<Filter>
              label="Work order status filter"
              value={filter}
              onChange={(v) => setQuery({ status: v })}
              options={[
                { id: "all", label: "All", count: counts.all },
                { id: "open", label: "Open", count: counts.open },
                { id: "in_progress", label: "In progress", count: counts.in_progress },
                { id: "closed", label: "Closed", count: counts.closed },
              ]}
            />
          </div>
        }
      >
        <DataTable
          label="Work orders"
          rows={visible}
          columns={columns}
          rowKey={key}
          onRowClick={(w) => open(w.id)}
          selectedKey={woId ?? null}
          sort={parseSort(query.sort)}
          onSortChange={(s) => setQuery({ sort: formatSort(s) })}
          defaultSort={{ key: "age", dir: "desc" }}
          flashKeys={orders.flash}
          pendingKeys={new Set(pendingClose.keys())}
          onOrderChange={setOrder}
          rowActions={(w) =>
            w.status !== "closed" ? (
              <Button size="sm" onClick={() => open(w.id)} aria-label={`Close ${w.id} with outcome`}>
                Close with outcome
              </Button>
            ) : null
          }
          loading={orders.loading && !orders.data}
          skeletonRows={5}
          empty={
            filtered && all.length > 0 ? (
              <EmptyState
                title={query.q ? `No work orders match “${query.q}”` : `No ${filter.replace(/_/g, " ")} work orders`}
                center
                action={
                  <Button size="sm" onClick={() => setQuery({ q: null, status: null })}>
                    Clear filters
                  </Button>
                }
              >
                Search matches WO id, component, aircraft, AMM task and approver.
              </EmptyState>
            ) : (
              <EmptyState
                title="No work orders yet"
                center
                action={
                  <ButtonLink size="sm" variant="primary" href={hrefFor("ops/alerts")}>
                    Go to alerts
                  </ButtonLink>
                }
              >
                Work orders are raised by approving a copilot proposal, for example “Raise a work order for alert #12”.
              </EmptyState>
            )
          }
        />
      </Panel>

      {woId && (
        <Sheet
          label="Work order"
          title={selected ? <CopyId value={selected.id} className="is-title" /> : <span className="mono">{woId}</span>}
          status={selected && (selected.status === "closed" ? outcomeChip(selected.outcome) : <Chip tone="info">{statusLabel(selected.status)}</Chip>)}
          facts={
            selected
              ? [
                  {
                    label: "Component",
                    value: (
                      <a className="mono" href={hrefFor(`ops/component/${selected.component_id}`)}>
                        {selected.component_id}
                      </a>
                    ),
                  },
                  { label: "Priority", value: priorityChip(selected.priority) },
                  { label: "Created", value: <RelTime iso={selected.created_at} /> },
                  { label: "Approved by", value: selected.approved_by },
                ]
              : undefined
          }
          actions={selected && <OverflowMenu items={menuFor(selected)} label="More work order actions" />}
          nav={
            pos
              ? { index: pos.index, total: pos.total, onPrev: prevId ? () => open(prevId) : undefined, onNext: nextId ? () => open(nextId) : undefined }
              : undefined
          }
          guard={() => (dirty ? "Your outcome draft stays saved for this work order, but it has not been submitted." : null)}
          onClose={closeSheet}
          footer={
            selected &&
            selected.status !== "closed" && (
              <>
                <Button
                  variant="primary"
                  onClick={requestClose}
                  disabled={!!notesError || !writable}
                  title={writable ? undefined : readOnlyReason("close work orders")}
                >
                  Close work order
                </Button>
                <span className="muted foot-hint" aria-live="polite">
                  {!writable ? readOnlyReason("close work orders") : draftSaved ? "Draft saved" : "Pick an outcome to close"}
                </span>
              </>
            )
          }
        >
          {orders.loading && !orders.data && <SheetSkeleton />}
          {orders.data && !selected && (
            <EmptyState
              title={`${woId} was not found`}
              action={
                <Button size="sm" onClick={closeSheet}>
                  Back to work orders
                </Button>
              }
            >
              Check the id, or clear the filters on the list.
            </EmptyState>
          )}
          {selected && (
            <div className="sheet-swap" key={selected.id}>
              <SheetSection title="Overview">
                <dl className="kv">
                  <dt>Aircraft</dt>
                  <dd>
                    <a className="mono" href={hrefFor(`ops/aircraft/${selected.aircraft_id}`)}>
                      {selected.aircraft_id}
                    </a>
                  </dd>
                  <dt>AMM task</dt>
                  <dd>{selected.task_ref ? <CopyId value={selected.task_ref} /> : <span className="muted">none</span>}</dd>
                  <dt>Raised by</dt>
                  <dd>{selected.created_by}</dd>
                  <dt>Notes</dt>
                  <dd>{selected.notes || <span className="muted">none</span>}</dd>
                </dl>
              </SheetSection>

              {selected.status !== "closed" ? (
                <SheetSection title="Close with outcome" aside={<span className="muted">feeds live precision</span>}>
                  <div className="stack" role="radiogroup" aria-label="Work order outcome" aria-invalid={!!outcomeError}>
                    {WO_OUTCOMES.map((o) => (
                      <button
                        key={o.id}
                        type="button"
                        role="radio"
                        aria-checked={outcome === o.id}
                        className="choice"
                        disabled={!writable}
                        onClick={() => {
                          setOutcome(o.id);
                          setOutcomeError(null);
                        }}
                      >
                        <span className="choice-radio" aria-hidden="true" />
                        <span>
                          <span className="choice-label">{o.label}</span>
                          <span className="choice-hint">{o.hint}</span>
                        </span>
                      </button>
                    ))}
                  </div>
                  {outcomeError && (
                    <p className="field-error" role="alert">
                      {outcomeError}
                    </p>
                  )}
                  <label className="field" style={{ marginTop: 12 }}>
                    <span className="field-label">
                      Findings <span className="muted">(optional)</span>
                    </span>
                    <textarea
                      className={`textarea${notesError ? " is-invalid" : ""}`}
                      name="findings"
                      disabled={!writable}
                      value={notes}
                      onChange={(e) => {
                        setNotes(e.target.value);
                        if (notesError) validateNotes(e.target.value);
                      }}
                      onBlur={(e) => validateNotes(e.target.value)}
                      aria-invalid={!!notesError}
                      placeholder={outcome === "nff" ? "What was inspected, and why it looked healthy…" : "What was inspected, what was found…"}
                    />
                    <span className={`field-hint tnum${notes.length > NOTES_MAX ? " is-bad" : ""}`}>
                      {notesError ?? `${notes.length} / ${NOTES_MAX}`}
                    </span>
                  </label>
                  {selected.alert_id != null && <p className="muted">This also closes the linked alert #{selected.alert_id}.</p>}
                </SheetSection>
              ) : (
                <SheetSection title="Outcome">
                  <dl className="kv">
                    <dt>Result</dt>
                    <dd>{outcomeChip(selected.outcome)}</dd>
                    <dt>Closed</dt>
                    <dd>{pendingClose.has(selected.id) ? <span className="muted">saving after the undo window…</span> : <RelTime iso={selected.closed_at} />}</dd>
                  </dl>
                </SheetSection>
              )}

              <SheetSection title="Related">
                <div className="related-list">
                  {selected.alert_id != null ? (
                    <a className="related-item" href={`#/ops/alerts/${selected.alert_id}`}>
                      <span>
                        Alert <span className="mono">#{selected.alert_id}</span>
                      </span>
                      <span className="muted">open alert sheet</span>
                    </a>
                  ) : (
                    <p className="muted">Raised without a linked alert (from a copilot fleet review).</p>
                  )}
                  <a className="related-item" href={hrefFor(`ops/component/${selected.component_id}`)}>
                    <span className="mono">{selected.component_id}</span>
                    <span className="muted">risk, history, SHAP</span>
                  </a>
                </div>
              </SheetSection>

              <details className="raw">
                <summary>Raw record</summary>
                <pre>{JSON.stringify(selected, null, 2)}</pre>
              </details>
            </div>
          )}
        </Sheet>
      )}

      {confirming && selected && (
        <ConfirmDialog
          title={`Close ${selected.id} as “${OUTCOME_LABEL[outcome]}”?`}
          confirmLabel="Close work order"
          onCancel={() => setConfirming(false)}
          onConfirm={() => commitClose(selected)}
        >
          <p>
            The outcome is recorded against <span className="mono">{selected.component_id}</span>
            {selected.alert_id != null ? ` and alert #${selected.alert_id} closes` : ""}. Work orders cannot be reopened, so you get a few seconds to undo before it is saved.
          </p>
        </ConfirmDialog>
      )}
    </div>
  );
}
