import { useMemo, useState } from "react";
import { fleetScan, getFleetTopRisk, listAircraft } from "../lib/api";
import { useAsync } from "../hooks/useAsync";
import { formatDecimal, formatPct } from "../lib/format";
import { hrefFor } from "../lib/routes";
import { humanizeType } from "../lib/risk";
import { filterAircraft, statusSeverity, summarizeAircraft } from "../lib/aircraft-index";
import { DataTable, type Column } from "../components/ui/data-table";
import { Button, Chip, PageHead, Panel, StatBar } from "../components/ui/primitives";
import { RiskMeter, Segmented } from "../components/ui/widgets";
import { EmptyState, Notice, ServiceStatusBanner } from "../components/ui/states";
import { DownloadIcon, RefreshIcon } from "../components/ui/icons";
import type { AircraftIndexRow, FleetRiskItem, FleetRiskResponse } from "../types";

const FLEET_SIZE = 30;

/** True when >=3 of the top rows round to the identical score (3 dp): the
 * model-saturation case this page must disclose rather than present the
 * ordering below the tied rows as if it were meaningful. */
function hasTiedTopScores(data: FleetRiskResponse): boolean {
  const rounded = data.items.slice(0, 10).map((i) => i.risk_score.toFixed(3));
  return rounded.length >= 3 && new Set(rounded).size < rounded.length;
}

function toCsv(data: FleetRiskResponse): string {
  const head = ["rank", "component_id", "aircraft_id", "component_type", "cycle", "risk_score", "alert"];
  const rows = data.items.map((i, idx) =>
    [idx + 1, i.component_id, i.aircraft_id, i.component_type, i.cycle, i.risk_score.toFixed(6), i.alert].join(","),
  );
  return [head.join(","), ...rows].join("\n");
}

type Ranked = { item: FleetRiskItem; rank: number };

function statusChip(status: string) {
  if (status === "serviceable") return <Chip tone="good">Serviceable</Chip>;
  if (status === "restricted") return <Chip tone="warn">Restricted</Chip>;
  if (status === "aog") return <Chip tone="bad">AOG</Chip>;
  return <Chip>{status}</Chip>;
}

interface FleetPageProps {
  view: "components" | "aircraft";
  onAskCopilot: (prompt: string) => void;
}

