"""Agent-created dashboards: the approval-gated `create_dashboard` /
`add_widget` tools, end to end through the real HTTP run flow with a scripted
model (network-free). Covers the preview shown on the approval card, approve
and deny outcomes, both SQL safety layers, RBAC, and idempotency."""

from __future__ import annotations

import sys
import time
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from agent_harness import (
    db,  # noqa: E402
    state,  # noqa: E402
)
from agent_harness.llm_client import build_scripted_model  # noqa: E402
from agent_harness.repos import dashboards as dashboards_repo  # noqa: E402
from agent_harness.tools.dashboard_tools import CreateDashboardInput, CreateDashboardTool  # noqa: E402
from agent_harness.tools.registry import build_default_registry  # noqa: E402
from api import app  # noqa: E402

client = TestClient(app)

EDITOR = {"X-User-Id": "u_editor"}
EDITOR2 = {"X-User-Id": "u_editor2"}
VIEWER = {"X-User-Id": "u_viewer"}
ADMIN = {"X-User-Id": "u_admin"}

_POLL_TIMEOUT_SECONDS = 8.0

SEVERITY_WIDGET = {
    "kind": "bar",
    "title": "Incidents by severity",
    "sql_query": "SELECT severity, count(*) AS n FROM incidents GROUP BY severity ORDER BY severity",
    "config": {"x_col": "severity", "y_cols": ["n"]},
    "col_span": 6,
}
OVER_TIME_WIDGET = {
    "kind": "line",
    "title": "Incidents over time",
    "sql_query": (
        "SELECT substring(created_at, 1, 10) AS day, "
        "count(*) FILTER (WHERE severity = 'high') AS high, "
        "count(*) FILTER (WHERE severity = 'low') AS low "
        "FROM incidents GROUP BY day ORDER BY day"
    ),
    "config": {"x_col": "day", "y_cols": ["high", "low"]},
    "col_span": 12,
}


@pytest.fixture(autouse=True)
def _isolate_trace_files(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)


@pytest.fixture(autouse=True)
def _seed_incidents():
    for i, severity in enumerate(("low", "high", "high")):
        db.insert_incident(
            incident_id=f"INC-T{i}",
            title=f"t{i}",
            description="d",
            severity=severity,
            status="created",
            created_at=f"2026-09-3{i}T10:00:00+00:00",
            run_id=None,
        )


def _use_script(monkeypatch, script: list[dict[str, Any]]) -> None:
    monkeypatch.setattr(state, "llm_client_factory", lambda: build_scripted_model(script))


def _create_dashboard_call(widgets: list[dict], name: str = "Incident dashboard") -> dict[str, Any]:
    return {
        "action": "tool_call",
        "tool_name": "create_dashboard",
        "tool_args": {"name": name, "description": "by agent", "widgets": widgets},
    }


def _start(objective: str, headers: dict) -> str:
    response = client.post("/api/v1/runs", json={"objective": objective}, headers=headers)
    assert response.status_code == 202, response.text
    return response.json()["run_id"]


def _wait(run_id: str, *targets: str, headers: dict = ADMIN) -> dict:
    deadline = time.monotonic() + _POLL_TIMEOUT_SECONDS
    body: dict = {}
    while time.monotonic() < deadline:
        body = client.get(f"/api/v1/runs/{run_id}", headers=headers).json()
        if body["status"] in targets:
            return body
        time.sleep(0.02)
    raise AssertionError(f"run {run_id} never reached {targets}; last: {body}")


def _events(body: dict, event_type: str) -> list[dict]:
    return [e for e in body["history"] if e["event_type"] == event_type]


def test_dashboard_tools_are_registered_approval_gated_and_rbac_filtered() -> None:
    admin_tools = build_default_registry("u_admin", "admin")
    assert admin_tools["create_dashboard"].requires_approval is True
    assert admin_tools["add_widget"].requires_approval is True
    assert "create_dashboard" in build_default_registry("u_editor", "editor")
    viewer_tools = build_default_registry("u_viewer", "viewer")
    assert {"create_dashboard", "add_widget"}.isdisjoint(viewer_tools)
    assert "search_knowledge_base" in viewer_tools

    catalog = {t["name"]: t for t in client.get("/api/v1/tools", headers=ADMIN).json()}
    assert catalog["create_dashboard"]["requires_approval"] is True


