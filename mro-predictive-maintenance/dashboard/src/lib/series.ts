/** Small helpers that turn real event timestamps into KPI-card series. */

const DAY = 86_400_000;

/** Events per calendar-length day for the last `days` days, oldest first.
 * Unparseable timestamps are skipped; future ones land in the last bucket. */
export function dailyCounts(isoTimes: string[], days = 14, now = Date.now()): number[] {
  const buckets = new Array<number>(days).fill(0);
  const start = now - days * DAY;
  for (const iso of isoTimes) {
    const t = Date.parse(iso);
    if (Number.isNaN(t) || t < start) continue;
    const idx = Math.min(days - 1, Math.floor((t - start) / DAY));
    buckets[idx] += 1;
  }
  return buckets;
}

/** How many events happened within the last `windowMs`. */
export function countSince(isoTimes: string[], windowMs = DAY, now = Date.now()): number {
  return isoTimes.reduce((n, iso) => {
    const t = Date.parse(iso);
    return !Number.isNaN(t) && t >= now - windowMs ? n + 1 : n;
  }, 0);
}
