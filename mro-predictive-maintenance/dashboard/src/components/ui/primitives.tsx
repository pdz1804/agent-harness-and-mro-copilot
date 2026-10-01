import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ReactNode } from "react";
import type { Tone } from "../../lib/risk";
import { AlertTriangleIcon, CheckCircleIcon, InfoIcon, OctagonIcon, RingIcon } from "./icons";

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
}

export function StatBar({ items, label }: { items: StatItem[]; label: string }) {
  return (
    <div className="statbar" role="group" aria-label={label}>
      {items.map((s, i) => {
        const inner = (
          <>
            <div className="stat-label">{s.label}</div>
            <div className={`stat-value${s.small ? " sm" : ""}`}>{s.value}</div>
            {s.sub !== undefined && <div className="stat-sub">{s.sub}</div>}
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
                {i < crumbs.length - 1 && <span aria-hidden="true">/</span>}
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
