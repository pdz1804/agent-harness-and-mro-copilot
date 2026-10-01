/** Inline validation for the optional run limits on New run: empty means
 * "server default"; otherwise a whole number >= 1. Returns the message to
 * show, or null when the value is acceptable. */
export function limitError(raw: string): string | null {
  const value = raw.trim()
  if (!value) return null
  if (!/^\d+$/.test(value)) return 'Use a whole number.'
  if (Number(value) < 1) return 'Must be at least 1.'
  return null
}
