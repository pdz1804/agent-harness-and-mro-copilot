import { useCallback, useEffect, useMemo, useState } from "react";
import { fleetScan, getFleetPage, listAircraft, listAlerts } from "../lib/api";
import { useAsync } from "../hooks/useAsync";
import { useAcknowledge } from "../hooks/useAcknowledge";
import { useCanWrite } from "../hooks/useCanWrite";
import { useUrlQuery } from "../hooks/useHashRoute";
import { readOnlyReason } from "../lib/identity";
import { formatDecimal, formatPct } from "../lib/format";
import { hrefFor } from "../lib/routes";
import { humanizeType } from "../lib/risk";
import { formatSort, parseSort } from "../lib/url-state";
import { BAND_LABEL, BAND_TONE, FLEET_DEFAULTS, FLEET_PAGE_SIZE, clampPage, fleetCsv, pageCount, pageRangeLabel, toServerSort, triagePrompt } from "../lib/fleet-list";
import { downloadText } from "../lib/csv";
import { filterAircraft, statusSeverity, summarizeAircraft } from "../lib/aircraft-index";
import { DataTable, type Column } from "../components/ui/data-table";
import { Button, Chip, PageHead, Panel, StatBar } from "../components/ui/primitives";
import { BulkBar, RiskMeter, Segmented } from "../components/ui/widgets";
import { EmptyState, LoadingRows, Notice, ServiceStatusBanner } from "../components/ui/states";
import { humanError, useToast } from "../components/ui/feedback";
import {
  ActivityIcon,
  AlertTriangleIcon,
  BotIcon,
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  DownloadIcon,
  GaugeIcon,
  PlaneIcon,
  RefreshIcon,
  ShieldIcon,
  WrenchIcon,
} from "../components/ui/icons";
import type { AircraftIndexRow, Alert, FleetListItem } from "../types";

type AskCopilot = (prompt: string, alertId?: number, context?: string) => void;

/** True when >=3 of the top rows round to the identical score (3 dp): the
 * model-saturation case this page must disclose rather than present the
 * ordering below the tied rows as if it were meaningful. */
function hasTiedTopScores(items: readonly FleetListItem[]): boolean {
  const rounded = items.slice(0, 10).map((i) => i.risk_score.toFixed(3));
  return rounded.length >= 3 && new Set(rounded).size < rounded.length;
}

function statusChip(status: string) {
  if (status === "serviceable") return <Chip tone="good">Serviceable</Chip>;
  if (status === "restricted") return <Chip tone="warn">Restricted</Chip>;
  if (status === "aog") return <Chip tone="bad">AOG</Chip>;
  return <Chip>{status}</Chip>;
}

interface FleetPageProps {
  view: "components" | "aircraft";
  onAskCopilot: AskCopilot;
}

/** Fleet: every component ranked by live model risk (GET /fleet/components,
 * paginated server-side) and the
 * aircraft index (GET /ops/aircraft). A row opens its detail page; the real
 * link in the first column keeps keyboard and middle-click working. */
export function FleetPage({ view, onAskCopilot }: FleetPageProps) {
  const setView = (v: "components" | "aircraft") => {
    window.location.hash = v === "aircraft" ? "#/ops/fleet/aircraft" : "#/ops/fleet";
  };
  return (
    <div className="page">
      <PageHead
        title="Fleet"
        description={
          view === "components"
            ? "Every component ranked by live model risk. Scan, filter, open one to see why."
            : "Every aircraft with its serviceability, open work and highest component risk."
        }
        actions={
          <Segmented
            label="Fleet view"
            value={view}
            onChange={setView}
            options={[
              { id: "components", label: "Components" },
              { id: "aircraft", label: "Aircraft" },
            ]}
          />
        }
      />
      {view === "components" ? <ComponentsView onAskCopilot={onAskCopilot} /> : <AircraftView />}
    </div>
  );
}

