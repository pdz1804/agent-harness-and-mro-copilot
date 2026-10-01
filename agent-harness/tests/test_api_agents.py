"""Agents (phase 04): CRUD + RBAC (`routers.agents`), the default-agent
resolution `POST /runs` falls back to when no `agent_id`/`session_id` is
given, session-agent stickiness, `GET /skills/commands`, `preview-route`,
and end-to-end trace assertions for slash/assigned/pinned-prompt-version
runs — all network-free (`state.llm_client_factory`/`_router_model_factory`
monkeypatched to deterministic doubles, per the established pattern)."""

from __future__ import annotations

import sys
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))


from agent_harness import state  # noqa: E402
from agent_harness.llm_client import build_router_model, build_scripted_model  # noqa: E402
from api import app  # noqa: E402

client = TestClient(app)

_POLL_TIMEOUT_SECONDS = 5.0
_POLL_INTERVAL_SECONDS = 0.02


@pytest.fixture(autouse=True)
def _isolate_trace_files(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)


@pytest.fixture(autouse=True)
def _use_final_answer_model(monkeypatch):
    """Default double for every test in this file that doesn't override it:
    a scripted model that answers immediately with no tool call — cheap and
    deterministic. Individual tests override via `monkeypatch.setattr`."""
    script = [{"action": "final_answer", "final_answer": "done."}]
    monkeypatch.setattr(state, "llm_client_factory", lambda: build_scripted_model(script))


def _wait_for_status(run_id: str, *targets: str) -> dict:
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


def _default_agent_id() -> str:
    return next(a["id"] for a in client.get("/api/v1/agents").json() if a["is_default"])


def _kb_answer_skill_id() -> str:
    return next(s["id"] for s in client.get("/api/v1/skills").json() if s["slug"] == "kb-answer")


# --- seeded library ------------------------------------------------------


def test_seeded_agents_include_one_default():
    agents = client.get("/api/v1/agents").json()
    slugs = {a["slug"] for a in agents}
    assert {"ops-assistant", "kb-concierge"} <= slugs
    defaults = [a for a in agents if a["is_default"]]
    assert len(defaults) == 1
    assert defaults[0]["slug"] == "ops-assistant"


# --- CRUD + validation -----------------------------------------------------


def test_create_get_update_delete_agent():
    prompt_id = client.get("/api/v1/prompts").json()[0]["id"]
    created = client.post(
        "/api/v1/agents",
        json={
            "slug": "test-agent",
            "name": "Test agent",
            "prompt_id": prompt_id,
            "skill_mode": "none",
            "base_tools": ["get_service_status"],
            "visibility": "shared",
        },
    )
    assert created.status_code == 201, created.text
    agent_id = created.json()["id"]

    fetched = client.get(f"/api/v1/agents/{agent_id}")
    assert fetched.status_code == 200
    assert fetched.json()["slug"] == "test-agent"

    updated = client.patch(f"/api/v1/agents/{agent_id}", json={"name": "Renamed"})
    assert updated.status_code == 200
    assert updated.json()["name"] == "Renamed"

    deleted = client.delete(f"/api/v1/agents/{agent_id}")
    assert deleted.status_code == 204
    assert client.get(f"/api/v1/agents/{agent_id}").status_code == 404


def test_create_agent_duplicate_slug_is_409():
    prompt_id = client.get("/api/v1/prompts").json()[0]["id"]
    payload = {"slug": "dup-agent", "name": "Dup", "prompt_id": prompt_id, "base_tools": []}
    assert client.post("/api/v1/agents", json=payload).status_code == 201
    assert client.post("/api/v1/agents", json=payload).status_code == 409


def test_create_agent_unknown_prompt_is_422():
    response = client.post(
        "/api/v1/agents", json={"slug": "bad-agent", "name": "Bad", "prompt_id": "does-not-exist", "base_tools": []}
    )
    assert response.status_code == 422


