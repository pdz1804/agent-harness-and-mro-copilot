/** Relative time ("5m ago") with an absolute tooltip ("1 Oct 2026, 14:03 GMT+7"). */
export function relativeTime(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const s = Math.round((now - t) / 1000);
  const a = Math.abs(s);
  if (a < 45) return "just now";
  let text: string;
  if (a < 3600) text = `${Math.round(a / 60)}m`;
  else if (a < 86400) text = `${Math.round(a / 3600)}h`;
  else if (a < 86400 * 30) text = `${Math.round(a / 86400)}d`;
  else if (a < 86400 * 365) text = `${Math.round(a / (86400 * 30))}mo`;
  else text = `${Math.round(a / (86400 * 365))}y`;
  return s < 0 ? `in ${text}` : `${text} ago`;
}

export function absoluteTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  });
}
