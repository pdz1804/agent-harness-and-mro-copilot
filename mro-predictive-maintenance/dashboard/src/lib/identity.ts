// Minimal identity for the dashboard's header picker -- mirrors the seeded
// users + roles in `src/copilot/identity.py` (that module is the source of
// truth the backend enforces against; this list is cosmetic/UI-only and
// duplicated here rather than fetched, so the picker renders instantly
// without waiting on a network round trip). `X-User` is sent on every
// mutating request (see `lib/api.ts`'s `authHeaders()`); the backend
// independently rejects an approval-kind resolve from "viewer" with a 403
// regardless of what this picker shows.
export interface SeededUser {
  id: string;
  label: string;
  role: "engineer" | "viewer";
}

export const SEEDED_USERS: SeededUser[] = [
  { id: "lead.engineer", label: "Lead engineer", role: "engineer" },
  { id: "planner", label: "Planner", role: "engineer" },
  { id: "viewer", label: "Viewer (read-only)", role: "viewer" },
];

export const DEFAULT_USER = "lead.engineer";

const STORAGE_KEY = "mro.dashboard.currentUser";

/** Fired on `window` whenever the acting identity changes, so pages that
 * cached a stale error banner (e.g. a 403 from the previous identity) can
 * clear it instead of showing a permission error against someone who never
 * tried that action. */
export const IDENTITY_CHANGE_EVENT = "mro:identity-change";

export function getCurrentUser(): string {
  try {
    return localStorage.getItem(STORAGE_KEY) || DEFAULT_USER;
  } catch {
    // localStorage unavailable (private mode, disabled storage, etc.) --
    // fall back to the default rather than throwing.
    return DEFAULT_USER;
  }
}

export function setCurrentUser(user: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, user);
  } catch {
    // Best-effort persistence only; the in-memory picker state still works
    // for the rest of this session even if storage is unavailable.
  }
  window.dispatchEvent(new CustomEvent(IDENTITY_CHANGE_EVENT, { detail: user }));
}

export function currentUserRole(): SeededUser["role"] {
  const id = getCurrentUser();
  return SEEDED_USERS.find((u) => u.id === id)?.role ?? "engineer";
}

/** Whether the currently-acting identity may approve/deny an approval-kind
 * pending item -- mirrors `src/copilot/identity.py::can_approve` (the
 * backend is the real enforcement point and independently returns 403; this
 * is only so the UI can disable the action up front with an explanation
 * instead of letting a viewer submit and then get rejected). */
export function canApprove(): boolean {
  return currentUserRole() !== "viewer";
}

/** Whether the acting identity may change operational data (acknowledge,
 * dismiss or close alerts, raise or close work orders, set aircraft status,
 * scan the fleet). Mirrors `src/copilot/identity.py::can_write`; the API
 * returns 403 for a viewer either way. */
export function canWrite(user: string = getCurrentUser()): boolean {
  return (SEEDED_USERS.find((u) => u.id === user)?.role ?? "engineer") !== "viewer";
}

export const READ_ONLY_PREFIX = "Viewer is read-only";

/** Tooltip / hint shown on a control a viewer cannot use. */
export function readOnlyReason(action: string): string {
  return `${READ_ONLY_PREFIX}. lead.engineer or planner can ${action}.`;
}

/** True when a disabled control's title is a role reason (so the button
 * shows a lock instead of looking merely inactive). */
export function isRoleLockReason(title: unknown): boolean {
  return typeof title === "string" && (title.startsWith(READ_ONLY_PREFIX) || title.startsWith("Only lead.engineer"));
}
