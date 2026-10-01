import { useState, type ReactNode } from "react";
import { AREAS, hrefFor, type AreaDef, type AreaId } from "../../lib/routes";
import { useHealth } from "../../hooks/useHealth";
import { SEEDED_USERS, getCurrentUser, setCurrentUser } from "../../lib/identity";
import { BookIcon, ChartIcon, HomeIcon, LockIcon, PlaneIcon, WrenchIcon } from "../ui/icons";

interface AppShellProps {
  area: AreaDef;
  /** Page id highlighted in the contextual sub-nav. */
  activePageId: string;
  /** Last visited page per area, so a primary tab returns you where you were. */
  lastPageByArea: Partial<Record<AreaId, string>>;
  pendingCount: number;
  /** Cockpit pages fill the viewport and scroll internally. */
  fill: boolean;
  children: ReactNode;
}

const AREA_ICON: Record<AreaId, ReactNode> = {
  overview: <HomeIcon />,
  ops: <WrenchIcon />,
  model: <ChartIcon />,
  about: <BookIcon />,
};

function IdentityPicker() {
  const [user, setUser] = useState(getCurrentUser());
  return (
    <label className="identity">
      <span className="identity-label">Acting as</span>
      <select
        className="select"
        aria-label="Acting as"
        value={user}
        onChange={(e) => {
          setCurrentUser(e.target.value);
          setUser(e.target.value);
        }}
      >
        {SEEDED_USERS.map((u) => (
          <option key={u.id} value={u.id}>
            {u.label}
          </option>
        ))}
      </select>
    </label>
  );
}

/** Three navigation levels, never a long flat list:
 *   1. primary areas (top bar; bottom tab bar on phones)
 *   2. the current area's pages (underline tabs)
 *   3. page-level views (segmented controls inside a page)
 * The top bar and sub-nav are solid and sit outside <main>, which is the only
 * scroll container, so content can never bleed through them. */
export function AppShell({ area, activePageId, lastPageByArea, pendingCount, fill, children }: AppShellProps) {
  const health = useHealth();
  const homeFor = (a: AreaDef) => lastPageByArea[a.id] ?? a.home;
  const healthState = health.online === null ? "pending" : health.online ? "ok" : "down";

  return (
    <div className="shell">
      <a className="skip-link" href="#app-main" onClick={(e) => {
        e.preventDefault();
        document.getElementById("app-main")?.focus();
      }}>
        Skip to content
      </a>
      <header className="topbar">
        <a className="brand" href={hrefFor("overview")} aria-label="MRO Predictive Maintenance, overview">
          <span className="brand-mark">
            <PlaneIcon />
          </span>
          <span className="brand-name">MRO Predictive Maintenance</span>
        </a>

        <nav className="primary-nav" aria-label="Primary">
          {AREAS.map((a) => (
            <a key={a.id} href={hrefFor(homeFor(a))} aria-current={a.id === area.id ? "page" : undefined} title={a.job}>
              {a.label}
            </a>
          ))}
        </nav>

        <div className="topbar-spacer" />

        <span className={`health is-${healthState}`} role="status" title={health.label}>
          <span className="health-dot" aria-hidden="true" />
          <span className="health-text">{health.label}</span>
        </span>
        <IdentityPicker />
        <a
          className={`pending-pill${pendingCount > 0 ? " is-active" : ""}`}
          href={hrefFor("ops/copilot")}
          title="Copilot actions awaiting a human decision"
        >
          <LockIcon />
          <span className="pending-pill-text">{pendingCount > 0 ? `${pendingCount} awaiting approval` : "No pending approvals"}</span>
          <span className="sr-only">{pendingCount > 0 ? `${pendingCount} awaiting approval` : "No pending approvals"}</span>
          {pendingCount > 0 && <span aria-hidden="true">{pendingCount}</span>}
        </a>
      </header>

      {area.pages.length > 1 ? (
        <nav className="subnav" aria-label={`${area.label} sections`}>
          <div className="subnav-inner">
            {area.pages.map((p) => (
              <a key={p.id} href={hrefFor(p.id)} aria-current={p.id === activePageId ? "page" : undefined}>
                {p.label}
                {p.id === "ops/copilot" && pendingCount > 0 && <span className="badge-count is-warn">{pendingCount}</span>}
              </a>
            ))}
          </div>
        </nav>
      ) : (
        <div />
      )}

      <main id="app-main" tabIndex={-1} className={`main${fill ? " main--fill" : ""}`}>
        {children}
      </main>

      <nav className="tabbar" aria-label="Primary (mobile)">
        {AREAS.map((a) => (
          <a key={a.id} href={hrefFor(homeFor(a))} aria-current={a.id === area.id ? "page" : undefined}>
            {AREA_ICON[a.id]}
            {a.label}
          </a>
        ))}
      </nav>
    </div>
  );
}
