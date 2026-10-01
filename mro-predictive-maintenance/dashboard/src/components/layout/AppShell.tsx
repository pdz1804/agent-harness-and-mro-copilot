import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { AREAS, hrefFor, type AreaDef, type AreaId } from "../../lib/routes";
import { useHealth } from "../../hooks/useHealth";
import { IDENTITY_CHANGE_EVENT, SEEDED_USERS, getCurrentUser, setCurrentUser } from "../../lib/identity";
import { isGroupOpen, loadCollapsed, saveCollapsed, toggleGroup } from "../../lib/nav-groups";
import { BookIcon, ChartIcon, ChevronDownIcon, HomeIcon, LockIcon, PlaneIcon, SearchIcon, WrenchIcon } from "../ui/icons";
import { CommandPalette, ShortcutSheet, type PaletteAction } from "./CommandPalette";
import { matchShortcut } from "../../lib/keyboard-nav";

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
  onPaletteAction: (action: PaletteAction, query: string) => void;
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

/** Fold state of the left-nav groups, persisted per acting user. */
function useNavFolds(activeGroupId: string) {
  const [user, setUser] = useState(getCurrentUser);
  const [collapsed, setCollapsed] = useState(() => loadCollapsed(getCurrentUser()));
  useEffect(() => {
    const onIdentity = () => {
      const u = getCurrentUser();
      setUser(u);
      setCollapsed(loadCollapsed(u));
    };
    window.addEventListener(IDENTITY_CHANGE_EVENT, onIdentity);
    return () => window.removeEventListener(IDENTITY_CHANGE_EVENT, onIdentity);
  }, []);
  const toggle = useCallback(
    (groupId: string) => {
      setCollapsed((prev) => {
        const next = toggleGroup(groupId, activeGroupId, prev);
        saveCollapsed(user, next);
        return next;
      });
    },
    [activeGroupId, user],
  );
  return { isOpen: (id: string) => isGroupOpen(id, activeGroupId, collapsed), toggle };
}

interface SideNavProps {
  area: AreaDef;
  activePageId: string;
  pendingCount: number;
  homeFor: (a: AreaDef) => string;
}

/** Desktop left nav: one group per area with a small fold chevron. The
 * active group cannot fold, so the current page is always visible. */