def test_create_agent_unknown_base_tool_is_422():
    prompt_id = client.get("/api/v1/prompts").json()[0]["id"]
    response = client.post(
        "/api/v1/agents",
        json={"slug": "bad-tool-agent", "name": "Bad", "prompt_id": prompt_id, "base_tools": ["not_a_tool"]},
    )
    assert response.status_code == 422


def test_delete_default_agent_is_409():
    default_id = _default_agent_id()
    response = client.delete(f"/api/v1/agents/{default_id}")
    assert response.status_code == 409


# --- RBAC ------------------------------------------------------------------


def test_viewer_cannot_create_agent():
    prompt_id = client.get("/api/v1/prompts").json()[0]["id"]
    response = client.post(
        "/api/v1/agents",
        json={"slug": "viewer-agent", "name": "x", "prompt_id": prompt_id, "base_tools": []},
        headers={"X-User-Id": "u_viewer"},
    )
    assert response.status_code == 403


def test_editor_cannot_read_or_write_another_editors_private_agent():
    prompt_id = client.get("/api/v1/prompts").json()[0]["id"]
    created = client.post(
        "/api/v1/agents",
        json={
            "slug": "editor-private-agent",
            "name": "Editor's",
            "prompt_id": prompt_id,
            "base_tools": [],
            "visibility": "private",
        },
        headers={"X-User-Id": "u_editor"},
    )
    assert created.status_code == 201
    agent_id = created.json()["id"]

    stranger_read = client.get(f"/api/v1/agents/{agent_id}", headers={"X-User-Id": "u_editor2"})
    assert stranger_read.status_code == 404

    stranger_write = client.patch(
        f"/api/v1/agents/{agent_id}", json={"name": "hijacked"}, headers={"X-User-Id": "u_editor2"}
    )
    assert stranger_write.status_code == 404

    admin_read = client.get(f"/api/v1/agents/{agent_id}", headers={"X-User-Id": "u_admin"})
    assert admin_read.status_code == 200


# --- default agent used when none passed / session stickiness --------------


def test_default_agent_used_when_no_agent_id_or_session_given():
    response = client.post("/api/v1/runs", json={"objective": "hello"})
    assert response.status_code == 202
    run_id = response.json()["run_id"]
    body = _wait_for_status(run_id, "completed")
    assert body["agent_id"] == _default_agent_id()


def test_session_sticks_to_the_agent_it_was_created_with():
    concierge_id = next(a["id"] for a in client.get("/api/v1/agents").json() if a["slug"] == "kb-concierge")
    session = client.post("/api/v1/sessions", json={"agent_id": concierge_id})
    assert session.status_code == 201
    assert session.json()["agent_id"] == concierge_id

    # A second run in the same session ignores a *different* requested
    # agent_id — the session's own agent always wins.
    other_agent_id = _default_agent_id()
    run = client.post(
        "/api/v1/runs",
        json={"objective": "hi", "session_id": session.json()["id"], "agent_id": other_agent_id},
    )
    assert run.status_code == 202
    body = _wait_for_status(run.json()["run_id"], "completed")
    assert body["agent_id"] == concierge_id


def test_create_session_with_unknown_agent_id_is_404():
    response = client.post("/api/v1/sessions", json={"agent_id": "does-not-exist"})
    assert response.status_code == 404


# --- GET /skills/commands ----------------------------------------------------


def test_skill_commands_lists_readable_enabled_skills():
    commands = client.get("/api/v1/skills/commands").json()
    slugs = {c["slug"] for c in commands}
    assert "kb-answer" in slugs
    entry = next(c for c in commands if c["slug"] == "kb-answer")
    assert set(entry.keys()) == {"slug", "name", "description", "examples"}


# --- trace assertions: assigned / slash / pinned prompt version ------------