/** Fleet: components ranked by live model risk (GET /fleet/top-risk) and the
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

function ComponentsView({ onAskCopilot }: { onAskCopilot: (prompt: string) => void }) {
  const fleet = useAsync(() => getFleetTopRisk(FLEET_SIZE), []);
  const [scanBusy, setScanBusy] = useState(false);
  const [scanResult, setScanResult] = useState<string | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [type, setType] = useState("all");
  const [alertsOnly, setAlertsOnly] = useState(false);

  const data = fleet.data;
  const types = useMemo(() => [...new Set((data?.items ?? []).map((i) => i.component_type))].sort(), [data]);
  const rows: Ranked[] = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (data?.items ?? [])
      .map((item, idx) => ({ item, rank: idx + 1 }))
      .filter(({ item }) => (type === "all" || item.component_type === type) && (!alertsOnly || item.alert))
      .filter(({ item }) => !q || item.component_id.toLowerCase().includes(q) || item.aircraft_id.toLowerCase().includes(q));
  }, [data, query, type, alertsOnly]);

  const runFleetScan = async () => {
    setScanBusy(true);
    setScanResult(null);
    setScanError(null);
    try {
      const r = await fleetScan(30);
      setScanResult(`Scored ${r.scored} components. ${r.new_alerts.length} new alert(s), ${r.existing} already open.`);
      fleet.reload();
    } catch (err) {
      setScanError(err instanceof Error ? err.message : String(err));
    } finally {
      setScanBusy(false);
    }
  };

  const exportCsv = () => {
    if (!data) return;
    const url = URL.createObjectURL(new Blob([toCsv(data)], { type: "text/csv" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "fleet-top-risk.csv";
    a.click();
    URL.revokeObjectURL(url);
  };

  const alertCount = (data?.items ?? []).filter((i) => i.alert).length;
  const top = data?.items[0];
  const threshold = data?.threshold ?? 0;

  const columns: Column<Ranked>[] = [
    { key: "rank", header: "#", numeric: true, fit: true, sortValue: (r) => r.rank, render: (r) => <span className="muted">{r.rank}</span> },
    {
      key: "component",
      header: "Component",
      grow: true,
      truncate: true,
      sortValue: (r) => r.item.component_id,
      render: (r) => (
        <a className="id-link" href={hrefFor(`ops/component/${r.item.component_id}`)} title={r.item.component_id}>
          {r.item.component_id}
        </a>
      ),
    },
    {
      key: "aircraft",
      header: "Aircraft",
      hideSm: true,
      fit: true,
      sortValue: (r) => r.item.aircraft_id,
      render: (r) => (
        <a className="id-link" href={hrefFor(`ops/aircraft/${r.item.aircraft_id}`)}>
          {r.item.aircraft_id}
        </a>
      ),
    },
    { key: "type", header: "Type", hideMd: true, sortValue: (r) => r.item.component_type, render: (r) => humanizeType(r.item.component_type) },
    { key: "cycle", header: "Cycle", numeric: true, hideMd: true, fit: true, sortValue: (r) => r.item.cycle, render: (r) => formatDecimal(r.item.cycle, 0) },
    {
      key: "risk",
      header: "Risk",
      numeric: true,
      sortValue: (r) => r.item.risk_score,
      render: (r) => <RiskMeter score={r.item.risk_score} threshold={threshold} />,
    },
    {
      key: "status",
      header: "Status",
      hideSm: true,
      fit: true,
      sortValue: (r) => r.item.alert,
      render: (r) => (r.item.alert ? <Chip tone="bad">Alert</Chip> : <Chip>Below threshold</Chip>),
    },
    {
      key: "truth",
      header: "Held-out label",
      hideMd: true,
      fit: true,
      sortValue: (r) => r.item.true_label,
      render: (r) => (r.item.true_label === 1 ? <Chip tone="warn">Removed in window</Chip> : <span className="muted">No removal</span>),
    },
    {
      key: "act",
      header: <span className="sr-only">Actions</span>,
      fit: true,
      hideSm: true,
      render: (r) => (
        <Button
          size="sm"
          variant="ghost"
          onClick={() =>
            onAskCopilot(
              `Tell me about component ${r.item.component_id} on aircraft ${r.item.aircraft_id} (current risk score ${r.item.risk_score.toFixed(4)}). Should we raise a work order?`,
            )
          }
        >
          Ask copilot
        </Button>
      ),
    },
  ];

  return (
    <>
      <StatBar
        label="Fleet summary"
        items={[
          { label: "Components scored", value: data?.n_scored ?? "…", sub: "latest snapshot each" },
          { label: "Over threshold", value: data ? alertCount : "…", sub: `in the top ${FLEET_SIZE}` },
          { label: "Highest risk", value: top ? formatPct(top.risk_score, 1) : data ? "n/a" : "…", sub: <span className="mono">{top?.component_id ?? ""}</span> },
          { label: "Alert threshold", value: data ? formatPct(data.threshold, 2) : "…", sub: data?.model_id },
        ]}
      />

      {scanResult && (
        <Notice tone="good" role="status" actions={<a href={hrefFor("ops/alerts")}>View alerts</a>}>
          {scanResult}
        </Notice>
      )}
      {scanError && <ServiceStatusBanner message={scanError} />}
      {fleet.error && <ServiceStatusBanner message={fleet.error} onRetry={fleet.reload} />}
      {data && hasTiedTopScores(data) && (
        <Notice tone="plain">
          Several top rows share the same risk score: the model saturates on near-certain removals in this dataset. Ties
          are broken by most recent snapshot, then component id, so the order is stable.
        </Notice>
      )}

      <Panel
        title="Components by risk"
        sub={`Live scored: top ${FLEET_SIZE} of ${data?.n_scored ?? "…"} active test-split components.`}
        flush
        actions={
          <Button variant="primary" size="sm" loading={scanBusy} onClick={runFleetScan}>
            <RefreshIcon />
            {scanBusy ? "Scanning…" : "Scan fleet now"}
          </Button>
        }
      >
        <div className="toolbar">
          <input
            className="input input-sm input-search"
            type="search"
            name="fleet-filter"
            autoComplete="off"
            spellCheck={false}
            placeholder="Filter by component or aircraft…"
            aria-label="Filter by component or aircraft"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <select className="select select-sm" aria-label="Component type" value={type} onChange={(e) => setType(e.target.value)}>
            <option value="all">All component types</option>
            {types.map((t) => (
              <option key={t} value={t}>
                {humanizeType(t)}
              </option>
            ))}
          </select>
          <label className="check">
            <input type="checkbox" checked={alertsOnly} onChange={(e) => setAlertsOnly(e.target.checked)} />
            Alerts only
          </label>
          <span className="toolbar-spacer" />
          <Button size="sm" onClick={exportCsv} disabled={!data}>
            <DownloadIcon />
            Export CSV
          </Button>
        </div>
        <DataTable
          label="Components ranked by risk"
          rows={rows}
          columns={columns}
          rowKey={(r) => r.item.component_id}
          rowHref={(r) => hrefFor(`ops/component/${r.item.component_id}`)}
          defaultSort={{ key: "rank", dir: "asc" }}
          loading={fleet.loading && !data}
          empty={
            <EmptyState title={fleet.error ? "Components could not be loaded" : data && data.items.length === 0 ? "No scored components" : "No components match"} center>
              {fleet.error
                ? "Use Retry above once the service is reachable."
                : data && data.items.length === 0
                ? "The service returned an empty fleet. Check that the model and test split are loaded."
                : `Clear the filters to see all ${data?.items.length ?? 0} ranked components.`}
            </EmptyState>
          }
          footer={
            data
              ? `${rows.length} of ${data.items.length} shown. The held-out label is the test split's real outcome (removed within 30 cycles), shown to sanity-check the ranking; a live fleet would not have it yet.`
              : undefined
          }
        />
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
          { label: "Aircraft", value: index.data ? summary.total : "…", sub: `${summary.scanned} scanned` },
          { label: "Serviceable", value: index.data ? summary.serviceable : "…" },
          { label: "Restricted / AOG", value: index.data ? `${summary.restricted} / ${summary.aog}` : "…" },
          { label: "Open alerts", value: index.data ? summary.openAlerts : "…", sub: `${summary.openWorkOrders} open work orders` },
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
