"""Dashboard/agent SQL runs as the least-privilege `harness_reader` role over
curated, owner-scoped views - never as the (superuser) application role.

These tests exercise the *database* boundary directly (`db.run_read_only_query`,
which skips the parse allowlist) so they prove the guarantee holds even if
`sql_guard` were bypassed, plus the HTTP surface for the same attacks."""

from __future__ import annotations

import sys
from pathlib import Path

import psycopg
import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from agent_harness import db  # noqa: E402
from agent_harness.sql_guard import ALLOWED_RELATIONS  # noqa: E402
from api import app  # noqa: E402

client = TestClient(app)

EDITOR = {"X-User-Id": "u_editor"}
EDITOR2 = {"X-User-Id": "u_editor2"}
ADMIN = {"X-User-Id": "u_admin"}


def _insert_run(run_id: str, owner_id: str) -> None:
    with db.connect() as conn:
        conn.execute(
            "INSERT INTO runs (run_id, objective, status, started_at, owner_id) "
            "VALUES (%s, %s, 'completed', 1.0, %s)",
            (run_id, f"objective of {owner_id}", owner_id),
        )


@pytest.mark.parametrize(
    "sql",
    [
        "SELECT substr(pg_read_file('postgresql.conf'), 1, 40)",
        "SELECT pg_ls_dir('.')",
        "SELECT * FROM public.users",
        "SELECT * FROM users",
        "SELECT lo_import('/etc/passwd')",
        "SELECT set_config('role', 'agent_harness', true)",
        "SELECT set_config('app.is_admin', 'on', true), * FROM runs",
    ],
)
def test_database_layer_rejects_privileged_reads_even_without_the_parse_guard(sql: str) -> None:
    with pytest.raises(psycopg.Error):
        db.run_read_only_query(sql)


def test_queries_run_as_a_non_superuser_role() -> None:
    result = db.run_read_only_query(
        "SELECT current_user AS who, (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS su"
    )
    assert result["rows"] == [{"who": "harness_reader", "su": False}]


def test_the_reader_role_owns_nothing_and_has_no_base_table_privileges() -> None:
    with db.connect() as conn:
        base = conn.execute(
            "SELECT table_name FROM information_schema.role_table_grants "
            "WHERE grantee = 'harness_reader' AND table_schema = 'public'"
        ).fetchall()
        views = {
            r["table_name"]
            for r in conn.execute(
                "SELECT table_name FROM information_schema.role_table_grants "
                "WHERE grantee = 'harness_reader' AND table_schema = 'harness_ro' "
                "AND privilege_type = 'SELECT'"
            ).fetchall()
        }
        privileges = {
            r["privilege_type"]
            for r in conn.execute(
                "SELECT privilege_type FROM information_schema.role_table_grants "
                "WHERE grantee = 'harness_reader'"
            ).fetchall()
        }
    assert base == []
    assert privileges == {"SELECT"}
    # The parse allowlist and the database grants describe the same set.
    assert views == set(ALLOWED_RELATIONS)


def test_cross_owner_read_returns_nothing_and_admin_sees_everything() -> None:
    _insert_run("run-of-editor", "u_editor")
    _insert_run("run-of-editor2", "u_editor2")

    own = db.run_read_only_query("SELECT run_id FROM runs", scope=db.QueryScope("u_editor", False))
    assert [r["run_id"] for r in own["rows"]] == ["run-of-editor"]

    other = db.run_read_only_query(
        "SELECT run_id FROM runs WHERE owner_id = 'u_editor2'", scope=db.QueryScope("u_editor", False)
    )
    assert other["rows"] == []

    nobody = db.run_read_only_query("SELECT run_id FROM runs")
    assert nobody["rows"] == []

    everyone = db.run_read_only_query("SELECT run_id FROM runs", scope=db.QueryScope("u_admin", True))
    assert {r["run_id"] for r in everyone["rows"]} == {"run-of-editor", "run-of-editor2"}


def test_global_service_view_is_visible_to_every_scope() -> None:
    assert db.run_read_only_query("SELECT count(*) AS n FROM services")["rows"][0]["n"] == 3


def test_events_incidents_and_usage_views_are_scoped_through_the_run_owner() -> None:
    _insert_run("run-a", "u_editor")
    _insert_run("run-b", "u_editor2")
    for run_id in ("run-a", "run-b"):
        db.append_event(
            run_id=run_id,
            step=1,
            event_type="llm_decision",
            timestamp=2.0,
            latency_ms=None,
            data={"llm_meta": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15}},
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
    scope = db.QueryScope("u_editor", False)
    assert db.run_read_only_query("SELECT run_id FROM events", scope=scope)["rows"] == [{"run_id": "run-a"}]
    assert db.run_read_only_query("SELECT id FROM incidents", scope=scope)["rows"] == [{"id": "INC-run-a"}]
    usage = db.run_read_only_query("SELECT sum(total_tokens) AS t FROM token_usage", scope=scope)
    assert usage["rows"] == [{"t": 15}]


