"""Tests for src/retrain.py's promotion gate (phase-02 requirement #3).

Pure-function tests only (fake champion/challenger metric dicts, no MLflow,
no pipeline training) -- fast, deterministic, run every time.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from src.retrain import evaluate_gate, extract_gate_metrics  # noqa: E402

CHAMPION = {"recall_ci_low": 0.75, "component_window_alerts_per_100": 3.0, "brier": 0.05}


def test_no_existing_champion_always_promotes():
    result = evaluate_gate(None, {"recall_ci_low": 0.1, "component_window_alerts_per_100": 10.0, "brier": 0.5})
    assert result["promote"] is True
    assert len(result["reasons"]) == 1


def test_challenger_strictly_better_promotes():
    challenger = {"recall_ci_low": 0.80, "component_window_alerts_per_100": 2.5, "brier": 0.04}
    result = evaluate_gate(CHAMPION, challenger)
    assert result["promote"] is True
    assert len(result["reasons"]) == 3
    assert all("PASS" in r for r in result["reasons"])


def test_challenger_within_recall_slack_still_promotes():
    # champion 0.75 - 0.02 slack = 0.73 floor; 0.74 clears it.
    challenger = {"recall_ci_low": 0.74, "component_window_alerts_per_100": 3.0, "brier": 0.05}
    result = evaluate_gate(CHAMPION, challenger)
    assert result["promote"] is True


def test_challenger_recall_drop_beyond_slack_rejects():
    challenger = {"recall_ci_low": 0.70, "component_window_alerts_per_100": 3.0, "brier": 0.05}
    result = evaluate_gate(CHAMPION, challenger)
    assert result["promote"] is False
    assert any("recall_ci_low" in r and "FAIL" in r for r in result["reasons"])


def test_challenger_over_alert_budget_rejects():
    challenger = {"recall_ci_low": 0.90, "component_window_alerts_per_100": 6.0, "brier": 0.05}
    result = evaluate_gate(CHAMPION, challenger)
    assert result["promote"] is False
    assert any("alerts_per_100" in r and "FAIL" in r for r in result["reasons"])


def test_challenger_worse_brier_beyond_slack_rejects():
    challenger = {"recall_ci_low": 0.90, "component_window_alerts_per_100": 2.0, "brier": 0.10}
    result = evaluate_gate(CHAMPION, challenger)
    assert result["promote"] is False
    assert any("brier" in r and "FAIL" in r for r in result["reasons"])


def test_brier_within_slack_still_promotes():
    # champion 0.05 + 0.005 slack = 0.055 ceiling; 0.054 clears it.
    challenger = {"recall_ci_low": 0.90, "component_window_alerts_per_100": 2.0, "brier": 0.054}
    result = evaluate_gate(CHAMPION, challenger)
    assert result["promote"] is True


def test_extract_gate_metrics_reads_realistic_model_card_shape():
    card = {
        "ci": {"recall_ci": [0.81, 0.95]},
        "alert_rate": {"component_window_alerts_per_100": 3.13},
        "calibration": {"brier_post": 0.031},
    }
    metrics = extract_gate_metrics(card)
    assert metrics == {
        "recall_ci_low": 0.81,
        "component_window_alerts_per_100": 3.13,
        "brier": 0.031,
    }
