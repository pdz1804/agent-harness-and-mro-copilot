"""Regression: a model that emits several approval-gated tool calls in a single
response (Pydantic AI runs them concurrently) must never hang the run, never
create duplicates, and always leave a resolvable approval or a terminal state."""

from __future__ import annotations

import sys
import time
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient
from pydantic_ai.messages import ModelMessage, ModelResponse, TextPart, ToolCallPart, ToolReturnPart
from pydantic_ai.models.function import AgentInfo, FunctionModel

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from agent_harness import state  # noqa: E402
from agent_harness.repos import dashboards as dashboards_repo  # noqa: E402
from api import app  # noqa: E402

client = TestClient(app)
ADMIN = {"X-User-Id": "u_admin"}

WIDGET = {
    "kind": "bar",
    "title": "Incidents by severity",
    "sql_query": "SELECT severity, count(*) AS n FROM incidents GROUP BY severity ORDER BY severity",
    "config": {"x_col": "severity", "y_cols": ["n"]},
    "col_span": 6,
}
ARGS = {"name": "Health dashboard", "description": "d", "widgets": [WIDGET]}


@pytest.fixture(autouse=True)
def _isolate(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)


def _parallel_model(arg_sets: list[dict[str, Any]]) -> FunctionModel:
    """First response: one create_dashboard call per entry of `arg_sets`.
    After any tool results arrive: a final answer."""

    def _fn(messages: list[ModelMessage], info: AgentInfo) -> ModelResponse:
        has_return = any(isinstance(p, ToolReturnPart) for m in messages for p in getattr(m, "parts", []))
        if has_return:
            return ModelResponse(parts=[TextPart(content="Done.")])
        return ModelResponse(parts=[ToolCallPart(tool_name="create_dashboard", args=a) for a in arg_sets])

    return FunctionModel(_fn, model_name="parallel")


def _wait(run_id: str, *targets: str, timeout: float = 10.0) -> dict:
    deadline = time.monotonic() + timeout
    body: dict = {}
    while time.monotonic() < deadline:
        body = client.get(f"/api/v1/runs/{run_id}", headers=ADMIN).json()
        if body["status"] in targets:
            return body
        time.sleep(0.02)
    raise AssertionError(f"run {run_id} never reached {targets}; last status={body.get('status')} pending={body.get('pending_approval')}")


def _run_to_completion(arg_sets: list[dict[str, Any]], monkeypatch) -> dict:
    monkeypatch.setattr(state, "llm_client_factory", lambda: _parallel_model(arg_sets))
    response = client.post("/api/v1/runs", json={"objective": "make a dashboard"}, headers=ADMIN)
    assert response.status_code == 202, response.text
    run_id = response.json()["run_id"]
    approvals = 0
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        body = client.get(f"/api/v1/runs/{run_id}", headers=ADMIN).json()
        if body["status"] == "pending_approval":
            assert body["pending_approval"] is not None, "pending_approval status with no approval to resolve"
            approvals += 1
            assert approvals <= 3, "approval requested repeatedly"
            client.post(f"/api/v1/runs/{run_id}/approve", json={"approved": True}, headers=ADMIN)
        elif body["status"] != "running":
            return body
        time.sleep(0.02)
    raise AssertionError(f"run hung; last={body['status']} pending={body.get('pending_approval')}")


def test_identical_parallel_calls_create_exactly_one_dashboard(monkeypatch) -> None:
    body = _run_to_completion([ARGS, ARGS], monkeypatch)
    assert body["status"] == "completed"
    assert len(dashboards_repo.list_dashboards()) == 1
    requested = [e for e in body["history"] if e["event_type"] == "approval_requested"]
    assert len(requested) == 1


def test_distinct_parallel_calls_are_approved_one_at_a_time(monkeypatch) -> None:
    other = {**ARGS, "name": "Second dashboard"}
    body = _run_to_completion([ARGS, other], monkeypatch)
    assert body["status"] == "completed"
    assert len(dashboards_repo.list_dashboards()) == 2
    assert body["pending_approval"] is None


def test_denied_identical_parallel_calls_ask_once_and_create_nothing(monkeypatch) -> None:
    monkeypatch.setattr(state, "llm_client_factory", lambda: _parallel_model([ARGS, ARGS]))
    run_id = client.post("/api/v1/runs", json={"objective": "make a dashboard"}, headers=ADMIN).json()["run_id"]
    _wait(run_id, "pending_approval")
    client.post(f"/api/v1/runs/{run_id}/approve", json={"approved": False}, headers=ADMIN)
    body = _wait(run_id, "completed")
    assert [e["event_type"] for e in body["history"]].count("approval_requested") == 1
    assert dashboards_repo.list_dashboards() == []


def test_unanswered_approval_is_bounded_by_the_approval_budget(monkeypatch) -> None:
    from agent_harness import settings

    monkeypatch.setattr(settings, "APPROVAL_TIMEOUT_SECONDS", 0.5)
    monkeypatch.setattr(state, "llm_client_factory", lambda: _parallel_model([ARGS, ARGS]))
    run_id = client.post("/api/v1/runs", json={"objective": "make a dashboard"}, headers=ADMIN).json()["run_id"]
    body = _wait(run_id, "cancelled", "completed", "time_limit_exceeded", "failed", timeout=8.0)
    assert body["status"] == "cancelled"
    assert body["pending_approval"] is None
    assert [e["event_type"] for e in body["history"]].count("approval_requested") == 1
    assert dashboards_repo.list_dashboards() == []


def test_loop_disables_parallel_tool_calls_when_a_tool_needs_approval() -> None:
    from agent_harness.loop import AgentLoop
    from agent_harness.tools.registry import build_default_registry

    gated = AgentLoop(model=_parallel_model([ARGS]), tools=build_default_registry("u_admin", "admin"))._build_agent()
    assert gated.model_settings is not None and gated.model_settings.get("parallel_tool_calls") is False
    read_only = {n: t for n, t in build_default_registry("u_admin", "admin").items() if not t.requires_approval}
    free = AgentLoop(model=_parallel_model([ARGS]), tools=read_only)._build_agent()
    assert not free.model_settings
