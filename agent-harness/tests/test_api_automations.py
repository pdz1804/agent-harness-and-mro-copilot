"""Automations (12d) API surface: `GET /automations`, `POST /automations`,
`PATCH /automations/{id}`, `GET /automations/runs` — plus a real end-to-end
proof that flipping a real service's status through the existing
`POST /services/{name}/status` code path (the endpoint the Services page
uses) actually starts a new real run through `RunRegistry.start_run`, the
exact same code path a manual `POST /runs` submission uses, when an enabled
automation matches that service+status transition."""

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


def test_create_automation_rejects_unknown_service_name():
    response = client.post(
        "/api/v1/automations",
        json={
            "name": "bad rule",
            "trigger_service_name": "not-a-real-service",
            "trigger_status": "down",
            "objective_template": "investigate",
        },
    )
    assert response.status_code == 422


def test_create_and_toggle_automation():
    create = client.post(
        "/api/v1/automations",
        json={
            "name": "search-index down",
            "trigger_service_name": "search-index",
            "trigger_status": "down",
            "objective_template": "investigate search-index",
        },
    )
    assert create.status_code == 201
    body = create.json()
    assert body["enabled"] is True
    automation_id = body["id"]

    listed = client.get("/api/v1/automations")
    assert listed.status_code == 200
    assert any(a["id"] == automation_id for a in listed.json())

    disable = client.patch(f"/api/v1/automations/{automation_id}", json={"enabled": False})
    assert disable.status_code == 200
    assert disable.json()["enabled"] is False


def test_toggle_unknown_automation_returns_404():
    response = client.patch("/api/v1/automations/not-a-real-id", json={"enabled": False})
    assert response.status_code == 404


def test_flipping_service_status_genuinely_starts_a_real_automation_run():
    """The mandatory real proof: configure a real automation, flip
    search-index to down via the same endpoint the Services page uses, and
    confirm a real new run actually started — tagged with
    triggered_by_automation_id, reaching a real terminal status with real
    agent activity (not a simulated/logged-only trigger)."""
    create = client.post(
        "/api/v1/automations",
        json={
            "name": "search-index down",
            "trigger_service_name": "search-index",
            "trigger_status": "down",
            "objective_template": "investigate search-index outage",
        },
    )
    assert create.status_code == 201
    automation_id = create.json()["id"]

    before_runs = {r["run_id"] for r in client.get("/api/v1/runs").json()}

    flip = client.post("/api/v1/services/search-index/status", json={"status": "down"})
    assert flip.status_code == 200

    # Poll GET /runs until the automation-triggered run shows up (the
    # trigger happens synchronously inside the status-flip request, but the
    # background thread needs a moment to record its first event).
    deadline = time.monotonic() + _POLL_TIMEOUT_SECONDS
    new_run = None
    while time.monotonic() < deadline and new_run is None:
        runs = client.get("/api/v1/runs").json()
        candidates = [
            r for r in runs if r["run_id"] not in before_runs and r["triggered_by_automation_id"] == automation_id
        ]
        if candidates:
            new_run = candidates[0]
        else:
            time.sleep(_POLL_INTERVAL_SECONDS)
    assert new_run is not None, "no automation-triggered run appeared in GET /runs"
    assert new_run["objective"] == "investigate search-index outage"

    snapshot = _wait_for_run_terminal(new_run["run_id"])
    assert snapshot["status"] == "completed"
    assert snapshot["triggered_by_automation_id"] == automation_id
    # Real agent activity happened — not a simulated/logged-only trigger.
    event_types = [e["event_type"] for e in snapshot["history"]]
    assert "llm_decision" in event_types
    assert any(e == "final_answer" for e in event_types)

    triggered_runs = client.get("/api/v1/automations/runs").json()
    assert any(r["run_id"] == new_run["run_id"] for r in triggered_runs)


def test_disabled_automation_does_not_start_a_run():
    create = client.post(
        "/api/v1/automations",
        json={
            "name": "search-index down (disabled)",
            "trigger_service_name": "search-index",
            "trigger_status": "down",
            "objective_template": "investigate search-index outage",
            "enabled": False,
        },
    )
    assert create.status_code == 201

    before_runs = {r["run_id"] for r in client.get("/api/v1/runs").json()}
    flip = client.post("/api/v1/services/search-index/status", json={"status": "down"})
    assert flip.status_code == 200

    time.sleep(0.5)
    after_runs = client.get("/api/v1/runs").json()
    assert {r["run_id"] for r in after_runs} == before_runs


def test_wildcard_any_service_automation_matches_every_service():
    create = client.post(
        "/api/v1/automations",
        json={
            "name": "any service degraded",
            "trigger_service_name": "any",
            "trigger_status": "degraded",
            "objective_template": "investigate a degraded service",
        },
    )
    assert create.status_code == 201
    automation_id = create.json()["id"]

    before_runs = {r["run_id"] for r in client.get("/api/v1/runs").json()}
    flip = client.post("/api/v1/services/auth-service/status", json={"status": "degraded"})
    assert flip.status_code == 200

    deadline = time.monotonic() + _POLL_TIMEOUT_SECONDS
    matched = False
    while time.monotonic() < deadline and not matched:
        runs = client.get("/api/v1/runs").json()
        matched = any(
            r["run_id"] not in before_runs and r["triggered_by_automation_id"] == automation_id for r in runs
        )
        if not matched:
            time.sleep(_POLL_INTERVAL_SECONDS)
    assert matched, "wildcard 'any' automation never started a run"
