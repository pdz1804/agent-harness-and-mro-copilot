"""Sessions: search, filters (status / agent / date), rename, archive, delete
(owner or admin), and the live pending-approval list."""

from __future__ import annotations

import sys
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from agent_harness import db, state  # noqa: E402
from agent_harness.llm_client import build_scripted_model  # noqa: E402
from api import app  # noqa: E402

client = TestClient(app)

ADMIN = {"X-User-Id": "u_admin"}
EDITOR = {"X-User-Id": "u_editor"}
EDITOR2 = {"X-User-Id": "u_editor2"}
VIEWER = {"X-User-Id": "u_viewer"}


@pytest.fixture(autouse=True)
def _isolate_trace_files(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)


def _session(session_id: str, title: str, owner: str, last_active: str, objective: str | None = None, status: str = "completed", agent_id: str | None = None) -> None:
    db.create_session(session_id, title, last_active, owner_id=owner, agent_id=agent_id)
    db.touch_session(session_id, last_active, status)
    if objective:
        db.upsert_run(
            {
                "run_id": f"run-{session_id}",
                "objective": objective,
                "status": status,
                "started_at": time.time(),
                "finished_at": time.time(),
                "final_answer": "done",
                "steps_taken": 1,
                "trace_path": "",
                "error": None,
                "session_id": session_id,
                "owner_id": owner,
            }
        )


def _ids(response) -> list[str]:
    assert response.status_code == 200, response.text
    return [s["id"] for s in response.json()]


@pytest.fixture
def seeded() -> None:
    _session("s-pay", "Payments latency check", "u_editor", "2026-09-01T10:00:00+00:00", "why is payments-api slow?")
    _session("s-auth", "Auth outage", "u_editor", "2026-09-10T10:00:00+00:00", "auth-service is returning 500s", status="failed")
    _session("s-kb", "Runbook question", "u_editor", "2026-09-20T10:00:00+00:00", "how do we roll back a deploy?")
    _session("s-other", "Someone else's chat", "u_editor2", "2026-09-15T10:00:00+00:00", "private objective about payments")


# --- search + filters -----------------------------------------------------------------


def test_list_is_newest_first_and_owner_scoped(seeded) -> None:
    assert _ids(client.get("/api/v1/sessions", headers=EDITOR)) == ["s-kb", "s-auth", "s-pay"]
    assert _ids(client.get("/api/v1/sessions", headers=EDITOR2)) == ["s-other"]
    assert set(_ids(client.get("/api/v1/sessions", headers=ADMIN))) == {"s-pay", "s-auth", "s-kb", "s-other"}


def test_search_matches_title_and_run_objectives_case_insensitively(seeded) -> None:
    assert _ids(client.get("/api/v1/sessions?q=PAYMENTS", headers=EDITOR)) == ["s-pay"]
    assert _ids(client.get("/api/v1/sessions?q=roll back", headers=EDITOR)) == ["s-kb"]  # objective only
    assert _ids(client.get("/api/v1/sessions?q=outage", headers=EDITOR)) == ["s-auth"]  # title only
    assert _ids(client.get("/api/v1/sessions?q=nothing-like-this", headers=EDITOR)) == []
    # Another user's objective text never leaks into a normal user's search.
    assert "s-other" not in _ids(client.get("/api/v1/sessions?q=private", headers=EDITOR))


def test_search_treats_like_wildcards_literally(seeded) -> None:
    assert _ids(client.get("/api/v1/sessions?q=%25", headers=EDITOR)) == []
    assert _ids(client.get("/api/v1/sessions?q=_", headers=EDITOR)) == []


def test_filter_by_status_and_date_range_and_agent(seeded) -> None:
    assert _ids(client.get("/api/v1/sessions?status=failed", headers=EDITOR)) == ["s-auth"]
    assert _ids(client.get("/api/v1/sessions?status=completed", headers=EDITOR)) == ["s-kb", "s-pay"]
    assert _ids(client.get("/api/v1/sessions?since=2026-09-05&until=2026-09-15", headers=EDITOR)) == ["s-auth"]
    assert _ids(client.get("/api/v1/sessions?since=2026-09-12", headers=EDITOR)) == ["s-kb"]
    agent_id = client.get("/api/v1/agents", headers=ADMIN).json()[0]["id"]
    _session("s-agent", "With an agent", "u_editor", "2026-09-25T10:00:00+00:00", agent_id=agent_id)
    assert _ids(client.get(f"/api/v1/sessions?agent_id={agent_id}", headers=EDITOR)) == ["s-agent"]


# --- rename / archive / delete -----------------------------------------------------------


def test_owner_can_rename_and_validation_applies(seeded) -> None:
    ok = client.patch("/api/v1/sessions/s-pay", json={"title": "  Payments, renamed  "}, headers=EDITOR)
    assert ok.status_code == 200 and ok.json()["title"] == "Payments, renamed"
    assert client.get("/api/v1/sessions/s-pay", headers=EDITOR).json()["title"] == "Payments, renamed"
    assert client.patch("/api/v1/sessions/s-pay", json={"title": "   "}, headers=EDITOR).status_code == 422
    assert client.patch("/api/v1/sessions/s-pay", json={}, headers=EDITOR).status_code == 422


def test_archive_hides_from_the_default_list_and_can_be_restored(seeded) -> None:
    archived = client.patch("/api/v1/sessions/s-auth", json={"archived": True}, headers=EDITOR)
    assert archived.status_code == 200 and archived.json()["archived_at"]
    assert _ids(client.get("/api/v1/sessions", headers=EDITOR)) == ["s-kb", "s-pay"]
    assert _ids(client.get("/api/v1/sessions?archived=only", headers=EDITOR)) == ["s-auth"]
    assert set(_ids(client.get("/api/v1/sessions?archived=include", headers=EDITOR))) == {"s-kb", "s-auth", "s-pay"}
    restored = client.patch("/api/v1/sessions/s-auth", json={"archived": False}, headers=EDITOR)
    assert restored.json()["archived_at"] is None
    assert "s-auth" in _ids(client.get("/api/v1/sessions", headers=EDITOR))


