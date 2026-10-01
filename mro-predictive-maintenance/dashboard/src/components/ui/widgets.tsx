import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { formatPct, formatSignedDecimal, humanizeFeatureName } from "../../lib/format";
import { ALERT_STAGES, STAGE_LABEL, riskTone } from "../../lib/risk";
import type { AlertEvent } from "../../types";
import { ChevronLeftIcon, ChevronRightIcon, CloseIcon } from "./icons";
import { ConfirmDialog } from "./feedback";
import { matchShortcut } from "../../lib/keyboard-nav";

/* ---- Segmented tablist ---------------------------------------------------- */
export interface SegmentedOption<T extends string> {
  id: T;
  label: string;
  count?: number;
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: SegmentedOption<T>[];
  onChange: (id: T) => void;
  label: string;
}) {
  return (
    <div className="seg" role="tablist" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          role="tab"
          aria-selected={value === o.id}
          className="seg-btn"
          onClick={() => onChange(o.id)}
        >
          {o.label}
          {o.count !== undefined && <span className="seg-count">{o.count}</span>}
        </button>
      ))}
    </div>
  );
}

/* ---- Risk bar: value drawn against its alert threshold ---------------------- */
export function RiskMeter({
  score,
  threshold,
  digits = 1,
  large,
  hideValue,
}: {
  score: number;
  threshold?: number;
  digits?: number;
  large?: boolean;
  hideValue?: boolean;
}) {
  const pct = Math.min(100, Math.max(0, score * 100));
  const tone = threshold !== undefined ? riskTone(score, threshold) : score >= 0.5 ? "bad" : "good";
  const fill = tone === "bad" ? " is-bad" : tone === "warn" ? " is-warn" : "";
  return (
    <div className={`risk${large ? " is-lg" : ""}`}>
      <div className="risk-track" aria-hidden="true">
        <div className={`risk-fill${fill}`} style={{ width: `${pct}%` }} />
        {threshold !== undefined && <div className="risk-notch" style={{ left: `${threshold * 100}%` }} />}
      </div>
      {!hideValue && <span className="risk-val">{formatPct(score, digits)}</span>}
      {threshold !== undefined && (
        <span className="sr-only">
          {`threshold ${formatPct(threshold, 2)}, ${score >= threshold ? "at or above" : "below"} it`}
        </span>
      )}
    </div>
  );
}

/* ---- Signed SHAP bars ------------------------------------------------------------ */
export interface Factor {
  feature: string;
  value: number;
}

/** Up (red) pushes risk up, down (teal) pulls it down. The signed number is
 * always printed, so the direction never rides on colour alone. */
export function FactorBars({ factors, maxAbs }: { factors: Factor[]; maxAbs?: number }) {
  const max = maxAbs ?? Math.max(...factors.map((f) => Math.abs(f.value)), 1e-9);
  return (
    <div>
      <div className="factors" role="list">
        {factors.map((f) => {
          const w = max === 0 ? 0 : (Math.abs(f.value) / max) * 100;
          const up = f.value >= 0;
          return (
            <div className="factor" key={f.feature} role="listitem">
              <span className="factor-name" title={f.feature}>
                {humanizeFeatureName(f.feature)}
              </span>
              <span className="factor-track" aria-hidden="true">
                <span className={`factor-fill ${up ? "is-up" : "is-down"}`} style={{ width: `${w}%`, [up ? "left" : "right"]: 0 }} />
              </span>
              <span className="factor-val">{formatSignedDecimal(f.value)}</span>
            </div>
          );
        })}
      </div>
      <div className="legend" style={{ marginTop: 8 }}>
        <span>
          <i className="swatch" style={{ background: "var(--bad)" }} />
          + raises risk
        </span>
        <span>
          <i className="swatch" style={{ background: "var(--series-accent)" }} />
          − lowers risk
        </span>
      </div>
    </div>
  );
}

/* ---- Alert lifecycle ---------------------------------------------------------------- */
const ACTION_FOR_STAGE: Record<string, string[]> = {
  open: ["opened", "open", "raised"],
  acknowledged: ["acknowledge", "acknowledged"],
  wo_raised: ["raise_wo", "wo_raised"],
  closed: ["close", "closed"],
};

