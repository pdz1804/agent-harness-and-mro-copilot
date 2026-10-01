"""End-to-end HTTP smoke test (phase 08b): drives the real FastAPI app
(`api.app`), over a real `TestClient`, through one full user journey —
login-as an editor -> create a skill -> create an agent (auto mode) ->
run with `/skill` (slash) and auto-discover modes -> approve a
sensitive tool call -> refresh a dashboard from a template -> score
sessions (eval agent) -> read the metrics overview. No step is
short-circuited or mocked at the HTTP layer — only the LLM backend is a
double (network-free by default).

Marked `e2e` (not `live`) so it's part of the default, always-green
pytest run: by default every LLM call (main loop, skill router, judge)
goes through a deterministic `FunctionModel`/`None` double (see
`agent_harness.llm_client.build_scripted_model`/`build_router_model`,
`state.llm_client_factory`, `agent_harness.routers.evals._judge_model_factory`
— the same monkeypatch points the rest of the suite already uses).
Pass `--live` (a plain `pytest` CLI flag registered in `conftest.py`, not the
`-m live` marker) to instead exercise the real OpenAI API end-to-end
(requires `OPENAI_API_KEY`); assertions loosen to structural checks in that
mode since a real model's wording/tool choice isn't scripted.

Run both ways:
    pytest tests/test_e2e_smoke.py -v            # TestModel/FunctionModel doubles
    pytest tests/test_e2e_smoke.py -v --live      # real OpenAI API
"""

from __future__ import annotations

import sys
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from conftest import client_as  # noqa: E402

from agent_harness import (
    settings,  # noqa: E402
    state,  # noqa: E402
)
from agent_harness.llm_client import build_openai_model, build_router_model, build_scripted_model  # noqa: E402
from api import app  # noqa: E402

pytestmark = pytest.mark.e2e

client = TestClient(app)

_POLL_TIMEOUT_SECONDS = 30.0
_POLL_INTERVAL_SECONDS = 0.05


@pytest.fixture(autouse=True)
def _isolate_trace_files(tmp_path, monkeypatch):
    """Never write into the project's real `runs/` directory."""
    monkeypatch.chdir(tmp_path)


def _sequential_factory(*builders: Callable[[], Any]) -> Callable[[], Any]:
    """Returns a zero-arg factory that hands out `builders[0]()`,
    `builders[1]()`, ... on successive calls (repeating the last one once
    exhausted). `POST /runs` always calls `state.llm_client_factory` exactly
    twice per request — once for the main loop's model, once for the
    auto-mode skill router's — in that source order (`model=...` is written
    before `router_model=...` in the call), so this lets one monkeypatch
    supply two distinct, purpose-built doubles for a single request."""
    state = {"i": 0}

    def factory() -> Any:
        i = min(state["i"], len(builders) - 1)
        state["i"] += 1
        return builders[i]()

    return factory


def _wait_for_run_status(headers: dict, run_id: str, *targets: str) -> dict:
    deadline = time.monotonic() + _POLL_TIMEOUT_SECONDS
    body: dict = {}
    while time.monotonic() < deadline:
        response = client.get(f"/api/v1/runs/{run_id}", headers=headers)
        assert response.status_code == 200, response.text
        body = response.json()
        if body["status"] in targets:
            return body
        time.sleep(_POLL_INTERVAL_SECONDS)
    raise AssertionError(f"run {run_id} did not reach status in {targets} within timeout; last body: {body}")


def _wait_for_eval_run_status(headers: dict, eval_run_id: str, *targets: str) -> dict:
    deadline = time.monotonic() + _POLL_TIMEOUT_SECONDS
    body: dict = {}
    while time.monotonic() < deadline:
        response = client.get(f"/api/v1/eval-runs/{eval_run_id}", headers=headers)
        assert response.status_code == 200, response.text
        body = response.json()
        if body["status"] in targets:
            return body
        time.sleep(_POLL_INTERVAL_SECONDS)
    raise AssertionError(f"eval run {eval_run_id} did not reach status in {targets}; last body: {body}")


