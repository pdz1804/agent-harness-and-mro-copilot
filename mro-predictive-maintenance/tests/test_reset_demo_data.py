"""The demo reset script returns a used ops store to its freshly seeded state."""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from sqlalchemy import func, select  # noqa: E402

from scripts.reset_demo_data import reset_demo_data  # noqa: E402
from src import config  # noqa: E402
from src.ops import db as ops_db  # noqa: E402
from src.service.app import app  # noqa: E402

LEAD = {"X-User": "lead.engineer"}


@pytest.fixture
def db_url(tmp_path, monkeypatch):
    if not config.MODEL_CARD_JSON.exists():
        pytest.skip("reports/model_card.json missing -- run `python -m src.pipeline` first")
    url = f"sqlite:///{tmp_path / 'ops.db'}"
    monkeypatch.setenv("DATABASE_URL", url)
    return url


def test_reset_restores_seeded_alerts_and_clears_user_actions(db_url):
    with TestClient(app) as client:
        client.post("/ops/fleet-scan", json={})
        seeded = client.get("/ops/alerts").json()
        assert seeded, "fleet scan should seed at least one alert"
        first, second = seeded[0], seeded[1] if len(seeded) > 1 else seeded[0]
        client.post(f"/ops/alerts/{first['id']}/transition", json={"action": "acknowledge"}, headers=LEAD)
        client.post("/ops/work-orders", headers=LEAD, json={
            "aircraft_id": second["aircraft_id"], "component_id": second["component_id"],
            "alert_id": second["id"], "approved_by": "lead.engineer",
        })
        client.post(f"/ops/aircraft/{first['aircraft_id']}/status", headers=LEAD,
                    json={"status": "restricted", "reason": "inspection"})
        assert client.get("/ops/work-orders").json()

    engine = ops_db.make_engine(db_url)
    counts = reset_demo_data(engine)
    assert counts["work_orders"] == 1
    assert counts["alerts_total"] == len(seeded)

    with engine.connect() as conn:
        statuses = {r.status for r in conn.execute(select(ops_db.alerts.c.status))}
        actions = {r.action for r in conn.execute(select(ops_db.alert_events.c.action))}
        wo_count = conn.execute(select(func.count()).select_from(ops_db.work_orders)).scalar_one()
        status_count = conn.execute(select(func.count()).select_from(ops_db.aircraft_status)).scalar_one()
    assert statuses == {"open"}
    assert actions == {"opened"}
    assert wo_count == 0 and status_count == 0

    # Idempotent: a second reset touches nothing.
    again = reset_demo_data(engine)
    assert again["alerts_reopened"] == 0 and again["work_orders"] == 0 and again["alert_events"] == 0
