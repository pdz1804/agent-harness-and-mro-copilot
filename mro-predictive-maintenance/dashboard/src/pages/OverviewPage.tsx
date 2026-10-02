import { getActivity, getFleetPage, getGlobalPending, getPerformance, listAlerts, listWorkOrders } from "../lib/api";
import { alertsByType } from "../lib/alerts-by-type";
import { useAsync } from "../hooks/useAsync";
import { useAcknowledge } from "../hooks/useAcknowledge";
import { useCanWrite } from "../hooks/useCanWrite";
import { readOnlyReason } from "../lib/identity";
import { approvalFields } from "../lib/activity";
import { TOOL_LABELS } from "../components/copilot/ApprovalCard";
import { formatDecimal, formatNumber, formatPct } from "../lib/format";
import { hrefFor } from "../lib/routes";
import { ageLabel, alertTone, asLiveOutcomes, componentTypeFromId, humanizeType, STAGE_LABEL } from "../lib/risk";
import { DataTable, type Column } from "../components/ui/data-table";
import { Button, ButtonLink, Chip, PageHead, Panel, StatBar } from "../components/ui/primitives";
import { RiskMeter } from "../components/ui/widgets";
import { EmptyState, LoadingRows, Notice } from "../components/ui/states";
import { ActivityIcon, BellIcon, BotIcon, CheckIcon, ClipboardIcon, GaugeIcon, LockIcon, WrenchIcon } from "../components/ui/icons";
import { RelTime } from "../components/ui/feedback";
import { countSince, dailyCounts } from "../lib/series";
import type { ReactNode } from "react";
import type { ActivityItem, Alert, DashboardData, ModelResult } from "../types";

const ACTIVITY_ICON: Record<string, ReactNode> = {
  alert: <BellIcon />,
  work_order: <WrenchIcon />,
  copilot: <BotIcon />,
  approval: <LockIcon />,
  drift: <ActivityIcon />,
};

function ActivityRow({ item }: { item: ActivityItem }) {
  const body = (
    <>
      <span className="activity-ico" aria-hidden="true">
        {ACTIVITY_ICON[item.kind] ?? <ActivityIcon />}
      </span>
      <span className="row-main">
        <span className="row-title">
          {item.title}
          {item.count > 1 && item.kind !== "alert" && <span className="muted tnum"> ×{item.count}</span>}
        </span>
        <span className="row-sub">{item.detail}</span>
      </span>
      <span className="row-end muted">
        <RelTime iso={item.at} />
      </span>
    </>
  );
  return item.href ? (
    <a className="row-item" href={hrefFor(item.href)}>
      {body}
    </a>
  ) : (
    <div className="row-item">{body}</div>
  );
}

const LANES: { role: string; goal: string; links: { label: string; to: string }[] }[] = [
  {
    role: "Reliability engineer",
    goal: "Decide what to inspect first",
    links: [
      { label: "Fleet risk ranking", to: "ops/fleet" },
      { label: "Alert inbox", to: "ops/alerts" },
      { label: "Ask the copilot", to: "ops/copilot" },
    ],
  },
  {
    role: "Maintenance planner",
    goal: "Turn risk into work, then learn from it",
    links: [
      { label: "Work orders and outcomes", to: "ops/work-orders" },
      { label: "Knowledge base (AMM / MEL)", to: "ops/knowledge-base" },
      { label: "Drift and live precision", to: "model/monitoring" },
    ],
  },
  {
    role: "Reviewer",
    goal: "Judge whether to trust it",
    links: [
      { label: "Performance against target", to: "model/performance" },
      { label: "What-if scoring", to: "model/what-if" },
      { label: "Production design", to: "about/production-design" },
    ],
  },
];

