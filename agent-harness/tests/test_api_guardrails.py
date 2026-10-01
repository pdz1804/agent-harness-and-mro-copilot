"""Guardrails (12c) API surface: `GET /guardrails`, `POST /guardrails`,
`PATCH /guardrails/{id}`, `GET /guardrails/triggers` — plus a real
end-to-end proof through `POST /runs` that a configured input guardrail
genuinely blocks a run (status `guardrail_blocked`, a `guardrail_blocked`
trace event, and no LLM call ever made)."""

from __future__ import annotations

import sys
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from agent_harness import state  # noqa: E402
from agent_harness.llm_client import build_test_model  # noqa: E402
from api import app  # noqa: E402

client = TestClient(app)

_POLL_TIMEOUT_SECONDS = 10.0
_POLL_INTERVAL_SECONDS = 0.02


@pytest.fixture(autouse=True)
def _isolate_trace_files(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)


@pytest.fixture(autouse=True)
def _use_test_model(monkeypatch):
    monkeypatch.setattr(state, "llm_client_factory", lambda: build_test_model(call_tools="all"))


def _wait_for_run_terminal(run_id: str) -> dict:
    deadline = time.monotonic() + _POLL_TIMEOUT_SECONDS
    body: dict = {}
    approved = False
    while time.monotonic() < deadline:
        response = client.get(f"/api/v1/runs/{run_id}")
        assert response.status_code == 200
        body = response.json()
        if body["status"] == "pending_approval" and not approved:
            client.post(f"/api/v1/runs/{run_id}/approve", json={"approved": True})
            approved = True
        elif body["status"] not in ("running", "pending_approval"):
            return body
        time.sleep(_POLL_INTERVAL_SECONDS)
    raise AssertionError(f"run {run_id} never reached a terminal status; last body: {body}")


def test_default_guardrail_seed_lists_severity_cap_enabled():
    response = client.get("/api/v1/guardrails")
    assert response.status_code == 200
    rows = response.json()
    severity_rows = [r for r in rows if r["kind"] == "severity_upgrade_block"]
    assert len(severity_rows) == 1
    assert severity_rows[0]["enabled"] is True


def test_create_and_toggle_guardrail():
    create = client.post(
        "/api/v1/guardrails",
        json={
            "name": "block wipe requests",
            "kind": "objective_pattern_block",
            "config": {"patterns": ["wipe the database"]},
        },
    )
    assert create.status_code == 201
    body = create.json()
    assert body["enabled"] is True
    assert body["config"] == {"patterns": ["wipe the database"]}
    guardrail_id = body["id"]

    disable = client.patch(f"/api/v1/guardrails/{guardrail_id}", json={"enabled": False})
    assert disable.status_code == 200
    assert disable.json()["enabled"] is False


def test_toggle_unknown_guardrail_returns_404():
    response = client.patch("/api/v1/guardrails/not-a-real-id", json={"enabled": False})
    assert response.status_code == 404


def test_configured_pattern_guardrail_genuinely_blocks_a_real_run():
    create = client.post(
        "/api/v1/guardrails",
        json={
            "name": "block wipe requests",
            "kind": "objective_pattern_block",
            "config": {"patterns": ["wipe the database"]},
        },
    )
    assert create.status_code == 201

    start = client.post("/api/v1/runs", json={"objective": "please wipe the database now"})
    assert start.status_code == 202
    run_id = start.json()["run_id"]

    snapshot = _wait_for_run_terminal(run_id)
    assert snapshot["status"] == "guardrail_blocked"
    assert snapshot["steps_taken"] == 0
    event_types = [e["event_type"] for e in snapshot["history"]]
    assert event_types == ["guardrail_blocked"]
    # No LLM call was ever made: no llm_decision event exists at all.
    assert "llm_decision" not in event_types

    triggers = client.get("/api/v1/guardrails/triggers")
    assert triggers.status_code == 200
    trigger_events = [t for t in triggers.json() if t["run_id"] == run_id]
    assert len(trigger_events) == 1
    assert trigger_events[0]["event_type"] == "guardrail_blocked"
