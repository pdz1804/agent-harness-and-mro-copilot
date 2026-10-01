"""Incident lifecycle (open -> acknowledged -> resolved with who/when), the detail
view with its link back to the originating run, owner scoping, and the duplicate
warning shown to the agent. Network-free (scripted models)."""

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


def _wait(run_id: str, headers: dict, *targets: str, timeout: float = 8.0) -> dict:
    deadline = time.monotonic() + timeout
    body: dict = {}
    while time.monotonic() < deadline:
        body = client.get(f"/api/v1/runs/{run_id}", headers=headers).json()
        if body["status"] in targets:
            return body
        time.sleep(0.02)
    raise AssertionError(f"run never reached {targets}: {body['status']}")


def _incident_call(title: str, service: str | None = "search-index", **extra) -> dict:
    args = {"title": title, "description": "index rebuild failed", "severity": "high", **extra}
    if service:
        args["service_name"] = service
    return {"action": "tool_call", "tool_name": "create_incident", "tool_args": args}


def _run(monkeypatch, script: list[dict], headers: dict, approve: bool | None = True) -> dict:
    monkeypatch.setattr(state, "llm_client_factory", lambda: build_scripted_model(script))
    started = client.post("/api/v1/runs", json={"objective": "handle the outage"}, headers=headers)
    assert started.status_code == 202, started.text
    run_id = started.json()["run_id"]
    if approve is not None:
        _wait(run_id, headers, "pending_approval")
        assert client.post(f"/api/v1/runs/{run_id}/approve", json={"approved": approve}, headers=headers).status_code == 200
    return _wait(run_id, headers, "completed")


def _raise_incident(monkeypatch, headers: dict = EDITOR, title: str = "search-index down", service: str | None = "search-index") -> dict:
    script = [_incident_call(title, service), {"action": "final_answer", "final_answer": "Opened."}]
    run = _run(monkeypatch, script, headers)
    incidents = client.get("/api/v1/incidents", headers=headers).json()
    return {"run": run, "incident": next(i for i in incidents if i["title"] == title)}


# --- creation + lifecycle ------------------------------------------------------------


def test_agent_created_incident_starts_open_with_service_and_creator(monkeypatch) -> None:
    made = _raise_incident(monkeypatch)
    incident = made["incident"]
    assert incident["status"] == "open"
    assert incident["service_name"] == "search-index" and incident["created_by"] == "u_editor"
    assert incident["run_id"] == made["run"]["run_id"]
    assert incident["acknowledged_at"] is None and incident["resolved_at"] is None


def test_acknowledge_then_resolve_records_who_and_when(monkeypatch) -> None:
    incident = _raise_incident(monkeypatch)["incident"]
    acked = client.post(f"/api/v1/incidents/{incident['id']}/acknowledge", headers=EDITOR)
    assert acked.status_code == 200
    assert acked.json()["status"] == "acknowledged" and acked.json()["acknowledged_by"] == "u_editor"
    assert acked.json()["acknowledged_at"]

    resolved = client.post(f"/api/v1/incidents/{incident['id']}/resolve", json={"note": "rebuild re-run"}, headers=ADMIN)
    assert resolved.status_code == 200
    body = resolved.json()
    assert body["status"] == "resolved" and body["resolved_by"] == "u_admin" and body["resolution_note"] == "rebuild re-run"

    detail = client.get(f"/api/v1/incidents/{incident['id']}", headers=ADMIN).json()
    assert [(t["event"], t["actor_id"]) for t in detail["timeline"]] == [
        ("opened", "u_editor"),
        ("acknowledged", "u_editor"),
        ("resolved", "u_admin"),
    ]
    assert detail["timeline"][2]["note"] == "rebuild re-run"
    assert detail["timeline"][1]["actor_name"] == "Evan Editor"


def test_resolve_straight_from_open_and_invalid_moves_are_409(monkeypatch) -> None:
    incident = _raise_incident(monkeypatch)["incident"]
    assert client.post(f"/api/v1/incidents/{incident['id']}/resolve", json={}, headers=EDITOR).status_code == 200
    assert client.post(f"/api/v1/incidents/{incident['id']}/acknowledge", headers=EDITOR).status_code == 409
    assert client.post(f"/api/v1/incidents/{incident['id']}/resolve", json={}, headers=EDITOR).status_code == 409

    other = _raise_incident(monkeypatch, title="second outage", service="auth-service")["incident"]
    assert client.post(f"/api/v1/incidents/{other['id']}/acknowledge", headers=EDITOR).status_code == 200
    assert client.post(f"/api/v1/incidents/{other['id']}/acknowledge", headers=EDITOR).status_code == 409


def test_viewer_cannot_change_an_incident_but_can_read_their_own(monkeypatch) -> None:
    made = _raise_incident(monkeypatch, headers=VIEWER)["incident"]
    assert [i["id"] for i in client.get("/api/v1/incidents", headers=VIEWER).json()] == [made["id"]]
    assert client.get(f"/api/v1/incidents/{made['id']}", headers=VIEWER).status_code == 200
    assert client.post(f"/api/v1/incidents/{made['id']}/acknowledge", headers=VIEWER).status_code == 403
    assert client.post(f"/api/v1/incidents/{made['id']}/resolve", json={}, headers=VIEWER).status_code == 403


def test_unknown_incident_is_404() -> None:
    assert client.get("/api/v1/incidents/INC-NOPE", headers=ADMIN).status_code == 404
    assert client.post("/api/v1/incidents/INC-NOPE/acknowledge", headers=ADMIN).status_code == 404


