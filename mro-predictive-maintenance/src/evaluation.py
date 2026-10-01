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


def select_threshold_max_recall_within_budget(
    sweep_df: pd.DataFrame, alerts_budget: float = config.TARGET_ALERTS_PER_100,
) -> dict:
    """Highest recall subject to alerts_per_100 <= budget; ties broken by
    fewer alerts. Unlike select_operating_threshold's "both_constraints_met"
    branch (which stops as soon as the target recall is cleared), this
    spends the FULL alert budget on recall -- an MRO reliability lead would
    rather use all 5 alerts/100 than stop at the first threshold that
    clears 80%. New default policy (phase-01 requirement #4).
    """
    within_budget = sweep_df[sweep_df["alerts_per_100"] <= alerts_budget]
    if len(within_budget) == 0:
        row = sweep_df.sort_values(["alerts_per_100", "threshold"]).iloc[0]
        status = "no_threshold_within_budget"
    else:
        row = within_budget.sort_values(
            ["recall", "alerts_per_100", "threshold"], ascending=[False, True, True]
        ).iloc[0]
        status = "within_budget"
    result = row.to_dict()
    result["status"] = status
    result["alerts_budget"] = alerts_budget
    result["policy"] = "max_recall_within_budget"
    return result


def select_threshold_min_expected_cost(
    sweep_df: pd.DataFrame,
    cost_missed_removal: float = config.COST_MISSED_REMOVAL,
    cost_false_alert: float = config.COST_FALSE_ALERT,
    alerts_budget: float = config.TARGET_ALERTS_PER_100,
) -> dict:
    """Threshold minimizing tp/fp/fn's expected cost (illustrative unit
    costs -- see src/config.py), subject to the same alert-rate budget cap
    (an ops team cannot inspect unlimited components regardless of what the
    cost model prefers).
    """
    within_budget = sweep_df[sweep_df["alerts_per_100"] <= alerts_budget]
    candidates = within_budget if len(within_budget) > 0 else sweep_df
    expected_cost = (
        candidates["fn"] * cost_missed_removal + candidates["fp"] * cost_false_alert
    )
    best_idx = expected_cost.idxmin()
    row = candidates.loc[best_idx].to_dict()
    row["expected_cost"] = float(expected_cost.loc[best_idx])
    row["status"] = "within_budget" if len(within_budget) > 0 else "no_threshold_within_budget"
    row["alerts_budget"] = alerts_budget
    row["cost_missed_removal"] = cost_missed_removal
    row["cost_false_alert"] = cost_false_alert
    row["policy"] = "min_expected_cost"
    return row


def alerts_per_100_components(
    df: pd.DataFrame, scores: np.ndarray, threshold: float,
    window_days: int = config.ALERT_WINDOW_DAYS,
    date_col: str = "snapshot_date", component_col: str = "component_id",
) -> dict:
    """Decision-window alert rate: per window_days-wide window, take each
    active component's LATEST snapshot inside that window and count what
    fraction alert -- rather than the row-based rate (every historical
    snapshot row counted equally, conflating check cadence with alert load;
    see reports/research-and-gap-analysis.md W4). Reports both the
    component-window rate (the one held against config.TARGET_ALERTS_PER_100)
    and the legacy row-based rate for comparison.
    """
    work = df[[date_col, component_col]].copy()
    work["snapshot_date"] = pd.to_datetime(work[date_col])
    work["score"] = np.asarray(scores)
    work["alert"] = work["score"] >= threshold

    if len(work) == 0:
        return {
            "component_window_alerts_per_100": 0.0, "n_windows": 0,
            "row_based_alerts_per_100": 0.0, "window_days": window_days,
        }

    start = work["snapshot_date"].min()
    work["window_idx"] = ((work["snapshot_date"] - start).dt.days // window_days).astype(int)

    per_window_rates = []
    for _window_idx, window_group in work.groupby("window_idx"):
        latest = window_group.sort_values("snapshot_date").groupby(component_col).tail(1)
        if len(latest) == 0:
            continue
        per_window_rates.append(100.0 * latest["alert"].sum() / len(latest))

    component_window_rate = float(np.mean(per_window_rates)) if per_window_rates else 0.0
    row_based_rate = 100.0 * work["alert"].sum() / len(work)

    return {
        "component_window_alerts_per_100": component_window_rate,
        "n_windows": len(per_window_rates),
        "row_based_alerts_per_100": float(row_based_rate),
        "window_days": window_days,
    }


def bootstrap_ci(
    df: pd.DataFrame, y_true: np.ndarray, y_score: np.ndarray, threshold: float,
    n_boot: int = 1000, group_col: str = "aircraft_id", seed: int = 42,
    ci: float = 0.95,
) -> dict:
    """Group (aircraft) bootstrap 95% percentile CI for recall/precision/
    alerts-per-100 -- resamples whole aircraft (with replacement), not rows,
    to respect the same group structure src/splitting.py protects (rows
    within one aircraft are correlated, so row-level bootstrap would
    understate the true uncertainty). Deterministic given `seed`.
    """
    rng = np.random.default_rng(seed)
    groups = df[group_col].to_numpy()
    unique_groups = np.unique(groups)
    y_true = np.asarray(y_true)
    y_score = np.asarray(y_score)

    group_row_idx = {g: np.where(groups == g)[0] for g in unique_groups}

    recalls, precisions, alert_rates = [], [], []
    for _ in range(n_boot):
        sampled_groups = rng.choice(unique_groups, size=len(unique_groups), replace=True)
        idx = np.concatenate([group_row_idx[g] for g in sampled_groups])
        yt = y_true[idx]
        ys = y_score[idx]
        pred = (ys >= threshold).astype(int)
        tp = int(((pred == 1) & (yt == 1)).sum())
        fp = int(((pred == 1) & (yt == 0)).sum())
        fn = int(((pred == 0) & (yt == 1)).sum())
        n_alerts = tp + fp
        recalls.append(tp / (tp + fn) if (tp + fn) > 0 else np.nan)
        precisions.append(tp / n_alerts if n_alerts > 0 else np.nan)
        alert_rates.append(100.0 * n_alerts / len(idx) if len(idx) > 0 else np.nan)

    alpha = (1.0 - ci) / 2.0

    def _pct_ci(values: list[float]) -> list[float]:
        arr = np.asarray(values, dtype=float)
        arr = arr[~np.isnan(arr)]
        if len(arr) == 0:
            return [float("nan"), float("nan")]
        return [float(np.quantile(arr, alpha)), float(np.quantile(arr, 1.0 - alpha))]

    return {
        "n_boot": n_boot,
        "confidence_level": ci,
        "recall_ci": _pct_ci(recalls),
        "precision_ci": _pct_ci(precisions),
        "alerts_per_100_ci": _pct_ci(alert_rates),
    }


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
