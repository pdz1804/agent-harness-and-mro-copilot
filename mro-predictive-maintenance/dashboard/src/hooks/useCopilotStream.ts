import { useEffect, useRef, useState } from "react";
import { copilotEventsUrl } from "../lib/api";
import type { CopilotStreamEvent } from "../types";

const EVENT_TYPES = [
  "run_started",
  "tool_call",
  "tool_result",
  "token",
  "final_answer",
  "awaiting_input",
  "run_status",
  "guardrail",
  "error",
];

/** Whether the tracked "last seen event id" for this run should be reset
 * (new run selected -- start replay from scratch) or carried over (same
 * run, new turn scheduled via resolve/follow-up -- do NOT replay events
 * already seen, most importantly the previous turn's own terminal
 * `run_status`). Exported standalone because it's the crux of the
 * reconnect-after-resume bug: pure and cheap to unit-test without stubbing
 * `EventSource`. */
export function nextLastEventId(prevRunId: string | null, runId: string | null, prevLastEventId: number): number {
  return runId !== prevRunId ? 0 : prevLastEventId;
}

/** Live SSE consumer for `GET /copilot/runs/{id}/events`. Direct setState per
 * token (no rAF batching) -- batching caused visible flicker in an earlier
 * pass on a sibling project, see memory: token deltas must render as they
 * arrive.
 *
 * The server-side stream is deliberately bounded to ONE turn: it closes at
 * the first `run_status` event, whether that turn ended `awaiting_input` or
 * `completed` (see `src/service/routers/copilot.py::run_events`'s
 * docstring and `tests/test_sse_stream.py`). That means resuming a run
 * (resolve/follow-up) starts a brand-new turn that this hook's original
 * `runId`-only subscription would never observe -- the real bug behind
 * "run list/detail stays awaiting_input after completion until reselected"
 * (a closed EventSource is NOT the same as a live one; the fix isn't
 * inspecting the payload, it's opening a fresh connection for the new
 * turn). `reconnectKey` exists for exactly that: bump it whenever a new
 * turn is scheduled on the same run (start/resolve/follow-up) to force
 * this effect to re-subscribe.
 *
 * ROOT CAUSE this hook used to have: every reconnect opened
 * `GET .../events` with no `last_event_id`, so the server's replay-then-
 * live-tail always resent the run's FULL event history from id 0 --
 * including the *previous* turn's own terminal `run_status` event (e.g.
 * `awaiting_input`, from before the approval was resolved). That stale
 * event arrived first, was indistinguishable from a real new terminal
 * event, and immediately set `terminal = true` + closed the connection --
 * before the resumed turn's actual tool_call/tool_result/final_answer/
 * run_status events were ever sent. The open run's detail then only ever
 * got updated by the page's defensive 1.5s backstop timer, which loses the
 * race on any turn slower than 1.5s (exactly the reported "doesn't update
 * even after 18s"). Fix: track the highest event id seen per run and pass
 * it as `?last_event_id=` on every reconnect for the SAME run, so replay
 * only resends events after the ones already rendered -- the new turn's
 * own terminal event is then the first (and only) `run_status` this
 * connection can see. */
export function useCopilotStream(runId: string | null, reconnectKey: number | string = 0) {
  const [events, setEvents] = useState<CopilotStreamEvent[]>([]);
  const [streamingText, setStreamingText] = useState("");
  const [connected, setConnected] = useState(false);
  const [terminal, setTerminal] = useState(false);
  const sourceRef = useRef<EventSource | null>(null);
  const lastEventIdRef = useRef<number>(0);
  const prevRunIdRef = useRef<string | null>(null);

  useEffect(() => {
    lastEventIdRef.current = nextLastEventId(prevRunIdRef.current, runId, lastEventIdRef.current);
    prevRunIdRef.current = runId;

    setEvents([]);
    setStreamingText("");
    setTerminal(false);
    if (!runId) return;

    const url = copilotEventsUrl(runId, lastEventIdRef.current);
    const source = new EventSource(url);
    sourceRef.current = source;

    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false);

    for (const type of EVENT_TYPES) {
      source.addEventListener(type, (evt: MessageEvent) => {
        let payload: Record<string, unknown> = {};
        try {
          payload = JSON.parse(evt.data) as Record<string, unknown>;
        } catch {
          payload = { raw: evt.data };
        }
        const id = evt.lastEventId ? Number(evt.lastEventId) : null;
        if (id !== null && id > lastEventIdRef.current) {
          lastEventIdRef.current = id;
        }
        setEvents((prev) => [...prev, { id, type, payload }]);
        if (type === "token" && typeof payload.text === "string") {
          setStreamingText((prev) => prev + (payload.text as string));
        }
        if (type === "run_status" || type === "error") {
          setTerminal(true);
          source.close();
          setConnected(false);
        }
      });
    }

    return () => {
      source.close();
      sourceRef.current = null;
    };
  }, [runId, reconnectKey]);

  return { events, streamingText, connected, terminal };
}
