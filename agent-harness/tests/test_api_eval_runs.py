"""API tests for the eval agent routes (phase 07 part B):
`POST /eval-runs`, `GET /eval-runs`, `GET /eval-runs/{id}`,
`GET /eval-metrics/overview`. Network-free throughout — every test
monkeypatches `routers.evals._judge_model_factory` to `None` (honest
"judge unavailable", the default in this environment since no real
`OPENAI_API_KEY` call is ever allowed in pytest) or a `FunctionModel`
double, mirroring `test_eval_scoring.py`'s pattern. Viewer's blanket 403 is
covered by `test_rbac.py`'s mutating-route sweep; this file covers the
scope/incremental/overview/poll-to-completion behavior the sweep doesn't."""

from __future__ import annotations

import time

import pytest
from fastapi.testclient import TestClient
from pydantic_ai.messages import ModelResponse, ToolCallPart
from pydantic_ai.models.function import AgentInfo, FunctionModel

from agent_harness import db, settings
from api import app

client = TestClient(app)


@pytest.fixture(autouse=True)
def _disable_mlflow_by_default(monkeypatch):
    """Every test in this file disables MLflow online-eval logging unless it
    explicitly re-enables it (see `test_online_eval_run_logs_to_mlflow`
    below) — matches `test_api_evals.py`'s convention of not depending on a
    real MLflow server for ordinary API-behavior tests."""
    monkeypatch.setattr(settings, "MLFLOW_TRACKING_URI", "")


def _seed_run(run_id: str, *, owner_id: str = "u_admin") -> None:
    db.upsert_run(
        {
            "run_id": run_id,
            "objective": "check auth-service status",
            "status": "completed",
            "started_at": time.time(),
            "finished_at": time.time(),
            "final_answer": "auth-service is operational.",
            "steps_taken": 2,
            "trace_path": None,
            "error": None,
            "owner_id": owner_id,
        }
    )
    db.append_event(
        run_id, 0, "tool_call_started", 1.0, None, {"tool_name": "get_service_status", "tool_args": {}}
    )
    db.append_event(
        run_id, 0, "tool_call_result", 1.1, None, {"tool_name": "get_service_status", "result": {"status": "operational"}}
    )
    db.append_event(run_id, 1, "final_answer", 1.2, None, {"final_answer": "auth-service is operational."})


def _verdict_model() -> FunctionModel:
    def _fn(messages, info: AgentInfo) -> ModelResponse:
        output_tools = getattr(info, "output_tools", None) or []
        tool_name = output_tools[0].name if output_tools else "final_result"
        return ModelResponse(
            parts=[
                ToolCallPart(
                    tool_name=tool_name,
                    args={
                        "task_success": 5,
                        "task_success_rationale": "resolved",
                        "groundedness": 5,
                        "groundedness_rationale": "supported",
                        "tool_choice": 5,
                        "tool_choice_rationale": "correct",
                        "safety_ok": True,
                        "safety_rationale": "fine",
                    },
                )
            ]
        )

    return FunctionModel(_fn, model_name="judge-double")


def _poll_until_terminal(eval_run_id: str, *, headers: dict, timeout: float = 10.0) -> dict:
    deadline = time.time() + timeout
    while time.time() < deadline:
        resp = client.get(f"/api/v1/eval-runs/{eval_run_id}", headers=headers)
        assert resp.status_code == 200
        body = resp.json()
        if body["status"] in ("completed", "failed"):
            return body
        time.sleep(0.05)
    raise AssertionError(f"eval_run '{eval_run_id}' never reached a terminal status within {timeout}s")


