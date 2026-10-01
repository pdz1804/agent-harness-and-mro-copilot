import type { ReactNode } from "react";
import { AlertTriangleIcon, InfoIcon, OctagonIcon } from "./icons";
import { Button } from "./primitives";

/** Empty state: says what is missing and what to do next. */
export function EmptyState({
  title,
  children,
  action,
  icon,
  center,
}: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
  icon?: ReactNode;
  center?: boolean;
}) {
  return (
    <div className={`empty${center ? " is-center" : ""}`}>
      <span className="empty-icon" aria-hidden="true">
        {icon ?? <InfoIcon />}
      </span>
      <span className="empty-title">{title}</span>
      {children && <span className="empty-body">{children}</span>}
      {action}
    </div>
  );
}

/** Skeleton shaped like the rows it replaces (never a centred spinner). */
export function LoadingRows({ rows = 5, height = 28, label = "Loading…" }: { rows?: number; height?: number; label?: string }) {
  return (
    <div className="skeleton-rows" role="status" aria-busy="true" aria-label={label}>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="skeleton" style={{ height }} />
      ))}
      <span className="sr-only">{label}</span>
    </div>
  );
}

type NoticeTone = "info" | "warn" | "error" | "good" | "plain";

/** Inline notice. Icon + text, so the tone never rides on colour alone. */
export function Notice({
  tone = "info",
  children,
  actions,
  role,
}: {
  tone?: NoticeTone;
  children: ReactNode;
  actions?: ReactNode;
  role?: "alert" | "status" | "note";
}) {
  const icon = tone === "error" ? <OctagonIcon /> : tone === "warn" ? <AlertTriangleIcon /> : <InfoIcon />;
  return (
    <div className={`notice${tone === "info" ? "" : ` notice-${tone}`}`} role={role ?? (tone === "error" ? "alert" : undefined)}>
      {icon}
      <div className="notice-body">{children}</div>
      {actions && <div className="notice-actions">{actions}</div>}
    </div>
  );
}

/** Error state used by every page: human copy first, technical detail
 * collapsed, and a Retry whenever a retry can help. */
export function ServiceStatusBanner({
  message,
  detail,
  onRetry,
}: {
  message: string;
  detail?: string;
  onRetry?: () => void;
}) {
  return (
    <Notice
      tone="error"
      role="alert"
      actions={
        onRetry && (
          <Button size="sm" onClick={onRetry}>
            Retry
          </Button>
        )
      }
    >
      <p>{message}</p>
      {detail && (
        <details>
          <summary>Technical details</summary>
          <pre>{detail}</pre>
        </details>
      )}
    </Notice>
  );
}

/** Skeleton shaped like a detail sheet body: factor bars, stepper, list. */
export function SheetSkeleton() {
  return (
    <div className="stack" style={{ gap: 20 }} aria-busy="true">
      <LoadingRows rows={4} height={14} label="Loading detail…" />
      <div className="skeleton" style={{ height: 44 }} />
      <LoadingRows rows={3} height={12} />
    </div>
  );
}

/** Shown at the top of pages with write controls when the acting identity is
 * the read-only viewer. The disabled controls carry the per-action reason. */
export function ReadOnlyNotice() {
  const focusPicker = () => document.querySelector<HTMLSelectElement>(".identity select")?.focus();
  return (
    <Notice
      tone="plain"
      role="status"
      actions={
        <button type="button" className="btn btn-sm" onClick={focusPicker}>
          Switch identity
        </button>
      }
    >
      You’re viewing as <strong>viewer</strong>, which is read-only. Actions show who can do them.
    </Notice>
  );
}
