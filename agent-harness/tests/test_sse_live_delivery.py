"""Live SSE delivery and the human approval budget.

The SSE tests drive the real `api.app` at the ASGI level (every middleware,
the `/api/v1` router and the SPA/static mount at "/") and record each
`http.response.body` message as it is sent. A buffering layer would show up
as the approval event arriving only together with the end of the stream;
here it must arrive while the run is still paused on the approval.
"""

from __future__ import annotations

import asyncio
import json
import sys
import time
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient
from pydantic_ai.messages import ModelMessage, ModelResponse, TextPart, ToolCallPart, ToolReturnPart
from pydantic_ai.models.function import AgentInfo, FunctionModel
from starlette.routing import Mount

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from agent_harness import settings, state  # noqa: E402
from agent_harness.repos import dashboards as dashboards_repo  # noqa: E402
from api import _CachedStaticFiles, app  # noqa: E402

client = TestClient(app)
ADMIN = {"X-User-Id": "u_admin"}
ARGS = {
    "name": "Health dashboard",
    "description": "d",
    "widgets": [
        {
            "kind": "bar",
            "title": "Incidents by severity",
            "sql_query": "SELECT severity, count(*) AS n FROM incidents GROUP BY severity ORDER BY severity",
            "config": {"x_col": "severity", "y_cols": ["n"]},
            "col_span": 6,
        }
    ],
}


@pytest.fixture(autouse=True)
def _isolate(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)


@pytest.fixture
def spa_mounted(tmp_path):
    """Guarantee the SPA/static mount is part of the app under test (it is
    only mounted at import when a web build exists on disk)."""
    if any(isinstance(r, Mount) and r.path == "" for r in app.router.routes):
        yield
        return
    build = tmp_path / "dist"
    build.mkdir()
    (build / "index.html").write_text("<!doctype html><div id=root></div>", encoding="utf-8")
    mount = Mount("/", _CachedStaticFiles(directory=str(build), html=True))
    app.router.routes.append(mount)
    try:
        yield
    finally:
        app.router.routes.remove(mount)


def _dashboard_model() -> FunctionModel:
    def _fn(messages: list[ModelMessage], info: AgentInfo) -> ModelResponse:
        if any(isinstance(p, ToolReturnPart) for m in messages for p in getattr(m, "parts", [])):
            return ModelResponse(parts=[TextPart(content="Dashboard created.")])
        return ModelResponse(parts=[ToolCallPart(tool_name="create_dashboard", args=ARGS)])

    return FunctionModel(_fn, model_name="dashboard")


def _start_run(monkeypatch, **extra: Any) -> str:
    monkeypatch.setattr(state, "llm_client_factory", _dashboard_model)
    response = client.post("/api/v1/runs", json={"objective": "make a dashboard", **extra}, headers=ADMIN)
    assert response.status_code == 202, response.text
    return response.json()["run_id"]


def _wait(run_id: str, *targets: str, timeout: float = 10.0) -> dict:
    deadline = time.monotonic() + timeout
    body: dict = {}
    while time.monotonic() < deadline:
        body = client.get(f"/api/v1/runs/{run_id}", headers=ADMIN).json()
        if body["status"] in targets:
            return body
        time.sleep(0.02)
    raise AssertionError(f"run {run_id} never reached {targets}; last={body.get('status')}")


class _StreamRecorder:
    """Raw ASGI client for one SSE request: records each body message with the
    run's live status at the moment it was sent."""

    def __init__(self, run_id: str) -> None:
        self.run_id = run_id
        self.chunks: list[tuple[str, str]] = []  # (run status when sent, body text)
        self.headers: dict[str, str] = {}
        self._disconnect = asyncio.Event()

    async def receive(self) -> dict[str, Any]:
        if not hasattr(self, "_sent_request"):
            self._sent_request = True
            return {"type": "http.request", "body": b"", "more_body": False}
        await self._disconnect.wait()
        return {"type": "http.disconnect"}

    async def send(self, message: dict[str, Any]) -> None:
        if message["type"] == "http.response.start":
            self.headers = {k.decode(): v.decode() for k, v in message["headers"]}
        elif message["type"] == "http.response.body" and message.get("body"):
            record = state.registry.get(self.run_id)
            self.chunks.append((record.status if record else "?", message["body"].decode()))

    def text(self) -> str:
        return "".join(body for _, body in self.chunks)

    def status_when_sent(self, event_type: str) -> str:
        for status, body in self.chunks:
            if f"event: {event_type}\n" in body:
                return status
        raise AssertionError(f"{event_type} never delivered; got: {self.text()[:400]}")

    def scope(self) -> dict[str, Any]:
        return {
            "type": "http",
            "asgi": {"version": "3.0", "spec_version": "2.3"},
            "http_version": "1.1",
            "method": "GET",
            "scheme": "http",
            "path": f"/api/v1/runs/{self.run_id}/events",
            "raw_path": f"/api/v1/runs/{self.run_id}/events".encode(),
            "query_string": b"as_user=u_admin",
            "root_path": "",
            "headers": [(b"host", b"testserver"), (b"accept", b"text/event-stream")],
            "client": ("127.0.0.1", 50000),
            "server": ("testserver", 80),
        }


