import { useCallback, useEffect, useMemo, useState } from "react";
import { getAlert, listAlerts, searchKb, transitionAlert } from "../lib/api";
import { readOnlyReason } from "../lib/identity";
import { useCanWrite } from "../hooks/useCanWrite";
import { useAsync } from "../hooks/useAsync";
import { useLiveList } from "../hooks/useLiveList";
import { navigateKeepingQuery, useUrlQuery } from "../hooks/useHashRoute";
import { formatPct, formatSignedDecimal, humanizeFeatureName } from "../lib/format";
import { hrefFor } from "../lib/routes";
import { buildQuery, formatSort, parseSort } from "../lib/url-state";
import { matchesQuery, withOverrides } from "../lib/row-diff";
import { neighborId, positionOf } from "../lib/keyboard-nav";
import { ALERT_STAGES, STAGE_LABEL, alertTone, componentTypeFromId, humanizeType, parseTopFactors } from "../lib/risk";
import { DataTable, type Column } from "../components/ui/data-table";
import { Button, ButtonLink, Chip, PageHead, Panel } from "../components/ui/primitives";
import { AlertStepper, BulkBar, FactorBars, RiskMeter, Segmented, Sheet, SheetSection, StagePips } from "../components/ui/widgets";
import { EmptyState, ReadOnlyNotice, ServiceStatusBanner, SheetSkeleton } from "../components/ui/states";
import { ConfirmDialog, CopyId, LiveStamp, OverflowMenu, RelTime, useToast, type MenuItem } from "../components/ui/feedback";
import { BotIcon, CheckIcon, SearchIcon } from "../components/ui/icons";
import type { Alert } from "../types";

type Filter = "all" | (typeof ALERT_STAGES)[number] | "dismissed";

const DEFAULTS = { stage: "all", q: "", sort: "age:desc" };

interface AlertsPageProps {
  /** Route param: `#/ops/alerts/<id>` opens that alert's sheet. */
  alertId?: string;
  onAskCopilot: (prompt: string, alertId?: number, context?: string) => void;
}

const askPrompt = (a: Alert) =>
  `Please investigate alert #${a.id} for component ${a.component_id} on aircraft ${a.aircraft_id} (risk score ${a.risk_score.toFixed(4)}). If the evidence supports it, propose a work order.`;

const key = (a: Alert) => String(a.id);

/** Alert inbox and lifecycle. Filters, search and sort live in the URL
 * query; the open alert lives in the path, so every view is linkable and
 * closing the sheet returns to the exact list you left. Mutations are
 * optimistic with an Undo toast:
 *  - Acknowledge / Close are held for the undo window and only then sent
 *    (the API has no "unacknowledge").
 *  - Dismiss from Open is sent at once; Undo sends the real `reopen`. */
