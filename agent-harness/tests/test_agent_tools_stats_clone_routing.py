"""Agents: usage stats (runs, judge success rate), clone, and the test chat marker;
Skills: the routing tester that runs the real router."""

from __future__ import annotations

import sys
import time
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from agent_harness import db, state  # noqa: E402
from agent_harness.llm_client import build_raising_router_model, build_router_model, build_test_model  # noqa: E402
from agent_harness.repos import evals as evals_repo  # noqa: E402
from agent_harness.routers import agents as agents_router  # noqa: E402
from api import app  # noqa: E402

client = TestClient(app)

ADMIN = {"X-User-Id": "u_admin"}
EDITOR = {"X-User-Id": "u_editor"}
EDITOR2 = {"X-User-Id": "u_editor2"}
VIEWER = {"X-User-Id": "u_viewer"}


@pytest.fixture(autouse=True)
def _isolate_trace_files(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)


def _agent(slug: str) -> dict[str, Any]:
    return next(a for a in client.get("/api/v1/agents", headers=ADMIN).json() if a["slug"] == slug)


def _store_run(run_id: str, agent_id: str, owner: str, status: str = "completed", steps: int = 2) -> None:
    session_id = f"s-{run_id}"
    db.create_session(session_id, run_id, "2026-09-01T00:00:00+00:00", owner_id=owner, agent_id=agent_id)
    db.upsert_run(
        {
            "run_id": run_id,
            "objective": f"objective {run_id}",
            "status": status,
            "started_at": time.time(),
            "finished_at": time.time(),
            "final_answer": "a",
            "steps_taken": steps,
            "trace_path": "",
            "error": None,
            "session_id": session_id,
            "owner_id": owner,
            "agent_id": agent_id,
        }
    )


def _judge(run_id: str, agent_id: str, score: float, passed: bool | None) -> None:
    eval_run = evals_repo.create_eval_run(triggered_by="u_admin", scope="all", judge_version="jv", judge_model="m", total=1)
    evals_repo.insert_results(
        eval_run["id"],
        [{"run_id": run_id, "metric": "task_success", "score": score, "passed": passed, "rationale": "r", "judge_version": "jv", "agent_id": agent_id}],
    )


# --- stats --------------------------------------------------------------------------------------


def test_stats_are_zero_for_an_unused_agent() -> None:
    body = client.get(f"/api/v1/agents/{_agent('ops-assistant')['id']}/stats", headers=EDITOR).json()
    assert body == {"runs": 0, "by_status": {}, "avg_steps": None, "scored_runs": 0, "success_rate": None}


def test_stats_count_runs_by_status_and_the_judge_success_rate() -> None:
    agent_id = _agent("ops-assistant")["id"]
    _store_run("x1", agent_id, "u_editor", steps=2)
    _store_run("x2", agent_id, "u_editor", steps=4)
    _store_run("x3", agent_id, "u_editor", status="failed", steps=0)
    _store_run("x4", agent_id, "u_editor2")
    _judge("x1", agent_id, 0.9, True)
    _judge("x2", agent_id, 0.2, False)
    _judge("x4", agent_id, 1.0, True)
    body = client.get(f"/api/v1/agents/{agent_id}/stats", headers=EDITOR).json()
    assert body["runs"] == 3 and body["by_status"] == {"completed": 2, "failed": 1}
    assert body["avg_steps"] == pytest.approx(2.0)
    assert body["scored_runs"] == 2 and body["success_rate"] == pytest.approx(0.5)
    # An admin sees everyone's runs; another editor sees only their own.
    assert client.get(f"/api/v1/agents/{agent_id}/stats", headers=ADMIN).json()["runs"] == 4
    other = client.get(f"/api/v1/agents/{agent_id}/stats", headers=EDITOR2).json()
    assert other["runs"] == 1 and other["success_rate"] == 1.0


def test_stats_respect_agent_visibility() -> None:
    private = client.post(
        "/api/v1/agents",
        json={"slug": "evans-private", "name": "Private", "prompt_id": _agent("ops-assistant")["prompt_id"], "visibility": "private"},
        headers=EDITOR,
    ).json()
    assert client.get(f"/api/v1/agents/{private['id']}/stats", headers=EDITOR).status_code == 200
    assert client.get(f"/api/v1/agents/{private['id']}/stats", headers=EDITOR2).status_code == 404
    assert client.get("/api/v1/agents/nope/stats", headers=EDITOR).status_code == 404


