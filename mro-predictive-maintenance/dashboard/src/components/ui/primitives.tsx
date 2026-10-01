import { useEffect, useId, useState, type AnchorHTMLAttributes, type ButtonHTMLAttributes, type ReactNode } from "react";
import type { Tone } from "../../lib/risk";
import { AlertTriangleIcon, CheckCircleIcon, ChevronRightIcon, InfoIcon, OctagonIcon, RingIcon } from "./icons";

/* ---- Button: primary (one per view) / secondary / ghost / danger / link --- */
type Variant = "primary" | "secondary" | "ghost" | "danger" | "link";
type Size = "sm" | "md" | "lg";

function btnClass(variant: Variant, size: Size, extra?: string, iconOnly?: boolean): string {
  return [
    "btn",
    variant === "secondary" ? "" : `btn-${variant}`,
    size === "md" ? "" : `btn-${size}`,
    iconOnly ? "btn-icon" : "",
    extra ?? "",
  ]
    .filter(Boolean)
    .join(" ");
}

interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "type"> {
  variant?: Variant;
  size?: Size;
  /** Swaps nothing visually but sets aria-busy and blocks double submit. */
  loading?: boolean;
  /** Icon-only buttons must pass a label. */
  iconOnly?: boolean;
  type?: "button" | "submit";
}

export function Button({
  variant = "secondary",
  size = "md",
  loading,
  iconOnly,
  className,
  disabled,
  type = "button",
  children,
  title,
  "aria-label": ariaLabel,
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={btnClass(variant, size, className, iconOnly)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      aria-label={ariaLabel}
      title={title ?? (iconOnly ? ariaLabel : undefined)}
      {...rest}
    >
      {children}
    </button>
  );
}

interface ButtonLinkProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
  variant?: Variant;
  size?: Size;
}

export function ButtonLink({ variant = "secondary", size = "md", className, children, ...rest }: ButtonLinkProps) {
  return (
    <a className={btnClass(variant, size, className)} {...rest}>
      {children}
    </a>
  );
}

/* ---- Chip: icon + word, never colour alone ------------------------------- */
const TONE_ICON: Record<Tone, ReactNode> = {
  good: <CheckCircleIcon />,
  bad: <OctagonIcon />,
  warn: <AlertTriangleIcon />,
  info: <InfoIcon />,
  neutral: <RingIcon />,
};

export function Chip({
  tone = "neutral",
  children,
  icon,
  plain,
  title,
}: {
  tone?: Tone;
  children: ReactNode;
  /** Override the default icon, or pass null for a count-style chip. */
  icon?: ReactNode | null;
  plain?: boolean;
  title?: string;
}) {
  const glyph = icon === undefined ? TONE_ICON[tone] : icon;
  return (
    <span className={`chip chip-${tone}${plain ? " chip-plain" : ""}`} title={title}>
      {glyph}
      {children}
    </span>
  );
}

/* ---- Panel: flat, bordered, never nested --------------------------------- */
export function Panel({
  title,
  sub,
  actions,
  flush,
  children,
  className,
  id,
  labelledBy,
}: {
  title?: ReactNode;
  sub?: ReactNode;
  actions?: ReactNode;
  flush?: boolean;
  children: ReactNode;
  className?: string;
  id?: string;
  labelledBy?: string;
}) {
  const headingId = id ? `${id}-title` : undefined;
  return (
    <section className={`panel${className ? ` ${className}` : ""}`} id={id} aria-labelledby={labelledBy ?? (title ? headingId : undefined)}>
      {(title || actions) && (
        <header className="panel-head">
          <div>
            {title && (
              <h2 className="panel-title" id={headingId}>
                {title}
              </h2>
            )}
            {sub && <div className="panel-sub">{sub}</div>}
          </div>
          {actions && <div className="panel-actions">{actions}</div>}
        </header>
      )}
      <div className={`panel-body${flush ? " flush" : ""}`}>{children}</div>
    </section>
  );
}

/* ---- Stat strip ------------------------------------------------------------ */
export interface StatItem {
  label: ReactNode;
  value: ReactNode;
  sub?: ReactNode;
  small?: boolean;
  href?: string;
  pressed?: boolean;
  onClick?: () => void;
  key?: string;
  /** Leading icon in the label row. */
  icon?: ReactNode;
  /** A real series (oldest first) drawn as a sparkline. Never fabricate one. */
  trend?: number[];
  trendTone?: "accent" | "bad" | "warn" | "good";
  /** Short change note shown as a chip, e.g. "+3 in 24h". */
  delta?: { text: string; tone?: Tone };
}

const NUMERIC = /^(-?\d+(?:\.\d+)?)(%?)$/;

/** Ticks a plain number (or "12.5%") up from zero once, 500ms, ease-out.
 * Anything else renders as-is; reduced motion renders the final value. */
