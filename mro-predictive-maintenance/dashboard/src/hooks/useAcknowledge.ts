import { useCallback, useState } from "react";
import { transitionAlert } from "../lib/api";
import { canWrite } from "../lib/identity";
import { useToast } from "../components/ui/feedback";
import type { Alert } from "../types";

/** Optimistic acknowledge with Undo, for pages outside the alert inbox
 * (Overview's "Needs attention", Fleet's bulk bar). Same contract as the
 * inbox: the API has no "unacknowledge", so the transition is held for the
 * undo window and only then sent. `pending` holds the alert ids shown as
 * acknowledged meanwhile. */
export function useAcknowledge(onSettled: () => void): { acknowledge: (alerts: Alert[]) => void; pending: ReadonlySet<number> } {
  const toast = useToast();
  const [pending, setPending] = useState<ReadonlySet<number>>(new Set());

  const mark = useCallback((ids: number[], on: boolean) => {
    setPending((s) => {
      const next = new Set(s);
      for (const id of ids) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  }, []);

  const acknowledge = useCallback(
    (alerts: Alert[]) => {
      const open = alerts.filter((a) => a.status === "open");
      if (open.length === 0 || !canWrite()) return;
      const ids = open.map((a) => a.id);
      mark(ids, true);
      toast.mutate(
        {
          id: `ack-${ids.join(",")}-${Date.now()}`,
          strategy: "deferred",
          commit: () => Promise.all(open.map((a) => transitionAlert(a.id, "acknowledge"))),
          onSettled: () => {
            onSettled();
            mark(ids, false);
          },
          onUndone: () => {
            mark(ids, false);
            toast.show({ tone: "info", message: open.length === 1 ? `Alert #${open[0].id} restored` : `${open.length} alerts restored`, durationMs: 2500 });
          },
          onError: () => {
            mark(ids, false);
            onSettled();
          },
        },
        {
          tone: "good",
          message: open.length === 1 ? `Alert #${open[0].id} acknowledged` : `${open.length} alerts acknowledged`,
          detail: open.length === 1 ? `${open[0].component_id} · ${open[0].aircraft_id}` : "Sent when the undo window ends.",
        },
      );
    },
    [mark, onSettled, toast],
  );

  return { acknowledge, pending };
}