def test_editor_can_start_and_poll_a_scoring_run_no_judge_configured(monkeypatch):
    import agent_harness.routers.evals as evals_router_module

    monkeypatch.setattr(evals_router_module, "_judge_model_factory", lambda: None)
    _seed_run("api-run-a", owner_id="u_editor")

    started = client.post("/api/v1/eval-runs", json={"scope": "mine", "limit": 50}, headers={"X-User-Id": "u_editor"})
    assert started.status_code == 202
    eval_run_id = started.json()["id"]

    final = _poll_until_terminal(eval_run_id, headers={"X-User-Id": "u_editor"})
    assert final["status"] == "completed"
    assert final["done"] == final["total"]

    detail = client.get(f"/api/v1/eval-runs/{eval_run_id}", headers={"X-User-Id": "u_editor"}).json()
    by_metric = {r["metric"]: r for r in detail["results"] if r["run_id"] == "api-run-a"}
    assert by_metric["task_success"]["score"] is None  # honest: no judge configured
    assert by_metric["tool_use_correctness"]["score"] == 1.0  # rule-only


def test_scoring_run_with_function_model_double_persists_judge_scores(monkeypatch):
    import agent_harness.routers.evals as evals_router_module

    monkeypatch.setattr(evals_router_module, "_judge_model_factory", _verdict_model)
    _seed_run("api-run-b", owner_id="u_editor")

    started = client.post(
        "/api/v1/eval-runs", json={"scope": "mine", "limit": 50}, headers={"X-User-Id": "u_editor"}
    )
    assert started.status_code == 202
    final = _poll_until_terminal(started.json()["id"], headers={"X-User-Id": "u_editor"})
    assert final["status"] == "completed"

    detail = client.get(f"/api/v1/eval-runs/{final['id']}", headers={"X-User-Id": "u_editor"}).json()
    by_metric = {r["metric"]: r for r in detail["results"] if r["run_id"] == "api-run-b"}
    assert by_metric["task_success"]["score"] == 1.0
    assert by_metric["task_success"]["rationale"] == "resolved"


def test_rescoring_without_force_skips_then_force_rescopes(monkeypatch):
    import agent_harness.routers.evals as evals_router_module

    monkeypatch.setattr(evals_router_module, "_judge_model_factory", lambda: None)
    _seed_run("api-run-c", owner_id="u_editor")

    first = client.post("/api/v1/eval-runs", json={"scope": "mine", "limit": 50}, headers={"X-User-Id": "u_editor"})
    first_final = _poll_until_terminal(first.json()["id"], headers={"X-User-Id": "u_editor"})
    assert first_final["summary"]["scored"] >= 1

    second = client.post("/api/v1/eval-runs", json={"scope": "mine", "limit": 50}, headers={"X-User-Id": "u_editor"})
    second_final = _poll_until_terminal(second.json()["id"], headers={"X-User-Id": "u_editor"})
    assert second_final["summary"]["scored"] == 0
    assert second_final["summary"]["skipped_already_scored"] >= 1

    third = client.post(
        "/api/v1/eval-runs", json={"scope": "mine", "limit": 50, "force": True}, headers={"X-User-Id": "u_editor"}
    )
    third_final = _poll_until_terminal(third.json()["id"], headers={"X-User-Id": "u_editor"})
    assert third_final["summary"]["scored"] >= 1
    assert third_final["summary"]["skipped_already_scored"] == 0


def test_non_admin_scope_all_is_silently_narrowed_to_mine(monkeypatch):
    import agent_harness.routers.evals as evals_router_module

    monkeypatch.setattr(evals_router_module, "_judge_model_factory", lambda: None)
    _seed_run("api-run-mine", owner_id="u_editor")
    _seed_run("api-run-other", owner_id="u_admin")

    started = client.post("/api/v1/eval-runs", json={"scope": "all", "limit": 200}, headers={"X-User-Id": "u_editor"})
    assert started.status_code == 202
    assert started.json()["scope"] == "mine"
    final = _poll_until_terminal(started.json()["id"], headers={"X-User-Id": "u_editor"})
    run_ids_scored = {r["run_id"] for r in client.get(f"/api/v1/eval-runs/{final['id']}", headers={"X-User-Id": "u_editor"}).json()["results"]}
    assert "api-run-other" not in run_ids_scored


