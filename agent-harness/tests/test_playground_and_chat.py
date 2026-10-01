"""Prompt Playground runs, conversation context across a session's turns,
the Stop button (cooperative cancellation), per-agent starter prompts, and
owner-scoped aggregates. All network-free (scripted/recording models)."""

from __future__ import annotations

import sys
import time
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient
from pydantic_ai.messages import ModelResponse, TextPart, ToolCallPart
from pydantic_ai.models.function import FunctionModel

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from agent_harness import (
    db,  # noqa: E402
    state,  # noqa: E402
)
from agent_harness.llm_client import build_scripted_model  # noqa: E402
from api import app  # noqa: E402

client = TestClient(app)

ADMIN = {"X-User-Id": "u_admin"}
EDITOR = {"X-User-Id": "u_editor"}
EDITOR2 = {"X-User-Id": "u_editor2"}
VIEWER = {"X-User-Id": "u_viewer"}

DRAFT = "You are PIRATE-BOT, helping {{user_name}} ({{user_role}}). Answer every question like a pirate would."


@pytest.fixture(autouse=True)
def _isolate_trace_files(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)


def _wait(run_id: str, *targets: str, headers: dict = ADMIN, timeout: float = 8.0) -> dict:
    deadline = time.monotonic() + timeout
    body: dict = {}
    while time.monotonic() < deadline:
        body = client.get(f"/api/v1/runs/{run_id}", headers=headers).json()
        if body["status"] in targets:
            return body
        time.sleep(0.02)
    raise AssertionError(f"run {run_id} never reached {targets}; last: {body}")


def _recording_model(sink: list[str], answer: str = "Aye.", script: list[dict] | None = None) -> FunctionModel:
    """A model that records the system prompt of every request it receives,
    then answers (or plays `script` of tool calls first)."""
    state = {"n": 0}

    def _fn(messages: list[Any], info: Any) -> ModelResponse:
        for message in messages:
            for part in getattr(message, "parts", []):
                if part.part_kind == "system-prompt":
                    sink.append(part.content)
                    break
            else:
                continue
            break
        i = state["n"]
        state["n"] += 1
        if script and i < len(script):
            step = script[i]
            return ModelResponse(parts=[ToolCallPart(tool_name=step["tool_name"], args=step["tool_args"])])
        return ModelResponse(parts=[TextPart(content=answer)])

    return FunctionModel(_fn, model_name="recording")


def _start(body: dict, headers: dict) -> dict:
    response = client.post("/api/v1/runs", json=body, headers=headers)
    assert response.status_code == 202, response.text
    return response.json()


# --- playground --------------------------------------------------------------


def test_playground_draft_is_used_verbatim_with_placeholders_rendered(monkeypatch) -> None:
    sink: list[str] = []
    monkeypatch.setattr(state, "llm_client_factory", lambda: _recording_model(sink))
    started = _start({"objective": "hello", "playground": {"system_prompt": DRAFT}}, EDITOR)
    run = _wait(started["run_id"], "completed", headers=EDITOR)
    assert run["prompt_version_id"] is None
    assert sink and "PIRATE-BOT" in sink[0]
    assert "Evan Editor (editor)" in sink[0] and "{{" not in sink[0]
    session = client.get(f"/api/v1/sessions/{started['session_id']}", headers=EDITOR).json()
    assert session["title"].startswith("[Playground]")


def test_playground_saved_version_records_the_version_and_uses_its_text(monkeypatch) -> None:
    prompt = client.post(
        "/api/v1/prompts",
        json={"slug": "pirate", "name": "Pirate", "kind": "system", "content": DRAFT, "visibility": "shared"},
        headers=EDITOR,
    ).json()
    version = prompt["versions"][0]
    sink: list[str] = []
    monkeypatch.setattr(state, "llm_client_factory", lambda: _recording_model(sink))
    started = _start(
        {"objective": "hello", "playground": {"prompt_id": prompt["id"], "prompt_version_id": version["id"]}}, EDITOR
    )
    run = _wait(started["run_id"], "completed", headers=EDITOR)
    assert run["prompt_version_id"] == version["id"]
    assert "PIRATE-BOT" in sink[0]


