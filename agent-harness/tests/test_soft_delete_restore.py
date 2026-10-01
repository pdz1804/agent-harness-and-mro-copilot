"""Soft delete + restore for every user-managed resource, the retention purge,
slug reuse over a tombstone, incident reopen, and the eval-run aggregates.

DELETE only stamps `deleted_at`; every read hides the row; `POST .../restore`
brings it back with the same body GET-by-id returns."""

from __future__ import annotations

import sys
import time
import uuid
from collections.abc import Callable
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from agent_harness import db, retrieval  # noqa: E402
from agent_harness.repos import evals as evals_repo  # noqa: E402
from agent_harness.repos import memories as memories_repo  # noqa: E402
from agent_harness.repos import trash  # noqa: E402
from agent_harness.tools.memory_tools import RecallInput, RecallTool  # noqa: E402
from api import app  # noqa: E402

client = TestClient(app)

ADMIN = {"X-User-Id": "u_admin"}
EDITOR = {"X-User-Id": "u_editor"}
EDITOR2 = {"X-User-Id": "u_editor2"}
VIEWER = {"X-User-Id": "u_viewer"}
API = "/api/v1"


@pytest.fixture(autouse=True)
def _isolate_trace_files(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)


def _uid() -> str:
    return uuid.uuid4().hex[:8]


def _old() -> str:
    return (datetime.now(timezone.utc) - timedelta(days=trash.RETENTION_DAYS + 1)).isoformat()


def _run_row(run_id: str, **extra: Any) -> dict[str, Any]:
    return {
        "run_id": run_id,
        "objective": "o",
        "status": "completed",
        "started_at": time.time(),
        "finished_at": time.time(),
        "final_answer": "a",
        "steps_taken": 1,
        "trace_path": "",
        "error": None,
        **extra,
    }


# --- per-resource factories -------------------------------------------------------------------


def _make_session(headers: dict) -> str:
    response = client.post(f"{API}/sessions", json={"title": f"s-{_uid()}"}, headers=headers)
    assert response.status_code == 201, response.text
    return response.json()["id"]


def _make_memory(headers: dict) -> str:
    response = client.post(f"{API}/memories", json={"fact": f"fact {_uid()} about widgets"}, headers=headers)
    assert response.status_code == 201, response.text
    return response.json()["id"]


def _make_kb(headers: dict) -> str:
    content = f"# Runbook {_uid()}\n\nThe quokka valve must be flushed before the reboot sequence begins."
    response = client.post(f"{API}/kb", json={"content": content}, headers=headers)
    assert response.status_code == 201, response.text
    return response.json()["id"]


def _make_dashboard(headers: dict) -> str:
    response = client.post(f"{API}/dashboards", json={"name": f"d-{_uid()}", "template_key": "blank"}, headers=headers)
    assert response.status_code == 201, response.text
    return response.json()["id"]


def _make_skill(headers: dict) -> str:
    response = client.post(
        f"{API}/skills",
        json={"slug": f"sk-{_uid()}", "name": "S", "description": "d", "allowed_tools": ["get_service_status"], "visibility": "private"},
        headers=headers,
    )
    assert response.status_code == 201, response.text
    return response.json()["id"]


def _make_prompt(headers: dict) -> str:
    response = client.post(
        f"{API}/prompts",
        json={"slug": f"pr-{_uid()}", "name": "P", "kind": "system", "content": "You are helpful.", "visibility": "private"},
        headers=headers,
    )
    assert response.status_code == 201, response.text
    return response.json()["id"]


def _make_agent(headers: dict) -> str:
    prompt_id = _make_prompt(headers)
    response = client.post(
        f"{API}/agents",
        json={"slug": f"ag-{_uid()}", "name": "A", "prompt_id": prompt_id, "visibility": "private"},
        headers=headers,
    )
    assert response.status_code == 201, response.text
    return response.json()["id"]