def test_approval_card_carries_a_real_preview_then_approve_creates_a_visible_dashboard(monkeypatch) -> None:
    _use_script(
        monkeypatch,
        [_create_dashboard_call([SEVERITY_WIDGET, OVER_TIME_WIDGET]), {"action": "final_answer", "final_answer": "Created."}],
    )
    run_id = _start("/build-dashboard incidents by severity over time", EDITOR)
    paused = _wait(run_id, "pending_approval", headers=EDITOR)

    pending = paused["pending_approval"]
    assert pending["tool_name"] == "create_dashboard"
    preview = pending["preview"]
    assert preview["kind"] == "dashboard"
    assert preview["name"] == "Incident dashboard"
    assert [w["title"] for w in preview["widgets"]] == ["Incidents by severity", "Incidents over time"]
    first = preview["widgets"][0]
    assert first["sql_query"].startswith("SELECT severity")
    assert first["columns"] == ["severity", "n"]
    assert first["row_count"] == 0  # the editor owns none of the seeded run-less incidents
    assert first["error"] is None
    # Nothing exists yet: the human has not approved.
    assert client.get("/api/v1/dashboards", headers=EDITOR).json() == []
    assert _events(paused, "approval_requested")[0]["data"]["preview"]["widgets"][0]["kind"] == "bar"

    assert client.post(f"/api/v1/runs/{run_id}/approve", json={"approved": True}, headers=EDITOR).status_code == 200
    done = _wait(run_id, "completed", headers=EDITOR)
    assert done["final_answer"] == "Created."
    result = _events(done, "tool_call_result")[0]["data"]["output"]
    assert result["widget_count"] == 2

    dashboards = client.get("/api/v1/dashboards", headers=EDITOR).json()
    assert len(dashboards) == 1
    dashboard = dashboards[0]
    assert dashboard["id"] == result["dashboard_id"]
    assert dashboard["owner_id"] == "u_editor"
    assert dashboard["visibility"] == "private"
    assert dashboard["created_by_run_id"] == run_id
    assert [w["title"] for w in dashboard["widgets"]] == ["Incidents by severity", "Incidents over time"]
    # Widgets were refreshed on creation, through the same read-only path.
    assert all(w["last_error"] is None and w["last_result"] is not None for w in dashboard["widgets"])
    # Another editor cannot see this private dashboard.
    assert client.get("/api/v1/dashboards", headers=EDITOR2).json() == []


def test_denying_creates_nothing(monkeypatch) -> None:
    _use_script(
        monkeypatch,
        [_create_dashboard_call([SEVERITY_WIDGET]), {"action": "final_answer", "final_answer": "Understood."}],
    )
    run_id = _start("/build-dashboard severity chart", EDITOR)
    _wait(run_id, "pending_approval", headers=EDITOR)
    client.post(f"/api/v1/runs/{run_id}/approve", json={"approved": False}, headers=EDITOR)
    done = _wait(run_id, "completed", headers=EDITOR)
    assert _events(done, "approval_denied")
    assert client.get("/api/v1/dashboards", headers=ADMIN).json() == []


@pytest.mark.parametrize(
    "bad_sql",
    [
        "SELECT * FROM users",
        "SELECT pg_read_file('postgresql.conf') AS n",
        "DELETE FROM services",
        "SELECT 1 AS n; SELECT 2 AS n",
    ],
)
def test_unsafe_sql_is_bounced_back_to_the_llm_before_any_approval(monkeypatch, bad_sql: str) -> None:
    widget = {**SEVERITY_WIDGET, "sql_query": bad_sql, "config": {"x_col": "n", "y_cols": ["n"]}}
    _use_script(
        monkeypatch,
        [_create_dashboard_call([widget]), {"action": "final_answer", "final_answer": "Could not."}],
    )
    run_id = _start("/build-dashboard anything", ADMIN)
    done = _wait(run_id, "completed", "pending_approval")
    assert done["status"] == "completed", "an unsafe widget must never reach the approval card"
    assert not _events(done, "approval_requested")
    assert _events(done, "tool_validation_error")
    assert client.get("/api/v1/dashboards", headers=ADMIN).json() == []


