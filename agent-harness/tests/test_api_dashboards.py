"""Dashboards (phase 06): templates, widgets, stored queries, live refresh.
Every query targets the real seeded Postgres schema — no mocks/placeholder
data (`tests/conftest.py` seeds 3 real `services` rows; `incidents`/`runs`/
`events` start empty per test, which templates handle as legitimate
zero-row results, not errors)."""

from __future__ import annotations

import sys
from pathlib import Path

import psycopg
import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from conftest import client_as  # noqa: E402

from api import app  # noqa: E402

client = TestClient(app)


def test_list_dashboard_templates_includes_all_four():
    resp = client.get("/api/v1/dashboard-templates")
    assert resp.status_code == 200
    keys = {t["key"] for t in resp.json()}
    assert keys == {"blank", "ops-overview", "agent-performance", "incident-analytics"}


@pytest.mark.parametrize("template_key", ["ops-overview", "agent-performance", "incident-analytics"])
def test_every_template_instantiates_and_refreshes_with_zero_widget_errors(template_key):
    created = client.post("/api/v1/dashboards", json={"name": f"from {template_key}", "template_key": template_key})
    assert created.status_code == 201
    dashboard = created.json()
    assert len(dashboard["widgets"]) >= 4
    kinds = {w["kind"] for w in dashboard["widgets"]}
    assert {"stat", "table"}.issubset(kinds)
    assert kinds & {"line", "bar", "area", "pie"}  # at least one chart widget

    refreshed = client.post(f"/api/v1/dashboards/{dashboard['id']}/refresh")
    assert refreshed.status_code == 200
    widgets = refreshed.json()["widgets"]
    errors = [(w["title"], w["last_error"]) for w in widgets if w["last_error"]]
    assert errors == [], f"widget(s) errored on real seeded data: {errors}"
    for w in widgets:
        assert w["last_result"] is not None
        assert w["refreshed_at"] is not None


def test_blank_template_has_no_widgets():
    created = client.post("/api/v1/dashboards", json={"name": "blank one", "template_key": "blank"})
    assert created.status_code == 201
    assert created.json()["widgets"] == []


def test_unknown_template_key_is_422():
    resp = client.post("/api/v1/dashboards", json={"name": "x", "template_key": "does-not-exist"})
    assert resp.status_code == 422


def test_refresh_liveness_stat_changes_after_a_real_service_status_change():
    created = client.post(
        "/api/v1/dashboards",
        json={
            "name": "liveness check",
            "template_key": "blank",
        },
    )
    dashboard_id = created.json()["id"]
    widget = client.post(
        f"/api/v1/dashboards/{dashboard_id}/widgets",
        json={
            "kind": "stat",
            "title": "operational services",
            "sql_query": "SELECT count(*) AS value FROM services WHERE status = 'operational'",
            "config": {"value_col": "value"},
            "col_span": 3,
        },
    )
    assert widget.status_code == 201
    widget_id = widget.json()["id"]

    before = client.post(f"/api/v1/dashboards/{dashboard_id}/widgets/{widget_id}/refresh")
    assert before.status_code == 200
    before_value = before.json()["last_result"]["rows"][0]["value"]

    status_change = client.post("/api/v1/services/auth-service/status", json={"status": "down"})
    assert status_change.status_code == 200

    after = client.post(f"/api/v1/dashboards/{dashboard_id}/widgets/{widget_id}/refresh")
    assert after.status_code == 200
    after_value = after.json()["last_result"]["rows"][0]["value"]

    assert after_value == before_value - 1


# Burns well past the 5s per-widget statement timeout using only allowlisted
# constructs (a 20k x 20k cross join of generated series).
_SLOW_QUERY = "SELECT count(*) AS n FROM generate_series(1, 20000) a, generate_series(1, 20000) b"


def test_widget_query_destructive_dml_rejected_at_create():
    created = client.post("/api/v1/dashboards", json={"name": "x", "template_key": "blank"})
    dashboard_id = created.json()["id"]
    resp = client.post(
        f"/api/v1/dashboards/{dashboard_id}/widgets",
        json={"kind": "table", "title": "x", "sql_query": "DELETE FROM services", "config": {}},
    )
    assert resp.status_code == 422
    assert "DELETE" in resp.json()["detail"]
    # never persisted
    assert client.get(f"/api/v1/dashboards/{dashboard_id}").json()["widgets"] == []