function ComponentsView({ onAskCopilot }: { onAskCopilot: AskCopilot }) {
  const toast = useToast();
  const writable = useCanWrite();
  const [query, setQuery] = useUrlQuery(FLEET_DEFAULTS);
  const [search, setSearch] = useState(query.q);
  const [scanBusy, setScanBusy] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [selected, setSelected] = useState<Map<string, FleetListItem>>(new Map());

  useEffect(() => setSearch(query.q), [query.q]);
  useEffect(() => {
    const id = setTimeout(() => {
      if (search !== query.q) setQuery({ q: search || null, page: null });
    }, 200);
    return () => clearTimeout(id);
  }, [search, query.q, setQuery]);

  const sort = parseSort(query.sort) ?? { key: "rank", dir: "asc" as const };
  const server = toServerSort(sort);
  const requested = clampPage(query.page, Number.MAX_SAFE_INTEGER);
  const filters = { band: query.band, componentType: query.type, aircraftType: query.fleet, q: query.q, sort: server.sort, dir: server.dir };
  const fleet = useAsync(
    () => getFleetPage({ ...filters, offset: (requested - 1) * FLEET_PAGE_SIZE, limit: FLEET_PAGE_SIZE }),
    [query.band, query.type, query.fleet, query.q, server.sort, server.dir, requested],
  );
  const openAlerts = useAsync(() => listAlerts("open"), []);
  const reloadOpenAlerts = openAlerts.reload;
  const { acknowledge, pending: ackPending } = useAcknowledge(reloadOpenAlerts);

  const data = fleet.data;
  const pages = data ? pageCount(data.total) : 1;
  const page = Math.min(requested, pages);
  const rows = data?.items ?? [];
  const threshold = data?.threshold ?? 0;
  const alertByComponent = useMemo(() => {
    const m = new Map<string, Alert>();
    for (const a of openAlerts.data ?? []) if (!ackPending.has(a.id)) m.set(a.component_id, a);
    return m;
  }, [openAlerts.data, ackPending]);

  const goPage = (p: number) => setQuery({ page: p <= 1 ? null : String(p) });
  const selection = useMemo(() => new Set(selected.keys()), [selected]);
  const clearSelection = useCallback(() => setSelected(new Map()), []);
  // Selection survives paging: only this page's rows change membership.
  const onSelectionChange = (next: Set<string>) =>
    setSelected((prev) => {
      const m = new Map(prev);
      for (const r of rows) {
        if (next.has(r.component_id)) m.set(r.component_id, r);
        else m.delete(r.component_id);
      }
      return m;
    });

  const selectedItems = [...selected.values()];
  const selectedAlerts = selectedItems.map((i) => alertByComponent.get(i.component_id)).filter((a): a is Alert => !!a);

  const runFleetScan = async () => {
    setScanBusy(true);
    try {
      const r = await fleetScan(30);
      toast.show({
        tone: r.new_alerts.length > 0 ? "warn" : "good",
        message: r.new_alerts.length > 0 ? `${r.new_alerts.length} new alert${r.new_alerts.length === 1 ? "" : "s"} raised` : "Scan complete: no new alerts",
        detail: `${r.scored} components scored · ${r.existing} already open`,
        link: { label: "View alerts", href: "#/ops/alerts?stage=open" },
      });
      fleet.reload();
      reloadOpenAlerts();
    } catch (err) {
      toast.show({ tone: "error", message: "Fleet scan failed.", detail: humanError(err) });
    } finally {
      setScanBusy(false);
    }
  };

  const exportAll = async () => {
    setExporting(true);
    try {
      const all = await getFleetPage({ ...filters, limit: 1000 });
      downloadText("fleet-components.csv", fleetCsv(all.items));
      toast.show({ tone: "info", message: `Exported ${all.items.length} components`, detail: "fleet-components.csv", durationMs: 2500 });
    } catch (err) {
      toast.show({ tone: "error", message: "Export failed.", detail: humanError(err) });
    } finally {
      setExporting(false);
    }
  };

  const exportSelected = () => {
    downloadText("fleet-selection.csv", fleetCsv([...selectedItems].sort((a, b) => a.rank - b.rank)));
  };

  const ackSelected = () => {
    acknowledge(selectedAlerts);
    clearSelection();
  };

  const askOne = (r: FleetListItem) =>
    onAskCopilot(
      `Tell me about component ${r.component_id} on aircraft ${r.aircraft_id} (current risk score ${r.risk_score.toFixed(4)}). Should we raise a work order?`,
      alertByComponent.get(r.component_id)?.id,
      r.component_id,
    );

  const columns: Column<FleetListItem>[] = [
    { key: "rank", header: "#", numeric: true, fit: true, sortValue: (r) => r.rank, render: (r) => <span className="muted">{r.rank}</span> },
    {
      key: "component",
      header: "Component",
      grow: true,
      truncate: true,
      sortValue: (r) => r.component_id,
      render: (r) => (
        <a className="id-link" href={hrefFor(`ops/component/${r.component_id}`)} title={r.component_id}>
          {r.component_id}
        </a>
      ),
    },
    { key: "type", header: "Type", hideMd: true, fit: true, sortValue: (r) => r.component_type, render: (r) => humanizeType(r.component_type) },
    {
      key: "aircraft",
      header: "Aircraft",
      hideSm: true,
      fit: true,
      sortValue: (r) => r.aircraft_id,
      render: (r) => (
        <>
          <a className="id-link" href={hrefFor(`ops/aircraft/${r.aircraft_id}`)}>
            {r.aircraft_id}
          </a>
          {r.aircraft_type && <span className="dt-sub">{r.aircraft_type}</span>}
        </>
      ),
    },
    {
      key: "risk",
      header: data ? `Risk vs ${formatPct(threshold, 2)}` : "Risk",
      headerLabel: "Risk",
      numeric: true,
      sortValue: (r) => r.risk_score,
      render: (r) => <RiskMeter score={r.risk_score} threshold={threshold} digits={2} />,
    },
    {
      key: "status",
      header: "Status",
      hideSm: true,
      fit: true,
      render: (r) => {
        const a = alertByComponent.get(r.component_id);
        return (
          <span className="row" style={{ flexWrap: "nowrap" }}>
            <Chip tone={BAND_TONE[r.band]}>{BAND_LABEL[r.band]}</Chip>
            {a && (
              <a className="muted mono" href={hrefFor(`ops/alerts/${a.id}`)} title={`Open alert #${a.id}`}>
                #{a.id}
              </a>
            )}
          </span>
        );
      },
    },
    { key: "cycle", header: "Cycle", numeric: true, hideMd: true, fit: true, sortValue: (r) => r.cycle, render: (r) => formatDecimal(r.cycle, 1) },
  ];

  const bands: { id: string; label: string; count?: number }[] = [
    { id: "all", label: "All", count: data?.n_scored },
    { id: "alert", label: "Alert", count: data?.counts.alert },
    { id: "watch", label: "Watch", count: data?.counts.watch },
    { id: "normal", label: "Normal", count: data?.counts.normal },
  ];
  const filtered = query.band !== "all" || query.type !== "all" || query.fleet !== "all" || query.q !== "";
  const pager = data && data.total > 0 && (
    <div className="pager">
      <span className="tnum">
        {pageRangeLabel(page, data.total)} · sorted by {sort.key === "rank" ? "risk, descending" : `${sort.key}, ${sort.dir === "asc" ? "ascending" : "descending"}`}
      </span>
      <span className="pager-btns">
        <Button size="sm" variant="ghost" iconOnly aria-label="Previous page" disabled={page <= 1} onClick={() => goPage(page - 1)}>
          <ChevronLeftIcon />
        </Button>
        <span className="tnum">
          {page} / {pages}
        </span>
        <Button size="sm" variant="ghost" iconOnly aria-label="Next page" disabled={page >= pages} onClick={() => goPage(page + 1)}>
          <ChevronRightIcon />
        </Button>
      </span>
    </div>
  );

  const emptyState = (
    <EmptyState title={fleet.error ? "Components could not be loaded" : data && data.n_scored === 0 ? "No scored components" : "No components match"} center>
      {fleet.error
        ? "Use Retry above once the service is reachable."
        : data && data.n_scored === 0
        ? "The service returned an empty fleet. Check that the model and test split are loaded."
        : (
          <>
            Nothing in this band and filter.{" "}
            <button type="button" className="btn btn-link" onClick={() => setQuery({ band: null, type: null, fleet: null, q: null, page: null })}>
              Clear filters
            </button>
          </>
        )}
    </EmptyState>
  );

  return (
    <>
      <StatBar
        label="Fleet summary"
        items={[
          { icon: <AlertTriangleIcon />, label: "Alert", value: data ? data.counts.alert : "…", sub: "at or over the threshold" },
          { icon: <ActivityIcon />, label: `Watch (≥ ${data ? formatPct(data.watch_floor, 0) : "50%"})`, value: data ? data.counts.watch : "…", sub: "below threshold, still high" },
          { icon: <WrenchIcon />, label: "Normal", value: data ? data.counts.normal : "…", sub: `of ${data?.n_scored ?? "…"} scored` },
          { icon: <GaugeIcon />, label: "Alert threshold", value: data ? formatPct(data.threshold, 2) : "…", sub: data?.model_id },
        ]}
      />

      {fleet.error && <ServiceStatusBanner message={fleet.error} onRetry={fleet.reload} />}
      {data && page === 1 && !filtered && sort.key === "rank" && hasTiedTopScores(rows) && (
        <div className="hide-sm">
          <Notice tone="plain">
            Several top rows share the same risk score: the model saturates on near-certain removals in this dataset. Ties
            are broken by most recent snapshot, then component id, so the order is stable.
          </Notice>
        </div>
      )}

      <Panel
        title="Components by risk"
        sub={data ? `All ${data.n_scored} active test-split components, scored live. Filters, sort and page live in the URL.` : "Scoring the fleet…"}
        flush
        actions={
          <>
            <Button size="sm" onClick={exportAll} loading={exporting} disabled={!data || data.total === 0}>
              <DownloadIcon />
              Export CSV
            </Button>
            <Button
              variant="primary"
              size="sm"
              loading={scanBusy}
              onClick={runFleetScan}
              disabled={!writable}
              title={writable ? undefined : readOnlyReason("scan the fleet")}
            >
              <RefreshIcon />
              {scanBusy ? "Scanning…" : "Scan fleet now"}
            </Button>
          </>
        }
      >
        <div className="toolbar">
          <div className="chip-scroll">
            <Segmented label="Risk band" value={query.band} onChange={(v) => setQuery({ band: v, page: null })} options={bands} />
          </div>
          <input
            className="input input-sm input-search"
            type="search"
            name="fleet-filter"
            autoComplete="off"
            spellCheck={false}
            placeholder="Filter by component or aircraft…"
            aria-label="Filter by component or aircraft"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <select className="select select-sm" aria-label="Component type" value={query.type} onChange={(e) => setQuery({ type: e.target.value, page: null })}>
            <option value="all">All component types</option>
            {(data?.component_types ?? []).map((t) => (
              <option key={t} value={t}>
                {humanizeType(t)}
              </option>
            ))}
          </select>
          <select className="select select-sm" aria-label="Aircraft type" value={query.fleet} onChange={(e) => setQuery({ fleet: e.target.value, page: null })}>
            <option value="all">{data?.aircraft_types?.length ? `Fleet: all ${data.aircraft_types.length} types` : "Fleet: all aircraft"}</option>
            {(data?.aircraft_types ?? []).map((t) => (
              <option key={t} value={t}>
                Fleet: {t}
              </option>
            ))}
          </select>
        </div>

        <BulkBar count={selected.size} onClear={clearSelection} hint="Selection survives paging.">
          <Button size="sm" variant="primary" onClick={() => onAskCopilot(triagePrompt(selectedItems), undefined, `${selected.size} components`)} {...(writable ? {} : { disabled: true, title: readOnlyReason("triage with the copilot") })}>
            <BotIcon />
            Ask copilot to triage {selected.size}
          </Button>
          <Button
            size="sm"
            onClick={ackSelected}
            disabled={!writable || selectedAlerts.length === 0}
            title={!writable ? readOnlyReason("acknowledge alerts") : selectedAlerts.length === 0 ? "None of the selected components has an open alert." : undefined}
          >
            <CheckIcon />
            Acknowledge {selectedAlerts.length} alert{selectedAlerts.length === 1 ? "" : "s"}
          </Button>
          <Button size="sm" onClick={exportSelected}>
            <DownloadIcon />
            Export
          </Button>
        </BulkBar>

        <div className="hide-sm">
          <DataTable
            label="Components ranked by risk"
            rows={rows}
            columns={columns}
            rowKey={(r) => r.component_id}
            rowHref={(r) => hrefFor(`ops/component/${r.component_id}`)}
            sort={sort}
            onSortChange={(s) => setQuery({ sort: formatSort(s), page: null })}
            selection={selection}
            onSelectionChange={onSelectionChange}
            loading={fleet.loading && !data}
            rowActions={(r) => (
              <Button size="sm" variant="ghost" onClick={() => askOne(r)}>
                Ask copilot
              </Button>
            )}
            empty={emptyState}
            footer={pager}
          />
        </div>

        <div className="show-sm">
          {fleet.loading && !data && <LoadingRows rows={5} height={64} />}
          {data && rows.length === 0 && emptyState}
          <ul className="fleet-cards" aria-label="Components ranked by risk">
            {rows.map((r) => (
              <li key={r.component_id}>
                <a className="fleet-card" href={hrefFor(`ops/component/${r.component_id}`)}>
                  <span className="fleet-card-top">
                    <span className="mono fleet-card-id">{r.component_id}</span>
                    <Chip tone={BAND_TONE[r.band]}>{BAND_LABEL[r.band]}</Chip>
                  </span>
                  <span className="fleet-card-sub muted">
                    {r.aircraft_type ?? r.aircraft_id} · cycle {formatDecimal(r.cycle, 1)}
                  </span>
                  <RiskMeter score={r.risk_score} threshold={threshold} digits={2} />
                </a>
              </li>
            ))}
          </ul>
          {pager}
        </div>
      </Panel>
    </>
  );
}