# resource -> (collection path, factory)
RESOURCES: dict[str, tuple[str, Callable[[dict], str]]] = {
    "sessions": ("sessions", _make_session),
    "memories": ("memories", _make_memory),
    "kb": ("kb", _make_kb),
    "dashboards": ("dashboards", _make_dashboard),
    "skills": ("skills", _make_skill),
    "agents": ("agents", _make_agent),
    "prompts": ("prompts", _make_prompt),
}
# Other users' private resources are invisible (404); the KB has no visibility concept, so a
# non-owner editor is refused with 403 there instead (same as its DELETE).
_NON_OWNER_STATUS = {"kb": 403}
_ALL = list(RESOURCES)


def _listed(path: str) -> set[str]:
    query = "?scope=all" if path == "memories" else ""
    return {item["id"] for item in client.get(f"{API}/{path}{query}", headers=ADMIN).json()}


def _get_status(path: str, item_id: str, headers: dict) -> int:
    """GET-by-id status; memories have no such route, so presence in the caller's list stands in."""
    if path == "memories":
        query = "?scope=all" if headers == ADMIN else ""
        found = any(m["id"] == item_id for m in client.get(f"{API}/memories{query}", headers=headers).json())
        return 200 if found else 404
    return client.get(f"{API}/{path}/{item_id}", headers=headers).status_code


@pytest.mark.parametrize("name", _ALL)
def test_delete_hides_then_restore_brings_back(name: str) -> None:
    path, make = RESOURCES[name]
    item_id = make(EDITOR)
    assert _get_status(path, item_id, EDITOR) == 200
    assert item_id in _listed(path)

    assert client.delete(f"{API}/{path}/{item_id}", headers=EDITOR).status_code == 204
    assert _get_status(path, item_id, EDITOR) == 404
    assert _get_status(path, item_id, ADMIN) == 404
    assert item_id not in _listed(path)
    assert client.delete(f"{API}/{path}/{item_id}", headers=EDITOR).status_code == 404  # already gone

    restored = client.post(f"{API}/{path}/{item_id}/restore", headers=EDITOR)
    assert restored.status_code == 200, restored.text
    assert restored.json()["id"] == item_id
    assert _get_status(path, item_id, EDITOR) == 200
    assert item_id in _listed(path)


@pytest.mark.parametrize("name", _ALL)
def test_restore_of_a_live_or_unknown_id_is_404(name: str) -> None:
    path, make = RESOURCES[name]
    item_id = make(EDITOR)
    assert client.post(f"{API}/{path}/{item_id}/restore", headers=EDITOR).status_code == 404
    assert client.post(f"{API}/{path}/does-not-exist/restore", headers=ADMIN).status_code == 404


@pytest.mark.parametrize("name", _ALL)
def test_non_owner_cannot_delete_or_restore(name: str) -> None:
    path, make = RESOURCES[name]
    expected = _NON_OWNER_STATUS.get(name, 404)
    item_id = make(EDITOR)
    assert client.delete(f"{API}/{path}/{item_id}", headers=EDITOR2).status_code == expected
    assert client.delete(f"{API}/{path}/{item_id}", headers=EDITOR).status_code == 204
    assert client.post(f"{API}/{path}/{item_id}/restore", headers=EDITOR2).status_code == expected
    assert _get_status(path, item_id, EDITOR) == 404  # still deleted
    assert client.post(f"{API}/{path}/{item_id}/restore", headers=ADMIN).status_code == 200


@pytest.mark.parametrize("name", ["kb", "dashboards", "skills", "agents", "prompts"])
def test_viewer_cannot_restore_config_resources(name: str) -> None:
    path, make = RESOURCES[name]
    item_id = make(EDITOR)
    assert client.delete(f"{API}/{path}/{item_id}", headers=EDITOR).status_code == 204
    assert client.post(f"{API}/{path}/{item_id}/restore", headers=VIEWER).status_code == 403
    assert _get_status(path, item_id, EDITOR) == 404


