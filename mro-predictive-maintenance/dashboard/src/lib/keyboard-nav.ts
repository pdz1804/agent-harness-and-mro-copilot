/** Keyboard helpers: item stepping inside sheets and global shortcuts. */

/** Next/previous id in the visible list, clamped (no wrap). Null when the
 * current id is not in the list or there is nowhere to go. */
export function neighborId<T extends string | number>(ids: readonly T[], current: T | null, dir: 1 | -1): T | null {
  if (current === null) return null;
  const i = ids.indexOf(current);
  if (i === -1) return null;
  const j = i + dir;
  return j >= 0 && j < ids.length ? ids[j] : null;
}

/** "3 of 12" position, or null when not in the list. */
export function positionOf<T>(ids: readonly T[], current: T | null): { index: number; total: number } | null {
  if (current === null) return null;
  const i = ids.indexOf(current);
  return i === -1 ? null : { index: i + 1, total: ids.length };
}

export interface TargetLike {
  tagName?: string;
  isContentEditable?: boolean;
  getAttribute?: (name: string) => string | null;
}

/** True when a keystroke belongs to a text field, not to a shortcut. */
export function isTypingTarget(el: TargetLike | null | undefined): boolean {
  if (!el) return false;
  const tag = (el.tagName ?? "").toUpperCase();
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag === "INPUT") {
    const type = (el.getAttribute?.("type") ?? "text").toLowerCase();
    return !["checkbox", "radio", "range", "button", "submit"].includes(type);
  }
  if (el.isContentEditable) return true;
  return el.getAttribute?.("role") === "combobox";
}

export type ShortcutId = "palette" | "help" | "prev" | "next" | "close";

export interface KeyLike {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
}

/** Map a key event to a shortcut. Single-key shortcuts are ignored while
 * typing; Ctrl/Cmd+K and Esc always work. */
export function matchShortcut(e: KeyLike, target: TargetLike | null): ShortcutId | null {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") return "palette";
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  if (e.key === "Escape") return "close";
  if (isTypingTarget(target)) return null;
  if (e.key === "?") return "help";
  if (e.key === "ArrowLeft" || e.key === "k") return "prev";
  if (e.key === "ArrowRight" || e.key === "j") return "next";
  return null;
}
