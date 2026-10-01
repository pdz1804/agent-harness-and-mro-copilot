"""Probability calibration + calibration-quality metrics.

Why: the take-home spec asks for "a risk score (probability)". Humans (and
later, the copilot) read that number as "this component has an X% chance of
an unscheduled removal" -- an uncalibrated tree-ensemble score is a good
*ranking* but a poor *probability* (HistGradientBoostingClassifier scores are
not guaranteed calibrated). This module fits isotonic calibration on a
held-out slice and reports Brier score + Expected Calibration Error (ECE) so
the calibration claim is falsifiable, not just asserted.

Split discipline (phase-01 requirement): calibrating AND selecting the
serving threshold on the SAME validation rows would be optimistically biased
(the threshold would implicitly be tuned to the calibration fit's quirks).
So the validation split is itself split in two, by aircraft (never by row --
would leak): ``val_cal`` fits the calibrator, ``val_thr`` is used
downstream by src/evaluation.py's threshold selection. See src/pipeline.py.
"""

from __future__ import annotations

import numpy as np
import pandas as pd
from sklearn.metrics import brier_score_loss

try:  # sklearn >= 1.6
    from sklearn.frozen import FrozenEstimator
    _HAS_FROZEN_ESTIMATOR = True
except ImportError:  # pragma: no cover -- exercised only on older sklearn
    _HAS_FROZEN_ESTIMATOR = False

from sklearn.calibration import CalibratedClassifierCV

MIN_POSITIVES_FOR_ISOTONIC = 50  # isotonic overfits with too few positives; see phase file risk


def split_val_cal_thr(val_df: pd.DataFrame, group_col: str = "aircraft_id", seed: int = 42):
    """50/50 aircraft-level split of the validation set into val_cal/val_thr.

    Group-level (not row-level) to avoid leaking a component's rows across
    the calibration/threshold boundary -- the same leakage class
    src/splitting.py already guards against for train/val/test.
    """
    groups = val_df[group_col].unique()
    rng = np.random.default_rng(seed)
    shuffled = rng.permutation(groups)
    half = len(shuffled) // 2
    cal_groups = set(shuffled[:half])
    val_cal = val_df[val_df[group_col].isin(cal_groups)].reset_index(drop=True)
    val_thr = val_df[~val_df[group_col].isin(cal_groups)].reset_index(drop=True)
    return val_cal, val_thr


def fit_calibrated_model(fitted_pipeline, val_cal_df: pd.DataFrame, feature_cols: list[str]):
    """Wrap an already-fitted pipeline with isotonic calibration on val_cal.

    Falls back to sigmoid (Platt) calibration -- which has far fewer
    parameters and does not overfit with a small positive count -- if
    val_cal has fewer than MIN_POSITIVES_FOR_ISOTONIC positives (documented
    risk in the phase file). Both the method actually used and the reason
    are returned so the caller can put it in the model card.
    """
    x_cal = val_cal_df[feature_cols]
    y_cal = val_cal_df["label"].to_numpy()
    n_positive = int(y_cal.sum())
    method = "isotonic" if n_positive >= MIN_POSITIVES_FOR_ISOTONIC else "sigmoid"

    if _HAS_FROZEN_ESTIMATOR:
        base = FrozenEstimator(fitted_pipeline)
        calibrated = CalibratedClassifierCV(base, method=method)
        calibrated.fit(x_cal, y_cal)
    else:  # pragma: no cover -- exercised only on older sklearn
        calibrated = CalibratedClassifierCV(fitted_pipeline, method=method, cv="prefit")
        calibrated.fit(x_cal, y_cal)

    return calibrated, {
        "method": method,
        "n_val_cal_rows": int(len(val_cal_df)),
        "n_val_cal_positive": n_positive,
        "fallback_to_sigmoid": method == "sigmoid",
    }


def predict_calibrated_scores(calibrated_model, df: pd.DataFrame, feature_cols: list[str]) -> np.ndarray:
    return calibrated_model.predict_proba(df[feature_cols])[:, 1]


def expected_calibration_error(y_true: np.ndarray, y_score: np.ndarray, n_bins: int = 10) -> float:
    """Standard equal-width-bin ECE: sum_b (n_b/n) * |acc_b - conf_b|."""
    y_true = np.asarray(y_true, dtype=float)
    y_score = np.asarray(y_score, dtype=float)
    bin_edges = np.linspace(0.0, 1.0, n_bins + 1)
    n = len(y_true)
    ece = 0.0
    for lo, hi in zip(bin_edges[:-1], bin_edges[1:]):
        in_bin = (y_score >= lo) & (y_score < hi) if hi < 1.0 else (y_score >= lo) & (y_score <= hi)
        n_bin = int(in_bin.sum())
        if n_bin == 0:
            continue
        acc = y_true[in_bin].mean()
        conf = y_score[in_bin].mean()
        ece += (n_bin / n) * abs(acc - conf)
    return float(ece)


def reliability_curve_points(y_true: np.ndarray, y_score: np.ndarray, n_bins: int = 10) -> list[dict]:
    """Per-bin (mean predicted probability, observed frequency, count) for a
    reliability diagram -- used by both pre- and post-calibration scores so
    the dashboard can plot both curves against the y=x diagonal.
    """
    y_true = np.asarray(y_true, dtype=float)
    y_score = np.asarray(y_score, dtype=float)
    bin_edges = np.linspace(0.0, 1.0, n_bins + 1)
    points = []
    for lo, hi in zip(bin_edges[:-1], bin_edges[1:]):
        in_bin = (y_score >= lo) & (y_score < hi) if hi < 1.0 else (y_score >= lo) & (y_score <= hi)
        n_bin = int(in_bin.sum())
        if n_bin == 0:
            continue
        points.append({
            "bin_lo": round(float(lo), 3),
            "bin_hi": round(float(hi), 3),
            "mean_predicted": float(y_score[in_bin].mean()),
            "observed_frequency": float(y_true[in_bin].mean()),
            "n": n_bin,
        })
    return points


def calibration_report(y_true: np.ndarray, score_pre: np.ndarray, score_post: np.ndarray) -> dict:
    return {
        "brier_pre": float(brier_score_loss(y_true, score_pre)),
        "brier_post": float(brier_score_loss(y_true, score_post)),
        "ece_pre": expected_calibration_error(y_true, score_pre),
        "ece_post": expected_calibration_error(y_true, score_post),
        "reliability_curve_pre": reliability_curve_points(y_true, score_pre),
        "reliability_curve_post": reliability_curve_points(y_true, score_post),
    }