export function AlertsPage({ alertId, onAskCopilot }: AlertsPageProps) {
  const toast = useToast();
  const list = useLiveList(() => listAlerts(), key, (a) => a.status);
  const [query, setQuery] = useUrlQuery(DEFAULTS);
  const writable = useCanWrite();
  const ro = (action: string) => (writable ? {} : { disabled: true, title: readOnlyReason(action) });
  const [overrides, setOverrides] = useState<Map<string, string>>(new Map());
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [note, setNote] = useState("");
  const [confirmClose, setConfirmClose] = useState<Alert | null>(null);
  const [order, setOrder] = useState<string[]>([]);
  const [search, setSearch] = useState(query.q);

  useEffect(() => setSearch(query.q), [query.q]);
  useEffect(() => {
    const id = setTimeout(() => {
      if (search !== query.q) setQuery({ q: search || null });
    }, 200);
    return () => clearTimeout(id);
  }, [search, query.q, setQuery]);

  const selectedId = alertId && /^\d+$/.test(alertId) ? Number(alertId) : null;
  const detail = useAsync(() => (selectedId === null ? Promise.resolve(null) : getAlert(selectedId)), [selectedId]);
  useEffect(() => setNote(""), [selectedId]);

  const all = useMemo(() => withOverrides(list.data ?? [], key, overrides), [list.data, overrides]);
  const filter = query.stage as Filter;
  const counts = useMemo(() => {
    const c: Record<string, number> = { dismissed: 0 };
    for (const s of ALERT_STAGES) c[s] = 0;
    for (const a of all) c[a.status] = (c[a.status] ?? 0) + 1;
    return c;
  }, [all]);
  const visible = useMemo(
    () =>
      all.filter(
        (a) =>
          (filter === "all" ? a.status !== "dismissed" : a.status === filter) &&
          matchesQuery(
            [a.id, `#${a.id}`, a.component_id, a.aircraft_id, a.component_type, humanizeType(a.component_type ?? componentTypeFromId(a.component_id))],
            query.q,
          ),
      ),
    [all, filter, query.q],
  );

  // Selection only ever holds rows you can see and act on.
  useEffect(() => {
    setSelection((s) => {
      const ok = new Set(visible.filter((a) => a.status === "open").map(key));
      const next = new Set([...s].filter((k) => ok.has(k)));
      return next.size === s.size ? s : next;
    });
  }, [visible]);

  const qs = buildQuery(query, DEFAULTS);
  const open = (id: number) => navigateKeepingQuery(`ops/alerts/${id}`, selectedId !== null);
  const closeSheet = () => navigateKeepingQuery("ops/alerts");

  const setOverride = useCallback((ids: string[], status: string | null) => {
    setOverrides((m) => {
      const next = new Map(m);
      for (const id of ids) {
        if (status === null) next.delete(id);
        else next.set(id, status);
      }
      return next;
    });
  }, []);

  const reloadList = list.reload;
  const reloadDetail = detail.reload;

  /** One mutation path for every alert action. */
  const act = (alerts: Alert[], action: "acknowledge" | "dismiss" | "close") => {
    if (alerts.length === 0 || !writable) return;
    const ids = alerts.map(key);
    const target = action === "acknowledge" ? "acknowledged" : action === "dismiss" ? "dismissed" : "closed";
    const n = note.trim() || undefined;
    setOverride(ids, target);
    setNote("");
    setSelection(new Set());
    const reversibleNow = action === "dismiss" && alerts.every((a) => a.status === "open");
    const label = alerts.length === 1 ? `Alert #${alerts[0].id} ${target}` : `${alerts.length} alerts ${target}`;
    toast.mutate(
      {
        id: `alert-${action}-${ids.join(",")}-${Date.now()}`,
        strategy: reversibleNow ? "compensate" : "deferred",
        commit: () => Promise.all(alerts.map((a) => transitionAlert(a.id, action, n))),
        revert: reversibleNow ? () => Promise.all(alerts.map((a) => transitionAlert(a.id, "reopen"))) : undefined,
        onSettled: () => {
          reloadList();
          reloadDetail();
          setTimeout(() => setOverride(ids, null), 1500);
        },
        onUndone: () => {
          setOverride(ids, null);
          reloadList();
          reloadDetail();
          toast.show({ tone: "info", message: alerts.length === 1 ? `Alert #${alerts[0].id} restored` : `${alerts.length} alerts restored`, durationMs: 2500 });
        },
        onError: () => {
          setOverride(ids, null);
          reloadList();
        },
      },
      {
        tone: "good",
        message: label,
        detail: alerts.length === 1 ? `${alerts[0].component_id} · ${alerts[0].aircraft_id}` : "Sent when the undo window ends.",
      },
    );
  };

  const raiseWo = (a: Alert) =>
    onAskCopilot(
      `Raise a work order for alert #${a.id}: component ${a.component_id} on aircraft ${a.aircraft_id}, risk ${a.risk_score.toFixed(4)} vs threshold ${a.threshold.toFixed(4)}. Look up the AMM task first.`,
      a.id,
      `Alert #${a.id} · ${a.component_id}`,
    );

  const reopen = (a: Alert) => {
    void transitionAlert(a.id, "reopen").then(
      () => {
        reloadList();
        reloadDetail();
        toast.show({ message: `Alert #${a.id} reopened` });
      },
      (err: unknown) => toast.show({ tone: "error", message: "Could not reopen the alert.", detail: err instanceof Error ? err.message : String(err) }),
    );
  };

  const selected: Alert | null = detail.data ? { ...detail.data, status: overrides.get(String(detail.data.id)) ?? detail.data.status } : null;
  const factors = parseTopFactors(selected?.top_factors_json).map((f) => ({ feature: f.feature, value: f.shap_value }));
  const ids = order.map(Number);
  const pos = positionOf(ids, selectedId);
  const prevId = neighborId(ids, selectedId, -1);
  const nextId = neighborId(ids, selectedId, 1);

  const primaryFor = (a: Alert) => {
    if (a.status === "open")
      return (
        <Button variant="primary" size="sm" onClick={() => act([a], "acknowledge")} {...ro("acknowledge")}>
          <CheckIcon />
          Acknowledge
        </Button>
      );
    if (a.status === "acknowledged")
      return (
        <Button variant="primary" size="sm" onClick={() => raiseWo(a)} {...ro("raise a work order")}>
          <BotIcon />
          Raise work order
        </Button>
      );
    if (a.status === "wo_raised")
      return (
        <Button variant="primary" size="sm" onClick={() => setConfirmClose(a)} {...ro("close alerts")}>
          Close alert
        </Button>
      );
    if (a.status === "dismissed" || a.status === "closed")
      return (
        <Button size="sm" onClick={() => reopen(a)} {...ro("reopen alerts")}>
          Reopen
        </Button>
      );
    return null;
  };

  const menuFor = (a: Alert): MenuItem[] => [
    ...(writable && (a.status === "open" || a.status === "acknowledged") ? [{ label: "Dismiss as not actionable", onSelect: () => act([a], "dismiss") }] : []),
    ...(writable && (a.status === "open" || a.status === "acknowledged") ? [{ label: "Close alert…", onSelect: () => setConfirmClose(a) }] : []),
    { label: "Open component page", onSelect: () => (window.location.hash = hrefFor(`ops/component/${a.component_id}`).slice(1)) },
    { label: "Open aircraft page", onSelect: () => (window.location.hash = hrefFor(`ops/aircraft/${a.aircraft_id}`).slice(1)) },
    {
      label: "Copy link to this alert",
      onSelect: () =>
        void navigator.clipboard
          ?.writeText(`${location.origin}${location.pathname}#/ops/alerts/${a.id}`)
          .then(() => toast.show({ tone: "info", message: "Link copied", durationMs: 2000 })),
    },
  ];

  const columns: Column<Alert>[] = [
    { key: "id", header: "Alert", numeric: true, fit: true, sortValue: (a) => a.id, render: (a) => <span className="mono tnum">#{a.id}</span> },
    {
      key: "component",
      header: "Component",
      grow: true,
      truncate: true,
      sortValue: (a) => a.component_id,
      render: (a) => (
        <>
          <a className="id-link" href={`#/ops/alerts/${a.id}${qs}`} title={a.component_id}>
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
    {
      key: "factor",
      header: "Top factor (SHAP)",
      hideSm: true,
      truncate: true,
      render: (a) => {
        const f = parseTopFactors(a.top_factors_json)[0];
        return f ? (
          <>
            <span className="factor-cell" title={humanizeFeatureName(f.feature)}>
              {humanizeFeatureName(f.feature)}
            </span>
            <span className={`dt-sub mono tnum factor-cell ${f.shap_value >= 0 ? "is-up" : "is-down"}`}>{formatSignedDecimal(f.shap_value)} log-odds</span>
          </>
        ) : (
          <span className="muted">—</span>
        );
      },
    },
    { key: "risk", header: "Risk", numeric: true, hideSm: true, sortValue: (a) => a.risk_score, render: (a) => <RiskMeter score={a.risk_score} threshold={a.threshold} /> },
    { key: "age", header: "Opened", numeric: true, fit: true, hideSm: true, sortValue: (a) => Date.parse(a.opened_at), render: (a) => <RelTime iso={a.opened_at} /> },
  ];

  const filtered = query.q !== "" || filter !== "all";
  const selectedRows = all.filter((a) => selection.has(key(a)));
  const pendingKeys = useMemo(() => new Set(overrides.keys()), [overrides]);
  const clearSelection = useCallback(() => setSelection(new Set()), []);

  return (
    <div className="page">
      <PageHead
        title="Alerts"
        description={
          <>
            One alert per component per scoring window. Acknowledge says “I’ve seen it”; a work order says “we’ll act”.
            <span className="page-facts">
              <span>
                Open <strong className="tnum">{counts.open ?? 0}</strong>
              </span>
              <span>
                Acknowledged <strong className="tnum">{counts.acknowledged ?? 0}</strong>
              </span>
              {all[0] && (
                <span>
                  Rule <code className="mono">risk_score ≥ {all[0].threshold.toFixed(4)}</code>
                </span>
              )}
              <span>
                Opened by <strong>fleet scan</strong>
              </span>
            </span>
          </>
        }
        actions={
          <>
            <Button
              disabled={!writable || (counts.open ?? 0) + (counts.acknowledged ?? 0) === 0}
              title={writable ? undefined : readOnlyReason("triage alerts with the copilot")}
              onClick={() => onAskCopilot("Summarize the open alerts and tell me what to do about each.", undefined, "All open alerts")}
            >
              <BotIcon />
              Triage all with copilot
            </Button>
            <ButtonLink href={hrefFor("ops/fleet")}>Scan from Fleet</ButtonLink>
          </>
        }
      />
      {list.error && <ServiceStatusBanner message={list.error} onRetry={list.reload} />}
      {!writable && <ReadOnlyNotice />}

      <Panel
        flush
        title="Alert inbox"
        sub={<LiveStamp at={list.updatedAt} loading={list.loading && !!list.data} />}
        actions={
          <div className="list-tools">
            <label className="search-field">
              <SearchIcon />
              <input
                className="input"
                type="search"
                name="alert-search"
                placeholder="Search id, component, aircraft…"
                aria-label="Search alerts"
                autoComplete="off"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </label>
            <Segmented<Filter>
              label="Alert stage filter"
              value={filter}
              onChange={(v) => setQuery({ stage: v })}
              options={[
                { id: "all", label: "Active", count: all.length - counts.dismissed },
                ...ALERT_STAGES.map((s) => ({ id: s as Filter, label: STAGE_LABEL[s], count: counts[s] })),
                { id: "dismissed", label: "Dismissed", count: counts.dismissed },
              ]}
            />
          </div>
        }
      >
        <BulkBar count={selection.size} onClear={clearSelection} hint="Only open alerts can be selected.">
          <Button size="sm" variant="primary" onClick={() => act(selectedRows, "acknowledge")}>
            <CheckIcon />
            Acknowledge {selection.size}
          </Button>
          <Button size="sm" onClick={() => act(selectedRows, "dismiss")}>
            Dismiss
          </Button>
        </BulkBar>
        <DataTable
          label="Alerts"
          rows={visible}
          columns={columns}
          rowKey={key}
          onRowClick={(a) => open(a.id)}
          selectedKey={selectedId === null ? null : String(selectedId)}
          sort={parseSort(query.sort)}
          onSortChange={(s) => setQuery({ sort: formatSort(s) })}
          defaultSort={{ key: "age", dir: "desc" }}
          selection={selection}
          onSelectionChange={setSelection}
          canSelect={(a) => writable && a.status === "open"}
          flashKeys={list.flash}
          pendingKeys={pendingKeys}
          onOrderChange={setOrder}
          rowActions={(a) =>
            a.status === "open" ? (
              <Button size="sm" onClick={() => act([a], "acknowledge")} aria-label={`Acknowledge alert ${a.id}`} {...ro("acknowledge")}>
                Acknowledge
              </Button>
            ) : a.status === "acknowledged" ? (
              <Button size="sm" onClick={() => raiseWo(a)} aria-label={`Raise work order for alert ${a.id}`} {...ro("raise a work order")}>
                Raise WO
              </Button>
            ) : null
          }
          loading={list.loading && !list.data}
          skeletonRows={6}
          empty={
            filtered && all.length > 0 ? (
              <EmptyState
                title={query.q ? `No alerts match “${query.q}”` : `No ${(STAGE_LABEL[filter] ?? filter).toLowerCase()} alerts`}
                center
                action={
                  <Button size="sm" onClick={() => setQuery({ q: null, stage: null })}>
                    Clear filters
                  </Button>
                }
              >
                Try a component id such as AC-005-HYD_PUMP, or show every active stage.
              </EmptyState>
            ) : (
              <EmptyState
                title="No alerts yet"
                center
                action={
                  <ButtonLink size="sm" variant="primary" href={hrefFor("ops/fleet")}>
                    Scan the fleet
                  </ButtonLink>
                }
              >
                Alerts appear when a fleet scan scores a component above its threshold, for example a hydraulic pump at 97% against 94%.
              </EmptyState>
            )
          }
        />
      </Panel>

      {selectedId !== null && (
        <Sheet
          label="Alert detail"
          title={selected ? <CopyId value={selected.component_id} /> : <>Alert <span className="tnum">#{selectedId}</span></>}
          subtitle={
            selected && (
              <>
                Alert <span className="tnum">#{selected.id}</span> · {humanizeType(selected.component_type ?? componentTypeFromId(selected.component_id))}
              </>
            )
          }
          status={selected && <Chip tone={alertTone(selected.status)}>{STAGE_LABEL[selected.status] ?? selected.status}</Chip>}
          facts={
            selected
              ? [
                  {
                    label: "Aircraft",
                    value: (
                      <a href={hrefFor(`ops/aircraft/${selected.aircraft_id}`)} className="mono">
                        {selected.aircraft_id}
                      </a>
                    ),
                  },
                  {
                    label: "Risk / threshold",
                    value: (
                      <span className="tnum">
                        {formatPct(selected.risk_score, 1)} <span className="muted">/ {formatPct(selected.threshold, 1)}</span>
                      </span>
                    ),
                  },
                  ...(selected.window_key ? [{ label: "Window", value: <span className="mono">{selected.window_key}</span> }] : []),
                  { label: "Opened", value: <RelTime iso={selected.opened_at} /> },
                ]
              : undefined
          }
          actions={
            selected && (
              <>
                {primaryFor(selected)}
                <OverflowMenu items={menuFor(selected)} label="More alert actions" />
              </>
            )
          }
          nav={
            pos
              ? {
                  index: pos.index,
                  total: pos.total,
                  onPrev: prevId !== null ? () => open(prevId) : undefined,
                  onNext: nextId !== null ? () => open(nextId) : undefined,
                }
              : undefined
          }
          guard={() => (note.trim() ? "Your note for the next action has not been recorded yet." : null)}
          onClose={closeSheet}
          footer={
            selected && (
              <>
                <Button onClick={() => onAskCopilot(askPrompt(selected), selected.id, `Alert #${selected.id} · ${selected.component_id}`)}>
                  <BotIcon />
                  Ask copilot
                </Button>
                <ButtonLink variant="ghost" href={hrefFor(`ops/component/${selected.component_id}`)}>
                  Open component
                </ButtonLink>
              </>
            )
          }
        >
          {detail.loading && !selected && <SheetSkeleton />}
          {detail.error && <ServiceStatusBanner message={detail.error} onRetry={detail.reload} />}
          {selected && (
            <div className="sheet-swap" key={selected.id}>
              {!writable && (
                <p className="sheet-callout" role="note">
                  {readOnlyReason("act on this alert")}
                </p>
              )}
              <SheetSection title="Why it alerted" aside={<span className="muted">SHAP at alert time</span>}>
                {factors.length > 0 ? <FactorBars factors={factors} /> : <p className="muted">No factor breakdown was stored for this alert.</p>}
                {factors[0] && (
                  <p className="sheet-callout">
                    Strongest driver: <strong>{humanizeFeatureName(factors[0].feature)}</strong> ({formatSignedDecimal(factors[0].value)} log-odds).
                  </p>
                )}
              </SheetSection>
              <RelatedProcedures componentType={selected.component_type ?? componentTypeFromId(selected.component_id)} />
              <SheetSection title="Lifecycle">
                <AlertStepper status={selected.status} events={selected.events ?? []} />
              </SheetSection>
              {writable && (selected.status === "open" || selected.status === "acknowledged" || selected.status === "wo_raised") && (
                <SheetSection title="Note for the next action" aside={<span className="muted">optional</span>}>
                  <input
                    className="input"
                    name="alert-note"
                    autoComplete="off"
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    placeholder="Recorded in the activity log…"
                    aria-label="Note for the next action"
                  />
                </SheetSection>
              )}
              <SheetSection title="Activity">
                <ul className="timeline">
                  {[...(selected.events ?? [])].reverse().map((e) => (
                    <li key={e.id}>
                      <RelTime iso={e.at} />
                      <span>
                        <strong>{e.actor}</strong> {e.action.replace(/_/g, " ")}
                        {e.note ? <span className="muted"> · “{e.note}”</span> : null}
                      </span>
                    </li>
                  ))}
                  {(selected.events ?? []).length === 0 && <li className="muted">No activity yet.</li>}
                </ul>
              </SheetSection>
              <SheetSection title="Related work orders">
                {(selected.work_orders ?? []).length > 0 ? (
                  <div className="related-list">
                    {selected.work_orders!.map((w) => (
                      <a key={w.id} className="related-item" href={hrefFor(`ops/work-orders/${w.id}`)}>
                        <span className="mono">{w.id}</span>
                        <span className="row">
                          <Chip tone={w.status === "closed" ? "good" : "info"}>{w.status.replace(/_/g, " ")}</Chip>
                          <span className="muted">{w.priority}</span>
                        </span>
                      </a>
                    ))}
                  </div>
                ) : (
                  <p className="muted">
                    None yet.{" "}
                    {selected.status === "acknowledged" || selected.status === "open" ? (
                      <button type="button" className="link-btn" onClick={() => raiseWo(selected)}>
                        Raise one with the copilot
                      </button>
                    ) : null}
                  </p>
                )}
              </SheetSection>
              <details className="raw">
                <summary>Raw record</summary>
                <pre>{JSON.stringify({ ...selected, events: undefined, work_orders: undefined }, null, 2)}</pre>
              </details>
            </div>
          )}
        </Sheet>
      )}

      {confirmClose && (
        <ConfirmDialog
          title={`Close alert #${confirmClose.id}?`}
          confirmLabel="Close alert"
          onCancel={() => setConfirmClose(null)}
          onConfirm={() => {
            const a = confirmClose;
            setConfirmClose(null);
            act([a], "close");
          }}
        >
          <p>
            <span className="mono">{confirmClose.component_id}</span> on {confirmClose.aircraft_id} leaves the active inbox. You get a few seconds to undo; after that,
            reopening sends it back to Open.
          </p>
        </ConfirmDialog>
      )}
    </div>
  );
}

/** Top knowledge-base procedures for the alert's component type. */
function RelatedProcedures({ componentType }: { componentType: string }) {
  const kb = useAsync(() => searchKb(`${humanizeType(componentType)} removal inspection fault`, 3, componentType), [componentType]);
  return (
    <SheetSection title="Related procedures" aside={<span className="muted">from the knowledge base</span>}>
      {kb.loading && !kb.data && <p className="muted">Searching…</p>}
      {kb.error && <p className="muted">Knowledge-base search is unavailable right now.</p>}
      {kb.data && kb.data.length === 0 && <p className="muted">No procedure matches this component type.</p>}
      {kb.data && kb.data.length > 0 && (
        <div className="rows rows-boxed">
          {kb.data.map((h) => (
            <a key={h.doc_id} className="row-item" href={hrefFor(`ops/knowledge-base/${h.doc_id}`)}>
              <Chip plain icon={null}>
                {h.doc_type}
              </Chip>
              <span className="row-main">
                <span className="row-title mono">{h.doc_id}</span>
                <span className="row-sub">{h.title}</span>
              </span>
            </a>
          ))}
        </div>
      )}
    </SheetSection>
  );
}