def test_two_versions_can_be_compared_on_the_same_input(monkeypatch) -> None:
    sinks: dict[str, list[str]] = {"a": [], "b": []}
    order = iter(["a", "b"])
    monkeypatch.setattr(state, "llm_client_factory", lambda: _recording_model(sinks[next(order, "b")]))
    objective = "What is the status of auth-service?"
    # Auto-routing is off for playground runs, so each run builds exactly one model.
    run_a = _start({"objective": objective, "playground": {"system_prompt": "Prompt A: be terse and formal please."}}, EDITOR)
    _wait(run_a["run_id"], "completed", headers=EDITOR)
    run_b = _start({"objective": objective, "playground": {"system_prompt": "Prompt B: be warm and talkative please."}}, EDITOR)
    _wait(run_b["run_id"], "completed", headers=EDITOR)
    assert "Prompt A" in sinks["a"][0] and "Prompt B" in sinks["b"][0]
    snap_a = client.get(f"/api/v1/runs/{run_a['run_id']}", headers=EDITOR).json()
    snap_b = client.get(f"/api/v1/runs/{run_b['run_id']}", headers=EDITOR).json()
    assert snap_a["objective"] == snap_b["objective"] == objective


def test_playground_runs_still_hit_the_approval_gate_with_real_tools(monkeypatch) -> None:
    script = [
        {
            "tool_name": "create_incident",
            "tool_args": {"title": "t", "description": "d", "severity": "low"},
        }
    ]
    monkeypatch.setattr(state, "llm_client_factory", lambda: _recording_model([], script=script))
    started = _start({"objective": "open an incident", "playground": {"system_prompt": DRAFT}}, EDITOR)
    paused = _wait(started["run_id"], "pending_approval", headers=EDITOR)
    assert paused["pending_approval"]["tool_name"] == "create_incident"
    assert db.list_incidents() == []
    client.post(f"/api/v1/runs/{started['run_id']}/approve", json={"approved": True}, headers=EDITOR)
    _wait(started["run_id"], "completed", headers=EDITOR)
    assert len(db.list_incidents()) == 1


def test_playground_validation_and_permissions(monkeypatch) -> None:
    monkeypatch.setattr(state, "llm_client_factory", lambda: _recording_model([]))
    assert client.post("/api/v1/runs", json={"objective": "x", "playground": {"system_prompt": DRAFT}}, headers=VIEWER).status_code == 403
    broken = client.post("/api/v1/runs", json={"objective": "x", "playground": {"system_prompt": "   "}}, headers=EDITOR)
    assert broken.status_code == 422 and "empty" in broken.json()["detail"]
    assert client.post("/api/v1/runs", json={"objective": "x", "playground": {}}, headers=EDITOR).status_code == 422
    unknown = client.post(
        "/api/v1/runs", json={"objective": "x", "playground": {"prompt_id": "nope", "prompt_version_id": "nope"}}, headers=EDITOR
    )
    assert unknown.status_code == 404
    no_prompt = client.post("/api/v1/runs", json={"objective": "x", "playground": {"prompt_version_id": "v"}}, headers=EDITOR)
    assert no_prompt.status_code == 422


# --- conversation context ----------------------------------------------------


def test_follow_up_run_sees_the_earlier_turns_of_its_session(monkeypatch) -> None:
    sink: list[str] = []
    monkeypatch.setattr(state, "llm_client_factory", lambda: _recording_model(sink, answer="Cache flush fixed it."))
    first = _start({"objective": "why was checkout slow?"}, ADMIN)
    _wait(first["run_id"], "completed")
    sink.clear()
    second = _start({"objective": "and what should we do next?", "session_id": first["session_id"]}, ADMIN)
    _wait(second["run_id"], "completed")
    prompt = next(p for p in sink if "Conversation so far" in p)
    assert "User: why was checkout slow?" in prompt
    assert "Assistant: Cache flush fixed it." in prompt