def test_viewer_owner_can_restore_own_session_and_memory() -> None:
    session_id = _make_session(VIEWER)
    assert client.delete(f"{API}/sessions/{session_id}", headers=VIEWER).status_code == 204
    assert client.post(f"{API}/sessions/{session_id}/restore", headers=VIEWER).status_code == 200
    memory_id = _make_memory(VIEWER)
    assert client.delete(f"{API}/memories/{memory_id}", headers=VIEWER).status_code == 204
    assert client.post(f"{API}/memories/{memory_id}/restore", headers=VIEWER).status_code == 200


# --- resource-specific behaviour --------------------------------------------------------------


def test_session_restore_brings_back_its_runs_and_a_deleted_session_cannot_be_continued() -> None:
    session_id = _make_session(EDITOR)
    db.upsert_run(_run_row(f"run-{session_id}", session_id=session_id, owner_id="u_editor"))
    assert client.delete(f"{API}/sessions/{session_id}", headers=EDITOR).status_code == 204
    resp = client.post(f"{API}/runs", json={"objective": "hi", "session_id": session_id}, headers=EDITOR)
    assert resp.status_code == 404
    body = client.post(f"{API}/sessions/{session_id}/restore", headers=EDITOR).json()
    assert [r["run_id"] for r in body["runs"]] == [f"run-{session_id}"]


def test_kb_search_excludes_deleted_doc_and_finds_it_again_after_restore() -> None:
    needle = f"zyxwv{_uid()}"
    content = f"# Runbook {needle}\n\nWhen the {needle} manifold overheats, vent the {needle} coolant loop first."
    doc_id = client.post(f"{API}/kb", json={"content": content}, headers=EDITOR).json()["id"]

    def hit_ids() -> set[str]:
        hits = client.post(f"{API}/kb/search", json={"query": needle, "top_k": 10}, headers=ADMIN).json()
        return {h["id"] for h in hits}

    assert doc_id in hit_ids()
    assert client.delete(f"{API}/kb/{doc_id}", headers=EDITOR).status_code == 204
    assert doc_id not in hit_ids()
    assert doc_id not in {d["id"] for d in retrieval.get_index().list_docs()}
    assert client.post(f"{API}/kb/{doc_id}/restore", headers=EDITOR).status_code == 200
    assert doc_id in hit_ids()


def test_recall_excludes_deleted_memory_until_restored() -> None:
    marker = f"qwertyfact{_uid()}"
    fact = f"The {marker} owner is Pat"
    memory_id = client.post(f"{API}/memories", json={"fact": fact}, headers=EDITOR).json()["id"]

    def recalled() -> list[str]:
        tool = RecallTool()
        tool.bind_context(owner_id="u_editor", owner_role="editor")
        return [m.id for m in tool.run(RecallInput(query=marker)).memories]

    assert memory_id in recalled()
    assert client.delete(f"{API}/memories/{memory_id}", headers=EDITOR).status_code == 204
    assert memory_id not in recalled()
    assert memories_repo.count_for_owner("u_editor") == len(memories_repo.list_memories(owner_id="u_editor"))
    # Saving the same fact again is a new memory, not a merge into the tombstone.
    again = client.post(f"{API}/memories", json={"fact": fact}, headers=EDITOR).json()
    assert again["id"] != memory_id
    assert client.post(f"{API}/memories/{memory_id}/restore", headers=EDITOR).status_code == 200


def test_dashboard_lookup_by_run_ignores_deleted() -> None:
    from agent_harness.repos import dashboards as dashboards_repo

    row = dashboards_repo.create_dashboard_with_widgets(
        name="agent made", description="", owner_id="u_editor", visibility="private", widgets=[], created_by_run_id="run-x"
    )
    assert dashboards_repo.find_dashboard_by_run("run-x", "agent made") is not None
    assert client.delete(f"{API}/dashboards/{row['id']}", headers=EDITOR).status_code == 204
    assert dashboards_repo.find_dashboard_by_run("run-x", "agent made") is None