# --- clone ----------------------------------------------------------------------------------------


def test_clone_copies_configuration_into_a_private_agent_owned_by_the_caller() -> None:
    source = _agent("kb-concierge")
    cloned = client.post(f"/api/v1/agents/{source['id']}/clone", headers=EDITOR)
    assert cloned.status_code == 201
    body = cloned.json()
    assert body["slug"] == "kb-concierge-copy" and body["name"] == "KB Concierge (copy)"
    assert body["owner_id"] == "u_editor" and body["visibility"] == "private" and body["is_default"] is False
    for field in ("prompt_id", "skill_mode", "skill_ids", "base_tools", "max_steps", "description", "avatar_color"):
        assert body[field] == source[field]
    again = client.post(f"/api/v1/agents/{source['id']}/clone", headers=EDITOR).json()
    assert again["slug"] == "kb-concierge-copy-2"


def test_cloning_the_default_agent_does_not_make_the_copy_default() -> None:
    body = client.post(f"/api/v1/agents/{_agent('ops-assistant')['id']}/clone", headers=EDITOR).json()
    assert body["is_default"] is False
    assert [a["slug"] for a in client.get("/api/v1/agents", headers=ADMIN).json() if a["is_default"]] == ["ops-assistant"]


def test_clone_rules() -> None:
    source = _agent("ops-assistant")
    assert client.post(f"/api/v1/agents/{source['id']}/clone", headers=VIEWER).status_code == 403
    assert client.post("/api/v1/agents/nope/clone", headers=EDITOR).status_code == 404
    private = client.post(
        "/api/v1/agents", json={"slug": "hidden", "name": "Hidden", "prompt_id": source["prompt_id"], "visibility": "private"}, headers=EDITOR
    ).json()
    assert client.post(f"/api/v1/agents/{private['id']}/clone", headers=EDITOR2).status_code == 404


# --- test chat -------------------------------------------------------------------------------------


def test_agent_test_chat_runs_the_agent_in_a_marked_session(monkeypatch) -> None:
    agent = _agent("ops-assistant")
    monkeypatch.setattr(state, "llm_client_factory", lambda: build_test_model(call_tools=[]))
    started = client.post("/api/v1/runs", json={"objective": "ping", "agent_id": agent["id"], "agent_test": True}, headers=EDITOR).json()
    deadline = time.monotonic() + 8
    while time.monotonic() < deadline and client.get(f"/api/v1/runs/{started['run_id']}", headers=EDITOR).json()["status"] == "running":
        time.sleep(0.02)
    run = client.get(f"/api/v1/runs/{started['run_id']}", headers=EDITOR).json()
    assert run["agent_id"] == agent["id"]
    session = client.get(f"/api/v1/sessions/{started['session_id']}", headers=EDITOR).json()
    assert session["title"] == "[Test] ping" and session["agent_id"] == agent["id"]
    # It counts toward the agent's usage like any other run.
    assert client.get(f"/api/v1/agents/{agent['id']}/stats", headers=EDITOR).json()["runs"] == 1


# --- skills routing tester ----------------------------------------------------------------------------


def _router(monkeypatch, selection: dict[str, Any]) -> None:
    monkeypatch.setattr(agents_router, "_router_model_factory", lambda: build_router_model(selection))


def test_route_test_returns_the_real_routers_pick_with_rationale_and_confidence(monkeypatch) -> None:
    _router(monkeypatch, {"skills": ["triage-outage"], "rationale": "an outage report", "confidence": 0.92})
    body = client.post("/api/v1/skills/route-test", json={"objective": "auth-service is returning errors"}, headers=VIEWER).json()
    assert body["mode"] == "router" and body["selected"] == ["triage-outage"]
    assert body["confidence"] == pytest.approx(0.92) and body["rationale"] == "an outage report"
    assert body["threshold"] == 0.5 and body["raw_picks"] == ["triage-outage"]
    selected = [c["slug"] for c in body["candidates"] if c["selected"]]
    assert selected == ["triage-outage"]
    assert {"kb-answer", "build-dashboard"} <= {c["slug"] for c in body["candidates"]}
    assert body["latency_ms"] is not None