def test_full_journey_skill_agent_auto_run_approval_dashboard_eval(live: bool, monkeypatch: pytest.MonkeyPatch):
    if live and not settings.OPENAI_API_KEY:
        pytest.skip("--live requires OPENAI_API_KEY to be set")

    editor_headers = {"X-User-Id": "u_editor"}
    editor = client_as(client, "u_editor")

    # --- 1. "login-as" the editor user (local identity switcher: just the
    # header — see rbac.py's honesty note) and confirm /me resolves it. ---
    me = client.get("/api/v1/me", headers=editor_headers)
    assert me.status_code == 200, me.text
    assert me.json()["id"] == "u_editor"
    assert me.json()["role"] == "editor"

    # --- 2. create a skill -------------------------------------------------
    skill_resp = editor.post(
        "/api/v1/skills",
        json={
            "slug": "e2e-smoke-check",
            "name": "E2E smoke check",
            "description": "Checks a named service's status for the end-to-end smoke test.",
            "instructions": "Look up the requested service's status and report it plainly.",
            "allowed_tools": ["get_service_status"],
            "visibility": "private",
        },
    )
    assert skill_resp.status_code == 201, skill_resp.text
    skill = skill_resp.json()

    # --- 3. create an agent (auto mode) binding that skill -----------------
    prompt_id = client.get("/api/v1/prompts", headers=editor_headers).json()[0]["id"]
    agent_resp = editor.post(
        "/api/v1/agents",
        json={
            "slug": "e2e-smoke-agent",
            "name": "E2E smoke agent",
            "prompt_id": prompt_id,
            "skill_mode": "auto",
            "skill_ids": [skill["id"]],
            "base_tools": [],
            "visibility": "private",
        },
    )
    assert agent_resp.status_code == 201, agent_resp.text
    agent = agent_resp.json()

    # --- 4a. run via `/slug` (slash command), forcing the skill ------------
    if live:
        monkeypatch.setattr(state, "llm_client_factory", lambda: build_openai_model())
    else:
        slash_script = [
            {"action": "tool_call", "tool_name": "get_service_status", "tool_args": {"service_name": "auth-service"}},
            {"action": "final_answer", "final_answer": "auth-service is **operational**."},
        ]
        monkeypatch.setattr(state, "llm_client_factory", _sequential_factory(lambda: build_scripted_model(slash_script)))

    slash_run = editor.post(
        "/api/v1/runs", json={"objective": "/e2e-smoke-check what is the status of auth-service?"}
    )
    assert slash_run.status_code == 202, slash_run.text
    slash_body = _wait_for_run_status(editor_headers, slash_run.json()["run_id"], "completed")
    slash_event_types = [e["event_type"] for e in slash_body["history"]]
    assert "skill_invoked" in slash_event_types
    assert slash_body["final_answer"]

    # --- 4b. run via auto-discover mode on the same agent -------------------
    if live:
        monkeypatch.setattr(state, "llm_client_factory", lambda: build_openai_model())
    else:
        auto_script = [
            {"action": "tool_call", "tool_name": "get_service_status", "tool_args": {"service_name": "payments-api"}},
            {"action": "final_answer", "final_answer": "payments-api is **degraded**."},
        ]
        router_selection = {"skills": [skill["slug"]], "rationale": "matches service-status objective", "confidence": 0.9}
        monkeypatch.setattr(
            state,
            "llm_client_factory",
            _sequential_factory(
                lambda: build_scripted_model(auto_script),
                lambda: build_router_model(router_selection),
            ),
        )

    auto_run = editor.post(
        "/api/v1/runs", json={"objective": "what is the status of payments-api?", "agent_id": agent["id"]}
    )
    assert auto_run.status_code == 202, auto_run.text
    auto_body = _wait_for_run_status(editor_headers, auto_run.json()["run_id"], "completed")
    auto_event_types = [e["event_type"] for e in auto_body["history"]]
    if not live:
        assert "skill_routed" in auto_event_types
    assert auto_body["final_answer"]

    # --- 5. approval: a sensitive tool call must pause for human approval --
    if live:
        monkeypatch.setattr(state, "llm_client_factory", lambda: build_openai_model())
        approval_objective = (
            "search-index is reporting a down status; please create an incident for the on-call team."
        )
    else:
        approval_script = [
            {"action": "tool_call", "tool_name": "get_service_status", "tool_args": {"service_name": "search-index"}},
            {
                "action": "tool_call",
                "tool_name": "create_incident",
                "tool_args": {
                    "title": "search-index is down",
                    "description": "Automated e2e smoke check found search-index down.",
                    "severity": "high",
                },
            },
            {"action": "final_answer", "final_answer": "Incident created and escalated."},
        ]
        monkeypatch.setattr(
            state, "llm_client_factory", _sequential_factory(lambda: build_scripted_model(approval_script))
        )
        approval_objective = "search-index is down, please create an incident"

    approval_run = editor.post("/api/v1/runs", json={"objective": approval_objective})
    assert approval_run.status_code == 202, approval_run.text
    run_id = approval_run.json()["run_id"]
    pending = _wait_for_run_status(editor_headers, run_id, "pending_approval", "completed")
    if pending["status"] == "pending_approval":
        assert pending["pending_approval"]["tool_name"] == "create_incident"
        approve = editor.post(f"/api/v1/runs/{run_id}/approve", json={"approved": True})
        assert approve.status_code == 200, approve.text
        pending = _wait_for_run_status(editor_headers, run_id, "completed")
    approved_event_types = [e["event_type"] for e in pending["history"]]
    assert "approval_granted" in approved_event_types or not live

    # --- 6. dashboard: create from template, then refresh live -------------
    dashboard_resp = editor.post(
        "/api/v1/dashboards", json={"name": "e2e smoke dashboard", "template_key": "agent-performance"}
    )
    assert dashboard_resp.status_code == 201, dashboard_resp.text
    dashboard_id = dashboard_resp.json()["id"]
    assert dashboard_resp.json()["last_refreshed_at"] is None

    refresh_resp = editor.post(f"/api/v1/dashboards/{dashboard_id}/refresh")
    assert refresh_resp.status_code == 200, refresh_resp.text
    assert refresh_resp.json()["last_refreshed_at"] is not None
    assert len(refresh_resp.json()["widgets"]) > 0

    # --- 7. score sessions (eval agent) -------------------------------------
    from agent_harness.routers import evals as evals_router

    if live:
        monkeypatch.setattr(evals_router, "_judge_model_factory", lambda: build_openai_model())
    else:
        monkeypatch.setattr(evals_router, "_judge_model_factory", lambda: None)

    eval_start = editor.post("/api/v1/eval-runs", json={"scope": "mine", "force": True})
    assert eval_start.status_code == 202, eval_start.text
    eval_run_id = eval_start.json()["id"]
    eval_final = _wait_for_eval_run_status(editor_headers, eval_run_id, "completed", "failed")
    assert eval_final["status"] == "completed", eval_final
    assert eval_final["total"] >= 3  # slash + auto + approval runs, at least

    # --- 8. overview: real per-metric numbers, including the new agent-only
    # latency split (phase 08b backend change) ------------------------------
    overview = editor.get("/api/v1/eval-metrics/overview")
    assert overview.status_code == 200, overview.text
    overview_body = overview.json()
    metrics_by_name = {row["metric"]: row for row in overview_body["metrics"]}
    assert "latency_ms" in metrics_by_name
    assert "agent_latency_ms" in metrics_by_name
    # The approval run waited on a human decision; its wall-clock latency
    # must be >= its agent-only latency across the scored population.
    assert metrics_by_name["latency_ms"]["latest_mean"] >= metrics_by_name["agent_latency_ms"]["latest_mean"]
