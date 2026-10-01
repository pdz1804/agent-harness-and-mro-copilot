import { useCallback, useEffect, useState } from "react";
import { parseHash, patchQuery, withPath } from "../lib/url-state";

/** Minimal hash router (no new dependency): `#/group/page/id?k=v` ->
 * segments + query. `window.location.hash` is the single source of truth, so
 * deep links and back/forward work; the query carries list state (filters,
 * search, sort) and survives opening and closing a detail sheet. */
const REPLACE_EVENT = "mro:hash-replace";

function read() {
  return parseHash(window.location.hash);
}

/** Change the URL without a history entry (filter typing, sort clicks). */
export function replaceHash(hash: string): void {
  if (hash === window.location.hash) return;
  history.replaceState(history.state, "", hash);
  window.dispatchEvent(new Event(REPLACE_EVENT));
}

/** Open/close a detail path while keeping the current list query. */
export function navigateKeepingQuery(path: string, replace = false): void {
  const next = withPath(window.location.hash, path);
  if (replace) replaceHash(next);
  else window.location.hash = next.slice(1);
}

function useHashParts() {
  const [parts, setParts] = useState(read);
  useEffect(() => {
    const on = () => setParts(read());
    window.addEventListener("hashchange", on);
    window.addEventListener(REPLACE_EVENT, on);
    return () => {
      window.removeEventListener("hashchange", on);
      window.removeEventListener(REPLACE_EVENT, on);
    };
  }, []);
  return parts;
}

export function useHashRoute(): [string[], (path: string) => void, Record<string, string>] {
  const parts = useHashParts();
  const navigate = useCallback((path: string) => {
    window.location.hash = path.startsWith("/") ? path : `/${path}`;
  }, []);
  return [parts.segments, navigate, parts.query];
}

/** List state in the URL query, with defaults kept out of the URL. */
export function useUrlQuery<T extends Record<string, string>>(
  defaults: T,
): [T, (patch: Partial<Record<keyof T, string | null>>) => void] {
  const { query } = useHashParts();
  const key = JSON.stringify(defaults);
  const merged = { ...defaults, ...query } as T;
  const set = useCallback(
    (patch: Partial<Record<keyof T, string | null>>) => {
      replaceHash(patchQuery(window.location.hash, patch as Record<string, string | null>, JSON.parse(key)));
    },
    [key],
  );
  return [merged, set];
}