def test_a_widget_that_fails_the_live_dry_run_is_rejected_before_approval(monkeypatch) -> None:
    broken = {**SEVERITY_WIDGET, "sql_query": "SELECT nonexistent_column AS severity, 1 AS n FROM incidents"}
    _use_script(
        monkeypatch,
        [_create_dashboard_call([SEVERITY_WIDGET, broken]), {"action": "final_answer", "final_answer": "Gave up."}],
    )
    run_id = _start("/build-dashboard broken", ADMIN)
    done = _wait(run_id, "completed", "pending_approval")
    assert done["status"] == "completed"
    errors = _events(done, "tool_validation_error")
    assert errors and errors[0]["data"]["stage"] == "precheck"
    assert "nonexistent_column" in errors[0]["data"]["error"]
    assert not _events(done, "approval_requested")


def test_config_not_matching_the_query_result_is_caught_by_the_dry_run(monkeypatch) -> None:
    mismatch = {**SEVERITY_WIDGET, "config": {"x_col": "severity", "y_cols": ["not_returned"]}}
    _use_script(monkeypatch, [_create_dashboard_call([mismatch]), {"action": "final_answer", "final_answer": "x"}])
    done = _wait(_start("/build-dashboard mismatch", ADMIN), "completed", "pending_approval")
    assert done["status"] == "completed"
    assert "not_returned" in _events(done, "tool_validation_error")[0]["data"]["error"]


def test_viewer_run_is_never_offered_the_tools_and_nothing_is_created(monkeypatch) -> None:
    _use_script(
        monkeypatch,
        [_create_dashboard_call([SEVERITY_WIDGET]), {"action": "final_answer", "final_answer": "No access."}],
    )
    run_id = _start("/build-dashboard severity chart", VIEWER)
    done = _wait(run_id, "completed", headers=VIEWER)
    assert _events(done, "no_tools_available")
    assert not _events(done, "approval_requested")
    assert client.get("/api/v1/dashboards", headers=ADMIN).json() == []


def test_tool_refuses_a_run_with_no_owner_context() -> None:
    tool = CreateDashboardTool()
    args = CreateDashboardInput(name="x", widgets=[SEVERITY_WIDGET])
    with pytest.raises(Exception, match="owner"):
        tool.precheck(args)


def test_viewer_role_bound_directly_is_denied_in_depth() -> None:
    tool = CreateDashboardTool()
    tool.bind_context(owner_id="u_viewer", owner_role="viewer", run_id="r1")
    with pytest.raises(Exception, match="not permitted"):
        tool.precheck(CreateDashboardInput(name="x", widgets=[SEVERITY_WIDGET]))


def test_create_dashboard_is_idempotent_per_run_and_name() -> None:
    tool = CreateDashboardTool()
    tool.bind_context(owner_id="u_editor", owner_role="editor", run_id="run-1")
    args = CreateDashboardInput(name="Same", widgets=[SEVERITY_WIDGET])
    first = tool.run(args)
    second = tool.run(args)
    assert first.dashboard_id == second.dashboard_id
    assert len(dashboards_repo.list_dashboards()) == 1


def test_widget_validation_happens_at_the_input_boundary() -> None:
    with pytest.raises(ValueError, match="users"):
        CreateDashboardInput(name="x", widgets=[{**SEVERITY_WIDGET, "sql_query": "SELECT * FROM users"}])
    with pytest.raises(ValueError):
        CreateDashboardInput(name="x", widgets=[])
    with pytest.raises(ValueError):
        CreateDashboardInput(name="x", widgets=[{**SEVERITY_WIDGET, "config": {}}])