def test_user_supplied_predicates_cannot_leak_rows_past_the_scope_filter() -> None:
    _insert_run("mine", "u_editor")
    _insert_run("theirs", "u_editor2")
    scope = db.QueryScope("u_editor", False)
    # `1 / (length(owner_id) - 9)` divides by zero for the other user's row
    # ('u_editor2' has 9 characters). It would only raise if the planner
    # evaluated this user-supplied predicate against that row before the
    # view's scope filter removed it - the `security_barrier` guarantee.
    result = db.run_read_only_query(
        "SELECT run_id FROM runs WHERE 1 / (length(owner_id) - 9) < 0",
        scope=scope,
    )
    assert result["rows"] == [{"run_id": "mine"}]


def test_describe_query_error_never_leaks_raw_exception_text() -> None:
    with pytest.raises(psycopg.Error) as caught:
        db.run_read_only_query("SELECT pg_read_file('postgresql.conf')")
    message = db.describe_query_error(caught.value)
    assert message == "query is not permitted: only the curated read-only views may be queried"
    with pytest.raises(psycopg.Error) as caught:
        db.run_read_only_query("SELECT nope FROM services")
    assert db.describe_query_error(caught.value).startswith("query failed: column")


# --- HTTP surface ------------------------------------------------------------


@pytest.mark.parametrize(
    "sql",
    [
        "SELECT rolsuper FROM pg_roles WHERE rolname = current_user",
        "SELECT substr(pg_read_file('postgresql.conf'), 1, 40)",
        "SELECT * FROM users",
        "SELECT * FROM pg_catalog.pg_roles",
    ],
)
def test_preview_endpoint_rejects_the_probe_queries_with_a_clean_422(sql: str) -> None:
    response = client.post(
        "/api/v1/queries/preview",
        json={"sql_query": sql, "kind": "table", "config": {}},
        headers=EDITOR,
    )
    assert response.status_code == 422
    assert "Traceback" not in response.text and "psycopg" not in response.text


def test_preview_returns_only_the_callers_own_rows() -> None:
    _insert_run("editor-run", "u_editor")
    _insert_run("editor2-run", "u_editor2")
    body = {"sql_query": "SELECT run_id FROM runs", "kind": "table", "config": {}}
    mine = client.post("/api/v1/queries/preview", json=body, headers=EDITOR).json()
    assert [r["run_id"] for r in mine["rows"]] == ["editor-run"]
    everyone = client.post("/api/v1/queries/preview", json=body, headers=ADMIN).json()
    assert {r["run_id"] for r in everyone["rows"]} == {"editor-run", "editor2-run"}


def test_dashboard_snapshot_uses_the_dashboard_owners_scope_not_the_viewers() -> None:
    _insert_run("editor-run", "u_editor")
    _insert_run("editor2-run", "u_editor2")
    created = client.post(
        "/api/v1/dashboards", json={"name": "mine", "template_key": "blank", "visibility": "shared"}, headers=EDITOR
    ).json()
    widget = client.post(
        f"/api/v1/dashboards/{created['id']}/widgets",
        json={"kind": "table", "title": "runs", "sql_query": "SELECT run_id FROM runs", "config": {}},
        headers=EDITOR,
    )
    assert widget.status_code == 201
    # An admin refreshes the editor's shared dashboard: the stored snapshot
    # must still only contain the editor's own rows.
    refreshed = client.post(f"/api/v1/dashboards/{created['id']}/refresh", headers=ADMIN).json()
    rows = refreshed["widgets"][0]["last_result"]["rows"]
    assert [r["run_id"] for r in rows] == ["editor-run"]


def test_ops_overview_templates_still_refresh_without_errors() -> None:
    for key in ("ops-overview", "agent-performance", "incident-analytics"):
        created = client.post("/api/v1/dashboards", json={"name": key, "template_key": key}, headers=ADMIN)
        assert created.status_code == 201
        refreshed = client.post(f"/api/v1/dashboards/{created.json()['id']}/refresh", headers=ADMIN).json()
        errors = [(w["title"], w["last_error"]) for w in refreshed["widgets"] if w["last_error"]]
        assert errors == [], errors