def test_low_confidence_degrades_to_no_skill_but_shows_what_was_proposed(monkeypatch) -> None:
    _router(monkeypatch, {"skills": ["kb-answer"], "rationale": "weak match", "confidence": 0.2})
    body = client.post("/api/v1/skills/route-test", json={"objective": "tell me a joke"}, headers=EDITOR).json()
    assert body["selected"] == [] and body["raw_picks"] == ["kb-answer"]
    assert not any(c["selected"] for c in body["candidates"])


def test_picks_outside_the_candidate_list_are_dropped(monkeypatch) -> None:
    _router(monkeypatch, {"skills": ["made-up-skill", "kb-answer"], "rationale": "r", "confidence": 0.9})
    body = client.post("/api/v1/skills/route-test", json={"objective": "how do we roll back"}, headers=EDITOR).json()
    assert body["selected"] == ["kb-answer"]


def test_a_slash_command_is_reported_as_forced_without_calling_the_router(monkeypatch) -> None:
    def _boom() -> None:
        raise AssertionError("router must not be called for a slash command")

    monkeypatch.setattr(agents_router, "_router_model_factory", _boom)
    body = client.post("/api/v1/skills/route-test", json={"objective": "/kb-answer how do we roll back"}, headers=EDITOR).json()
    assert body["mode"] == "slash" and body["selected"] == ["kb-answer"] and body["confidence"] == 1.0
    assert client.post("/api/v1/skills/route-test", json={"objective": "/no-such-skill hi"}, headers=EDITOR).status_code == 422
    assert client.post("/api/v1/skills/route-test", json={"objective": "/kb-answer"}, headers=EDITOR).status_code == 422


def test_candidates_can_be_restricted_to_an_agents_skill_list(monkeypatch) -> None:
    concierge = _agent("kb-concierge")
    kb = next(s for s in client.get("/api/v1/skills", headers=ADMIN).json() if s["slug"] == "kb-answer")
    patched = client.patch(f"/api/v1/agents/{concierge['id']}", json={"skill_mode": "auto", "skill_ids": [kb["id"]]}, headers=ADMIN)
    assert patched.status_code == 200
    _router(monkeypatch, {"skills": ["kb-answer"], "rationale": "r", "confidence": 0.8})
    body = client.post("/api/v1/skills/route-test", json={"objective": "q", "agent_id": concierge["id"]}, headers=EDITOR).json()
    assert [c["slug"] for c in body["candidates"]] == ["kb-answer"]


def test_only_skills_the_caller_can_read_are_candidates(monkeypatch) -> None:
    client.post(
        "/api/v1/skills",
        json={"slug": "evans-secret", "name": "Secret", "description": "private skill", "allowed_tools": ["get_service_status"], "visibility": "private"},
        headers=EDITOR,
    )
    _router(monkeypatch, {"skills": [], "rationale": "none", "confidence": 0.1})
    other = client.post("/api/v1/skills/route-test", json={"objective": "x"}, headers=EDITOR2).json()
    assert "evans-secret" not in {c["slug"] for c in other["candidates"]}
    mine = client.post("/api/v1/skills/route-test", json={"objective": "x"}, headers=EDITOR).json()
    assert "evans-secret" in {c["slug"] for c in mine["candidates"]}


def test_router_failure_is_a_502_not_a_500(monkeypatch) -> None:
    monkeypatch.setattr(agents_router, "_router_model_factory", lambda: build_raising_router_model("provider down"))
    response = client.post("/api/v1/skills/route-test", json={"objective": "anything"}, headers=EDITOR)
    assert response.status_code == 502 and "provider down" not in response.text


def test_route_test_validates_input_and_unknown_agent(monkeypatch) -> None:
    _router(monkeypatch, {"skills": [], "rationale": "", "confidence": 0.0})
    assert client.post("/api/v1/skills/route-test", json={"objective": ""}, headers=EDITOR).status_code == 422
    assert client.post("/api/v1/skills/route-test", json={"objective": "x", "agent_id": "nope"}, headers=EDITOR).status_code == 404
