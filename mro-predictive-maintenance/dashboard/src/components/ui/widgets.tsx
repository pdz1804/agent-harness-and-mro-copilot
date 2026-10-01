import { useEffect, useRef, type ReactNode } from "react";
import { formatPct, formatSignedDecimal, humanizeFeatureName } from "../../lib/format";
import { ALERT_STAGES, STAGE_LABEL, riskTone } from "../../lib/risk";
import type { AlertEvent } from "../../types";
import { CloseIcon } from "./icons";

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

/* ---- Sheet: right dialog (bottom-aligned full width on phones) ----------------------- */
export function Sheet({
  title,
  subtitle,
  onClose,
  children,
  footer,
  label,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  label: string;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCloseRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      previous?.focus?.();
    };
  }, []);

  return (
    <div className="scrim" onClick={onClose}>
      <aside className="sheet" role="dialog" aria-modal="true" aria-label={label} onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <div style={{ minWidth: 0 }}>
            <h2 className="sheet-title">{title}</h2>
            {subtitle && <div className="panel-sub">{subtitle}</div>}
          </div>
          <button
            ref={closeRef}
            type="button"
            className="btn btn-ghost btn-sm btn-icon"
            aria-label="Close"
            title="Close"
            onClick={onClose}
          >
            <CloseIcon />
          </button>
        </div>
        <div className="sheet-body">{children}</div>
        {footer && <div className="sheet-foot">{footer}</div>}
      </aside>
    </div>
  );
}
