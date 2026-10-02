"""Integrations: tool detail (JSON schema, recent calls, error rate, latency) and
per-tool timeout/retry settings that the agent loop really uses."""

from __future__ import annotations

import sys
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from pydantic import BaseModel

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from agent_harness import state  # noqa: E402
from agent_harness.config import HarnessConfig  # noqa: E402
from agent_harness.llm_client import build_scripted_model  # noqa: E402
from agent_harness.loop import AgentLoop  # noqa: E402
from agent_harness.tools.base import Tool  # noqa: E402
from api import app  # noqa: E402

client = TestClient(app)

ADMIN = {"X-User-Id": "u_admin"}
EDITOR = {"X-User-Id": "u_editor"}
EDITOR2 = {"X-User-Id": "u_editor2"}
VIEWER = {"X-User-Id": "u_viewer"}


@pytest.fixture(autouse=True)
def _isolate_trace_files(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)


def _run_script(monkeypatch, script: list[dict], headers: dict) -> dict:
    monkeypatch.setattr(state, "llm_client_factory", lambda: build_scripted_model(script))
    started = client.post("/api/v1/runs", json={"objective": "check things"}, headers=headers)
    run_id = started.json()["run_id"]
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        body = client.get(f"/api/v1/runs/{run_id}", headers=headers).json()
        if body["status"] == "completed":
            return body
        time.sleep(0.02)
    raise AssertionError("run did not complete")


def _status_call(service: str) -> dict:
    return {"action": "tool_call", "tool_name": "get_service_status", "tool_args": {"service_name": service}}


# --- detail -----------------------------------------------------------------------------


def test_detail_has_schema_description_and_global_default_limits() -> None:
    body = client.get("/api/v1/integrations/create_incident", headers=VIEWER).json()
    assert body["tool_name"] == "create_incident" and body["enabled"] is True
    assert body["requires_approval"] is True and "incident" in body["description"].lower()
    assert set(body["input_schema"]["properties"]) >= {"title", "description", "severity", "service_name"}
    assert body["input_schema"]["required"] == ["title", "description", "severity"]
    assert "incident_id" in body["output_schema"]["properties"]
    assert body["effective"] == {
        "timeout_seconds": 10.0,
        "max_retries": 2,
        "timeout_overridden": False,
        "retries_overridden": False,
    }
    assert body["stats"] == {"calls": 0, "errors": 0, "error_rate": None, "avg_latency_ms": None}
    assert body["recent_calls"] == []


def test_unknown_tool_detail_is_404() -> None:
    assert client.get("/api/v1/integrations/not_a_tool", headers=ADMIN).status_code == 404


def test_stats_and_recent_calls_come_from_real_traces_and_are_owner_scoped(monkeypatch) -> None:
    script = [_status_call("auth-service"), _status_call("no-such-service"), {"action": "final_answer", "final_answer": "done"}]
    run = _run_script(monkeypatch, script, EDITOR)

    body = client.get("/api/v1/integrations/get_service_status", headers=EDITOR).json()
    # 1 success + 1 failed attempt: an unknown service name is not retried.
    assert body["stats"]["calls"] == 2 and body["stats"]["errors"] == 1
    assert body["stats"]["error_rate"] == pytest.approx(0.5)
    assert body["stats"]["avg_latency_ms"] is not None and body["stats"]["avg_latency_ms"] >= 0
    outcomes = [c["outcome"] for c in body["recent_calls"]]
    assert outcomes.count("ok") == 1 and outcomes.count("error") == 1
    newest = body["recent_calls"][0]
    assert newest["run_id"] == run["run_id"] and newest["args"] == {"service_name": "no-such-service"}
    assert "Unknown service" in newest["error"]

    other = client.get("/api/v1/integrations/get_service_status", headers=EDITOR2).json()
    assert other["stats"]["calls"] == 0 and other["recent_calls"] == []
    assert client.get("/api/v1/integrations/get_service_status", headers=ADMIN).json()["stats"]["calls"] == 2


# --- settings ------------------------------------------------------------------------------


def test_admin_sets_and_clears_per_tool_limits() -> None:
    patched = client.patch("/api/v1/integrations/get_service_status", json={"timeout_seconds": 0.5, "max_retries": 0}, headers=ADMIN)
    assert patched.status_code == 200
    assert patched.json()["timeout_seconds"] == 0.5 and patched.json()["max_retries"] == 0
    detail = client.get("/api/v1/integrations/get_service_status", headers=ADMIN).json()
    assert detail["effective"] == {
        "timeout_seconds": 0.5,
        "max_retries": 0,
        "timeout_overridden": True,
        "retries_overridden": True,
    }
    assert any(r["tool_name"] == "get_service_status" and r["max_retries"] == 0 for r in client.get("/api/v1/integrations", headers=ADMIN).json())
    # null clears a limit back to the global default; the other one is untouched.
    cleared = client.patch("/api/v1/integrations/get_service_status", json={"timeout_seconds": None}, headers=ADMIN).json()
    assert cleared["timeout_seconds"] is None and cleared["max_retries"] == 0