def test_non_admin_cannot_see_another_users_eval_run():
    _seed_run("api-run-owner-only", owner_id="u_editor")
    started = client.post("/api/v1/eval-runs", json={"scope": "mine"}, headers={"X-User-Id": "u_editor"})
    eval_run_id = started.json()["id"]

    stranger = client.get(f"/api/v1/eval-runs/{eval_run_id}", headers={"X-User-Id": "u_editor2"})
    assert stranger.status_code == 404

    admin = client.get(f"/api/v1/eval-runs/{eval_run_id}", headers={"X-User-Id": "u_admin"})
    assert admin.status_code == 200


def test_overview_reports_judge_unavailable_when_no_key_configured(monkeypatch):
    import agent_harness.routers.evals as evals_router_module
    from agent_harness import settings

    monkeypatch.setattr(evals_router_module, "_judge_model_factory", lambda: None)
    monkeypatch.setattr(settings, "OPENAI_API_KEY", "")
    overview = client.get("/api/v1/eval-metrics/overview", headers={"X-User-Id": "u_admin"})
    assert overview.status_code == 200
    assert overview.json()["judge_available"] is False


def test_overview_aggregates_scored_runs_for_the_caller(monkeypatch):
    import agent_harness.routers.evals as evals_router_module

    monkeypatch.setattr(evals_router_module, "_judge_model_factory", lambda: None)
    _seed_run("api-run-overview", owner_id="u_editor2")
    started = client.post("/api/v1/eval-runs", json={"scope": "mine"}, headers={"X-User-Id": "u_editor2"})
    _poll_until_terminal(started.json()["id"], headers={"X-User-Id": "u_editor2"})

    overview = client.get("/api/v1/eval-metrics/overview?days=30", headers={"X-User-Id": "u_editor2"})
    assert overview.status_code == 200
    body = overview.json()
    metric_names = {m["metric"] for m in body["metrics"]}
    assert "tool_use_correctness" in metric_names
    assert any(m["metric"] == "tool_use_correctness" and m["latest_mean"] == 1.0 for m in body["metrics"])


def test_online_eval_run_logs_to_mlflow(monkeypatch):
    """Re-enables the real (Dockerized) MLflow tracking URI from `.env` for
    this one test — if none is configured in this environment, skip rather
    than fail (mirrors `test_api_evals.py`'s `pytest.skip` pattern)."""
    import agent_harness.routers.evals as evals_router_module

    real_uri = settings.MLFLOW_TRACKING_URI
    # conftest doesn't clear MLFLOW_TRACKING_URI, but the autouse fixture
    # above just blanked `settings.MLFLOW_TRACKING_URI` for every other test
    # in this module; re-read it from the environment directly since that's
    # the real source of truth for whether a server is actually configured.
    import os

    env_uri = os.environ.get("MLFLOW_TRACKING_URI", real_uri)
    if not env_uri:
        pytest.skip("no MLFLOW_TRACKING_URI available in this environment to test against")
    monkeypatch.setattr(settings, "MLFLOW_TRACKING_URI", env_uri)

    monkeypatch.setattr(evals_router_module, "_judge_model_factory", lambda: None)
    _seed_run("api-run-mlflow", owner_id="u_editor")
    started = client.post("/api/v1/eval-runs", json={"scope": "mine"}, headers={"X-User-Id": "u_editor"})
    eval_run_id = started.json()["id"]
    _poll_until_terminal(eval_run_id, headers={"X-User-Id": "u_editor"}, timeout=20.0)

    # `mlflow_run_id` is attached by a second, slightly-later write (the
    # scoring job itself reaches `completed` before the MLflow logging
    # step that follows it) — poll a little longer specifically for it.
    deadline = time.time() + 15.0
    final = None
    while time.time() < deadline:
        final = client.get(f"/api/v1/eval-runs/{eval_run_id}", headers={"X-User-Id": "u_editor"}).json()
        if final.get("mlflow_run_id"):
            break
        time.sleep(0.2)
    assert final is not None and final["mlflow_run_id"], "a configured MLflow server must receive a real run id"
    assert final["mlflow_url"] and final["mlflow_run_id"] in final["mlflow_url"]
