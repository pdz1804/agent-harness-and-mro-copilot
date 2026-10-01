"""Integrations (12b): `GET /integrations`, `PATCH /integrations/{tool_name}`,
and the critical real requirement — a disabled tool is genuinely absent from
the tool list a *new* run's agent is built with (`run_registry.py::
RunRegistry._build_enabled_tool_registry`), not merely hidden in the UI.

`build_test_model(call_tools="all")` is used for the enforcement proof: this
`TestModel` calls every tool *currently registered on the agent* exactly
once, then returns a final answer — so if a disabled tool is truly absent
from the `pydantic_ai.Agent`'s tool list, `TestModel` itself never calls it,
which shows up as its name never appearing in any `tool_call_started`/
`llm_decision` trace event."""

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
    # `call_tools="all"` calls every tool *currently registered on the
    # agent* exactly once — a disabled tool is simply never among them,
    # which is exactly the real behavior under test. `create_incident` is
    # approval-gated, so `_wait_for_run_terminal` below auto-approves any
    # pending approval it triggers rather than treating that as a failure.
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
            approve = client.post(f"/api/v1/runs/{run_id}/approve", json={"approved": True})
            assert approve.status_code == 200
            approved = True
        elif body["status"] not in ("running", "pending_approval"):
            return body
        time.sleep(_POLL_INTERVAL_SECONDS)
    raise AssertionError(f"run {run_id} never reached a terminal status; last body: {body}")


def _tool_names_called(history: list[dict]) -> set[str]:
    names = set()
    for event in history:
        if event["event_type"] in ("tool_call_started", "llm_decision"):
            data = event.get("data") or {}
            name = data.get("tool_name")
            if name:
                names.add(name)
    return names


def test_list_integrations_seeded_enabled_by_default():
    response = client.get("/api/v1/integrations")
    assert response.status_code == 200
    body = response.json()
    names = {row["tool_name"]: row["enabled"] for row in body}
    assert names == {
        "search_knowledge_base": True,
        "get_service_status": True,
        "create_incident": True,
        "create_dashboard": True,
        "add_widget": True,
        "remember": True,
        "recall": True,
    }


def test_toggle_unknown_tool_name_returns_404():
    response = client.patch("/api/v1/integrations/not_a_real_tool", json={"enabled": False})
    assert response.status_code == 404


def test_disabling_a_tool_removes_it_from_a_new_runs_tool_list():
    """The mandatory real proof: disable `search_knowledge_base`, start a
    run whose agent would otherwise call every registered tool once
    (`TestModel(call_tools="all")`), and confirm the trace never shows it
    being called — because it was never registered on the agent at all."""
    toggle = client.patch("/api/v1/integrations/search_knowledge_base", json={"enabled": False})
    assert toggle.status_code == 200
    assert toggle.json()["enabled"] is False

    start = client.post("/api/v1/runs", json={"objective": "Investigate auth-service."})
    assert start.status_code == 202
    run_id = start.json()["run_id"]

    snapshot = _wait_for_run_terminal(run_id)
    assert snapshot["status"] == "completed"
    called = _tool_names_called(snapshot["history"])
    assert "search_knowledge_base" not in called
    # The other two enabled tools are still genuinely available and called.
    assert "get_service_status" in called


def test_reenabling_a_tool_restores_it_for_a_subsequent_run():
    client.patch("/api/v1/integrations/search_knowledge_base", json={"enabled": False})
    disabled_start = client.post("/api/v1/runs", json={"objective": "Investigate auth-service."})
    disabled_snapshot = _wait_for_run_terminal(disabled_start.json()["run_id"])
    assert "search_knowledge_base" not in _tool_names_called(disabled_snapshot["history"])

    reenable = client.patch("/api/v1/integrations/search_knowledge_base", json={"enabled": True})
    assert reenable.status_code == 200
    assert reenable.json()["enabled"] is True

    reenabled_start = client.post("/api/v1/runs", json={"objective": "Investigate auth-service."})
    reenabled_snapshot = _wait_for_run_terminal(reenabled_start.json()["run_id"])
    assert "search_knowledge_base" in _tool_names_called(reenabled_snapshot["history"])
