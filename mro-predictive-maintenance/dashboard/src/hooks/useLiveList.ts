import { useEffect, useRef, useState } from "react";
import { useAsync, type AsyncState } from "./useAsync";
import { changedKeys, signatureMap } from "../lib/row-diff";

export interface LiveList<T> extends AsyncState<T[]> {
  /** Rows a refresh just changed (highlight for ~1.4s). */
  flash: Set<string>;
  /** When the last successful load landed. */
  updatedAt: number | null;
}

/** A list that refreshes itself every `intervalMs` while the tab is
 * visible, and reports which rows changed so they can flash. */
export function useLiveList<T>(fn: () => Promise<T[]>, key: (r: T) => string, sig: (r: T) => string, intervalMs = 20_000): LiveList<T> {
  const state = useAsync(fn, []);
  const prev = useRef<Map<string, string> | null>(null);
  const [flash, setFlash] = useState<Set<string>>(new Set());
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const keyRef = useRef({ key, sig });
  keyRef.current = { key, sig };

  useEffect(() => {
    if (!state.data) return;
    const { key: k, sig: s } = keyRef.current;
    const changed = changedKeys(prev.current, state.data, k, s);
    prev.current = signatureMap(state.data, k, s);
    setUpdatedAt(Date.now());
    if (changed.size > 0) {
      setFlash(changed);
      const id = setTimeout(() => setFlash(new Set()), 1400);
      return () => clearTimeout(id);
    }
  }, [state.data]);

  const reload = state.reload;
  useEffect(() => {
    const id = setInterval(() => {
      if (document.visibilityState === "visible") reload();
    }, intervalMs);
    return () => clearInterval(id);
  }, [reload, intervalMs]);

  return { ...state, flash, updatedAt };
}
