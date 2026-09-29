"""Metrics, threshold sweep, and operating-point selection.

Operating point: the take-home asks for recall >= 0.80 (catch at least
80% of real unscheduled removals) while alerting on no more than 5 per
100 active components (an "alert" = a predicted-positive row). The
threshold is chosen on the VALIDATION split (never on test, to avoid
tuning to the evaluation set) and then simply applied to test, whose
resulting recall/alert-rate is reported honestly -- including if the
two constraints cannot be hit simultaneously.
"""

from __future__ import annotations

import numpy as np
import pandas as pd
from sklearn.metrics import average_precision_score, precision_recall_curve, roc_auc_score

from . import config


def summary_metrics(y_true: np.ndarray, y_score: np.ndarray) -> dict:
    return {
        "n_rows": int(len(y_true)),
        "n_positive": int(y_true.sum()),
        "roc_auc": float(roc_auc_score(y_true, y_score)) if len(np.unique(y_true)) > 1 else float("nan"),
        "pr_auc": float(average_precision_score(y_true, y_score)) if len(np.unique(y_true)) > 1 else float("nan"),
    }


def threshold_sweep(y_true: np.ndarray, y_score: np.ndarray, n_thresholds: int = 199) -> pd.DataFrame:
    thresholds = np.linspace(0.01, 0.99, n_thresholds)
    n = len(y_true)
    rows = []
    for t in thresholds:
        pred = (y_score >= t).astype(int)
        tp = int(((pred == 1) & (y_true == 1)).sum())
        fp = int(((pred == 1) & (y_true == 0)).sum())
        fn = int(((pred == 0) & (y_true == 1)).sum())
        n_alerts = tp + fp
        recall = tp / (tp + fn) if (tp + fn) > 0 else 0.0
        precision = tp / n_alerts if n_alerts > 0 else 0.0
        alerts_per_100 = 100.0 * n_alerts / n
        rows.append({
            "threshold": round(float(t), 4),
            "recall": recall,
            "precision": precision,
            "alerts_per_100": alerts_per_100,
            "n_alerts": n_alerts,
            "tp": tp, "fp": fp, "fn": fn,
        })
    return pd.DataFrame(rows)


def select_operating_threshold(
    sweep_df: pd.DataFrame,
    target_recall: float = config.TARGET_RECALL,
    target_alerts_per_100: float = config.TARGET_ALERTS_PER_100,
) -> dict:
    """Pick the threshold nearest the (recall>=target, alert_rate<=target) constraint.

    Preference order:
      1. Among thresholds satisfying BOTH constraints, take the one with the
         lowest alert rate (fewest false alarms for the required recall).
      2. If no threshold satisfies both, take the one maximizing recall
         among those satisfying the alert-rate cap (best effort on the
         harder-to-hit constraint), and report the shortfall honestly.
      3. If nothing satisfies the alert-rate cap either, fall back to the
         threshold with the highest recall*... simply report the
         highest-recall row overall and flag both constraints as unmet.
    """
    both_ok = sweep_df[
        (sweep_df["recall"] >= target_recall) & (sweep_df["alerts_per_100"] <= target_alerts_per_100)
    ]
    if len(both_ok) > 0:
        row = both_ok.sort_values(["alerts_per_100", "threshold"]).iloc[0]
        status = "both_constraints_met"
    else:
        alert_ok = sweep_df[sweep_df["alerts_per_100"] <= target_alerts_per_100]
        if len(alert_ok) > 0:
            row = alert_ok.sort_values(["recall", "threshold"], ascending=[False, True]).iloc[0]
            status = "alert_rate_met_recall_shortfall"
        else:
            row = sweep_df.sort_values(["recall", "threshold"], ascending=[False, True]).iloc[0]
            status = "neither_constraint_met"

    result = row.to_dict()
    result["status"] = status
    result["target_recall"] = target_recall
    result["target_alerts_per_100"] = target_alerts_per_100
    return result


def apply_threshold(y_true: np.ndarray, y_score: np.ndarray, threshold: float) -> dict:
    pred = (y_score >= threshold).astype(int)
    tp = int(((pred == 1) & (y_true == 1)).sum())
    fp = int(((pred == 1) & (y_true == 0)).sum())
    fn = int(((pred == 0) & (y_true == 1)).sum())
    tn = int(((pred == 0) & (y_true == 0)).sum())
    n_alerts = tp + fp
    n = len(y_true)
    return {
        "threshold": threshold,
        "tp": tp, "fp": fp, "fn": fn, "tn": tn,
        "recall": tp / (tp + fn) if (tp + fn) > 0 else 0.0,
        "precision": tp / n_alerts if n_alerts > 0 else 0.0,
        "alerts_per_100": 100.0 * n_alerts / n,
        "n_alerts": n_alerts,
        "n_rows": n,
    }