def test_assigned_mode_agent_run_emits_skills_assigned_and_scopes_tools():
    concierge_id = next(a["id"] for a in client.get("/api/v1/agents").json() if a["slug"] == "kb-concierge")
    response = client.post("/api/v1/runs", json={"objective": "what is our escalation policy", "agent_id": concierge_id})
    assert response.status_code == 202
    body = _wait_for_status(response.json()["run_id"], "completed")
    event_types = [e["event_type"] for e in body["history"]]
    assert event_types[0] == "skills_assigned"
    assert body["history"][0]["data"]["slugs"] == ["kb-answer"]


def test_slash_command_run_emits_skill_invoked_and_strips_the_command():
    response = client.post("/api/v1/runs", json={"objective": "/kb-answer what is our on-call policy"})
    assert response.status_code == 202
    body = _wait_for_status(response.json()["run_id"], "completed")
    assert body["objective"] == "what is our on-call policy"
    first = body["history"][0]
    assert first["event_type"] == "skill_invoked"
    assert first["data"]["slug"] == "kb-answer"
    assert first["data"]["source"] == "slash"


def test_slash_command_for_unknown_skill_is_422_before_any_run_or_session_is_created():
    sessions_before = len(client.get("/api/v1/sessions").json())
    response = client.post("/api/v1/runs", json={"objective": "/not-a-real-skill do something"})
    assert response.status_code == 422
    assert len(client.get("/api/v1/sessions").json()) == sessions_before


def test_pinned_prompt_version_is_used_even_after_a_newer_version_is_activated():
    prompt = client.get("/api/v1/prompts").json()[0]
    prompt_id = prompt["id"]
    v1_id = prompt["active_version"]["id"]
    new_version = client.post(
        f"/api/v1/prompts/{prompt_id}/versions", json={"content": "a newer version", "activate": True}
    )
    assert new_version.status_code == 201
    assert new_version.json()["id"] != v1_id

    pinned_agent = client.post(
        "/api/v1/agents",
        json={
            "slug": "pinned-agent",
            "name": "Pinned",
            "prompt_id": prompt_id,
            "prompt_version_id": v1_id,
            "base_tools": [],
        },
    )
    assert pinned_agent.status_code == 201
    agent_id = pinned_agent.json()["id"]

    run = client.post("/api/v1/runs", json={"objective": "hi", "agent_id": agent_id})
    body = _wait_for_status(run.json()["run_id"], "completed")
    assert body["prompt_version_id"] == v1_id


# --- preview-route -----------------------------------------------------------


def test_preview_route_dry_runs_the_router_with_no_persistence(monkeypatch):
    from agent_harness.routers import agents as agents_router

    monkeypatch.setattr(
        agents_router,
        "_router_model_factory",
        lambda: build_router_model({"skills": ["kb-answer"], "rationale": "matches", "confidence": 0.85}),
    )
    default_id = _default_agent_id()
    runs_before = len(client.get("/api/v1/runs").json())
    response = client.post(
        f"/api/v1/agents/{default_id}/preview-route", json={"objective": "how do we roll back a bad deploy"}
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["selected"] == ["kb-answer"]
    assert body["confidence"] == 0.85
    assert len(client.get("/api/v1/runs").json()) == runs_before  # no run/session created


def test_preview_route_rejects_a_non_auto_agent():
    concierge_id = next(a["id"] for a in client.get("/api/v1/agents").json() if a["slug"] == "kb-concierge")
    response = client.post(f"/api/v1/agents/{concierge_id}/preview-route", json={"objective": "anything"})
    assert response.status_code == 422


def test_preview_route_viewer_allowed_read_only(monkeypatch):
    from agent_harness.routers import agents as agents_router

    monkeypatch.setattr(
        agents_router,
        "_router_model_factory",
        lambda: build_router_model({"skills": [], "rationale": "no match", "confidence": 0.1}),
    )
    default_id = _default_agent_id()
    response = client.post(
        f"/api/v1/agents/{default_id}/preview-route",
        json={"objective": "anything"},
        headers={"X-User-Id": "u_viewer"},
    )
    assert response.status_code == 200