def test_add_widget_extends_an_existing_dashboard_for_its_owner_only(monkeypatch) -> None:
    created = client.post("/api/v1/dashboards", json={"name": "Mine", "template_key": "blank"}, headers=EDITOR).json()
    add_call = {
        "action": "tool_call",
        "tool_name": "add_widget",
        "tool_args": {"dashboard_id": created["id"], "widget": SEVERITY_WIDGET},
    }
    _use_script(monkeypatch, [add_call, {"action": "final_answer", "final_answer": "Added."}])

    # Another editor may not even see the private dashboard: rejected before approval.
    stranger = _wait(_start("/build-dashboard add a chart", EDITOR2), "completed", "pending_approval", headers=EDITOR2)
    assert stranger["status"] == "completed"
    assert "unknown dashboard" in _events(stranger, "tool_validation_error")[0]["data"]["error"]

    _use_script(monkeypatch, [add_call, {"action": "final_answer", "final_answer": "Added."}])
    run_id = _start("/build-dashboard add a chart", EDITOR)
    paused = _wait(run_id, "pending_approval", headers=EDITOR)
    assert paused["pending_approval"]["preview"]["kind"] == "widget"
    client.post(f"/api/v1/runs/{run_id}/approve", json={"approved": True}, headers=EDITOR)
    _wait(run_id, "completed", headers=EDITOR)
    widgets = client.get(f"/api/v1/dashboards/{created['id']}", headers=EDITOR).json()["widgets"]
    assert [w["title"] for w in widgets] == ["Incidents by severity"]
    assert widgets[0]["last_result"] is not None


def test_integration_toggle_removes_the_tool_from_new_runs(monkeypatch) -> None:
    assert client.patch("/api/v1/integrations/create_dashboard", json={"enabled": False}, headers=ADMIN).status_code == 200
    _use_script(monkeypatch, [_create_dashboard_call([SEVERITY_WIDGET]), {"action": "final_answer", "final_answer": "x"}])
    done = _wait(_start("/build-dashboard severity chart", ADMIN), "completed", "pending_approval")
    assert done["status"] == "completed"
    assert not _events(done, "approval_requested")
    assert client.get("/api/v1/dashboards", headers=ADMIN).json() == []


def test_build_dashboard_skill_is_seeded_shared_and_uses_both_tools() -> None:
    skill = next(s for s in client.get("/api/v1/skills", headers=ADMIN).json() if s["slug"] == "build-dashboard")
    assert skill["visibility"] == "shared" and skill["enabled"] is True
    assert set(skill["allowed_tools"]) == {"create_dashboard", "add_widget"}
    commands = {c["slug"] for c in client.get("/api/v1/skills/commands", headers=EDITOR).json()}
    assert "build-dashboard" in commands


def test_duplicate_and_auto_refresh_endpoints() -> None:
    created = client.post(
        "/api/v1/dashboards", json={"name": "Ops", "template_key": "ops-overview", "visibility": "shared"}, headers=ADMIN
    ).json()
    copy = client.post(f"/api/v1/dashboards/{created['id']}/duplicate", json={}, headers=EDITOR)
    assert copy.status_code == 201
    body = copy.json()
    assert body["name"] == "Ops (copy)"
    assert body["owner_id"] == "u_editor" and body["visibility"] == "private"
    assert len(body["widgets"]) == len(created["widgets"]) > 0
    assert client.post("/api/v1/dashboards/nope/duplicate", json={}, headers=EDITOR).status_code == 404

    updated = client.patch(f"/api/v1/dashboards/{body['id']}", json={"auto_refresh_seconds": 30}, headers=EDITOR)
    assert updated.status_code == 200 and updated.json()["auto_refresh_seconds"] == 30
    assert client.patch(f"/api/v1/dashboards/{body['id']}", json={"auto_refresh_seconds": 7}, headers=EDITOR).status_code == 422
    cleared = client.patch(f"/api/v1/dashboards/{body['id']}", json={"auto_refresh_seconds": 0}, headers=EDITOR)
    assert cleared.json()["auto_refresh_seconds"] is None


def test_admin_preview_shows_real_row_counts_and_sample_rows(monkeypatch) -> None:
    _use_script(monkeypatch, [_create_dashboard_call([SEVERITY_WIDGET]), {"action": "final_answer", "final_answer": "ok"}])
    paused = _wait(_start("/build-dashboard severity chart", ADMIN), "pending_approval")
    widget = paused["pending_approval"]["preview"]["widgets"][0]
    assert widget["row_count"] == 2  # high, low
    assert {r["severity"]: r["n"] for r in widget["sample_rows"]} == {"high": 2, "low": 1}
