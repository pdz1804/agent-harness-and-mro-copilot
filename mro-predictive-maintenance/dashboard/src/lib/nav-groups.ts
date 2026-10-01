// Fold state for the left-nav groups. Persisted per acting user so a
// planner's folded "About" group does not fold it for the lead engineer.
// The active group is always shown open regardless of the stored state, so
// you can never be on a page whose nav entry is hidden.

const KEY_PREFIX = "mro.nav.collapsed.";

export function navStorageKey(userId: string): string {
  return KEY_PREFIX + userId;
}

/** Parse a stored value into a set of collapsed group ids; tolerant of junk. */
export function parseCollapsed(raw: string | null): Set<string> {
  if (!raw) return new Set();
  try {
    const v: unknown = JSON.parse(raw);
    return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

export function serializeCollapsed(set: ReadonlySet<string>): string {
  return JSON.stringify([...set].sort());
}

export function isGroupOpen(groupId: string, activeGroupId: string, collapsed: ReadonlySet<string>): boolean {
  return groupId === activeGroupId || !collapsed.has(groupId);
}

/** Toggle a group. Folding the active group is a no-op (it stays open). */
export function toggleGroup(groupId: string, activeGroupId: string, collapsed: ReadonlySet<string>): Set<string> {
  const next = new Set(collapsed);
  if (next.has(groupId)) next.delete(groupId);
  else if (groupId !== activeGroupId) next.add(groupId);
  return next;
}

export function loadCollapsed(userId: string): Set<string> {
  try {
    return parseCollapsed(localStorage.getItem(navStorageKey(userId)));
  } catch {
    return new Set(); // storage unavailable: everything open
  }
}

export function saveCollapsed(userId: string, set: ReadonlySet<string>): void {
  try {
    localStorage.setItem(navStorageKey(userId), serializeCollapsed(set));
  } catch {
    // best-effort; in-memory state still works this session
  }
}