export function CountUp({ value }: { value: ReactNode }) {
  const text = typeof value === "number" ? String(value) : typeof value === "string" ? value : null;
  const match = text ? NUMERIC.exec(text) : null;
  const target = match ? Number(match[1]) : 0;
  const decimals = match && match[1].includes(".") ? match[1].split(".")[1].length : 0;
  const [shown, setShown] = useState<number | null>(null);

  useEffect(() => {
    if (!match) return;
    const reduce = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce || target === 0) {
      setShown(target);
      return;
    }
    let raf = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / 500);
      const eased = 1 - Math.pow(1 - t, 3);
      setShown(target * eased);
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, decimals, match?.[2]]);

  if (!match) return <>{value}</>;
  const n = shown ?? 0;
  return (
    <>
      <span aria-hidden="true">
        {n.toFixed(decimals)}
        {match[2]}
      </span>
      <span className="sr-only">{text}</span>
    </>
  );
}

/** Smooth sparkline with a soft gradient fill. Decorative: the value and
 * sub-line beside it carry the meaning. */
export function Sparkline({ points, tone = "accent" }: { points: number[]; tone?: "accent" | "bad" | "warn" | "good" }) {
  const id = useId();
  if (points.length < 2) return null;
  const w = 120;
  const h = 34;
  const max = Math.max(...points);
  const min = Math.min(...points);
  const span = max - min || 1;
  const xy = points.map((p, i) => [(i / (points.length - 1)) * w, h - 3 - ((p - min) / span) * (h - 8)] as const);
  let d = `M${xy[0][0]},${xy[0][1]}`;
  for (let i = 1; i < xy.length; i++) {
    const [x0, y0] = xy[i - 1];
    const [x1, y1] = xy[i];
    const cx = (x0 + x1) / 2;
    d += ` C${cx},${y0} ${cx},${y1} ${x1},${y1}`;
  }
  const last = xy[xy.length - 1];
  return (
    <svg className={`spark is-${tone}`} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id={id} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor="currentColor" stopOpacity="0.22" />
          <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={`${d} L${w},${h} L0,${h} Z`} fill={`url(#${id})`} stroke="none" />
      <path d={d} fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
      <circle cx={last[0]} cy={last[1]} r="2.5" fill="var(--surface)" stroke="currentColor" strokeWidth="1.75" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

export function StatBar({ items, label }: { items: StatItem[]; label: string }) {
  return (
    <div className="statbar" role="group" aria-label={label}>
      {items.map((s, i) => {
        const inner = (
          <>
            <div className="stat-label">
              {s.icon && <span className="stat-icon">{s.icon}</span>}
              {s.label}
            </div>
            <div className="stat-row">
              <div className={`stat-value${s.small ? " sm" : ""}`}>
                <CountUp value={s.value} />
              </div>
              {s.trend && s.trend.length > 1 && <Sparkline points={s.trend} tone={s.trendTone} />}
            </div>
            {(s.sub !== undefined || s.delta) && (
              <div className="stat-sub">
                {s.delta && (
                  <Chip tone={s.delta.tone ?? "neutral"} icon={null}>
                    {s.delta.text}
                  </Chip>
                )}
                {s.sub}
              </div>
            )}
          </>
        );
        const key = s.key ?? String(i);
        if (s.href) {
          return (
            <a key={key} className="stat" href={s.href}>
              {inner}
            </a>
          );
        }
        if (s.onClick) {
          return (
            <button key={key} type="button" className="stat" aria-pressed={s.pressed ?? false} onClick={s.onClick}>
              {inner}
            </button>
          );
        }
        return (
          <div key={key} className="stat">
            {inner}
          </div>
        );
      })}
    </div>
  );
}

/* ---- Page head --------------------------------------------------------------- */
export interface Crumb {
  label: string;
  href?: string;
}

export function PageHead({
  title,
  description,
  crumbs,
  actions,
}: {
  title: ReactNode;
  description?: ReactNode;
  crumbs?: Crumb[];
  actions?: ReactNode;
}) {
  return (
    <header className="page-head">
      <div className="page-head-text">
        {crumbs && crumbs.length > 0 && (
          <nav className="crumbs" aria-label="Breadcrumb">
            {crumbs.map((c, i) => (
              <span key={`${c.label}-${i}`} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                {c.href ? <a href={c.href}>{c.label}</a> : <span aria-current="page">{c.label}</span>}
                {i < crumbs.length - 1 && <ChevronRightIcon />}
              </span>
            ))}
          </nav>
        )}
        <h1 className="page-title">{title}</h1>
        {description && <p className="page-desc">{description}</p>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </header>
  );
}

/* ---- Switch -------------------------------------------------------------------- */
export function Switch({
  checked,
  onChange,
  children,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  children: ReactNode;
  disabled?: boolean;
}) {
  return (
    <label className="switch">
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="switch-ui" aria-hidden="true" />
      <span>{children}</span>
    </label>
  );
}
