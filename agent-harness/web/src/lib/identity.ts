/** Local "identity switcher" for the RBAC foundation (phase 01) — NOT
 * authentication. The currently-selected user id is stored in
 * `localStorage` and sent as `X-User-Id` on every fetch-based API call (see
 * `lib/api.ts`), or as `?as_user=` on the one endpoint that can't set a
 * custom header (`EventSource`-based SSE — see `useRunStream`). Trivially
 * spoofable by any client with devtools open; the enforcement that matters
 * happens server-side (`agent_harness.rbac` + every route's `Depends`), not
 * here — see the UserSwitcher component and README for the honest framing. */

const STORAGE_KEY = 'agent-harness:current-user-id'

/** Matches the seeded `u_admin` row from
 * `alembic/versions/e1a9c6f4b2d8_add_users_and_ownership.py` — used only
 * until `GET /users` resolves at least once and a real choice is made or
 * confirmed. */
const DEFAULT_USER_ID = 'u_admin'

export function getCurrentUserId(): string {
  try {
    return localStorage.getItem(STORAGE_KEY) ?? DEFAULT_USER_ID
  } catch {
    // localStorage can throw in some sandboxed/private-browsing contexts.
    return DEFAULT_USER_ID
  }
}

/** Fired on `window` whenever `setCurrentUserId` is called, so any open
 * page can react (e.g. re-fetch `/me`) without a full reload. */
export const IDENTITY_CHANGE_EVENT = 'agent-harness:identity-changed'

export function setCurrentUserId(userId: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, userId)
  } catch {
    // Best-effort only; a failed write just means the switch doesn't persist.
  }
  window.dispatchEvent(new CustomEvent(IDENTITY_CHANGE_EVENT))
}