def test_delete_removes_the_session_its_runs_and_events(seeded) -> None:
    db.append_event("run-s-pay", 1, "llm_decision", time.time(), None, {"x": 1})
    assert client.delete("/api/v1/sessions/s-pay", headers=EDITOR).status_code == 204
    assert client.get("/api/v1/sessions/s-pay", headers=EDITOR).status_code == 404
    assert client.get("/api/v1/runs/run-s-pay", headers=EDITOR).status_code == 404
    with db.connect() as conn:
        assert conn.execute("SELECT COUNT(*) AS n FROM events WHERE run_id = 'run-s-pay'").fetchone()["n"] == 0
    assert "s-pay" not in _ids(client.get("/api/v1/sessions", headers=ADMIN))


def test_rbac_owner_or_admin_only(seeded) -> None:
    # Not the owner (and not admin): the session is invisible, so 404 for every verb.
    assert client.patch("/api/v1/sessions/s-pay", json={"title": "mine now"}, headers=EDITOR2).status_code == 404
    assert client.delete("/api/v1/sessions/s-pay", headers=EDITOR2).status_code == 404
    assert client.patch("/api/v1/sessions/s-pay", json={"archived": True}, headers=VIEWER).status_code == 404
    # Admin may manage anyone's.
    assert client.patch("/api/v1/sessions/s-pay", json={"title": "admin renamed"}, headers=ADMIN).status_code == 200
    assert client.delete("/api/v1/sessions/s-other", headers=ADMIN).status_code == 204


def test_a_viewer_manages_their_own_chats() -> None:
    _session("s-viewer", "Viewer chat", "u_viewer", "2026-09-02T10:00:00+00:00", "hello")
    assert client.patch("/api/v1/sessions/s-viewer", json={"title": "Renamed by viewer"}, headers=VIEWER).status_code == 200
    assert client.delete("/api/v1/sessions/s-viewer", headers=VIEWER).status_code == 204


def test_unknown_session_is_404() -> None:
    assert client.patch("/api/v1/sessions/nope", json={"title": "x"}, headers=ADMIN).status_code == 404
    assert client.delete("/api/v1/sessions/nope", headers=ADMIN).status_code == 404


def test_cannot_delete_a_session_with_a_run_in_flight(monkeypatch) -> None:
    script = [
        {"action": "tool_call", "tool_name": "create_incident", "tool_args": {"title": "t", "description": "d", "severity": "low"}},
        {"action": "final_answer", "final_answer": "ok"},
    ]
    monkeypatch.setattr(state, "llm_client_factory", lambda: build_scripted_model(script))
    started = client.post("/api/v1/runs", json={"objective": "open one"}, headers=EDITOR).json()
    run_id, session_id = started["run_id"], started["session_id"]
    deadline = time.monotonic() + 8
    while time.monotonic() < deadline and client.get(f"/api/v1/runs/{run_id}", headers=EDITOR).json()["status"] != "pending_approval":
        time.sleep(0.02)
    assert client.delete(f"/api/v1/sessions/{session_id}", headers=EDITOR).status_code == 409
    client.post(f"/api/v1/runs/{run_id}/approve", json={"approved": False}, headers=EDITOR)
    deadline = time.monotonic() + 8
    while time.monotonic() < deadline and client.get(f"/api/v1/runs/{run_id}", headers=EDITOR).json()["status"] != "completed":
        time.sleep(0.02)
    assert client.delete(f"/api/v1/sessions/{session_id}", headers=EDITOR).status_code == 204
    assert client.get(f"/api/v1/runs/{run_id}", headers=EDITOR).status_code == 404


# --- pending approvals (header badge) -------------------------------------------------------


def test_pending_approvals_lists_waiting_runs_scoped_to_who_can_approve(monkeypatch) -> None:
    script = [
        {"action": "tool_call", "tool_name": "create_incident", "tool_args": {"title": "t", "description": "d", "severity": "low"}},
        {"action": "final_answer", "final_answer": "ok"},
    ]
    monkeypatch.setattr(state, "llm_client_factory", lambda: build_scripted_model(script))
    assert client.get("/api/v1/approvals/pending", headers=EDITOR).json() == []
    run_id = client.post("/api/v1/runs", json={"objective": "open one"}, headers=EDITOR).json()["run_id"]
    deadline = time.monotonic() + 8
    while time.monotonic() < deadline and not client.get("/api/v1/approvals/pending", headers=EDITOR).json():
        time.sleep(0.02)
    waiting = client.get("/api/v1/approvals/pending", headers=EDITOR).json()
    assert [w["run_id"] for w in waiting] == [run_id] and waiting[0]["tool_name"] == "create_incident"
    assert waiting[0]["objective"] == "open one" and waiting[0]["session_id"]
    assert client.get("/api/v1/approvals/pending", headers=EDITOR2).json() == []
    assert [w["run_id"] for w in client.get("/api/v1/approvals/pending", headers=ADMIN).json()] == [run_id]

    client.post(f"/api/v1/runs/{run_id}/approve", json={"approved": True}, headers=EDITOR)
    deadline = time.monotonic() + 8
    while time.monotonic() < deadline and client.get("/api/v1/approvals/pending", headers=EDITOR).json():
        time.sleep(0.02)
    assert client.get("/api/v1/approvals/pending", headers=EDITOR).json() == []