@pytest.mark.parametrize(
    "sql_query",
    [
        "UPDATE services SET status = 'down'",
        "SELECT 1; DROP TABLE services",
        "WITH x AS (DELETE FROM services RETURNING *) SELECT * FROM x",
    ],
)
def test_widget_query_variants_of_mutation_rejected(sql_query):
    created = client.post("/api/v1/dashboards", json={"name": "x", "template_key": "blank"})
    dashboard_id = created.json()["id"]
    resp = client.post(
        f"/api/v1/dashboards/{dashboard_id}/widgets",
        json={"kind": "table", "title": "x", "sql_query": sql_query, "config": {}},
    )
    assert resp.status_code == 422


def test_widget_query_even_a_query_that_bypasses_the_text_check_cannot_mutate_data():
    """Defense in depth: directly exercises `db.run_read_only_query`'s
    Postgres-level READ ONLY + always-rollback guarantee, independent of
    the text filter — mirrors the equivalent 12e Artifacts proof."""
    from agent_harness import db

    before = db.list_services()
    down_count_before = sum(1 for s in before if s["status"] == "down")
    with pytest.raises(psycopg.Error):
        db.run_read_only_query("UPDATE services SET status = 'down'")
    after = db.list_services()
    down_count_after = sum(1 for s in after if s["status"] == "down")
    assert down_count_after == down_count_before


def test_widget_query_row_cap_truncates_large_result():
    created = client.post("/api/v1/dashboards", json={"name": "x", "template_key": "blank"})
    dashboard_id = created.json()["id"]
    widget = client.post(
        f"/api/v1/dashboards/{dashboard_id}/widgets",
        json={
            "kind": "table",
            "title": "big",
            "sql_query": "SELECT generate_series(1, 5000) AS n",
            "config": {},
        },
    )
    assert widget.status_code == 201
    widget_id = widget.json()["id"]
    refreshed = client.post(f"/api/v1/dashboards/{dashboard_id}/widgets/{widget_id}/refresh")
    assert refreshed.status_code == 200
    result = refreshed.json()["last_result"]
    assert result["truncated"] is True
    assert len(result["rows"]) == 1000


def test_widget_query_slow_query_times_out_as_widget_error_not_500():
    created = client.post("/api/v1/dashboards", json={"name": "x", "template_key": "blank"})
    dashboard_id = created.json()["id"]
    widget = client.post(
        f"/api/v1/dashboards/{dashboard_id}/widgets",
        json={"kind": "table", "title": "slow", "sql_query": _SLOW_QUERY, "config": {}},
    )
    assert widget.status_code == 201
    widget_id = widget.json()["id"]
    refreshed = client.post(f"/api/v1/dashboards/{dashboard_id}/widgets/{widget_id}/refresh")
    assert refreshed.status_code == 200  # never a 500 — the timeout is captured as this widget's error
    body = refreshed.json()
    assert body["last_error"] is not None
    assert "timed out" in body["last_error"]
    assert body["last_result"] is None


def test_shape_error_stat_query_returning_two_rows_becomes_widget_error_only():
    created = client.post("/api/v1/dashboards", json={"name": "x", "template_key": "blank"})
    dashboard_id = created.json()["id"]
    widget = client.post(
        f"/api/v1/dashboards/{dashboard_id}/widgets",
        json={
            "kind": "stat",
            "title": "bad shape",
            "sql_query": "SELECT name, 1 AS value FROM services LIMIT 2",
            "config": {"value_col": "value"},
        },
    )
    assert widget.status_code == 201
    widget_id = widget.json()["id"]
    refreshed = client.post(f"/api/v1/dashboards/{dashboard_id}/widgets/{widget_id}/refresh")
    assert refreshed.status_code == 200
    assert "exactly 1 row" in refreshed.json()["last_error"]


def test_refresh_dashboard_response_reflects_the_just_bumped_last_refreshed_at():
    """Regression test for the phase-08 bug: `refresh_dashboard` used to
    serialize the dashboard row fetched *before*
    `dashboards_repo.refresh_dashboard()` bumped `last_refreshed_at`, so the
    HTTP response (and therefore the UI's "Last refreshed" header) always
    lagged one refresh behind reality."""
    created = client.post("/api/v1/dashboards", json={"name": "x", "template_key": "blank"})
    dashboard_id = created.json()["id"]
    assert created.json()["last_refreshed_at"] is None

    refreshed = client.post(f"/api/v1/dashboards/{dashboard_id}/refresh")
    assert refreshed.status_code == 200
    first_refreshed_at = refreshed.json()["last_refreshed_at"]
    assert first_refreshed_at is not None

    # A second refresh must move the timestamp forward again, not just
    # repeat the first response's stale value.
    second = client.post(f"/api/v1/dashboards/{dashboard_id}/refresh")
    assert second.status_code == 200
    assert second.json()["last_refreshed_at"] is not None
    assert second.json()["last_refreshed_at"] >= first_refreshed_at

    # And a plain GET afterward must agree with what refresh just reported
    # (the response wasn't serialized from stale pre-refresh state).
    fetched = client.get(f"/api/v1/dashboards/{dashboard_id}")
    assert fetched.json()["last_refreshed_at"] == second.json()["last_refreshed_at"]