/** One bullet row: value as a bar, the target as a notch. */
function Bullet({ label, value, display, target, targetLabel, scale, primary }: { label: string; value: number; display: string; target: number; targetLabel: string; scale: number; primary?: boolean }) {
  return (
    <div className="bullet" title={targetLabel}>
      <span className="bullet-label">{label}</span>
      <div className="bullet-track" aria-hidden="true">
        <div className={`bullet-fill${primary ? " is-primary" : ""}`} style={{ width: `${Math.min(100, (value / scale) * 100)}%` }} />
        <div className="bullet-target" style={{ left: `${Math.min(100, (target / scale) * 100)}%` }} />
      </div>
      <span className="bullet-val">{display}</span>
    </div>
  );
}

export function OverviewPage({ data, pendingCount }: { data: DashboardData; pendingCount: number }) {
  const { dataset, target, models } = data;
  const primary: ModelResult = models.find((m) => m.is_primary) ?? models[0];
  const { splits } = dataset;
  const caught = Math.round(primary.test_recall * primary.test_n_positive);

  const live = useAsync(async () => {
    const [alerts, wos, perf] = await Promise.all([listAlerts(), listWorkOrders(), getPerformance()]);
    return { alerts, wos, perf };
  }, []);
  const approvals = useAsync(() => getGlobalPending(), [pendingCount]);
  const activity = useAsync(() => getActivity(8), []);
  // Only the type list and fleet size are needed; limit=1 keeps the payload small.
  const fleetMix = useAsync(() => getFleetPage({ limit: 1 }), []);
  const writable = useCanWrite();
  const reloadLive = live.reload;
  const reloadActivity = activity.reload;
  const { acknowledge, pending: ackPending } = useAcknowledge(() => {
    reloadLive();
    reloadActivity();
  });
  const pendingApprovals = (approvals.data ?? []).filter((p) => !p.is_stale && p.kind === "approval");

  const openAlerts = (live.data?.alerts ?? []).filter((a) => a.status !== "closed");
  const alertTimes = (live.data?.alerts ?? []).map((a) => a.opened_at);
  const openWos = (live.data?.wos ?? []).filter((w) => w.status !== "closed");
  const outcomes = asLiveOutcomes(live.data?.perf.live_outcomes);
  const attention = openAlerts
    .filter((a) => a.status === "open" && !ackPending.has(a.id))
    .sort((a, b) => b.risk_score - a.risk_score || Date.parse(b.opened_at) - Date.parse(a.opened_at))
    .slice(0, 5);
  const lastOpened = alertTimes.length > 0 ? alertTimes.reduce((m, t) => (Date.parse(t) > Date.parse(m) ? t : m)) : null;
  const woTimes = (live.data?.wos ?? []).map((w) => w.created_at);
  const newAlerts = countSince(alertTimes);
  const byType = alertsByType(live.data?.alerts ?? [], fleetMix.data?.component_types ?? []);
  const typeMax = Math.max(1, ...byType.map((t) => t.count));
  const perType = fleetMix.data && fleetMix.data.component_types.length > 0 ? Math.round(fleetMix.data.n_scored / fleetMix.data.component_types.length) : null;

  const splitTotal = splits.train.rows + splits.val.rows + splits.test.rows;
  const parts = [
    { label: "Train", rows: splits.train.rows, aircraft: splits.train.aircraft, color: "var(--series-accent)" },
    { label: "Validation (threshold chosen here)", rows: splits.val.rows, aircraft: splits.val.aircraft, color: "var(--series-baseline)" },
    { label: "Test (held out)", rows: splits.test.rows, aircraft: splits.test.aircraft, color: "var(--text)" },
  ];
  const alertScale = Math.max(target.max_alerts_per_100, ...models.map((m) => m.test_alerts_per_100)) * 1.15;

  const columns: Column<Alert>[] = [
    {
      key: "component",
      header: "Component",
      grow: true,
      truncate: true,
      render: (a) => (
        <>
          <a className="id-link" href={hrefFor(`ops/alerts/${a.id}`)} title={a.component_id}>
            {a.component_id}
          </a>
          <span className="dt-sub">{humanizeType(a.component_type ?? componentTypeFromId(a.component_id))} · open {ageLabel(a.opened_at)}</span>
        </>
      ),
    },
    { key: "stage", header: "Stage", fit: true, hideSm: true, render: (a) => <Chip tone={alertTone(a.status)}>{STAGE_LABEL[a.status] ?? a.status}</Chip> },
    { key: "risk", header: "Risk", numeric: true, render: (a) => <RiskMeter score={a.risk_score} threshold={a.threshold} /> },
  ];

  return (
    <div className="page">
      <PageHead
        title="Overview"
        description={
          <>
            Predicts which aircraft components need an unscheduled removal within 30 flight cycles, explains each score, and routes the risky ones into alerts, work orders and an approval-gated copilot.
            <span className="page-facts">
              {lastOpened && (
                <span>
                  Last alert raised <strong><RelTime iso={lastOpened} /></strong>
                </span>
              )}
              <span>
                Model <strong className="mono">{primary.id}</strong>
              </span>
              <span>
                Alert threshold <strong className="tnum">{formatPct(primary.chosen_threshold, 2)}</strong>
              </span>
            </span>
          </>
        }
        actions={
          <>
            <ButtonLink href={hrefFor("model/performance")}>See the evidence</ButtonLink>
            <ButtonLink variant="primary" href={hrefFor("ops/fleet")}>
              Open the fleet
            </ButtonLink>
          </>
        }
      />

      <StatBar
        label="Operations right now"
        items={[
          {
            label: "Open alerts",
            icon: <BellIcon />,
            value: live.loading ? "…" : openAlerts.length,
            sub: "not yet closed",
            href: hrefFor("ops/alerts"),
            trend: live.data ? dailyCounts(alertTimes) : undefined,
            trendTone: "bad",
            delta: live.data ? { text: `+${newAlerts} in 24h`, tone: newAlerts > 0 ? "warn" : "neutral" } : undefined,
          },
          { label: "Awaiting approval", icon: <LockIcon />, value: pendingCount, sub: "copilot actions needing a human", href: hrefFor("ops/copilot") },
          {
            label: "Open work orders",
            icon: <ClipboardIcon />,
            value: live.loading ? "…" : openWos.length,
            sub: "waiting for an outcome",
            href: hrefFor("ops/work-orders"),
            trend: live.data ? dailyCounts(woTimes) : undefined,
          },
          {
            icon: <GaugeIcon />,
            label: "Live precision",
            value: outcomes?.live_precision != null ? formatPct(outcomes.live_precision, 0) : "n/a",
            sub: outcomes ? `${outcomes.closed_with_outcome} closed with outcome` : "from closed work orders",
            href: hrefFor("model/monitoring"),
          },
        ]}
      />

      <div className="grid-main-side">
        <div className="stack" style={{ gap: "var(--s-5)" }}>
        <Panel
          flush
          title="Needs attention"
          sub="Open alerts, highest risk first. Acknowledge is optimistic with undo."
          actions={
            <ButtonLink size="sm" href={hrefFor("ops/alerts")}>
              All alerts
            </ButtonLink>
          }
        >
          {live.error ? (
            <div style={{ padding: 16 }}>
              <Notice tone="warn">The service is not reachable, so live operations are unavailable. The model evidence on this page is static and still shown.</Notice>
            </div>
          ) : (
            <DataTable
              label="Open alerts needing attention"
              rows={attention}
              columns={columns}
              rowKey={(a) => String(a.id)}
              rowHref={(a) => hrefFor(`ops/alerts/${a.id}`)}
              loading={live.loading && !live.data}
              skeletonRows={3}
              rowActions={(a) => (
                <Button
                  size="sm"
                  onClick={() => acknowledge([a])}
                  aria-label={`Acknowledge alert ${a.id}`}
                  {...(writable ? {} : { disabled: true, title: readOnlyReason("acknowledge") })}
                >
                  <CheckIcon />
                  Acknowledge
                </Button>
              )}
              empty={
                <EmptyState title="Nothing open" center>
                  Run a fleet scan from the Fleet page to raise new alerts.
                </EmptyState>
              }
            />
          )}
        </Panel>

        <Panel
          title="Alerts by component type"
          sub={perType != null ? `Active alerts per type · ${perType} components per type in the scored fleet` : "Active alerts per type in the scored fleet"}
        >
          {live.error ? (
            <Notice tone="plain">Unavailable while the service is unreachable.</Notice>
          ) : live.loading && !live.data ? (
            <LoadingRows rows={3} height={20} />
          ) : byType.length === 0 ? (
            <EmptyState title="No alerts yet" center>
              Run a fleet scan to raise alerts.
            </EmptyState>
          ) : (
            <ul className="type-bars" aria-label="Active alerts by component type">
              {byType.map((t) => (
                <li key={t.type}>
                  <a className="type-bar-label mono" href={`${hrefFor("ops/fleet")}?type=${encodeURIComponent(t.type)}`} title={`${humanizeType(t.type)} in the fleet`}>
                    {t.type}
                  </a>
                  <span className="type-bar-track" aria-hidden="true">
                    <span className="type-bar-fill" style={{ width: `${(t.count / typeMax) * 100}%` }} />
                  </span>
                  <span className="type-bar-count tnum">{t.count}</span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
        </div>

        <Panel
          title="Held-out result"
          sub={`${primary.label}, deployed`}
          actions={primary.target_met ? <Chip tone="good">Target met</Chip> : <Chip tone="bad">Target not met</Chip>}
        >
          <div className="bullet-group">
            <div className="bullet-group-label">Recall (target at least {formatPct(target.min_recall, 0)})</div>
            {models.map((m) => (
              <Bullet key={m.id} label={m.is_primary ? `${m.label} (deployed)` : m.label} value={m.test_recall} display={formatPct(m.test_recall)} target={target.min_recall} targetLabel={`target ${formatPct(target.min_recall, 0)}`} scale={1} primary={m.is_primary} />
            ))}
          </div>
          <div className="bullet-group">
            <div className="bullet-group-label">Alerts per 100 (target at most {formatDecimal(target.max_alerts_per_100, 1)})</div>
            {models.map((m) => (
              <Bullet key={m.id} label={m.is_primary ? `${m.label} (deployed)` : m.label} value={m.test_alerts_per_100} display={formatDecimal(m.test_alerts_per_100)} target={target.max_alerts_per_100} targetLabel={`target ${formatDecimal(target.max_alerts_per_100, 1)}`} scale={alertScale} primary={m.is_primary} />
            ))}
          </div>
          <dl className="kv" style={{ marginTop: 16 }}>
            <dt>Precision</dt>
            <dd>
              {formatPct(primary.test_precision)} <span className="muted">({primary.test_n_alerts} alerts raised)</span>
            </dd>
            <dt>Removals caught</dt>
            <dd>
              {caught} of {primary.test_n_positive} <span className="muted">real unscheduled removals</span>
            </dd>
          </dl>
          <p className="legend" style={{ marginTop: 12 }}>
            <span>
              <i className="swatch" style={{ width: 2, height: 12, background: "var(--text)" }} />
              target
            </span>
          </p>
        </Panel>
      </div>

      <div className="grid-2">
        <Panel
          title="Copilot approvals"
          sub="Actions the copilot proposed that wait for a human."
          actions={pendingApprovals.length > 0 ? <Chip tone="warn">{pendingApprovals.length} awaiting</Chip> : undefined}
          flush
        >
          {approvals.error && (
            <div style={{ padding: 16 }}>
              <Notice tone="plain">Approvals are unavailable while the service is unreachable.</Notice>
            </div>
          )}
          {approvals.loading && !approvals.data && <LoadingRows rows={2} height={40} />}
          {approvals.data && pendingApprovals.length === 0 && (
            <EmptyState title="Nothing awaiting approval" center>
              When the copilot proposes a work order or a status change, it waits here for an engineer.
            </EmptyState>
          )}
          <div className="rows">
            {pendingApprovals.slice(0, 3).map((p) => (
              <div className="approval-mini" key={p.id}>
                <div className="row row-between">
                  <span className="row-title">{TOOL_LABELS[p.tool_name ?? ""] ?? p.tool_name ?? "Tool call"}</span>
                  <code className="mono muted">{p.tool_name}</code>
                </div>
                <dl className="kv is-compact">
                  {approvalFields(p.args).map((f) => (
                    <div key={f.key} style={{ display: "contents" }}>
                      <dt>{f.label}</dt>
                      <dd className="mono">{f.value}</dd>
                    </div>
                  ))}
                </dl>
                <div className="row row-between">
                  <ButtonLink size="sm" variant="primary" href={`${hrefFor("ops/copilot")}${p.run_id ? `?run=${encodeURIComponent(p.run_id)}` : ""}`}>
                    Review in copilot
                  </ButtonLink>
                  {p.run_id && <span className="muted mono" title={p.run_id}>{p.run_id.slice(0, 12)}…</span>}
                </div>
              </div>
            ))}
          </div>
        </Panel>

        <Panel title="Activity" sub="Alert, work-order, copilot and drift events, newest first." flush>
          {activity.error && (
            <div style={{ padding: 16 }}>
              <Notice tone="plain">The activity feed is unavailable while the service is unreachable.</Notice>
            </div>
          )}
          {activity.loading && !activity.data && <LoadingRows rows={4} height={36} />}
          {activity.data && activity.data.length === 0 && (
            <EmptyState title="No activity yet" center>
              Scan the fleet or acknowledge an alert and it shows up here.
            </EmptyState>
          )}
          <div className="rows">
            {(activity.data ?? []).map((item) => (
              <ActivityRow key={`${item.group}-${item.at}`} item={item} />
            ))}
          </div>
        </Panel>
      </div>

      <Panel title="Where to start" sub="Pick the job; each path is two or three clicks." flush>
        <div className="lanes">
          {LANES.map((l) => (
            <section className="lane" key={l.role} aria-label={l.role}>
              <h3 className="lane-role">{l.role}</h3>
              <p className="lane-goal">{l.goal}</p>
              <ul>
                {l.links.map((k) => (
                  <li key={k.to}>
                    <a href={hrefFor(k.to)}>{k.label}</a>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </Panel>

      <div className="grid-2">
        <Panel title="Leakage-safe split" sub="Whole aircraft stay in one split, ordered by delivery date. The threshold is chosen on validation only, then applied to test without re-tuning.">
          <div className="split-bar" role="img" aria-label="Train, validation and test row shares">
            {parts.map((p) => (
              <span key={p.label} style={{ width: `${(p.rows / splitTotal) * 100}%`, background: p.color }} />
            ))}
          </div>
          <div className="legend" style={{ marginTop: 10, flexDirection: "column", gap: 4 }}>
            {parts.map((p) => (
              <span key={p.label}>
                <i className="swatch" style={{ background: p.color }} />
                {p.label}: {formatNumber(p.rows)} rows, {p.aircraft} aircraft
              </span>
            ))}
          </div>
        </Panel>
        <Panel title="The data" sub={`Synthetic and seeded (seed ${dataset.seed}); no real fleet data was supplied.`}>
          <dl className="kv">
            <dt>Aircraft</dt>
            <dd>{formatNumber(dataset.aircraft)}</dd>
            <dt>Components</dt>
            <dd>{formatNumber(dataset.components_total)}</dd>
            <dt>Positive rate</dt>
            <dd>{formatDecimal(dataset.positive_rate_pct, 2)}%</dd>
          </dl>
          <p style={{ marginTop: 12 }}>
            <a href={hrefFor("about/architecture")}>How a prediction travels, stage by stage</a>
          </p>
        </Panel>
      </div>
    </div>
  );
}
