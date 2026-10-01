"""Sessions (12a): `POST /sessions`, `GET /sessions`, `GET /sessions/{id}`,
and `POST /runs`'s `session_id` plumbing.

The critical real behavior under test: a session's live status (`GET
/sessions`) must correctly reflect a run that is still `pending_approval`
in this process, exactly the same in-memory `RunRegistry` overlay
`GET /runs/{run_id}` already relies on — this is what makes a reload or a
second tab show the session as still live instead of resetting/going
stale (see `docs/product/PRD.md` section 4.4)."""

from __future__ import annotations

import sys
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from agent_harness import state  # noqa: E402
from agent_harness.llm_client import build_routing_model  # noqa: E402
from api import app  # noqa: E402

client = TestClient(app)

_POLL_TIMEOUT_SECONDS = 5.0
_POLL_INTERVAL_SECONDS = 0.02


@pytest.fixture(autouse=True)
def _isolate_trace_files(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)


@pytest.fixture(autouse=True)
def _use_heuristic_llm(monkeypatch):
    monkeypatch.setattr(state, "llm_client_factory", lambda: build_routing_model())


def _wait_for_run_status(run_id: str, *targets: str) -> dict:
    deadline = time.monotonic() + _POLL_TIMEOUT_SECONDS
    body: dict = {}
    while time.monotonic() < deadline:
        response = client.get(f"/api/v1/runs/{run_id}")
        assert response.status_code == 200
        body = response.json()
        if body["status"] in targets:
            return body
        time.sleep(_POLL_INTERVAL_SECONDS)
    raise AssertionError(f"run {run_id} did not reach status in {targets} within timeout; last body: {body}")


def _wait_for_session_status(session_id: str, *targets: str) -> dict:
    deadline = time.monotonic() + _POLL_TIMEOUT_SECONDS
    body: dict = {}
    while time.monotonic() < deadline:
        response = client.get("/api/v1/sessions")
        assert response.status_code == 200
        body = next(s for s in response.json() if s["id"] == session_id)
        if body["status"] in targets:
            return body
        time.sleep(_POLL_INTERVAL_SECONDS)
    raise AssertionError(f"session {session_id} did not reach status in {targets}; last body: {body}")


def test_create_session_explicit():
    response = client.post("/api/v1/sessions", json={"title": "My investigation"})
    assert response.status_code == 201
    body = response.json()
    assert body["title"] == "My investigation"
    assert body["status"] == "idle"
    assert body["last_run_id"] is None


def test_create_session_defaults_title():
    response = client.post("/api/v1/sessions", json={})
    assert response.status_code == 201
    assert response.json()["title"] == "New chat"


def test_start_run_without_session_id_auto_creates_session():
    response = client.post("/api/v1/runs", json={"objective": "What is the status of auth-service?"})
    assert response.status_code == 202
    body = response.json()
    session_id = body["session_id"]
    assert session_id

    session_response = client.get(f"/api/v1/sessions/{session_id}")
    assert session_response.status_code == 200
    session_body = session_response.json()
    assert session_body["title"].startswith("What is the status of auth-service?")
    assert any(r["run_id"] == body["run_id"] for r in session_body["runs"])


def test_start_run_with_explicit_session_id_reuses_session():
    session = client.post("/api/v1/sessions", json={"title": "Reused session"}).json()
    response = client.post(
        "/api/v1/runs", json={"objective": "What is the status of payments-api?", "session_id": session["id"]}
    )
    assert response.status_code == 202
    assert response.json()["session_id"] == session["id"]

    detail = client.get(f"/api/v1/sessions/{session['id']}").json()
    assert detail["title"] == "Reused session"
    assert len(detail["runs"]) == 1


def test_start_run_with_unknown_session_id_returns_404():
    response = client.post(
        "/api/v1/runs", json={"objective": "Objective", "session_id": "does-not-exist"}
    )
    assert response.status_code == 404


def test_session_reflects_live_pending_approval_status():
    """The scenario the phase file calls out: a session must show as
    pending_approval (not reset to idle or stuck stale) while its run is
    still awaiting a human decision in this process."""
    response = client.post(
        "/api/v1/runs",
        json={"objective": "search-index is down, please create an incident", "max_steps": 6},
    )
    assert response.status_code == 202
    run_id = response.json()["run_id"]
    session_id = response.json()["session_id"]

    _wait_for_run_status(run_id, "pending_approval")
    session_body = _wait_for_session_status(session_id, "pending_approval")
    assert session_body["last_run_id"] == run_id

    # Simulate "reload"/"a new tab": GET /sessions again, independent of any
    # prior request state, still reports the correct live status.
    reread = client.get("/api/v1/sessions").json()
    reread_session = next(s for s in reread if s["id"] == session_id)
    assert reread_session["status"] == "pending_approval"

    approve_response = client.post(f"/api/v1/runs/{run_id}/approve", json={"approved": True})
    assert approve_response.status_code == 200
    _wait_for_run_status(run_id, "completed")
    completed_session = _wait_for_session_status(session_id, "completed")
    assert completed_session["last_run_id"] == run_id


def test_get_session_unknown_id_returns_404():
    response = client.get("/api/v1/sessions/does-not-exist")
    assert response.status_code == 404


def test_list_sessions_idle_for_session_with_no_run():
    created = client.post("/api/v1/sessions", json={"title": "Empty session"}).json()
    sessions = client.get("/api/v1/sessions").json()
    match = next(s for s in sessions if s["id"] == created["id"])
    assert match["status"] == "idle"
    assert match["last_run_id"] is None
