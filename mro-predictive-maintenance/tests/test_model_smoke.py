"""Smoke tests: both models train and produce valid probability scores."""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import numpy as np  # noqa: E402
import pytest  # noqa: E402

from data.generate_dataset import generate  # noqa: E402
from src.evaluation import apply_threshold, select_operating_threshold, summary_metrics, threshold_sweep  # noqa: E402
from src.features import build_model_table  # noqa: E402
from src.modeling import build_models, fit_model, predict_scores  # noqa: E402
from src.splitting import time_group_split  # noqa: E402


@pytest.fixture(scope="module")
def split_table():
    # Larger fleet than the leakage-test fixture so both classes are present
    # in every split after the group+time split (small n_aircraft can starve
    # val/test of positives, which would make this a flaky smoke test).
    aircraft, components, snapshots, faults, maint = generate(seed=42, n_aircraft=120)
    table = build_model_table(aircraft, components, snapshots, faults, maint)
    return time_group_split(table)


@pytest.mark.parametrize("model_name", ["logistic_regression", "hist_gradient_boosting"])
def test_model_trains_and_scores_are_valid_probabilities(split_table, model_name):
    train_df, val_df, test_df, _ = split_table
    models = build_models(seed=42)
    pipeline = fit_model(models[model_name], train_df)

    scores = predict_scores(pipeline, test_df)

    assert len(scores) == len(test_df)
    assert np.all(np.isfinite(scores))
    assert scores.min() >= 0.0
    assert scores.max() <= 1.0


def test_evaluation_helpers_run_end_to_end(split_table):
    train_df, val_df, test_df, _ = split_table
    models = build_models(seed=42)
    pipeline = fit_model(models["logistic_regression"], train_df)

    val_scores = predict_scores(pipeline, val_df)
    test_scores = predict_scores(pipeline, test_df)

    val_summary = summary_metrics(val_df["label"].to_numpy(), val_scores)
    assert 0.0 <= val_summary["roc_auc"] <= 1.0
    assert 0.0 <= val_summary["pr_auc"] <= 1.0

    sweep = threshold_sweep(val_df["label"].to_numpy(), val_scores)
    assert (sweep["recall"] >= 0).all() and (sweep["recall"] <= 1).all()
    assert (sweep["alerts_per_100"] >= 0).all()

    chosen = select_operating_threshold(sweep)
    assert 0.0 <= chosen["threshold"] <= 1.0
    assert chosen["status"] in {
        "both_constraints_met", "alert_rate_met_recall_shortfall", "neither_constraint_met",
    }

    test_result = apply_threshold(test_df["label"].to_numpy(), test_scores, chosen["threshold"])
    assert test_result["tp"] + test_result["fn"] == int(test_df["label"].sum())
    assert 0.0 <= test_result["recall"] <= 1.0
