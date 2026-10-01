"""Hand-computed MTBUR / removals-per-1000FH / UCL-breach checks on a tiny
fixture (2 components, 1 quarter of exposure, 1 unscheduled removal) --
verifies src/ops/kpis.py's arithmetic directly rather than via the live
dataset (which the phase-01 realism profile may still be changing).
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pandas as pd  # noqa: E402
import pytest  # noqa: E402

from src.ops import db as ops_db  # noqa: E402
from src.ops import kpis  # noqa: E402
from src.ops import service as ops_service  # noqa: E402


@pytest.fixture
def engine(tmp_path):
    eng = ops_db.make_engine(f"sqlite:///{tmp_path / 'ops.db'}")
    ops_db.init_db(eng)
    yield eng
    eng.dispose()


def _tiny_fleet():
    # Two hydraulic pumps on one aircraft, both installed 2026-01-01.
    # cycles_per_day * avg_flight_hours_per_cycle = 4 * 2.5 = 10 FH/day.
    aircraft_df = pd.DataFrame([
        {"aircraft_id": "AC-1", "cycles_per_day": 4.0, "avg_flight_hours_per_cycle": 2.5},
    ])
    components_df = pd.DataFrame([
        {
            "component_id": "C-1", "aircraft_id": "AC-1", "component_type": "hydraulic_pump",
            "install_date": "2026-01-01", "removal_type": "unscheduled",
            "removal_date": "2026-02-15", "removal_cycle": 100,
        },
        {
            "component_id": "C-2", "aircraft_id": "AC-1", "component_type": "hydraulic_pump",
            "install_date": "2026-01-01", "removal_type": None, "removal_date": None,
            "removal_cycle": None,
        },
    ])
    return components_df, aircraft_df


def test_mtbur_and_removals_per_1000fh_hand_computed():
    components_df, aircraft_df = _tiny_fleet()
    table = kpis.component_type_quarterly_reliability(components_df, aircraft_df)

    q1 = table[table["quarter"] == "2026Q1"].iloc[0]
    # C-1: active Jan 1 -> Feb 15 = 46 days. C-2: active Jan 1 -> Mar 31 = 90 days.
    expected_exposure = (46 * 10.0) + (90 * 10.0)
    assert q1["exposure_fh"] == pytest.approx(expected_exposure, rel=1e-6)
    assert q1["unscheduled_removals"] == 1

    expected_rate = 1 / expected_exposure * 1000.0
    assert q1["removals_per_1000fh"] == pytest.approx(expected_rate, rel=1e-6)
    assert q1["mtbur_fh"] == pytest.approx(expected_exposure / 1, rel=1e-6)


def test_ucl_breach_flagged_when_current_quarter_spikes():
    # 4 quiet prior quarters (0 removals) then a spike quarter with several
    # unscheduled removals in a short exposure window -> mean=0, std=0 for
    # the prior window is degenerate, so use a fixture with some prior
    # variance instead: alternate 0/2 removals for 4 quarters, then a spike.
    rows = []
    aircraft_df = pd.DataFrame([
        {"aircraft_id": "AC-1", "cycles_per_day": 4.0, "avg_flight_hours_per_cycle": 2.5},
    ])
    quarter_starts = ["2025-01-01", "2025-04-01", "2025-07-01", "2025-10-01", "2026-01-01"]
    removal_pattern = [0, 2, 0, 2, 8]  # last quarter spikes far above prior mean+2sd
    component_idx = 0
    for q_start, n_removals in zip(quarter_starts, removal_pattern):
        for _ in range(n_removals):
            component_idx += 1
            rows.append({
                "component_id": f"C-{component_idx}", "aircraft_id": "AC-1",
                "component_type": "hydraulic_pump", "install_date": "2025-01-01",
                "removal_type": "unscheduled", "removal_date": q_start, "removal_cycle": 50,
            })
    # A always-active baseline component so exposure_fh > 0 in every quarter.
    rows.append({
        "component_id": "C-baseline", "aircraft_id": "AC-1", "component_type": "hydraulic_pump",
        "install_date": "2025-01-01", "removal_type": None, "removal_date": None,
        "removal_cycle": None,
    })
    components_df = pd.DataFrame(rows)

    table = kpis.component_type_quarterly_reliability(components_df, aircraft_df)
    spike_row = table[table["quarter"] == "2026Q1"].iloc[0]
    assert bool(spike_row["alert_level_breached"]) is True

    quiet_row = table[table["quarter"] == "2025Q3"].iloc[0]
    assert quiet_row["ucl_removals_per_1000fh"] is not None


def test_live_precision_and_nff_rate_from_work_orders(engine):
    with engine.connect() as conn:
        for i, outcome in enumerate(["confirmed_failure", "confirmed_failure", "nff", "not_inspected"]):
            alert = conn.execute(ops_db.alerts.insert().values(
                component_id="C-1", aircraft_id="AC-1", component_type="hydraulic_pump",
                opened_at="2026-01-01T00:00:00+00:00", window_key=f"W{i}", risk_score=0.9,
                threshold=0.5, status="open", top_factors_json="[]", source="fleet_scan",
            ))
            alert_id = alert.inserted_primary_key[0]
            conn.commit()
            wo = ops_service.create_work_order(
                conn, aircraft_id="AC-1", component_id="C-1", alert_id=alert_id,
                approved_by="lead.engineer", created_by="engineer.demo",
            )
            ops_service.close_work_order(conn, wo["id"], outcome=outcome)

        result = kpis.live_precision_and_nff(conn)

    assert result["closed_with_outcome"] == 4
    assert result["confirmed_failure"] == 2
    assert result["nff"] == 1
    assert result["not_inspected"] == 1
    # live_precision excludes not_inspected from the denominator: 2 / (2 + 1)
    assert result["live_precision"] == pytest.approx(2 / 3)
    assert result["nff_rate"] == pytest.approx(1 / 3)