def test_skill_in_use_is_refused_until_the_agent_using_it_is_deleted() -> None:
    skill_id = _make_skill(ADMIN)
    prompt_id = _make_prompt(ADMIN)
    agent = client.post(
        f"{API}/agents",
        json={
            "slug": f"ag-{_uid()}",
            "name": "A",
            "prompt_id": prompt_id,
            "skill_mode": "assigned",
            "skill_ids": [skill_id],
            "visibility": "private",
        },
        headers=ADMIN,
    )
    assert agent.status_code == 201, agent.text
    assert client.delete(f"{API}/skills/{skill_id}", headers=ADMIN).status_code == 409
    assert client.delete(f"{API}/agents/{agent.json()['id']}", headers=ADMIN).status_code == 204
    assert client.delete(f"{API}/skills/{skill_id}", headers=ADMIN).status_code == 204


def test_default_agent_cannot_be_deleted() -> None:
    from agent_harness.repos import agents as agents_repo

    default = agents_repo.get_default_agent()
    assert default is not None
    assert client.delete(f"{API}/agents/{default['id']}", headers=ADMIN).status_code == 409
    assert agents_repo.get_default_agent() is not None


def test_agent_restore_conflicts_while_its_prompt_is_deleted() -> None:
    agent_id = _make_agent(ADMIN)
    prompt_id = client.get(f"{API}/agents/{agent_id}", headers=ADMIN).json()["prompt_id"]
    assert client.delete(f"{API}/agents/{agent_id}", headers=ADMIN).status_code == 204
    assert client.delete(f"{API}/prompts/{prompt_id}", headers=ADMIN).status_code == 204
    assert client.post(f"{API}/agents/{agent_id}/restore", headers=ADMIN).status_code == 409
    assert client.post(f"{API}/prompts/{prompt_id}/restore", headers=ADMIN).status_code == 200
    assert client.post(f"{API}/agents/{agent_id}/restore", headers=ADMIN).status_code == 200


# --- slug reuse -------------------------------------------------------------------------------


def test_slug_can_be_reused_after_delete_for_skills_agents_prompts() -> None:
    slug = f"reuse-{_uid()}"
    prompt = {"slug": slug, "name": "P", "kind": "system", "content": "x"}
    first_prompt = client.post(f"{API}/prompts", json=prompt, headers=ADMIN).json()["id"]
    assert client.post(f"{API}/prompts", json=prompt, headers=ADMIN).status_code == 409  # live slug conflicts
    assert client.delete(f"{API}/prompts/{first_prompt}", headers=ADMIN).status_code == 204
    second_prompt = client.post(f"{API}/prompts", json=prompt, headers=ADMIN)
    assert second_prompt.status_code == 201, second_prompt.text
    assert client.post(f"{API}/prompts/{first_prompt}/restore", headers=ADMIN).status_code == 404

    skill = {"slug": slug, "name": "S", "description": "d", "allowed_tools": ["get_service_status"]}
    first_skill = client.post(f"{API}/skills", json=skill, headers=ADMIN).json()["id"]
    assert client.post(f"{API}/skills", json=skill, headers=ADMIN).status_code == 409
    assert client.delete(f"{API}/skills/{first_skill}", headers=ADMIN).status_code == 204
    reused = client.post(f"{API}/skills", json=skill, headers=ADMIN)
    assert reused.status_code == 201, reused.text
    assert client.post(f"{API}/skills/{first_skill}/restore", headers=ADMIN).status_code == 404

    agent = {"slug": slug, "name": "A", "prompt_id": second_prompt.json()["id"]}
    first_agent = client.post(f"{API}/agents", json=agent, headers=ADMIN).json()["id"]
    assert client.delete(f"{API}/agents/{first_agent}", headers=ADMIN).status_code == 204
    again = client.post(f"{API}/agents", json=agent, headers=ADMIN)
    assert again.status_code == 201, again.text