async def _consume(recorder: _StreamRecorder, on_event: str, action, timeout: float = 10.0) -> None:
    """Run the SSE request; when `on_event` has been delivered, call
    `action()` once (in a thread, it may block), then read to stream_end."""
    task = asyncio.create_task(app(recorder.scope(), recorder.receive, recorder.send))
    deadline = time.monotonic() + timeout
    acted = False
    while time.monotonic() < deadline:
        text = recorder.text()
        if not acted and f"event: {on_event}\n" in text:
            acted = True
            await asyncio.to_thread(action)
        if "event: stream_end\n" in text:
            break
        await asyncio.sleep(0.02)
    recorder._disconnect.set()
    await asyncio.wait_for(task, timeout=5)
    assert acted, f"{on_event} never delivered: {recorder.text()[:400]}"


def test_sse_delivers_approval_live_through_the_full_app(monkeypatch, spa_mounted) -> None:
    run_id = _start_run(monkeypatch)
    recorder = _StreamRecorder(run_id)
    asyncio.run(
        _consume(recorder, "approval_requested", lambda: state.registry.resolve_approval(run_id, True))
    )

    assert recorder.headers["content-type"].startswith("text/event-stream")
    assert recorder.headers.get("cache-control") == "no-cache"
    assert recorder.headers.get("x-accel-buffering") == "no"
    # Incremental, not buffered: the approval reached the client while the run
    # was still paused on it, and the end of the stream came in a later message.
    assert recorder.status_when_sent("approval_requested") == "pending_approval"
    assert "event: stream_end\n" not in next(b for _, b in recorder.chunks if "approval_requested" in b)
    text = recorder.text()
    assert text.index("event: approval_granted") < text.index("event: final_answer") < text.index("event: stream_end")
    assert _wait(run_id, "completed")["status"] == "completed"


def test_late_subscriber_gets_the_pending_approval_replayed(monkeypatch, spa_mounted) -> None:
    """A client that connects after `approval_requested` was recorded still
    receives it (history replay), instead of only keep-alives."""
    run_id = _start_run(monkeypatch)
    _wait(run_id, "pending_approval")

    recorder = _StreamRecorder(run_id)
    asyncio.run(
        _consume(recorder, "approval_requested", lambda: state.registry.resolve_approval(run_id, False))
    )

    replayed = [json.loads(line[6:]) for line in recorder.text().splitlines() if line.startswith("data: {")]
    requested = [e for e in replayed if e.get("event_type") == "approval_requested"]
    assert len(requested) == 1, "replayed history must not duplicate events"
    assert requested[0]["data"]["tool_name"] == "create_dashboard"
    assert "event: approval_denied" in recorder.text()


def test_approval_wait_is_excluded_from_the_agent_wall_clock(monkeypatch) -> None:
    run_id = _start_run(monkeypatch, max_wall_clock_seconds=1)
    _wait(run_id, "pending_approval")
    time.sleep(2.0)  # the human takes twice the agent's whole budget to decide
    assert client.get(f"/api/v1/runs/{run_id}", headers=ADMIN).json()["status"] == "pending_approval"

    client.post(f"/api/v1/runs/{run_id}/approve", json={"approved": True}, headers=ADMIN)
    body = _wait(run_id, "completed", "time_limit_exceeded", "cancelled", "failed")
    assert body["status"] == "completed"
    assert body["final_answer"] == "Dashboard created."
    assert len(dashboards_repo.list_dashboards()) == 1


def test_approval_timeout_ends_the_run_cleanly_not_as_a_denial(monkeypatch) -> None:
    monkeypatch.setattr(settings, "APPROVAL_TIMEOUT_SECONDS", 0.5)
    run_id = _start_run(monkeypatch)
    body = _wait(run_id, "cancelled", "completed", "time_limit_exceeded", "failed")

    assert body["status"] == "cancelled"
    assert body["pending_approval"] is None
    types = [e["event_type"] for e in body["history"]]
    assert "approval_denied" not in types
    assert "time_limit_exceeded" not in types
    timed_out = next(e for e in body["history"] if e["event_type"] == "approval_timed_out")
    assert timed_out["data"]["tool_name"] == "create_dashboard"
    assert timed_out["data"]["timeout_seconds"] == 0.5
    cancelled = next(e for e in body["history"] if e["event_type"] == "run_cancelled")
    assert cancelled["data"]["reason"] == "approval_timeout"
    # The model was not consulted again after the timeout.
    assert types.index("approval_timed_out") > types.index("approval_requested")
    assert "final_answer" not in types
    assert dashboards_repo.list_dashboards() == []


def test_approval_timeout_defaults_to_fifteen_minutes_and_reads_the_env(monkeypatch) -> None:
    from agent_harness.config import HarnessConfig

    assert HarnessConfig().approval_timeout_seconds == settings.APPROVAL_TIMEOUT_SECONDS
    monkeypatch.setenv("APPROVAL_TIMEOUT_SECONDS", "42")
    assert settings._env_float("APPROVAL_TIMEOUT_SECONDS", 900.0) == 42.0
    monkeypatch.setenv("APPROVAL_TIMEOUT_SECONDS", "nope")
    assert settings._env_float("APPROVAL_TIMEOUT_SECONDS", 900.0) == 900.0
    monkeypatch.delenv("APPROVAL_TIMEOUT_SECONDS")
    assert settings._env_float("APPROVAL_TIMEOUT_SECONDS", 900.0) == 900.0