def test_incidents_are_owner_scoped_for_list_detail_and_changes(monkeypatch) -> None:
    incident = _raise_incident(monkeypatch)["incident"]
    assert client.get("/api/v1/incidents", headers=EDITOR2).json() == []
    assert client.get(f"/api/v1/incidents/{incident['id']}", headers=EDITOR2).status_code == 404
    assert client.post(f"/api/v1/incidents/{incident['id']}/acknowledge", headers=EDITOR2).status_code == 404
    assert [i["id"] for i in client.get("/api/v1/incidents", headers=ADMIN).json()] == [incident["id"]]


def test_detail_links_back_to_the_originating_run(monkeypatch) -> None:
    made = _raise_incident(monkeypatch)
    detail = client.get(f"/api/v1/incidents/{made['incident']['id']}", headers=EDITOR).json()
    assert detail["run"]["run_id"] == made["run"]["run_id"]
    assert detail["run"]["session_id"] == made["run"]["session_id"]
    assert detail["run"]["objective"] == "handle the outage"


def test_list_filters_by_status_and_service(monkeypatch) -> None:
    a = _raise_incident(monkeypatch, title="search outage", service="search-index")["incident"]
    b = _raise_incident(monkeypatch, title="auth outage", service="auth-service")["incident"]
    client.post(f"/api/v1/incidents/{a['id']}/resolve", json={}, headers=EDITOR)
    assert [i["id"] for i in client.get("/api/v1/incidents?status=open", headers=EDITOR).json()] == [b["id"]]
    assert [i["id"] for i in client.get("/api/v1/incidents?status=resolved", headers=EDITOR).json()] == [a["id"]]
    assert [i["id"] for i in client.get("/api/v1/incidents?service=search-index", headers=EDITOR).json()] == [a["id"]]
    assert client.get("/api/v1/incidents?status=bogus", headers=EDITOR).status_code == 422


def test_legacy_created_status_reads_as_open() -> None:
    db.insert_incident("INC-LEGACY", "old one", "d", "low", "created", "2026-01-01T00:00:00+00:00", "")
    row = next(i for i in client.get("/api/v1/incidents", headers=ADMIN).json() if i["id"] == "INC-LEGACY")
    assert row["status"] == "open"
    assert client.post("/api/v1/incidents/INC-LEGACY/acknowledge", headers=ADMIN).status_code == 200


# --- duplicate warning ------------------------------------------------------------------


def _events(run_id: str, headers: dict, event_type: str) -> list[dict]:
    return [e for e in client.get(f"/api/v1/runs/{run_id}", headers=headers).json()["history"] if e["event_type"] == event_type]


def test_agent_is_warned_when_an_open_incident_exists_for_the_service(monkeypatch) -> None:
    first = _raise_incident(monkeypatch)["incident"]
    script = [
        _incident_call("search-index is down again"),
        {"action": "final_answer", "final_answer": f"{first['id']} already covers it."},
    ]
    run = _run(monkeypatch, script, EDITOR, approve=None)
    # The warning came back to the agent as a tool failure: no approval was ever asked.
    assert not _events(run["run_id"], EDITOR, "approval_requested")
    warning = _events(run["run_id"], EDITOR, "tool_validation_error")
    assert warning and warning[0]["data"]["stage"] == "precheck"
    assert "Duplicate warning" in warning[0]["data"]["error"] and first["id"] in warning[0]["data"]["error"]
    assert len(client.get("/api/v1/incidents", headers=EDITOR).json()) == 1


def test_agent_may_override_the_warning_with_allow_duplicate(monkeypatch) -> None:
    _raise_incident(monkeypatch)
    script = [
        _incident_call("search-index: separate disk alarm", allow_duplicate=True),
        {"action": "final_answer", "final_answer": "Opened a second one."},
    ]
    _run(monkeypatch, script, EDITOR, approve=True)
    assert len(client.get("/api/v1/incidents?service=search-index", headers=EDITOR).json()) == 2


def test_resolved_incidents_do_not_trigger_the_warning(monkeypatch) -> None:
    first = _raise_incident(monkeypatch)["incident"]
    client.post(f"/api/v1/incidents/{first['id']}/resolve", json={}, headers=EDITOR)
    _raise_incident(monkeypatch, title="search-index down (round 2)")
    assert len(client.get("/api/v1/incidents?status=open", headers=EDITOR).json()) == 1


def test_no_warning_without_a_service_name_or_for_another_service(monkeypatch) -> None:
    _raise_incident(monkeypatch)
    _raise_incident(monkeypatch, title="no service named", service=None)
    _raise_incident(monkeypatch, title="auth is down", service="auth-service")
    assert len(client.get("/api/v1/incidents", headers=EDITOR).json()) == 3


def test_other_users_incidents_do_not_leak_into_the_warning(monkeypatch) -> None:
    _raise_incident(monkeypatch, headers=EDITOR)
    # editor2 cannot see editor's incident, so editor2's agent is not blocked by it.
    _raise_incident(monkeypatch, headers=EDITOR2, title="editor2 sees the outage too")
    assert len(client.get("/api/v1/incidents", headers=EDITOR2).json()) == 1


def test_get_service_status_surfaces_the_open_incident_to_the_agent(monkeypatch) -> None:
    first = _raise_incident(monkeypatch)["incident"]
    script = [
        {"action": "tool_call", "tool_name": "get_service_status", "tool_args": {"service_name": "search-index"}},
        {"action": "final_answer", "final_answer": "Already tracked."},
    ]
    run = _run(monkeypatch, script, EDITOR, approve=None)
    result = _events(run["run_id"], EDITOR, "tool_call_result")[0]["data"]["output"]
    assert [i["id"] for i in result["open_incidents"]] == [first["id"]]
