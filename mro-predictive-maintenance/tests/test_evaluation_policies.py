"""Tests for the new threshold policies, component-window alert rate, and
bootstrap CI (src/evaluation.py, phase-01 requirements #4, #5, #6)."""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402
import pytest  # noqa: E402

from src import config, evaluation  # noqa: E402


@pytest.fixture
def synthetic_sweep():
    """A hand-built sweep where the "right answer" for each policy is known:
    lower thresholds buy more recall at the cost of more alerts; only two
    thresholds are within the 5/100 alert budget."""
    return pd.DataFrame([
        {"threshold": 0.9, "recall": 0.60, "precision": 1.00, "alerts_per_100": 1.0, "n_alerts": 10, "tp": 10, "fp": 0, "fn": 7},
        {"threshold": 0.7, "recall": 0.80, "precision": 0.90, "alerts_per_100": 3.0, "n_alerts": 30, "tp": 27, "fp": 3, "fn": 7},
        {"threshold": 0.5, "recall": 0.92, "precision": 0.70, "alerts_per_100": 5.0, "n_alerts": 50, "tp": 35, "fp": 15, "fn": 3},
        {"threshold": 0.3, "recall": 0.97, "precision": 0.40, "alerts_per_100": 9.0, "n_alerts": 90, "tp": 36, "fp": 54, "fn": 1},
    ])


def test_max_recall_within_budget_beats_min_alerts_recall(synthetic_sweep):
    min_alerts = evaluation.select_operating_threshold(synthetic_sweep, target_recall=0.80, target_alerts_per_100=5.0)
    max_recall = evaluation.select_threshold_max_recall_within_budget(synthetic_sweep, alerts_budget=5.0)
    assert max_recall["recall"] >= min_alerts["recall"]
    # min_alerts stops at the first threshold clearing 80% recall (0.7);
    # max_recall_within_budget spends the whole 5/100 budget (0.5).
    assert max_recall["threshold"] == pytest.approx(0.5)
    assert min_alerts["threshold"] == pytest.approx(0.7)


def test_min_expected_cost_picks_the_known_optimum(synthetic_sweep):
    # cost = fn * miss_cost + fp * alert_cost; with miss_cost >> alert_cost the
    # optimum should shift toward higher recall / more alerts (0.5 or 0.3).
    chosen = evaluation.select_threshold_min_expected_cost(
        synthetic_sweep, cost_missed_removal=50_000, cost_false_alert=1_500, alerts_budget=5.0,
    )
    # Within the 5.0 alert-budget candidates (0.9, 0.7, 0.5): expected costs
    # are 7*50000=350000, 7*50000+3*1500=354500, 3*50000+15*1500=172500 -> 0.5 wins.
    assert chosen["threshold"] == pytest.approx(0.5)
    assert chosen["status"] == "within_budget"


def test_min_expected_cost_falls_back_outside_budget_when_nothing_qualifies(synthetic_sweep):
    tiny_budget = synthetic_sweep.copy()
    tiny_budget["alerts_per_100"] = tiny_budget["alerts_per_100"] + 100  # nothing fits
    chosen = evaluation.select_threshold_min_expected_cost(tiny_budget, alerts_budget=5.0)
    assert chosen["status"] == "no_threshold_within_budget"


def test_component_window_alert_rate_hand_built_answer():
    # 2 components, 2 windows (day 0-29, day 30-59). Component A alerts in
    # both windows (2 snapshots -> 2 latest-per-window, both alert).
    # Component B alerts only in the second window.
    df = pd.DataFrame({
        "component_id": ["A", "A", "B", "B"],
        "snapshot_date": pd.to_datetime(["2026-01-01", "2026-02-01", "2026-01-15", "2026-02-15"]),
    })
    scores = np.array([0.9, 0.9, 0.1, 0.9])
    result = evaluation.alerts_per_100_components(df, scores, threshold=0.5, window_days=30)
    # window 0 (days 0-29): A@0.9 alert, B@0.1 no-alert -> 50%
    # window 1 (days 30-59): A@0.9 alert, B@0.9 alert -> 100%
    assert result["n_windows"] == 2
    assert result["component_window_alerts_per_100"] == pytest.approx(75.0)
    assert result["row_based_alerts_per_100"] == pytest.approx(75.0)  # 3/4 rows alert here too


def test_bootstrap_ci_contains_point_estimate_and_is_deterministic():
    rng = np.random.default_rng(0)
    n = 200
    df = pd.DataFrame({"aircraft_id": [f"AC-{i % 20:03d}" for i in range(n)]})
    y_true = (rng.random(n) < 0.1).astype(int)
    y_score = np.clip(y_true * 0.6 + rng.random(n) * 0.4, 0, 1)
    threshold = 0.5

    point = evaluation.apply_threshold(y_true, y_score, threshold)
    ci_a = evaluation.bootstrap_ci(df, y_true, y_score, threshold, n_boot=200, seed=42)
    ci_b = evaluation.bootstrap_ci(df, y_true, y_score, threshold, n_boot=200, seed=42)

    assert ci_a == ci_b  # deterministic given seed
    lo, hi = ci_a["recall_ci"]
    assert lo <= point["recall"] <= hi or np.isnan(point["recall"])
    lo, hi = ci_a["alerts_per_100_ci"]
    assert lo <= point["alerts_per_100"] <= hi


def test_cost_config_defaults_are_the_documented_illustrative_values():
    assert config.COST_MISSED_REMOVAL == 50_000.0
    assert config.COST_FALSE_ALERT == 1_500.0