def test_one_broken_widget_does_not_prevent_the_rest_of_the_dashboard_from_rendering():
    created = client.post("/api/v1/dashboards", json={"name": "x", "template_key": "blank"})
    dashboard_id = created.json()["id"]
    client.post(
        f"/api/v1/dashboards/{dashboard_id}/widgets",
        json={
            "kind": "stat",
            "title": "good",
            "sql_query": "SELECT count(*) AS value FROM services",
            "config": {"value_col": "value"},
        },
    )
    client.post(
        f"/api/v1/dashboards/{dashboard_id}/widgets",
        json={"kind": "table", "title": "slow", "sql_query": _SLOW_QUERY, "config": {}},
    )
    refreshed = client.post(f"/api/v1/dashboards/{dashboard_id}/refresh")
    assert refreshed.status_code == 200
    widgets = refreshed.json()["widgets"]
    good = next(w for w in widgets if w["title"] == "good")
    slow = next(w for w in widgets if w["title"] == "slow")
    assert good["last_error"] is None
    assert good["last_result"]["rows"][0]["value"] == 3
    assert slow["last_error"] is not None


def test_config_validation_422_on_widget_create():
    created = client.post("/api/v1/dashboards", json={"name": "x", "template_key": "blank"})
    dashboard_id = created.json()["id"]
    resp = client.post(
        f"/api/v1/dashboards/{dashboard_id}/widgets",
        json={"kind": "stat", "title": "x", "sql_query": "SELECT 1 AS n", "config": {}},
    )
    assert resp.status_code == 422


def test_queries_preview_does_not_persist_anything():
    created = client.post("/api/v1/dashboards", json={"name": "x", "template_key": "blank"})
    dashboard_id = created.json()["id"]
    resp = client.post(
        "/api/v1/queries/preview",
        json={"sql_query": "SELECT count(*) AS value FROM services", "kind": "stat", "config": {"value_col": "value"}},
    )
    assert resp.status_code == 200
    assert resp.json()["rows"][0]["value"] == 3
    assert client.get(f"/api/v1/dashboards/{dashboard_id}").json()["widgets"] == []


# --- RBAC -----------------------------------------------------------------


def test_editor_cannot_edit_another_editors_private_dashboard_and_cannot_see_it():
    editor = client_as(client, "u_editor")
    created = editor.post("/api/v1/dashboards", json={"name": "editor-private", "template_key": "blank", "visibility": "private"})
    assert created.status_code == 201
    dashboard_id = created.json()["id"]

    editor2 = client_as(client, "u_editor2")
    assert editor2.get(f"/api/v1/dashboards/{dashboard_id}").status_code == 404
    assert editor2.patch(f"/api/v1/dashboards/{dashboard_id}", json={"name": "x"}).status_code == 404
    assert (
        editor2.post(f"/api/v1/dashboards/{dashboard_id}/widgets", json={"kind": "stat", "title": "x", "sql_query": "SELECT 1 AS v", "config": {"value_col": "v"}}).status_code
        == 404
    )


def test_viewer_can_refresh_a_shared_dashboard_but_cannot_edit_it():
    editor = client_as(client, "u_editor")
    created = editor.post("/api/v1/dashboards", json={"name": "shared one", "template_key": "blank", "visibility": "shared"})
    dashboard_id = created.json()["id"]

    viewer = client_as(client, "u_viewer")
    assert viewer.get(f"/api/v1/dashboards/{dashboard_id}").status_code == 200
    assert viewer.post(f"/api/v1/dashboards/{dashboard_id}/refresh").status_code == 200
    assert viewer.patch(f"/api/v1/dashboards/{dashboard_id}", json={"name": "x"}).status_code == 403
    assert viewer.post(f"/api/v1/dashboards/{dashboard_id}/widgets", json={"kind": "stat", "title": "x", "sql_query": "SELECT 1", "config": {}}).status_code == 403
