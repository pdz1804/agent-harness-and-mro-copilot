"""Tests for the /ops FastAPI router: fleet-scan, alerts, work orders,
aircraft status, reliability -- exercised through the real ASGI app with a
tmp-file sqlite database (never `data/ops.db`, per phase-03 test notes).
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from src import config  # noqa: E402
from src.service.app import app  # noqa: E402


@pytest.fixture
def client(tmp_path, monkeypatch):
    if not config.MODEL_CARD_JSON.exists():
        pytest.skip("reports/model_card.json missing -- run `python -m src.pipeline` first")
    db_url = f"sqlite:///{tmp_path / 'ops.db'}"
    monkeypatch.setenv("DATABASE_URL", db_url)
    with TestClient(app) as c:
        yield c


def test_fleet_scan_then_list_alerts(client):
    resp = client.post("/ops/fleet-scan", json={"window_days": 30})
    assert resp.status_code == 200
    body = resp.json()
    assert body["scored"] > 0

    resp2 = client.get("/ops/alerts")
    assert resp2.status_code == 200
    assert len(resp2.json()) == len(body["new_alerts"])


def test_fleet_scan_twice_creates_no_duplicate_alerts(client):
    first = client.post("/ops/fleet-scan", json={"window_days": 30}).json()
    second = client.post("/ops/fleet-scan", json={"window_days": 30}).json()
    assert second["new_alerts"] == []
    assert second["existing"] == len(first["new_alerts"])


def _first_alert_id(client) -> int:
    client.post("/ops/fleet-scan", json={"window_days": 30})
    alerts = client.get("/ops/alerts").json()
    assert len(alerts) >= 1
    return alerts[0]["id"]


def test_get_alert_includes_events_and_work_orders(client):
    alert_id = _first_alert_id(client)
    resp = client.get(f"/ops/alerts/{alert_id}")
    assert resp.status_code == 200
    body = resp.json()
    assert body["id"] == alert_id
    assert "events" in body and "work_orders" in body
    assert len(body["events"]) >= 1  # "opened" event logged by fleet_scan


def test_get_alert_missing_is_404(client):
    resp = client.get("/ops/alerts/999999")
    assert resp.status_code == 404


def test_alert_transition_invalid_action_is_409(client):
    alert_id = _first_alert_id(client)
    resp = client.post(f"/ops/alerts/{alert_id}/transition", json={"action": "wo_raised"})
    assert resp.status_code == 409


def test_alert_transition_valid_action_succeeds(client):
    alert_id = _first_alert_id(client)
    resp = client.post(
        f"/ops/alerts/{alert_id}/transition",
        json={"action": "acknowledge", "note": "looking into it"},
        headers={"X-User": "jane.doe"},
    )
    assert resp.status_code == 200
    assert resp.json()["status"] == "acknowledged"


def test_work_order_create_without_approver_is_422(client):
    alert_id = _first_alert_id(client)
    alert = client.get(f"/ops/alerts/{alert_id}").json()
    resp = client.post("/ops/work-orders", json={
        "aircraft_id": alert["aircraft_id"], "component_id": alert["component_id"],
        "approved_by": "", "alert_id": alert_id,
    })
    assert resp.status_code == 422


def test_work_order_create_missing_field_is_422(client):
    resp = client.post("/ops/work-orders", json={"aircraft_id": "AC-1"})
    assert resp.status_code == 422


def test_work_order_lifecycle(client):
    alert_id = _first_alert_id(client)
    alert = client.get(f"/ops/alerts/{alert_id}").json()

    create_resp = client.post("/ops/work-orders", json={
        "aircraft_id": alert["aircraft_id"], "component_id": alert["component_id"],
        "alert_id": alert_id, "approved_by": "lead.engineer", "task_ref": "AMM-32-11",
        "priority": "urgent",
    })
    assert create_resp.status_code == 201
    wo_id = create_resp.json()["id"]

    alert_after = client.get(f"/ops/alerts/{alert_id}").json()
    assert alert_after["status"] == "wo_raised"

    close_resp = client.post(f"/ops/work-orders/{wo_id}/close", json={
        "outcome": "confirmed_failure", "notes": "replaced pump",
    })
    assert close_resp.status_code == 200
    assert close_resp.json()["outcome"] == "confirmed_failure"

    alert_final = client.get(f"/ops/alerts/{alert_id}").json()
    assert alert_final["status"] == "closed"


def test_aircraft_status_set_and_read_back(client):
    resp = client.post(
        "/ops/aircraft/AC-1/status", json={"status": "aog", "reason": "test"},
        headers={"X-User": "lead.engineer"},
    )
    assert resp.status_code == 200
    assert resp.json()["status"] == "aog"

    aircraft = client.get("/ops/aircraft/AC-1").json()
    assert aircraft["status"]["status"] == "aog"
    assert aircraft["status"]["updated_by"] == "lead.engineer"


def test_aircraft_status_invalid_enum_is_422(client):
    resp = client.post("/ops/aircraft/AC-1/status", json={"status": "not_a_status"})
    assert resp.status_code == 422


def test_get_aircraft_endpoint(client):
    alert_id = _first_alert_id(client)
    alert = client.get(f"/ops/alerts/{alert_id}").json()
    resp = client.get(f"/ops/aircraft/{alert['aircraft_id']}")
    assert resp.status_code == 200
    body = resp.json()
    assert body["aircraft_id"] == alert["aircraft_id"]
    assert "components" in body and "open_alerts" in body and "open_work_orders" in body


def test_reliability_endpoint(client):
    resp = client.get("/ops/reliability")
    assert resp.status_code == 200
    body = resp.json()
    assert "quarterly" in body and "live_outcomes" in body


VIEWER = {"X-User": "viewer"}


def test_viewer_cannot_transition_alert(client):
    alert_id = _first_alert_id(client)
    resp = client.post(f"/ops/alerts/{alert_id}/transition", json={"action": "acknowledge"}, headers=VIEWER)
    assert resp.status_code == 403
    assert "read-only" in resp.json()["detail"]
    # Nothing changed: the alert is still open and no event was written.
    after = client.get(f"/ops/alerts/{alert_id}").json()
    assert after["status"] == "open"


def test_viewer_cannot_create_or_close_work_orders_or_set_status(client):
    alert_id = _first_alert_id(client)
    alert = client.get(f"/ops/alerts/{alert_id}").json()
    body = {"aircraft_id": alert["aircraft_id"], "component_id": alert["component_id"],
            "alert_id": alert_id, "approved_by": "viewer"}
    assert client.post("/ops/work-orders", json=body, headers=VIEWER).status_code == 403
    assert client.get("/ops/work-orders").json() == []

    body["approved_by"] = "lead.engineer"
    wo_id = client.post("/ops/work-orders", json=body, headers={"X-User": "lead.engineer"}).json()["id"]
    resp = client.post(f"/ops/work-orders/{wo_id}/close", json={"outcome": "confirmed_failure"}, headers=VIEWER)
    assert resp.status_code == 403

    resp = client.post(f"/ops/aircraft/{alert['aircraft_id']}/status",
                       json={"status": "AOG", "reason": "x"}, headers=VIEWER)
    assert resp.status_code == 403


def test_viewer_can_still_read(client):
    assert client.get("/ops/alerts", headers=VIEWER).status_code == 200
    assert client.get("/ops/work-orders", headers=VIEWER).status_code == 200


def test_viewer_cannot_trigger_fleet_scans_or_toggle_automations(client):
    assert client.post("/ops/fleet-scan", json={}, headers=VIEWER).status_code == 403
    assert client.post("/copilot/fleet-scan", json={}, headers=VIEWER).status_code == 403
    assert client.patch("/copilot/automations/1", json={"enabled": False}, headers=VIEWER).status_code == 403


def test_activity_feed_reflects_real_events_and_collapses_bursts(client):
    assert client.get("/ops/activity").json() == []
    scan = client.post("/ops/fleet-scan", json={"window_days": 30}).json()
    n_new = len(scan["new_alerts"])
    assert n_new >= 2
    feed = client.get("/ops/activity").json()
    assert "drift" in [i["kind"] for i in feed]  # the scan persists a drift snapshot
    opened = [i for i in feed if i["kind"] == "alert"]
    assert len(opened) == 1 and opened[0]["count"] == n_new
    assert opened[0]["title"] == f"{n_new} alerts opened"

    alert_id = scan["new_alerts"][0]
    client.post(f"/ops/alerts/{alert_id}/transition", json={"action": "acknowledge"}, headers={"X-User": "planner"})
    newest = client.get("/ops/activity").json()[0]
    assert newest["title"] == f"Alert #{alert_id} acknowledged"
    assert newest["actor"] == "planner" and newest["href"] == f"ops/alerts/{alert_id}"

    alert = client.get(f"/ops/alerts/{alert_id}").json()
    wo = client.post(
        "/ops/work-orders",
        json={
            "aircraft_id": alert["aircraft_id"], "component_id": alert["component_id"],
            "approved_by": "lead.engineer", "alert_id": alert_id,
        },
    ).json()
    feed = client.get("/ops/activity").json()
    assert f"{wo['id']} created" in [i["title"] for i in feed]
    times = [i["at"] for i in feed]
    assert times == sorted(times, reverse=True)


def test_activity_feed_validates_limit(client):
    assert client.get("/ops/activity?limit=0").status_code == 422
    assert client.get("/ops/activity?limit=101").status_code == 422
    assert client.get("/ops/activity?limit=2").status_code == 200
