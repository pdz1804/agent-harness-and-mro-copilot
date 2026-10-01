"""Tests for src/calibration.py (phase-01 requirement #3)."""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402
import pytest  # noqa: E402
from scipy.stats import spearmanr  # noqa: E402

from data.generate_dataset import generate  # noqa: E402
from src import calibration  # noqa: E402
from src.features import build_model_table  # noqa: E402
from src.modeling import ALL_FEATURES, build_models, fit_model, predict_scores  # noqa: E402
from src.splitting import time_group_split  # noqa: E402


@pytest.fixture(scope="module")
def fitted_hgb_and_splits():
    aircraft, components, snapshots, faults, maint = generate(seed=42, n_aircraft=150, profile="realistic")
    table = build_model_table(aircraft, components, snapshots, faults, maint)
    train_df, val_df, test_df, _ = time_group_split(table)
    pipeline = fit_model(build_models(seed=42)["hist_gradient_boosting"], train_df)
    return pipeline, train_df, val_df, test_df


def test_split_val_cal_thr_is_group_disjoint_and_covers_val(fitted_hgb_and_splits):
    _, _, val_df, _ = fitted_hgb_and_splits
    val_cal, val_thr = calibration.split_val_cal_thr(val_df, seed=1)
    assert set(val_cal["aircraft_id"]).isdisjoint(set(val_thr["aircraft_id"]))
    assert len(val_cal) + len(val_thr) == len(val_df)
    assert len(val_cal) > 0 and len(val_thr) > 0


def test_calibrated_probabilities_are_in_unit_interval_and_brier_improves(fitted_hgb_and_splits):
    pipeline, _, val_df, _test_df = fitted_hgb_and_splits
    val_cal, val_thr = calibration.split_val_cal_thr(val_df, seed=1)

    raw_scores = predict_scores(pipeline, val_thr)
    calibrated_model, meta = calibration.fit_calibrated_model(pipeline, val_cal, ALL_FEATURES)
    cal_scores = calibration.predict_calibrated_scores(calibrated_model, val_thr, ALL_FEATURES)

    assert np.all(cal_scores >= 0.0) and np.all(cal_scores <= 1.0)
    assert meta["method"] in {"isotonic", "sigmoid"}

    report = calibration.calibration_report(val_thr["label"].to_numpy(), raw_scores, cal_scores)
    # Small tolerance: isotonic on a small val_cal can occasionally tie/edge
    # over pre-calibration Brier by a hair; the fix must not make it *worse*
    # by a material margin.
    assert report["brier_post"] <= report["brier_pre"] + 0.01


def test_calibration_preserves_rank_order(fitted_hgb_and_splits):
    pipeline, _, val_df, _test_df = fitted_hgb_and_splits
    val_cal, val_thr = calibration.split_val_cal_thr(val_df, seed=1)

    raw_scores = predict_scores(pipeline, val_thr)
    calibrated_model, _ = calibration.fit_calibrated_model(pipeline, val_cal, ALL_FEATURES)
    cal_scores = calibration.predict_calibrated_scores(calibrated_model, val_thr, ALL_FEATURES)

    rho, _ = spearmanr(raw_scores, cal_scores)
    assert rho > 0.98, f"calibration should be (near-)monotone, got Spearman rho={rho:.4f}"


def test_expected_calibration_error_is_zero_for_a_perfectly_calibrated_score():
    rng = np.random.default_rng(0)
    y_score = rng.uniform(0, 1, size=5000)
    y_true = (rng.random(5000) < y_score).astype(int)
    ece = calibration.expected_calibration_error(y_true, y_score, n_bins=10)
    assert ece < 0.05


def test_falls_back_to_sigmoid_when_val_cal_has_few_positives(fitted_hgb_and_splits):
    pipeline, _, val_df, _test_df = fitted_hgb_and_splits
    val_cal, _ = calibration.split_val_cal_thr(val_df, seed=1)
    negatives = val_cal[val_cal["label"] == 0]
    positives = val_cal[val_cal["label"] == 1].head(2)  # keep the fit valid (2 classes), still < MIN_POSITIVES_FOR_ISOTONIC
    assert len(positives) > 0, "fixture split has no positives to sample from -- adjust seed"
    starved = pd.concat([negatives, positives], ignore_index=True)
    _, meta = calibration.fit_calibrated_model(pipeline, starved, ALL_FEATURES)
    assert meta["method"] == "sigmoid"
    assert meta["fallback_to_sigmoid"] is True
