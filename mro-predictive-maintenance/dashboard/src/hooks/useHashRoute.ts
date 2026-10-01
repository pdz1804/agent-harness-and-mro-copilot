import { useCallback, useEffect, useState } from "react";

/** Minimal hash router (no new dependency): `#/group/page/id` -> segments.
 * Deep links for cards (e.g. `#/ops/alerts/12`) work with browser back/forward
 * because `window.location.hash` is the single source of truth. */
function readSegments(): string[] {
  const raw = window.location.hash.replace(/^#\/?/, "");
  return raw.length > 0 ? raw.split("/").filter(Boolean) : [];
}

export function useHashRoute(): [string[], (path: string) => void] {
  const [segments, setSegments] = useState<string[]>(readSegments());

  useEffect(() => {
    const onHashChange = () => setSegments(readSegments());
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  const navigate = useCallback((path: string) => {
    window.location.hash = path.startsWith("/") ? path : `/${path}`;
  }, []);

  return [segments, navigate];
}
