import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createUndoQueue, type UndoJob } from "../../lib/undo-queue";
import { absoluteTime, relativeTime } from "../../lib/time";
import { AlertTriangleIcon, CheckCircleIcon, CloseIcon, InfoIcon, OctagonIcon } from "./icons";
import { Button } from "./primitives";

/* ==== Toast: the one feedback channel for every mutation ================== */
export type ToastTone = "good" | "info" | "warn" | "error";

export interface ToastInput {
  message: ReactNode;
  tone?: ToastTone;
  /** Secondary line, e.g. the object id. */
  detail?: ReactNode;
  /** Link to the result ("View WO-2026-0009"). */
  link?: { label: string; href: string };
  /** Undo action; the toast shows a countdown bar for the undo window. */
  undo?: () => void;
  /** Extra action (e.g. "Retry"). */
  action?: { label: string; onClick: () => void };
  durationMs?: number;
}

interface ToastItem extends ToastInput {
  id: number;
  durationMs: number;
}

interface ToastApi {
  show: (t: ToastInput) => number;
  dismiss: (id: number) => void;
  /** Push a mutation through the undo queue and show its toast. */
  mutate: (job: UndoJob, toast: Omit<ToastInput, "undo">) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

export const UNDO_WINDOW_MS = 6000;

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast outside <ToastProvider>");
  return ctx;
}

const TONE_ICON: Record<ToastTone, ReactNode> = {
  good: <CheckCircleIcon />,
  info: <InfoIcon />,
  warn: <AlertTriangleIcon />,
  error: <OctagonIcon />,
};

function ToastView({ t, onDismiss }: { t: ToastItem; onDismiss: () => void }) {
  const [paused, setPaused] = useState(false);
  const remaining = useRef(t.durationMs);
  const startedAt = useRef(Date.now());

  useEffect(() => {
    if (paused) return;
    startedAt.current = Date.now();
    const id = setTimeout(onDismiss, remaining.current);
    return () => {
      clearTimeout(id);
      remaining.current -= Date.now() - startedAt.current;
    };
  }, [paused, onDismiss]);

  return (
    <div
      className={`toast2 is-${t.tone ?? "good"}`}
      role={t.tone === "error" ? "alert" : "status"}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      <span className="toast2-icon" aria-hidden="true">
        {TONE_ICON[t.tone ?? "good"]}
      </span>
      <div className="toast2-body">
        <div className="toast2-msg">{t.message}</div>
        {t.detail && <div className="toast2-detail">{t.detail}</div>}
      </div>
      <div className="toast2-actions">
        {t.link && (
          <a className="btn btn-sm btn-ghost" href={t.link.href} onClick={onDismiss}>
            {t.link.label}
          </a>
        )}
        {t.action && (
          <Button size="sm" variant="ghost" onClick={() => { t.action!.onClick(); onDismiss(); }}>
            {t.action.label}
          </Button>
        )}
        {t.undo && (
          <Button size="sm" className="toast2-undo" onClick={() => { t.undo!(); onDismiss(); }}>
            Undo
          </Button>
        )}
        <button type="button" className="btn btn-ghost btn-sm btn-icon" aria-label="Dismiss notification" onClick={onDismiss}>
          <CloseIcon />
        </button>
      </div>
      {t.undo && (
        <span
          className="toast2-timer"
          aria-hidden="true"
          style={{ animationDuration: `${t.durationMs}ms`, animationPlayState: paused ? "paused" : "running" }}
        />
      )}
    </div>
  );
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const seq = useRef(0);
  const queue = useMemo(() => createUndoQueue(UNDO_WINDOW_MS), []);

  const dismiss = useCallback((id: number) => setItems((xs) => xs.filter((x) => x.id !== id)), []);
  const show = useCallback((t: ToastInput) => {
    const id = ++seq.current;
    const durationMs = t.durationMs ?? (t.undo ? UNDO_WINDOW_MS : t.tone === "error" ? 9000 : 4500);
    setItems((xs) => [...xs.slice(-2), { ...t, id, durationMs }]);
    return id;
  }, []);

  const mutate = useCallback(
    (job: UndoJob, toast: Omit<ToastInput, "undo">) => {
      queue.push({
        ...job,
        onError: (err) => {
          job.onError?.(err);
          show({ tone: "error", message: "That change did not save.", detail: humanError(err), durationMs: 9000 });
        },
      });
      show({ ...toast, undo: () => void queue.undo(job.id) });
    },
    [queue, show],
  );

  // Never lose a deferred change: commit pending ones when the tab hides.
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === "hidden") queue.flush();
    };
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", queue.flush);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", queue.flush);
    };
  }, [queue]);

  const api = useMemo(() => ({ show, dismiss, mutate }), [show, dismiss, mutate]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="toast2-region" aria-live="polite" aria-label="Notifications">
        {items.map((t) => (
          <ToastView key={t.id} t={t} onDismiss={() => dismiss(t.id)} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

/** Strip transport noise ("409 Conflict: {...}") down to the reason. */
export function humanError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const m = /"detail"\s*:\s*"([^"]+)"/.exec(raw);
  return m ? m[1] : raw;
}

/* ==== Copyable ID ========================================================== */
export function CopyId({ value, label, className }: { value: string; label?: string; className?: string }) {
  const toast = useContext(ToastContext);
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className={`copy-id${copied ? " is-copied" : ""}${className ? ` ${className}` : ""}`}
      title={`Copy ${value}`}
      aria-label={`Copy ${label ?? value}`}
      onClick={(e) => {
        e.stopPropagation();
        e.preventDefault();
        void navigator.clipboard?.writeText(value).then(
          () => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
            toast?.show({ tone: "info", message: <>Copied <span className="mono">{value}</span></>, durationMs: 2000 });
          },
          () => toast?.show({ tone: "warn", message: "Clipboard is blocked in this browser." }),
        );
      }}
    >
      <span className="mono">{label ?? value}</span>
      <svg className="copy-id-ico" viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
        {copied ? (
          <path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        ) : (
          <>
            <rect x="5.5" y="5.5" width="7" height="7" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.3" />
            <path d="M10.5 3.5h-5a2 2 0 0 0-2 2v5" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
          </>
        )}
      </svg>
    </button>
  );
}