def test_prompt_slug_reuse_when_past_runs_reference_the_deleted_prompt() -> None:
    slug = f"pinned-{_uid()}"
    created = client.post(
        f"{API}/prompts", json={"slug": slug, "name": "P", "kind": "system", "content": "x"}, headers=ADMIN
    ).json()
    db.upsert_run(_run_row(f"run-{_uid()}", prompt_version_id=created["active_version"]["id"]))
    assert client.delete(f"{API}/prompts/{created['id']}", headers=ADMIN).status_code == 204
    again = client.post(
        f"{API}/prompts", json={"slug": slug, "name": "P2", "kind": "system", "content": "y"}, headers=ADMIN
    )
    assert again.status_code == 201, again.text
    assert again.json()["slug"] == slug
    # The referenced old prompt is kept (history intact) but cannot be restored over the new slug owner.
    assert _exists("prompts", created["id"])


# --- retention purge --------------------------------------------------------------------------


def _backdate(table: str, item_id: str) -> None:
    with db.connect() as conn:
        conn.execute(f"UPDATE {table} SET deleted_at = %s WHERE id = %s", (_old(), item_id))


def _exists(table: str, item_id: str) -> bool:
    key = "run_id" if table == "runs" else "id"
    with db.connect() as conn:
        return conn.execute(f"SELECT 1 FROM {table} WHERE {key} = %s", (item_id,)).fetchone() is not None


@pytest.mark.parametrize(
    "name,table",
    [
        ("sessions", "chat_sessions"),
        ("memories", "memories"),
        ("kb", "kb_documents"),
        ("dashboards", "dashboards"),
        ("skills", "skills"),
        ("agents", "agents"),
        ("prompts", "prompts"),
    ],
)
def test_purge_removes_only_tombstones_older_than_retention(name: str, table: str) -> None:
    path, make = RESOURCES[name]
    old_id, recent_id, live_id = make(EDITOR), make(EDITOR), make(EDITOR)
    for item_id in (old_id, recent_id):
        assert client.delete(f"{API}/{path}/{item_id}", headers=EDITOR).status_code == 204
    _backdate(table, old_id)
    trash.purge_expired()
    assert not _exists(table, old_id)
    assert _exists(table, recent_id)
    assert _exists(table, live_id)
    assert client.post(f"{API}/{path}/{recent_id}/restore", headers=EDITOR).status_code == 200


def test_purging_a_session_also_removes_its_runs_and_events() -> None:
    session_id = _make_session(EDITOR)
    run_id = f"run-{session_id}"
    db.upsert_run(_run_row(run_id, session_id=session_id, owner_id="u_editor"))
    db.append_event(run_id, 1, "llm_decision", time.time(), None, {"x": 1})
    assert client.delete(f"{API}/sessions/{session_id}", headers=EDITOR).status_code == 204
    _backdate("chat_sessions", session_id)
    trash.purge_expired()
    assert not _exists("runs", run_id)
    with db.connect() as conn:
        assert conn.execute("SELECT COUNT(*) AS n FROM events WHERE run_id = %s", (run_id,)).fetchone()["n"] == 0


def test_purging_an_agent_keeps_its_runs_unattributed() -> None:
    agent_id = _make_agent(EDITOR)
    run_id = f"run-{_uid()}"
    db.upsert_run(_run_row(run_id, agent_id=agent_id, owner_id="u_editor"))
    assert client.delete(f"{API}/agents/{agent_id}", headers=EDITOR).status_code == 204
    _backdate("agents", agent_id)
    trash.purge_expired()
    assert not _exists("agents", agent_id)
    assert _exists("runs", run_id)


# --- incident reopen --------------------------------------------------------------------------


def _incident(status: str = "open") -> str:
    incident_id = f"inc-{_uid()}"
    db.insert_incident(incident_id, "reopen me", "d", "high", status, datetime.now(timezone.utc).isoformat(), "")
    return incident_id


