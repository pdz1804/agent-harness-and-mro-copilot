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