def test_first_turn_has_no_conversation_section(monkeypatch) -> None:
    sink: list[str] = []
    monkeypatch.setattr(state, "llm_client_factory", lambda: _recording_model(sink))
    _wait(_start({"objective": "hi"}, ADMIN)["run_id"], "completed")
    assert sink and all("Conversation so far" not in p for p in sink)


# --- cancel ------------------------------------------------------------------


def _tool_loop_model() -> FunctionModel:
    return build_scripted_model(
        [{"action": "tool_call", "tool_name": "get_service_status", "tool_args": {"service_name": "auth-service"}}],
        think_time_seconds=0.15,
    )


def test_cancel_stops_a_running_run_at_its_next_checkpoint(monkeypatch) -> None:
    monkeypatch.setattr(state, "llm_client_factory", _tool_loop_model)
    run_id = _start({"objective": "keep checking auth-service", "max_steps": 40}, EDITOR)["run_id"]
    time.sleep(0.5)
    response = client.post(f"/api/v1/runs/{run_id}/cancel", headers=EDITOR)
    assert response.status_code == 200
    done = _wait(run_id, "cancelled", headers=EDITOR)
    assert done["steps_taken"] < 40
    assert [e["event_type"] for e in done["history"]][-1] == "run_cancelled"
    persisted = db.get_run(run_id)
    assert persisted["status"] == "cancelled"
    # Already finished: stopping again is a conflict, not a success.
    assert client.post(f"/api/v1/runs/{run_id}/cancel", headers=EDITOR).status_code == 409


def test_cancel_while_waiting_for_approval_denies_it_and_runs_nothing(monkeypatch) -> None:
    script = [{"tool_name": "create_incident", "tool_args": {"title": "t", "description": "d", "severity": "low"}}]
    monkeypatch.setattr(state, "llm_client_factory", lambda: _recording_model([], script=script))
    run_id = _start({"objective": "open an incident"}, EDITOR)["run_id"]
    _wait(run_id, "pending_approval", headers=EDITOR)
    assert client.post(f"/api/v1/runs/{run_id}/cancel", headers=EDITOR).status_code == 200
    done = _wait(run_id, "cancelled", headers=EDITOR)
    types = [e["event_type"] for e in done["history"]]
    assert "approval_denied" in types and "run_cancelled" in types
    assert db.list_incidents() == []
    assert done["pending_approval"] is None


def test_cancel_permissions(monkeypatch) -> None:
    monkeypatch.setattr(state, "llm_client_factory", _tool_loop_model)
    run_id = _start({"objective": "keep checking", "max_steps": 40}, EDITOR)["run_id"]
    time.sleep(0.3)
    assert client.post(f"/api/v1/runs/{run_id}/cancel", headers=EDITOR2).status_code == 404
    assert client.post("/api/v1/runs/does-not-exist/cancel", headers=EDITOR).status_code == 404
    assert client.post(f"/api/v1/runs/{run_id}/cancel", headers=ADMIN).status_code == 200
    _wait(run_id, "cancelled", headers=ADMIN)


def test_a_viewer_can_stop_their_own_run(monkeypatch) -> None:
    monkeypatch.setattr(state, "llm_client_factory", _tool_loop_model)
    run_id = _start({"objective": "keep checking", "max_steps": 40}, VIEWER)["run_id"]
    time.sleep(0.3)
    assert client.post(f"/api/v1/runs/{run_id}/cancel", headers=VIEWER).status_code == 200
    _wait(run_id, "cancelled", headers=VIEWER)


# --- starter prompts ---------------------------------------------------------


def _default_agent() -> dict:
    return next(a for a in client.get("/api/v1/agents", headers=ADMIN).json() if a["is_default"])


def test_starters_come_from_the_skills_the_caller_can_actually_use() -> None:
    agent = _default_agent()
    admin = client.get(f"/api/v1/agents/{agent['id']}/starters", headers=ADMIN).json()
    texts = {s["text"] for s in admin}
    assert 0 < len(admin) <= 6
    assert all(s["skill_slug"] for s in admin)
    # build-dashboard is only offered to roles that may build dashboards.
    viewer_texts = {s["text"] for s in client.get(f"/api/v1/agents/{agent['id']}/starters", headers=VIEWER).json()}
    assert not any("dashboard" in t for t in viewer_texts)
    editor_all = client.get(f"/api/v1/agents/{agent['id']}/starters", headers=EDITOR).json()
    assert len(editor_all) <= 6 and texts