export function AlertStepper({ status, events }: { status: string; events: AlertEvent[] }) {
  const currentIdx = Math.max(0, ALERT_STAGES.indexOf(status as (typeof ALERT_STAGES)[number]));
  return (
    <ol className="stepper" aria-label="Alert lifecycle">
      {ALERT_STAGES.map((stage, i) => {
        const done = i <= currentIdx;
        const ev = [...events].reverse().find((e) => ACTION_FOR_STAGE[stage].includes(e.action));
        return (
          <li
            key={stage}
            className={`step${done ? " is-done" : ""}${i === currentIdx ? " is-current" : ""}`}
            aria-current={i === currentIdx ? "step" : undefined}
          >
            <span className="step-dot" aria-hidden="true" />
            <span className="step-label">{STAGE_LABEL[stage]}</span>
            {done && ev && (
              <span className="step-meta">
                {ev.actor}
                <br />
                {new Date(ev.at).toLocaleDateString()}
              </span>
            )}
          </li>
        );
      })}
    </ol>
  );
}

export function StagePips({ status }: { status: string }) {
  const idx = ALERT_STAGES.indexOf(status as (typeof ALERT_STAGES)[number]);
  return (
    <span className="pips" aria-hidden="true">
      {ALERT_STAGES.map((s, i) => (
        <span key={s} className={`pip${i <= idx ? " is-on" : ""}`} />
      ))}
    </span>
  );
}

/* ---- Sheet: the one detail surface ------------------------------------------------
 * Right side sheet (bottom sheet on phones) that keeps the list visible.
 * Same anatomy everywhere: title + status chip, key facts row, primary
 * action and an overflow menu, then sections. Esc closes, Left/Right (or
 * k/j) step through the list it was opened from. */
export interface SheetFact {
  label: string;
  value: ReactNode;
}

export interface SheetNav {
  index: number;
  total: number;
  onPrev?: () => void;
  onNext?: () => void;
}