def test_enabled_toggle_still_works_and_leaves_limits_alone() -> None:
    client.patch("/api/v1/integrations/recall", json={"max_retries": 4}, headers=ADMIN)
    off = client.patch("/api/v1/integrations/recall", json={"enabled": False}, headers=ADMIN).json()
    assert off["enabled"] is False and off["max_retries"] == 4


@pytest.mark.parametrize("body", [{}, {"timeout_seconds": 0}, {"timeout_seconds": 301}, {"max_retries": -1}, {"max_retries": 11}, {"enabled": None}])
def test_invalid_settings_are_rejected(body) -> None:
    assert client.patch("/api/v1/integrations/get_service_status", json=body, headers=ADMIN).status_code == 422


def test_settings_are_admin_only_and_unknown_tool_404() -> None:
    assert client.patch("/api/v1/integrations/get_service_status", json={"max_retries": 1}, headers=EDITOR).status_code == 403
    assert client.patch("/api/v1/integrations/nope", json={"max_retries": 1}, headers=ADMIN).status_code == 404


def test_the_run_registry_applies_the_stored_limits_to_a_real_run(monkeypatch) -> None:
    from agent_harness.exceptions import ToolExecutionError
    from agent_harness.tools.get_service_status import GetServiceStatusTool

    def _upstream_down(self, args):
        raise ToolExecutionError("service registry unavailable")  # transient: retryable

    monkeypatch.setattr(GetServiceStatusTool, "run", _upstream_down)
    client.patch("/api/v1/integrations/get_service_status", json={"max_retries": 0}, headers=ADMIN)
    run = _run_script(monkeypatch, [_status_call("auth-service"), {"action": "final_answer", "final_answer": "done"}], EDITOR)
    errors = [e for e in run["history"] if e["event_type"] == "tool_call_error"]
    assert len(errors) == 1  # one attempt only: the stored max_retries=0 was used, not the global 2
    assert not [e for e in run["history"] if e["event_type"] == "tool_call_retry"]
    assert [e for e in run["history"] if e["event_type"] == "tool_call_retries_exhausted"][0]["data"]["attempts"] == 1


# --- the loop itself --------------------------------------------------------------------------


class _SleepIn(BaseModel):
    seconds: float


class _SleepOut(BaseModel):
    slept: float


class _SlowTool(Tool[_SleepIn, _SleepOut]):
    name = "slow_tool"
    description = "Sleeps."
    input_model = _SleepIn
    output_model = _SleepOut
    requires_approval = False

    def __init__(self) -> None:
        self.calls = 0

    def run(self, args: _SleepIn) -> _SleepOut:
        self.calls += 1
        time.sleep(args.seconds)
        return _SleepOut(slept=args.seconds)


def _slow_loop(runs_dir, tool_settings, config: HarnessConfig):
    tool = _SlowTool()
    script = [
        {"action": "tool_call", "tool_name": "slow_tool", "tool_args": {"seconds": 0.4}},
        {"action": "final_answer", "final_answer": "finished"},
    ]
    loop = AgentLoop(
        model=build_scripted_model(script), tools={"slow_tool": tool}, config=config, runs_dir=runs_dir, tool_settings=tool_settings
    )
    return tool, loop


def test_loop_uses_a_tools_own_timeout_and_retry_count(runs_dir) -> None:
    config = HarnessConfig(tool_timeout_seconds=5.0, max_tool_retries=0, tool_retry_backoff_seconds=0.001)
    tool, loop = _slow_loop(runs_dir, {"slow_tool": {"timeout_seconds": 0.05, "max_retries": 2}}, config)
    result = loop.run("slow")
    timeouts = [e for e in result.history if e.event_type == "tool_call_timeout"]
    # The override (timeout 0.05s, 2 retries) beats the global (5s, 0 retries): 3 timed-out attempts.
    assert len(timeouts) == 3 and all(e.data["timeout_seconds"] == 0.05 for e in timeouts)
    assert [e for e in result.history if e.event_type == "tool_call_retries_exhausted"][0].data["attempts"] == 3
    assert result.status == "completed"


def test_loop_falls_back_to_global_limits_without_an_override(runs_dir) -> None:
    config = HarnessConfig(tool_timeout_seconds=0.05, max_tool_retries=1, tool_retry_backoff_seconds=0.001)
    _tool, loop = _slow_loop(runs_dir, {}, config)
    result = loop.run("slow")
    timeouts = [e for e in result.history if e.event_type == "tool_call_timeout"]
    assert len(timeouts) == 2 and timeouts[0].data["timeout_seconds"] == 0.05


def test_a_partial_override_only_replaces_the_value_that_is_set(runs_dir) -> None:
    config = HarnessConfig(tool_timeout_seconds=0.05, max_tool_retries=1, tool_retry_backoff_seconds=0.001)
    _tool, loop = _slow_loop(runs_dir, {"slow_tool": {"timeout_seconds": None, "max_retries": 3}}, config)
    result = loop.run("slow")
    timeouts = [e for e in result.history if e.event_type == "tool_call_timeout"]
    assert len(timeouts) == 4 and timeouts[0].data["timeout_seconds"] == 0.05