/* ==== Relative time with absolute on hover ================================ */
export function RelTime({ iso, prefix }: { iso: string | null | undefined; prefix?: string }) {
  const [, force] = useState(0);
  useEffect(() => {
    const id = setInterval(() => force((n) => n + 1), 30_000);
    return () => clearInterval(id);
  }, []);
  if (!iso) return <span className="muted">n/a</span>;
  const abs = absoluteTime(iso);
  return (
    <time className="reltime" dateTime={iso} title={abs}>
      {prefix ? `${prefix} ` : ""}
      {relativeTime(iso)}
    </time>
  );
}

/* ==== Confirm dialog: names the object; never window.confirm ============== */
export function ConfirmDialog({
  title,
  children,
  confirmLabel,
  danger,
  busy,
  onConfirm,
  onCancel,
}: {
  title: string;
  children?: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const confirmRef = useRef<HTMLButtonElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    confirmRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onCancel();
      }
      if (e.key === "Tab" && boxRef.current) {
        const f = boxRef.current.querySelectorAll<HTMLElement>("button:not([disabled])");
        if (f.length === 0) return;
        const first = f[0];
        const last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      previous?.focus?.();
    };
  }, [onCancel]);
  return (
    <div className="dialog-scrim" onClick={onCancel}>
      <div ref={boxRef} className="dialog" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title" onClick={(e) => e.stopPropagation()}>
        <h2 id="confirm-title" className="dialog-title">
          {title}
        </h2>
        {children && <div className="dialog-body">{children}</div>}
        <div className="dialog-foot">
          <Button onClick={onCancel}>Cancel</Button>
          <Button ref={confirmRef} variant={danger ? "danger" : "primary"} loading={busy} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}

/* ==== Overflow menu (⋯) ===================================================== */
export interface MenuItem {
  label: string;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
  hint?: string;
}

export function OverflowMenu({ items, label = "More actions" }: { items: MenuItem[]; label?: string }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<"down" | "up">("down");
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!open || !btnRef.current) return;
    const r = btnRef.current.getBoundingClientRect();
    setPos(window.innerHeight - r.bottom < 220 ? "up" : "down");
    menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]:not([disabled])')?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node) && !btnRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
        btnRef.current?.focus();
      }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        e.stopPropagation();
        const els = [...(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])') ?? [])];
        const i = els.indexOf(document.activeElement as HTMLElement);
        els[(i + (e.key === "ArrowDown" ? 1 : -1) + els.length) % els.length]?.focus();
      }
    };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  if (items.length === 0) return null;
  return (
    <span className="menu-anchor">
      <button
        ref={btnRef}
        type="button"
        className="btn btn-ghost btn-sm btn-icon"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        title={label}
        onClick={() => setOpen((v) => !v)}
      >
        <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
          <circle cx="3.5" cy="8" r="1.3" fill="currentColor" />
          <circle cx="8" cy="8" r="1.3" fill="currentColor" />
          <circle cx="12.5" cy="8" r="1.3" fill="currentColor" />
        </svg>
      </button>
      {open && (
        <div ref={menuRef} className={`menu is-${pos}`} role="menu" aria-label={label}>
          {items.map((it) => (
            <button
              key={it.label}
              type="button"
              role="menuitem"
              className={`menu-item${it.danger ? " is-danger" : ""}`}
              disabled={it.disabled}
              title={it.hint}
              onClick={() => {
                setOpen(false);
                it.onSelect();
              }}
            >
              {it.label}
            </button>
          ))}
        </div>
      )}
    </span>
  );
}

/* ==== "Updated just now" live stamp ====================================== */
export function LiveStamp({ at, loading }: { at: number | null; loading?: boolean }) {
  const [, force] = useState(0);
  useEffect(() => {
    const id = setInterval(() => force((n) => n + 1), 15_000);
    return () => clearInterval(id);
  }, []);
  return (
    <span className={`live-stamp${loading ? " is-loading" : ""}`} aria-live="off">
      <span className="live-dot" aria-hidden="true" />
      {loading ? "Refreshing…" : at ? `Updated ${relativeTime(new Date(at).toISOString())}` : "Loading…"}
    </span>
  );
}