function SideNav({ area, activePageId, pendingCount, homeFor }: SideNavProps) {
  const { isOpen, toggle } = useNavFolds(area.id);
  return (
    <nav className="sidenav" aria-label="Primary">
      <a className="brand" href={hrefFor("overview")} aria-label="MRO Predictive Maintenance, overview">
        <span className="brand-mark">
          <PlaneIcon />
        </span>
        <span className="brand-name">
          MRO <span className="brand-name-soft">Predictive Maintenance</span>
        </span>
      </a>
      <div className="sidenav-scroll">
        {AREAS.map((a) => {
          if (a.pages.length <= 1) {
            return (
              <a
                key={a.id}
                className="sidenav-item sidenav-top"
                href={hrefFor(homeFor(a))}
                aria-current={a.id === area.id ? "page" : undefined}
                title={a.job}
              >
                {AREA_ICON[a.id]}
                {a.label}
              </a>
            );
          }
          const open = isOpen(a.id);
          const active = a.id === area.id;
          const listId = `sidenav-group-${a.id}`;
          return (
            <div key={a.id} className={`sidenav-group${open ? " is-open" : ""}${active ? " is-active" : ""}`}>
              <button
                type="button"
                className="sidenav-group-head"
                aria-expanded={open}
                aria-controls={listId}
                title={active ? `${a.job} The current section stays open.` : a.job}
                onClick={() => toggle(a.id)}
              >
                {AREA_ICON[a.id]}
                <span className="sidenav-group-label">{a.label}</span>
                <ChevronDownIcon className="sidenav-chev" />
              </button>
              <div className="sidenav-fold" id={listId}>
                <ul className="sidenav-list">
                  {a.pages.map((p) => (
                    <li key={p.id}>
                      <a className="sidenav-item" href={hrefFor(p.id)} aria-current={p.id === activePageId ? "page" : undefined}>
                        {p.label}
                        {p.id === "ops/copilot" && pendingCount > 0 && <span className="badge-count is-warn">{pendingCount}</span>}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          );
        })}
      </div>
    </nav>
  );
}

/** Three navigation levels, never a long flat list:
 *   1. primary areas (top bar; bottom tab bar on phones)
 *   2. the current area's pages (segmented tabs with a sliding indicator)
 *   3. page-level views (segmented controls inside a page)
 * The top bar and sub-nav are solid and sit outside <main>, which is the only
 * scroll container, so content can never bleed through them. */
export function AppShell({ area, activePageId, lastPageByArea, pendingCount, fill, children, onPaletteAction }: AppShellProps) {
  const health = useHealth();
  const homeFor = (a: AreaDef) => lastPageByArea[a.id] ?? a.home;
  const healthState = health.online === null ? "pending" : health.online ? "ok" : "down";
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const subnavRef = useRef<HTMLDivElement>(null);
  const [indicator, setIndicator] = useState<{ x: number; w: number } | null>(null);
  const mainRef = useRef<HTMLElement>(null);
  const [scrolled, setScrolled] = useState(false);

  // Floating chrome frosts harder once content scrolls beneath it.
  useEffect(() => {
    const el = mainRef.current;
    if (!el) return;
    const onScroll = () => setScrolled(el.scrollTop > 4);
    onScroll();
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [activePageId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const sc = matchShortcut(e, e.target as HTMLElement);
      if (sc === "palette") {
        e.preventDefault();
        setHelpOpen(false);
        setPaletteOpen((v) => !v);
      } else if (sc === "help" && !document.querySelector(".palette-scrim, .dialog-scrim")) {
        e.preventDefault();
        setHelpOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // The sub-nav indicator slides to the current tab (transform + width only).
  useLayoutEffect(() => {
    const measure = () => {
      const el = subnavRef.current?.querySelector<HTMLElement>('a[aria-current="page"]');
      setIndicator(el ? { x: el.offsetLeft, w: el.offsetWidth } : null);
    };
    measure();
    window.addEventListener("resize", measure);
    void document.fonts?.ready.then(measure);
    return () => window.removeEventListener("resize", measure);
  }, [activePageId, area.id, pendingCount]);

  const pendingText = pendingCount > 0 ? `${pendingCount} awaiting approval` : "No pending approvals";

  return (
    <div className={`shell${area.pages.length > 1 ? "" : " shell--nosub"}`} data-scrolled={scrolled || undefined}>
      <a className="skip-link" href="#app-main" onClick={(e) => {
        e.preventDefault();
        document.getElementById("app-main")?.focus();
      }}>
        Skip to content
      </a>
      <SideNav area={area} activePageId={activePageId} pendingCount={pendingCount} homeFor={homeFor} />
      <header className="topbar">
        <a className="brand brand--top" href={hrefFor("overview")} aria-label="MRO Predictive Maintenance, overview">
          <span className="brand-mark">
            <PlaneIcon />
          </span>
          <span className="brand-name">
            MRO <span className="brand-name-soft">Predictive Maintenance</span>
          </span>
        </a>

        <nav className="primary-nav" aria-label="Primary">
          {AREAS.map((a) => (
            <a key={a.id} href={hrefFor(homeFor(a))} aria-current={a.id === area.id ? "page" : undefined} title={a.job}>
              {AREA_ICON[a.id]}
              {a.label}
            </a>
          ))}
        </nav>

        <div className="topbar-spacer" />

        <button
          type="button"
          className="cmd-btn"
          onClick={() => setPaletteOpen(true)}
          aria-label="Search or run a command"
          aria-keyshortcuts="Control+K Meta+K"
        >
          <SearchIcon />
          <span className="cmd-btn-text">Search or run…</span>
          <kbd className="kbd">Ctrl K</kbd>
        </button>

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
          <span className="pending-pill-text">{pendingText}</span>
          <span className="sr-only">{pendingText}</span>
          {pendingCount > 0 && (
            <span className="pending-pill-count" aria-hidden="true">
              {pendingCount}
            </span>
          )}
        </a>
      </header>
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onAction={(a, q) => (a === "shortcuts" ? setHelpOpen(true) : onPaletteAction(a, q))}
      />
      {helpOpen && <ShortcutSheet onClose={() => setHelpOpen(false)} />}

      {area.pages.length > 1 ? (
        <nav className="subnav" aria-label={`${area.label} sections`}>
          <div className="subnav-inner" ref={subnavRef}>
            {indicator && (
              <span
                className="subnav-indicator"
                aria-hidden="true"
                style={{ transform: `translateX(${indicator.x}px)`, width: indicator.w }}
              />
            )}
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

      <main ref={mainRef} id="app-main" tabIndex={-1} className={`main${fill ? " main--fill" : ""}`}>
        {children}
      </main>

      <nav className="tabbar" aria-label="Primary (mobile)">
        {AREAS.map((a) => (
          <a key={a.id} href={hrefFor(homeFor(a))} aria-current={a.id === area.id ? "page" : undefined}>
            <span className="tabbar-icon">{AREA_ICON[a.id]}</span>
            {a.label}
          </a>
        ))}
      </nav>
    </div>
  );
}
