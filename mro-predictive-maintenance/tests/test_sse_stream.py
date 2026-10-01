"""SSE streaming + reconnect/replay tests for ``GET /copilot/runs/{id}/events``.

Uses ``fastapi.testclient.TestClient.stream()`` (the standard, well-supported
way to test an ASGI SSE endpoint synchronously -- it runs the app on a
background thread/event-loop portal while the test thread reads chunks
incrementally). The endpoint is deliberately bounded to one turn (closes at
the first ``run_status``/``error`` event, see
``src/service/routers/copilot.py``'s ``run_events`` docstring) so a client
that fully drains the response (any ASGI test transport, or a real
``EventSource`` that reconnects per turn) never hangs waiting for a
heartbeat that would otherwise arrive every 15s forever.
"""

from __future__ import annotations

import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from pydantic_ai.messages import ModelResponse, TextPart, ToolCallPart  # noqa: E402
from pydantic_ai.models.function import AgentInfo  # noqa: E402

from src import config  # noqa: E402
from src.copilot import runs as copilot_runs_mod  # noqa: E402
from src.copilot.models import OFFLINE_SCRIPTED_MODEL_NAME, build_scripted_model  # noqa: E402
from src.service.app import app  # noqa: E402
from src.service.routers import copilot as copilot_router_mod  # noqa: E402


@pytest.fixture
def client(tmp_path, monkeypatch):
    if not config.MODEL_CARD_JSON.exists():
        pytest.skip("reports/model_card.json missing -- run `python -m src.pipeline` first")
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path / 'ops.db'}")
    with TestClient(app) as c:
        yield c


def _last_tool_return(messages):
    for m in reversed(messages):
        for p in reversed(getattr(m, "parts", [])):
            if p.part_kind == "tool-return":
                return p
    return None


def _read_sse_events(stream, timeout=20.0):
    events = []
    buf = ""
    deadline = time.time() + timeout
    for chunk in stream.iter_text():
        buf += chunk
        while "\n\n" in buf:
            block, buf = buf.split("\n\n", 1)
            if not block.strip() or block.startswith(":"):
                continue
            evt = {"id": None, "event": None, "data": None}
            for line in block.splitlines():
                if line.startswith("id: "):
                    evt["id"] = int(line[len("id: "):])
                elif line.startswith("event: "):
                    evt["event"] = line[len("event: "):]
                elif line.startswith("data: "):
                    evt["data"] = line[len("data: "):]
            if evt["event"]:
                events.append(evt)
        if time.time() > deadline:
            break
    return events


def test_sse_start_yields_token_deltas_before_final_answer(client):
    resp = client.post("/copilot/runs", json={"prompt": "show me the top risk components"})
    run_id = resp.json()["run_id"]

    with client.stream("GET", f"/copilot/runs/{run_id}/events") as stream:
        assert stream.status_code == 200
        events = _read_sse_events(stream)

    types = [e["event"] for e in events]
    assert "token" in types
    assert types.count("token") >= 2
    assert "final_answer" in types
    assert types.index("token") < types.index("final_answer")
    assert types[-1] == "run_status"  # bounded stream: closes at the terminal event


def _wo_scripted_model(row):
    def model_fn(messages, info: AgentInfo):
        last = _last_tool_return(messages)
        if last is None:
            return ModelResponse(parts=[ToolCallPart(tool_name="create_work_order", args={
                "aircraft_id": row["aircraft_id"], "component_id": row["component_id"],
                "task_ref": None, "priority": "routine", "justification": "elevated risk",
            })])
        return ModelResponse(parts=[TextPart(content=f"Handled: {last.content}")])
    return model_fn


def test_sse_reconnect_with_last_event_id_replays_only_missed_events(client, monkeypatch):
    """Pause on an approval card, disconnect, reconnect with a stale
    ``Last-Event-ID`` -- the awaiting_input structural event is replayed
    (tokens are never persisted/replayed by design). Then approve and
    open a fresh stream for the resumed turn to completion."""
    row = client.get("/fleet/top-risk?n=1").json()["items"][0]
    model = build_scripted_model(_wo_scripted_model(row))
    monkeypatch.setattr(copilot_runs_mod.copilot_models, "resolve_model",
                         lambda prefer_openai=True: (model, OFFLINE_SCRIPTED_MODEL_NAME))

    run_id = client.post("/copilot/runs", json={"prompt": "raise a work order for this pump"}).json()["run_id"]

    with client.stream("GET", f"/copilot/runs/{run_id}/events") as stream:
        first_pass_events = _read_sse_events(stream)
    assert any(e["event"] == "awaiting_input" for e in first_pass_events)

    snapshot = client.get(f"/copilot/runs/{run_id}").json()
    assert snapshot["status"] == "awaiting_input"

    # Reconnect "from scratch" (Last-Event-ID: 0) -- must replay the
    # awaiting_input event again (simulates a client that never saw it).
    with client.stream("GET", f"/copilot/runs/{run_id}/events",
                        headers={"Last-Event-ID": "0"}) as stream:
        replay_events = _read_sse_events(stream)
    assert any(e["event"] == "awaiting_input" for e in replay_events)
    ids = [e["id"] for e in replay_events if e["id"] is not None]
    assert ids == sorted(ids)

    # Reconnect using the highest id already seen -- the awaiting_input
    # event (already delivered) must not be replayed a second time.
    # Asserted directly against RunManager.events_since (the same replay
    # primitive the endpoint uses) rather than a second live HTTP stream,
    # since a run with nothing new to replay would otherwise block on the
    # endpoint's real 15s heartbeat before this assertion could observe
    # "no new events" -- that codepath is exercised for real in the manual
    # live-server verification in this phase's report.
    max_id = max(ids)
    manager = copilot_router_mod._module_state["manager"]  # noqa: SLF001
    no_replay_events = manager.events_since(run_id, max_id)
    assert no_replay_events == []

    pending = client.get(f"/copilot/runs/{run_id}").json()["pending"][0]
    resolve_resp = client.post(
        f"/copilot/runs/{run_id}/resolve",
        json={"resolutions": [{"pending_id": pending["id"], "decision": "approve"}]},
        headers={"X-User": "lead.engineer"},
    )
    assert resolve_resp.status_code == 202

    # Fresh stream for the resumed turn -- ends in completed.
    with client.stream("GET", f"/copilot/runs/{run_id}/events") as stream:
        resume_events = _read_sse_events(stream)
    resume_types = [e["event"] for e in resume_events]
    assert "final_answer" in resume_types or client.get(f"/copilot/runs/{run_id}").json()["status"] == "completed"

    final_status = client.get(f"/copilot/runs/{run_id}").json()["status"]
    assert final_status == "completed"

    wos = client.get("/ops/work-orders").json()
    assert any(w["component_id"] == row["component_id"] and w["approved_by"] == "lead.engineer" for w in wos)