def test_assigned_agent_only_offers_its_own_skills_examples() -> None:
    concierge = next(a for a in client.get("/api/v1/agents", headers=ADMIN).json() if a["slug"] == "kb-concierge")
    starters = client.get(f"/api/v1/agents/{concierge['id']}/starters", headers=ADMIN).json()
    assert starters and {s["skill_slug"] for s in starters} == {"kb-answer"}


def test_disabling_a_tool_hides_the_starters_that_need_it() -> None:
    agent = _default_agent()
    client.patch("/api/v1/integrations/create_dashboard", json={"enabled": False}, headers=ADMIN)
    client.patch("/api/v1/integrations/add_widget", json={"enabled": False}, headers=ADMIN)
    starters = client.get(f"/api/v1/agents/{agent['id']}/starters", headers=ADMIN).json()
    assert not any(s["skill_slug"] == "build-dashboard" for s in starters)


# --- owner-scoped aggregates -------------------------------------------------


def _insert_run(run_id: str, owner_id: str, automation: bool = False) -> None:
    with db.connect() as conn:
        automation_id = None
        if automation:
            automation_id = f"auto-{run_id}"
            conn.execute(
                "INSERT INTO automations (id, name, trigger_service_name, trigger_status, objective_template, "
                "enabled, created_at, owner_id) VALUES (%s, 'a', 'any', 'down', 'x', TRUE, 'now', 'u_admin')",
                (automation_id,),
            )
        conn.execute(
            "INSERT INTO runs (run_id, objective, status, started_at, owner_id, triggered_by_automation_id) "
            "VALUES (%s, 'o', 'completed', %s, %s, %s)",
            (run_id, time.time(), owner_id, automation_id),
        )


def test_usage_incidents_guardrail_triggers_and_automation_runs_are_owner_scoped() -> None:
    now = time.time()
    for run_id, owner in (("run-e1", "u_editor"), ("run-e2", "u_editor2")):
        _insert_run(run_id, owner, automation=True)
        db.append_event(
            run_id=run_id,
            step=1,
            event_type="llm_decision",
            timestamp=now,
            latency_ms=None,
            data={"llm_meta": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15}},
        )
        db.append_event(
            run_id=run_id,
            step=0,
            event_type="guardrail_blocked",
            timestamp=now,
            latency_ms=None,
            data={"guardrail_name": "g", "matched_pattern": "p"},
        )
        db.insert_incident(
            incident_id=f"INC-{run_id}",
            title="t",
            description="d",
            severity="low",
            status="created",
            created_at="2026-10-01T00:00:00+00:00",
            run_id=run_id,
        )
    db.insert_incident(
        incident_id="INC-orphan",
        title="t",
        description="d",
        severity="low",
        status="created",
        created_at="2026-10-01T00:00:00+00:00",
        run_id=None,
    )

    assert [i["id"] for i in client.get("/api/v1/incidents", headers=EDITOR).json()] == ["INC-run-e1"]
    assert [i["id"] for i in client.get("/api/v1/incidents", headers=EDITOR2).json()] == ["INC-run-e2"]
    assert {i["id"] for i in client.get("/api/v1/incidents", headers=ADMIN).json()} == {"INC-run-e1", "INC-run-e2", "INC-orphan"}

    assert client.get("/api/v1/usage/today", headers=EDITOR).json()["total_tokens"] == 15
    assert client.get("/api/v1/usage/today", headers=ADMIN).json()["total_tokens"] == 30

    assert [t["run_id"] for t in client.get("/api/v1/guardrails/triggers", headers=EDITOR2).json()] == ["run-e2"]
    assert len(client.get("/api/v1/guardrails/triggers", headers=ADMIN).json()) == 2

    assert [r["run_id"] for r in client.get("/api/v1/automations/runs", headers=EDITOR).json()] == ["run-e1"]
    assert len(client.get("/api/v1/automations/runs", headers=ADMIN).json()) == 2
