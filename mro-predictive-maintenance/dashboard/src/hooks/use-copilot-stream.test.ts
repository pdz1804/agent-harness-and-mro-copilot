import { describe, expect, it } from "vitest";
import { nextLastEventId } from "./useCopilotStream";
import { copilotEventsUrl } from "../lib/api";

// Root-cause regression coverage for the "open run's detail never updates
// after a resume" bug: every SSE reconnect used to replay a run's full
// event history from id 0, so resolving an approval re-delivered the
// PREVIOUS turn's own terminal `run_status` event first and the stream
// closed before the resumed turn's real completion ever arrived. The fix
// tracks the highest event id seen per run and only resets it when the
// user actually switches to a different run.
describe("nextLastEventId", () => {
  it("keeps the tracked last-event-id when reconnecting on the SAME run (a resume)", () => {
    // Run was previously at event id 7 (its terminal awaiting_input event).
    // A resolve schedules a new turn and bumps reconnectKey, but runId is
    // unchanged -- the new connection must not replay id 7 again.
    expect(nextLastEventId("run-1", "run-1", 7)).toBe(7);
  });

  it("resets to 0 when the user selects a different run", () => {
    expect(nextLastEventId("run-1", "run-2", 7)).toBe(0);
  });

  it("resets to 0 on the very first subscribe (no previous run)", () => {
    expect(nextLastEventId(null, "run-1", 0)).toBe(0);
  });

  it("stays 0 while there is no active run", () => {
    expect(nextLastEventId("run-1", null, 7)).toBe(0);
  });
});

describe("copilotEventsUrl", () => {
  it("omits last_event_id for a fresh subscribe (id 0)", () => {
    expect(copilotEventsUrl("run-1")).toBe("http://localhost:8100/copilot/runs/run-1/events");
  });

  it("forwards last_event_id on a reconnect so the server skips already-seen events", () => {
    expect(copilotEventsUrl("run-1", 7)).toBe("http://localhost:8100/copilot/runs/run-1/events?last_event_id=7");
  });
});
