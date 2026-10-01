/** Auto-refresh intervals a dashboard can be set to (seconds; 0 = manual
 * only). Must match `AUTO_REFRESH_CHOICES` in `routers/dashboards.py`. */
export const AUTO_REFRESH_CHOICES: ReadonlyArray<number> = [0, 10, 30, 60, 300]

export function autoRefreshLabel(seconds: number | null | undefined): string {
  if (!seconds) return 'Manual'
  if (seconds < 60) return `Every ${seconds}s`
  return `Every ${seconds / 60} min`
}

/** Normalize whatever the server sent to one of the allowed choices. */
export function normalizeAutoRefresh(seconds: number | null | undefined): number {
  return seconds && AUTO_REFRESH_CHOICES.includes(seconds) ? seconds : 0
}
