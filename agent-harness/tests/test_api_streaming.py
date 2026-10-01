"""Tests for `GET /runs/{run_id}/events` (SSE) and `GET /runs/{run_id}/export`.

The SSE endpoint reuses the same background-thread run flow as
`test_api_async_runs.py`; these tests assert events arrive in order (by the
monotonic `step` field) and the stream closes once the run reaches a
terminal status, without asserting on wall-clock timing (real thread
scheduling makes that flaky)."""

from __future__ import annotations

import sys
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from agent_harness import state  # noqa: E402
from agent_harness.llm_client import build_routing_model, build_streaming_final_answer_model  # noqa: E402
from api import app  # noqa: E402

client = TestClient(app)

_POLL_TIMEOUT_SECONDS = 5.0
_POLL_INTERVAL_SECONDS = 0.02


@pytest.fixture(autouse=True)
def _isolate_trace_files(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)


@pytest.fixture(autouse=True)
def _use_heuristic_llm(monkeypatch):
    monkeypatch.setattr(
        state,
        "llm_client_factory",
        lambda: build_routing_model(),
    )


def _wait_for_status(run_id: str, *targets: str) -> dict:
    deadline = time.monotonic() + _POLL_TIMEOUT_SECONDS
    body: dict = {}
    while time.monotonic() < deadline:
        response = client.get(f"/api/v1/runs/{run_id}")
        assert response.status_code == 200
        body = response.json()
        if body["status"] in targets:
            return body
        time.sleep(_POLL_INTERVAL_SECONDS)
    raise AssertionError(f"run {run_id} did not reach status in {targets}; last body: {body}")


def _parse_sse(raw_text: str) -> list[tuple[str, str]]:
    """Parse raw SSE text into a list of (event_type, data_json) pairs."""
    events: list[tuple[str, str]] = []
    event_type = None
    for line in raw_text.splitlines():
        if line.startswith("event: "):
            event_type = line[len("event: ") :]
        elif line.startswith("data: ") and event_type is not None:
            events.append((event_type, line[len("data: ") :]))
    return events


def test_sse_stream_for_completed_run_replays_persisted_snapshot():
    """A run that has already finished (persisted-only, not live in this
    process's registry -- simulated here by waiting for completion before
    subscribing) gets one run_snapshot event with full history, then closes."""
    start = client.post(
        "/api/v1/runs", json={"objective": "What is the status of auth-service?", "max_steps": 5}
    )
    run_id = start.json()["run_id"]
    _wait_for_status(run_id, "completed")

    # Drop it from the live in-memory registry to force the persisted-only
    # path, exactly as would happen after a process restart.
    state.registry._runs.pop(run_id, None)

    with client.stream("GET", f"/api/v1/runs/{run_id}/events") as response:
        assert response.status_code == 200
        assert response.headers["content-type"].startswith("text/event-stream")
        raw = "".join(response.iter_text())

    events = _parse_sse(raw)
    event_types = [e for e, _ in events]
    assert event_types == ["run_snapshot", "stream_end"]


def test_sse_stream_for_live_run_emits_events_in_order_and_closes():
    start = client.post(
        "/api/v1/runs", json={"objective": "What is the status of payments-api?", "max_steps": 5}
    )
    run_id = start.json()["run_id"]

    with client.stream("GET", f"/api/v1/runs/{run_id}/events") as response:
        assert response.status_code == 200
        raw = "".join(response.iter_text())

    events = _parse_sse(raw)
    assert events, "expected at least one SSE event"
    assert events[-1][0] == "stream_end"

    # Every AgentEvent (all but the final stream_end) carries a "step" field;
    # steps must be non-decreasing (never reordered) across the stream.
    steps = []
    for _event_type, data in events[:-1]:
        import json as _json

        steps.append(_json.loads(data)["step"])
    assert steps == sorted(steps)

    _wait_for_status(run_id, "completed")


def test_sse_stream_emits_llm_token_delta_events_that_assemble_to_final_answer(monkeypatch):
    """Real token-by-token streaming over the SSE path: a `FunctionModel`
    with a `stream_function` (see `build_streaming_final_answer_model`)
    emits genuine `llm_token_delta` events (field="final_answer") the same
    way a real streaming OpenAI response would (see the phase-11b spike
    report's part C for the live OpenAI capture of this exact mechanism).
    Assert they arrive in order and, once concatenated, equal the
    persisted `final_answer` event's text exactly — proving the delta
    overlay and the assembled/persisted event agree."""
    monkeypatch.setattr(
        state,
        "llm_client_factory",
        lambda: build_streaming_final_answer_model("auth-service is operational."),
    )
    start = client.post(
        "/api/v1/runs", json={"objective": "What is the status of auth-service?", "max_steps": 5}
    )
    run_id = start.json()["run_id"]

    with client.stream("GET", f"/api/v1/runs/{run_id}/events") as response:
        assert response.status_code == 200
        raw = "".join(response.iter_text())

    events = _parse_sse(raw)
    import json as _json

    delta_events = [_json.loads(data) for etype, data in events if etype == "llm_token_delta"]
    assert delta_events, "expected at least one llm_token_delta event"
    assert all(e["data"]["field"] in ("final_answer", "tool_args") for e in delta_events)

    final_answer_deltas = [e for e in delta_events if e["data"]["field"] == "final_answer"]
    assembled_from_deltas = "".join(e["data"]["delta"] for e in final_answer_deltas)

    final_answer_events = [_json.loads(data) for etype, data in events if etype == "final_answer"]
    assert len(final_answer_events) == 1
    assert assembled_from_deltas == final_answer_events[0]["data"]["final_answer"]

    # Deltas must never be persisted to record.history / the snapshot -
    # only the assembled llm_decision/final_answer events are the source of
    # truth (see loop.py::_decide and run_registry.py::_on_event).
    _wait_for_status(run_id, "completed")
    snapshot = client.get(f"/api/v1/runs/{run_id}").json()
    assert all(e["event_type"] != "llm_token_delta" for e in snapshot["history"])


def test_sse_stream_unknown_run_returns_404():
    response = client.get("/api/v1/runs/does-not-exist/events")
    assert response.status_code == 404


def test_export_run_returns_full_trace():
    start = client.post(
        "/api/v1/runs", json={"objective": "What is the status of auth-service?", "max_steps": 5}
    )
    run_id = start.json()["run_id"]
    _wait_for_status(run_id, "completed")

    response = client.get(f"/api/v1/runs/{run_id}/export")
    assert response.status_code == 200
    body = response.json()
    assert body["run_id"] == run_id
    assert body["status"] == "completed"
    assert isinstance(body["history"], list)
    assert len(body["history"]) > 0


def test_export_unknown_run_returns_404():
    response = client.get("/api/v1/runs/does-not-exist/export")
    assert response.status_code == 404