def test_reopen_moves_resolved_to_acknowledged_clears_resolution_and_records_who() -> None:
    incident_id = _incident()
    assert client.post(f"{API}/incidents/{incident_id}/resolve", json={"note": "fixed"}, headers=ADMIN).status_code == 200
    reopened = client.post(f"{API}/incidents/{incident_id}/reopen", headers=ADMIN)
    assert reopened.status_code == 200, reopened.text
    body = reopened.json()
    assert body["status"] == "acknowledged"
    assert body["resolved_at"] is None and body["resolved_by"] is None and body["resolution_note"] is None
    assert body["reopened_by"] == "u_admin" and body["reopened_at"]
    detail = client.get(f"{API}/incidents/{incident_id}", headers=ADMIN).json()
    assert [e["event"] for e in detail["timeline"]] == ["opened", "reopened"]
    assert detail["timeline"][-1]["actor_id"] == "u_admin"


def test_reopen_after_ack_and_resolve_lists_timeline_in_order_and_can_resolve_again() -> None:
    incident_id = _incident()
    assert client.post(f"{API}/incidents/{incident_id}/acknowledge", headers=ADMIN).status_code == 200
    assert client.post(f"{API}/incidents/{incident_id}/resolve", json={}, headers=ADMIN).status_code == 200
    assert client.post(f"{API}/incidents/{incident_id}/reopen", headers=ADMIN).status_code == 200
    events = [e["event"] for e in client.get(f"{API}/incidents/{incident_id}", headers=ADMIN).json()["timeline"]]
    assert events == ["opened", "acknowledged", "reopened"]
    assert client.post(f"{API}/incidents/{incident_id}/resolve", json={}, headers=ADMIN).status_code == 200


@pytest.mark.parametrize("status", ["open", "acknowledged"])
def test_reopen_of_a_non_resolved_incident_is_409(status: str) -> None:
    assert client.post(f"{API}/incidents/{_incident(status)}/reopen", headers=ADMIN).status_code == 409


def test_reopen_needs_mutate_incidents_and_a_visible_incident() -> None:
    incident_id = _incident("resolved")
    assert client.post(f"{API}/incidents/{incident_id}/reopen", headers=VIEWER).status_code == 403
    assert client.post(f"{API}/incidents/nope/reopen", headers=ADMIN).status_code == 404
    assert client.post(f"{API}/incidents/{incident_id}/reopen", headers=EDITOR).status_code == 404  # admin-only incident


# --- eval run aggregates ----------------------------------------------------------------------


def _seed_eval_run(scores: list[tuple[float | None, bool | None]]) -> str:
    eval_run = evals_repo.create_eval_run(triggered_by="u_admin", scope="all", judge_version="jv", judge_model="m")
    rows = []
    for score, passed in scores:
        run_id = f"run-{_uid()}"
        db.upsert_run(_run_row(run_id))
        rows.append(
            {"run_id": run_id, "metric": "task_success", "score": score, "passed": passed, "rationale": None,
             "judge_version": f"jv-{_uid()}"}
        )
    evals_repo.insert_results(eval_run["id"], rows)
    return eval_run["id"]


def test_eval_run_reports_avg_score_and_failed_count_in_list_and_get() -> None:
    eval_run_id = _seed_eval_run([(1.0, True), (0.5, False), (None, None), (0.0, False)])
    got = client.get(f"{API}/eval-runs/{eval_run_id}", headers=ADMIN).json()
    assert got["avg_score"] == pytest.approx(0.5)
    assert got["failed_count"] == 2
    listed = next(r for r in client.get(f"{API}/eval-runs", headers=ADMIN).json() if r["id"] == eval_run_id)
    assert listed["avg_score"] == pytest.approx(0.5) and listed["failed_count"] == 2


def test_eval_run_without_results_has_null_avg_and_zero_failures() -> None:
    eval_run = evals_repo.create_eval_run(triggered_by="u_admin", scope="all", judge_version="jv", judge_model="m")
    got = client.get(f"{API}/eval-runs/{eval_run['id']}", headers=ADMIN).json()
    assert got["avg_score"] is None and got["failed_count"] == 0
