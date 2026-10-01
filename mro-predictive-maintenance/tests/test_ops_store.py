"""Tests for src/ops/db.py + src/ops/service.py: schema, fleet-scan
idempotency + persistence across restart, alert transitions, work-order
approval gate.

Uses a tmp-file sqlite database per test (never `data/ops.db`) via the
`ops_db_url` fixture, and the real trained model artifacts already
committed under models/ + reports/ (consistent with tests/test_service.py --
no mocking of the model).
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pytest  # noqa: E402

from src import config  # noqa: E402
from src.ops import db as ops_db  # noqa: E402
from src.ops import service as ops_service  # noqa: E402
from src.service.model_store import ModelStore  # noqa: E402


@pytest.fixture
def ops_db_url(tmp_path):
    return f"sqlite:///{tmp_path / 'ops.db'}"


@pytest.fixture
def engine(ops_db_url):
    eng = ops_db.make_engine(ops_db_url)
    ops_db.init_db(eng)
    yield eng
    eng.dispose()


@pytest.fixture(scope="module")
def loaded_store():
    if not config.MODEL_CARD_JSON.exists():
        pytest.skip("reports/model_card.json missing -- run `python -m src.pipeline` first")
    store = ModelStore()
    store.load()
    return store


def test_fleet_scan_records_predictions_and_opens_alerts(engine, loaded_store):
    with engine.connect() as conn:
        result = ops_service.fleet_scan(conn, loaded_store, window_days=30)

    assert result.scored == len(loaded_store.test_latest_df)
    assert result.existing_alerts == 0

    with engine.connect() as conn:
        pred_count = conn.execute(ops_db.predictions.select()).all()
        alert_count = conn.execute(ops_db.alerts.select()).all()
    assert len(pred_count) == result.scored
    assert len(alert_count) == len(result.new_alerts)


def test_fleet_scan_twice_is_idempotent(engine, loaded_store):
    with engine.connect() as conn:
        first = ops_service.fleet_scan(conn, loaded_store, window_days=30)
    with engine.connect() as conn:
        second = ops_service.fleet_scan(conn, loaded_store, window_days=30)

    assert second.new_alerts == []
    assert second.existing_alerts == len(first.new_alerts)

    with engine.connect() as conn:
        alert_rows = conn.execute(ops_db.alerts.select()).all()
    # No duplicate (component_id, window_key) alert rows were created.
    assert len(alert_rows) == len(first.new_alerts)


def test_alerts_persist_across_new_engine_same_file(ops_db_url, loaded_store):
    engine1 = ops_db.make_engine(ops_db_url)
    ops_db.init_db(engine1)
    with engine1.connect() as conn:
        result = ops_service.fleet_scan(conn, loaded_store, window_days=30)
    engine1.dispose()

    # Simulate a service restart: brand-new engine, same underlying file.
    engine2 = ops_db.make_engine(ops_db_url)
    with engine2.connect() as conn:
        rows = conn.execute(ops_db.alerts.select()).all()
    engine2.dispose()

    assert len(rows) == len(result.new_alerts)


def test_create_work_order_without_approver_raises(engine):
    with engine.connect() as conn:
        with pytest.raises(ops_service.ApprovalRequiredError):
            ops_service.create_work_order(
                conn, aircraft_id="AC-1", component_id="C-1",
                approved_by="", created_by="engineer.demo",
            )
        with pytest.raises(ops_service.ApprovalRequiredError):
            ops_service.create_work_order(
                conn, aircraft_id="AC-1", component_id="C-1",
                approved_by="   ", created_by="engineer.demo",
            )


def test_create_work_order_with_approver_succeeds_and_updates_alert(engine):
    with engine.connect() as conn:
        result = conn.execute(ops_db.alerts.insert().values(
            component_id="C-1", aircraft_id="AC-1", component_type="hydraulic_pump",
            opened_at="2026-01-01T00:00:00+00:00", window_key="W0", risk_score=0.9,
            threshold=0.5, status="open", top_factors_json="[]", source="fleet_scan",
        ))
        alert_id = result.inserted_primary_key[0]
        conn.commit()

        wo = ops_service.create_work_order(
            conn, aircraft_id="AC-1", component_id="C-1", alert_id=alert_id,
            approved_by="lead.engineer", created_by="engineer.demo", priority="urgent",
        )
        assert wo["id"].startswith("WO-")
        alert_row = conn.execute(
            ops_db.alerts.select().where(ops_db.alerts.c.id == alert_id)
        ).mappings().first()
        assert alert_row["status"] == "wo_raised"


def test_close_work_order_sets_outcome_and_closes_alert(engine):
    with engine.connect() as conn:
        result = conn.execute(ops_db.alerts.insert().values(
            component_id="C-2", aircraft_id="AC-2", component_type="hydraulic_pump",
            opened_at="2026-01-01T00:00:00+00:00", window_key="W0", risk_score=0.9,
            threshold=0.5, status="open", top_factors_json="[]", source="fleet_scan",
        ))
        alert_id = result.inserted_primary_key[0]
        conn.commit()

        wo = ops_service.create_work_order(
            conn, aircraft_id="AC-2", component_id="C-2", alert_id=alert_id,
            approved_by="lead.engineer", created_by="engineer.demo",
        )
        closed = ops_service.close_work_order(conn, wo["id"], outcome="nff", notes="no fault found")
        assert closed["outcome"] == "nff"

        alert_row = conn.execute(
            ops_db.alerts.select().where(ops_db.alerts.c.id == alert_id)
        ).mappings().first()
        assert alert_row["status"] == "closed"


def test_alert_transition_matrix_rejects_invalid_transition(engine):
    with engine.connect() as conn:
        result = conn.execute(ops_db.alerts.insert().values(
            component_id="C-3", aircraft_id="AC-3", component_type="hydraulic_pump",
            opened_at="2026-01-01T00:00:00+00:00", window_key="W0", risk_score=0.9,
            threshold=0.5, status="closed", top_factors_json="[]", source="fleet_scan",
        ))
        alert_id = result.inserted_primary_key[0]
        conn.commit()

        with pytest.raises(ops_service.InvalidTransition):
            ops_service.transition_alert(conn, alert_id, "acknowledge", actor="engineer.demo")


def test_alert_transition_valid_path(engine):
    with engine.connect() as conn:
        result = conn.execute(ops_db.alerts.insert().values(
            component_id="C-4", aircraft_id="AC-4", component_type="hydraulic_pump",
            opened_at="2026-01-01T00:00:00+00:00", window_key="W0", risk_score=0.9,
            threshold=0.5, status="open", top_factors_json="[]", source="fleet_scan",
        ))
        alert_id = result.inserted_primary_key[0]
        conn.commit()

        acked = ops_service.transition_alert(conn, alert_id, "acknowledge", actor="engineer.demo")
        assert acked["status"] == "acknowledged"
        dismissed = ops_service.transition_alert(conn, alert_id, "dismiss", actor="engineer.demo")
        assert dismissed["status"] == "dismissed"


def test_set_aircraft_status_requires_approver(engine):
    with engine.connect() as conn:
        with pytest.raises(ops_service.ApprovalRequiredError):
            ops_service.set_aircraft_status(conn, "AC-5", "aog", updated_by="")

        result = ops_service.set_aircraft_status(
            conn, "AC-5", "aog", updated_by="lead.engineer", reason="test"
        )
        assert result["status"] == "aog"
