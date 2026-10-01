"""Tests for the async pause/resume run flow (`POST /runs`, `GET
/runs/{run_id}`, `POST /runs/{run_id}/approve`, `GET /runs`) that the web
UI uses instead of the synchronous `POST /run`.

Each background run executes on a real `threading.Thread` started by the
FastAPI request handler, so these tests poll `GET /runs/{run_id}` with a
short bounded wait rather than asserting on the immediate response body."""

from __future__ import annotations

import sys
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

# api.py lives at the project root (sibling of tests/), not under src/.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from agent_harness import state  # noqa: E402
from agent_harness.llm_client import build_routing_model  # noqa: E402
from api import app  # noqa: E402

client = TestClient(app)

_POLL_TIMEOUT_SECONDS = 5.0
_POLL_INTERVAL_SECONDS = 0.02


@pytest.fixture(autouse=True)
def _isolate_trace_files(tmp_path, monkeypatch):
    """Same isolation as test_api.py: never write into the project's real
    runs/ directory while exercising the background-thread run flow."""
    monkeypatch.chdir(tmp_path)


@pytest.fixture(autouse=True)
def _use_heuristic_llm(monkeypatch):
    """See test_api.py: inject the deterministic test double instead of the
    real OpenAI-requiring default factory."""
    monkeypatch.setattr(state, "llm_client_factory", lambda: build_routing_model())


def _wait_for_status(run_id: str, *targets: str) -> dict:
    """Poll GET /runs/{run_id} until status is one of `targets` (or fail)."""
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


def test_start_run_returns_immediately_with_running_status():
    response = client.post(
        "/api/v1/runs",
        json={"objective": "What is the status of auth-service?", "max_steps": 5},
    )
    assert response.status_code == 202
    body = response.json()
    assert body["status"] in ("running", "pending_approval", "completed")
    assert body["run_id"]

    final = _wait_for_status(body["run_id"], "completed")
    assert final["final_answer"] is not None
    assert len(final["history"]) > 0


def test_pending_approval_snapshot_then_approve_reaches_completed():
    response = client.post(
        "/api/v1/runs",
        json={"objective": "search-index is down, please create an incident", "max_steps": 6},
    )
    assert response.status_code == 202
    run_id = response.json()["run_id"]

    pending_body = _wait_for_status(run_id, "pending_approval")
    assert pending_body["pending_approval"] is not None
    assert pending_body["pending_approval"]["tool_name"] == "create_incident"
    assert "title" in pending_body["pending_approval"]["tool_args"]
    assert "severity" in pending_body["pending_approval"]["tool_args"]

    approve_response = client.post(f"/api/v1/runs/{run_id}/approve", json={"approved": True})
    assert approve_response.status_code == 200

    final_body = _wait_for_status(run_id, "completed")
    event_types = [e["event_type"] for e in final_body["history"]]
    assert "approval_granted" in event_types
    incident_results = [
        e
        for e in final_body["history"]
        if e["event_type"] == "tool_call_result" and e["data"].get("tool_name") == "create_incident"
    ]
    assert len(incident_results) == 1
    assert incident_results[0]["data"]["output"]["status"] == "created"
    assert final_body["pending_approval"] is None


def test_pending_approval_deny_unblocks_and_run_completes_denial_path():
    response = client.post(
        "/api/v1/runs",
        json={"objective": "search-index is down, please create an incident", "max_steps": 6},
    )
    assert response.status_code == 202
    run_id = response.json()["run_id"]

    pending_body = _wait_for_status(run_id, "pending_approval")
    assert pending_body["pending_approval"]["tool_name"] == "create_incident"

    deny_response = client.post(f"/api/v1/runs/{run_id}/approve", json={"approved": False})
    assert deny_response.status_code == 200

    final_body = _wait_for_status(run_id, "completed")
    event_types = [e["event_type"] for e in final_body["history"]]
    assert "approval_denied" in event_types
    assert "approval_granted" not in event_types
    incident_results = [
        e
        for e in final_body["history"]
        if e["event_type"] == "tool_call_result" and e["data"].get("tool_name") == "create_incident"
    ]
    assert len(incident_results) == 0


def test_approve_unknown_run_id_returns_404():
    response = client.post("/api/v1/runs/does-not-exist/approve", json={"approved": True})
    assert response.status_code == 404


def test_approve_with_no_pending_approval_returns_409():
    response = client.post(
        "/api/v1/runs",
        json={"objective": "What is the status of auth-service?", "max_steps": 5},
    )
    run_id = response.json()["run_id"]
    _wait_for_status(run_id, "completed")

    conflict_response = client.post(f"/api/v1/runs/{run_id}/approve", json={"approved": True})
    assert conflict_response.status_code == 409


def test_get_unknown_run_id_returns_404():
    response = client.get("/api/v1/runs/does-not-exist")
    assert response.status_code == 404


def test_start_run_rejects_blank_objective():
    response = client.post("/api/v1/runs", json={"objective": "   "})
    assert response.status_code == 422


def test_list_runs_includes_started_run():
    response = client.post(
        "/api/v1/runs",
        json={"objective": "What is the status of payments-api?", "max_steps": 5},
    )
    run_id = response.json()["run_id"]

    list_response = client.get("/api/v1/runs")
    assert list_response.status_code == 200
    run_ids = [r["run_id"] for r in list_response.json()]
    assert run_id in run_ids

    _wait_for_status(run_id, "completed")
