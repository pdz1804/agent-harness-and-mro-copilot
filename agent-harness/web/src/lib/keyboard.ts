/** Keyboard-shortcut guards shared by sheets, the approval bar and the shell. */

interface TargetLike {
  tagName?: string
  isContentEditable?: boolean
  getAttribute?: (name: string) => string | null
}

/** True when a key event comes from somewhere the user is typing, so single-
 * letter / arrow shortcuts must not fire (inputs, textareas, selects,
 * contenteditable, comboboxes). */
export function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as TargetLike | null
  if (!el || typeof el.tagName !== 'string') return false
  const tag = el.tagName.toUpperCase()
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (el.isContentEditable) return true
  const role = el.getAttribute?.('role')
  return role === 'combobox' || role === 'textbox'
}

/** A bare single-key shortcut: no modifier held and not typing. */
export function isBareKey(event: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; target: EventTarget | null }, key: string): boolean {
  return !event.ctrlKey && !event.metaKey && !event.altKey && event.key.toLowerCase() === key.toLowerCase() && !isTypingTarget(event.target)
}