function AircraftView() {
  const index = useAsync(() => listAircraft(), []);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("all");

  const all = index.data ?? [];
  const summary = useMemo(() => summarizeAircraft(all), [all]);
  const rows = useMemo(() => filterAircraft(all, query, status), [all, query, status]);

  const columns: Column<AircraftIndexRow>[] = [
    {
      key: "aircraft",
      header: "Aircraft",
      grow: true,
      truncate: true,
      sortValue: (r) => r.aircraft_id,
      render: (r) => (
        <a className="id-link" href={hrefFor(`ops/aircraft/${r.aircraft_id}`)} title={r.aircraft_id}>
          {r.aircraft_id}
        </a>
      ),
    },
    { key: "status", header: "Status", fit: true, sortValue: (r) => statusSeverity(r.status), render: (r) => statusChip(r.status) },
    { key: "alerts", header: "Open alerts", numeric: true, fit: true, sortValue: (r) => r.n_open_alerts, render: (r) => r.n_open_alerts },
    { key: "wos", header: "Open WOs", numeric: true, fit: true, hideSm: true, sortValue: (r) => r.n_open_wos, render: (r) => r.n_open_wos },
    {
      key: "risk",
      header: "Highest component risk",
      numeric: true,
      sortValue: (r) => r.max_risk,
      render: (r) => (r.max_risk === null ? <span className="muted">not scanned yet</span> : <RiskMeter score={r.max_risk} />),
    },
  ];

  return (
    <>
      <StatBar
        label="Aircraft summary"
        items={[
          { icon: <PlaneIcon />, label: "Aircraft", value: index.data ? summary.total : "…", sub: `${summary.scanned} scanned` },
          { icon: <ShieldIcon />, label: "Serviceable", value: index.data ? summary.serviceable : "…" },
          { icon: <AlertTriangleIcon />, label: "Restricted / AOG", value: index.data ? `${summary.restricted} / ${summary.aog}` : "…" },
          { icon: <ActivityIcon />, label: "Open alerts", value: index.data ? summary.openAlerts : "…", sub: `${summary.openWorkOrders} open work orders` },
        ]}
      />
      {index.error && <ServiceStatusBanner message={index.error} onRetry={index.reload} />}
      <Panel title="Aircraft" sub="Worst risk first by default. Click a row to open the aircraft." flush>
        <div className="toolbar">
          <input
            className="input input-sm input-search"
            type="search"
            name="aircraft-filter"
            autoComplete="off"
            spellCheck={false}
            placeholder="Filter by tail number…"
            aria-label="Filter by aircraft"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <select className="select select-sm" aria-label="Serviceability" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="all">All statuses</option>
            <option value="serviceable">Serviceable</option>
            <option value="restricted">Restricted</option>
            <option value="aog">AOG</option>
          </select>
        </div>
        <DataTable
          label="Aircraft index"
          rows={rows}
          columns={columns}
          rowKey={(r) => r.aircraft_id}
          rowHref={(r) => hrefFor(`ops/aircraft/${r.aircraft_id}`)}
          defaultSort={{ key: "risk", dir: "desc" }}
          loading={index.loading && !index.data}
          empty={
            <EmptyState title={index.error ? "Aircraft could not be loaded" : all.length === 0 ? "No aircraft yet" : "No aircraft match"} center>
              {index.error ? "Use Retry above once the service is reachable." : all.length === 0 ? "Run a fleet scan from the Components view to populate the index." : "Clear the filters to see every aircraft."}
            </EmptyState>
          }
          footer={index.data ? `${rows.length} of ${all.length} aircraft.` : undefined}
        />
      </Panel>
    </>
  );
}
