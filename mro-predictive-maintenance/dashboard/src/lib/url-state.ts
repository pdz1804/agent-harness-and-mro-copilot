/** Hash URL state: `#/ops/alerts/12?stage=open&q=pump&sort=risk:desc`.
 * The path picks the page (and the open sheet); the query holds list state
 * (filters, search, sort) so back/forward and shared links restore a view. */

export interface HashParts {
  /** Path without leading slash, e.g. "ops/alerts/12". */
  path: string;
  segments: string[];
  query: Record<string, string>;
}

export function parseHash(hash: string): HashParts {
  const raw = hash.replace(/^#\/?/, "");
  const q = raw.indexOf("?");
  const path = (q === -1 ? raw : raw.slice(0, q)).replace(/\/+$/, "");
  const search = q === -1 ? "" : raw.slice(q + 1);
  const query: Record<string, string> = {};
  for (const [k, v] of new URLSearchParams(search)) if (v !== "") query[k] = v;
  return { path, segments: path ? path.split("/").filter(Boolean) : [], query };
}

/** Serialise a query, dropping empty and default values; keys sorted so
 * equal states give equal URLs. */
export function buildQuery(query: Record<string, string | null | undefined>, defaults: Record<string, string> = {}): string {
  const entries = Object.entries(query)
    .filter(([k, v]) => v != null && v !== "" && defaults[k] !== v)
    .sort(([a], [b]) => a.localeCompare(b)) as [string, string][];
  return entries.length ? `?${new URLSearchParams(entries).toString()}` : "";
}

export function buildHash(path: string, query: Record<string, string | null | undefined> = {}, defaults: Record<string, string> = {}): string {
  return `#/${path.replace(/^\/+/, "")}${buildQuery(query, defaults)}`;
}

/** Same query, new path: opening or closing a sheet keeps the list state. */
export function withPath(hash: string, path: string): string {
  return buildHash(path, parseHash(hash).query);
}

/** Merge a patch into the current query (null removes a key). */
export function patchQuery(hash: string, patch: Record<string, string | null>, defaults: Record<string, string> = {}): string {
  const { path, query } = parseHash(hash);
  return buildHash(path, { ...query, ...patch }, defaults);
}

export interface SortSpec {
  key: string;
  dir: "asc" | "desc";
}

export function parseSort(raw: string | undefined): SortSpec | null {
  if (!raw) return null;
  const [key, dir] = raw.split(":");
  if (!key || (dir !== "asc" && dir !== "desc")) return null;
  return { key, dir };
}

export function formatSort(sort: SortSpec | null): string | null {
  return sort ? `${sort.key}:${sort.dir}` : null;
}