export function Sheet({
  title,
  subtitle,
  status,
  facts,
  actions,
  onClose,
  children,
  footer,
  label,
  nav,
  guard,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  /** Status chip next to the title. */
  status?: ReactNode;
  /** Key facts row under the title. */
  facts?: SheetFact[];
  /** Header actions: primary button and the overflow menu. */
  actions?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  label: string;
  nav?: SheetNav;
  /** Return a message to block closing ("Discard changes?"), or null. */
  guard?: () => string | null;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const sheetRef = useRef<HTMLElement>(null);
  const [leaving, setLeaving] = useState(false);
  const [guardMsg, setGuardMsg] = useState<{ msg: string; then: () => void } | null>(null);
  const latest = useRef({ onClose, nav, guard });
  latest.current = { onClose, nav, guard };

  const closeNow = useCallback(() => {
    const reduce = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce) {
      latest.current.onClose();
      return;
    }
    setLeaving(true);
    setTimeout(() => latest.current.onClose(), 160);
  }, []);

  /** Run `then` unless a dirty form blocks it; then ask first. */
  const guarded = useCallback((then: () => void) => {
    const msg = latest.current.guard?.() ?? null;
    if (msg) setGuardMsg({ msg, then });
    else then();
  }, []);

  const step = useCallback(
    (dir: 1 | -1) => {
      const n = latest.current.nav;
      const go = dir === 1 ? n?.onNext : n?.onPrev;
      if (go) guarded(go);
    },
    [guarded],
  );

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    sheetRef.current?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (document.querySelector(".dialog-scrim, .palette-scrim")) return;
      const sc = matchShortcut(e, e.target as HTMLElement);
      if (sc === "close") {
        e.preventDefault();
        guarded(closeNow);
      } else if (sc === "prev" || sc === "next") {
        if (!latest.current.nav) return;
        e.preventDefault();
        step(sc === "next" ? 1 : -1);
      } else if (e.key === "Tab" && sheetRef.current) {
        const f = [
          ...sheetRef.current.querySelectorAll<HTMLElement>(
            "a[href], button:not([disabled]), input:not([disabled]), textarea, select",
          ),
        ];
        if (f.length === 0) return;
        if (e.shiftKey && document.activeElement === f[0]) {
          e.preventDefault();
          f[f.length - 1].focus();
        } else if (!e.shiftKey && document.activeElement === f[f.length - 1]) {
          e.preventDefault();
          f[0].focus();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      if (previous && document.contains(previous)) previous.focus({ preventScroll: true });
    };
  }, [closeNow, guarded, step]);

  return (
    <div className={`scrim${leaving ? " is-leaving" : ""}`} onClick={() => guarded(closeNow)}>
      <aside ref={sheetRef} tabIndex={-1} className="sheet" role="dialog" aria-modal="true" aria-label={label} onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <div className="sheet-head-top">
            {nav ? (
              <div className="sheet-nav" role="group" aria-label="Step through the list">
                <button
                  type="button"
                  className="btn btn-ghost btn-sm btn-icon"
                  aria-label="Previous item"
                  title="Previous (Left arrow)"
                  disabled={!nav.onPrev}
                  onClick={() => step(-1)}
                >
                  <ChevronLeftIcon />
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm btn-icon"
                  aria-label="Next item"
                  title="Next (Right arrow)"
                  disabled={!nav.onNext}
                  onClick={() => step(1)}
                >
                  <ChevronRightIcon />
                </button>
                <span className="sheet-pos tnum">
                  {nav.index} of {nav.total}
                </span>
              </div>
            ) : (
              <span className="sheet-kicker">{label}</span>
            )}
            <div className="sheet-head-actions">
              {actions}
              <button
                ref={closeRef}
                type="button"
                className="btn btn-ghost btn-sm btn-icon"
                aria-label="Close"
                title="Close (Esc)"
                onClick={() => guarded(closeNow)}
              >
                <CloseIcon />
              </button>
            </div>
          </div>
          <div className="sheet-titlebar">
            <h2 className="sheet-title">{title}</h2>
            {status}
          </div>
          {subtitle && <div className="panel-sub">{subtitle}</div>}
          {facts && facts.length > 0 && (
            <dl className="sheet-facts">
              {facts.map((f) => (
                <div key={f.label} className="sheet-fact">
                  <dt>{f.label}</dt>
                  <dd>{f.value}</dd>
                </div>
              ))}
            </dl>
          )}
        </div>
        <div className="sheet-body">{children}</div>
        {footer && <div className="sheet-foot">{footer}</div>}
      </aside>
      {guardMsg && (
        <div onClick={(e) => e.stopPropagation()}>
          <ConfirmDialog
            title="Discard changes?"
            confirmLabel="Discard"
            danger
            onCancel={() => setGuardMsg(null)}
            onConfirm={() => {
              const then = guardMsg.then;
              setGuardMsg(null);
              latest.current.guard = undefined;
              then();
            }}
          >
            {guardMsg.msg}
          </ConfirmDialog>
        </div>
      )}
    </div>
  );
}

/** Sheet section with the standard heading. */
export function SheetSection({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="sheet-section">
      <div className="sheet-section-head">
        <h3 className="sheet-section-title">{title}</h3>
        {aside}
      </div>
      {children}
    </section>
  );
}

/* ---- Bulk bar: the one selection toolbar (Alerts, Fleet) ------------------ */
export function BulkBar({ count, onClear, hint, children }: { count: number; onClear: () => void; hint?: ReactNode; children: ReactNode }) {
  // Esc clears the selection unless a dialog or sheet is handling it.
  useEffect(() => {
    if (count === 0) return;
    const on = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (document.querySelector("[role=dialog]")) return;
      onClear();
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [count, onClear]);
  if (count === 0) return null;
  return (
    <div className="bulkbar" role="region" aria-label="Bulk actions">
      <span className="bulkbar-count tnum" aria-live="polite">
        {count} selected
      </span>
      {children}
      <button type="button" className="btn btn-ghost btn-sm" onClick={onClear}>
        <CloseIcon />
        Clear <kbd className="kbd hide-sm">Esc</kbd>
      </button>
      {hint && <span className="bulkbar-hint muted hide-sm">{hint}</span>}
    </div>
  );
}
