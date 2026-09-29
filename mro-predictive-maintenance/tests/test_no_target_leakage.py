"""Regression tests for the target-leakage bug found via the live scoring UI.

Bug: the generator injected "final inspection" checks in the 30-cycle
label window right before an unscheduled removal, and the maintenance
features counted those checks the same as routine scheduled checks. That
made ``cycles_since_last_check`` / ``check_count_last_1500cyc`` a near-
perfect proxy for the label ("recently inspected" -> "about to fail"),
because the inspection was a *consequence* of the impending removal, not
information legitimately available at prediction time.

Fix (data/generate_dataset.py + src/features.py): symptom-triggered
"final inspection" checks are tagged ``event_type="unscheduled_check"``,
distinct from routine ``event_type="scheduled_check"`` checks on the fixed
maintenance-program grid. src/features.py's maintenance-history features
only count ``scheduled_check`` rows.

These tests would have caught the original bug (they fail against the
pre-fix generator, where every check was tagged "scheduled_check").
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402

from data.generate_dataset import generate  # noqa: E402
from src import config  # noqa: E402
from src.features import build_model_table  # noqa: E402
from src.modeling import ALL_FEATURES, build_models, fit_model, predict_scores  # noqa: E402
from src.splitting import time_group_split  # noqa: E402


def test_no_feature_is_computed_from_events_inside_the_label_window():
    """The symptom-triggered "final inspection" checks the generator injects
    inside a component's 30-cycle label window are tagged
    event_type="unscheduled_check", distinct from routine event_type=
    "scheduled_check" grid checks. src/features.py must (a) never let those
    symptom-triggered events feed a maintenance-history rolling aggregate,
    and (b) never let a snapshot ROW that only exists because it IS one of
    those injected checks report a maintenance-recency value computed off
    its own (label-caused) cycle position -- see src/features.py docstring
    and _rolling_maintenance_features for why both matter."""
    aircraft, components, snapshots, faults, maint = generate(seed=42, n_aircraft=80)

    # The symptom-triggered checks exist (sanity check the fixture is
    # meaningful, not vacuously true) and are tagged distinctly.
    unscheduled_checks = maint[maint["event_type"] == "unscheduled_check"]
    assert len(unscheduled_checks) > 0

    table = build_model_table(aircraft, components, snapshots, faults, maint)
    assert "check_type" not in ALL_FEATURES
    assert "check_type" in config.NON_FEATURE_COLUMNS
    # The audit column is present in the table (for inspection) but never fed
    # to a model: config.NON_FEATURE_COLUMNS / modeling.ALL_FEATURES agree.
    assert "check_type" in table.columns
    assert set(ALL_FEATURES).isdisjoint(config.NON_FEATURE_COLUMNS)

    # Rows that are themselves a symptom-triggered check must not report a
    # cycles_since_last_check value computed off their own label-caused
    # cycle -- they get the fixed, class-independent routine-check default
    # instead (NOT NaN: a NaN-native model could otherwise treat "missing" as
    # its own leaky split direction -- see src/features.py docstring).
    # check_count_last_1500cyc IS computed normally even for these rows (a
    # window count is not sensitive to the ~28-cycle shift the way a
    # subtraction from the row's own cycle is -- see docstring for why a
    # constant here was tried and rejected).
    injected_rows = table[table["check_type"] == "unscheduled_check"]
    assert len(injected_rows) > 0
    assert (injected_rows["cycles_since_last_check"] == config.ROUTINE_CHECK_INTERVAL_CYCLES).all()
    assert injected_rows["check_count_last_1500cyc"].notna().all()

    # No maintenance-recency feature is ever NaN: a NaN-native model
    # (HistGradientBoostingClassifier) would otherwise be free to treat
    # "missing" as its own split direction, which is exactly as leaky as
    # leaving the raw label-caused cycle value in place (see features.py).
    assert table["cycles_since_last_check"].notna().all()
    assert table["check_count_last_1500cyc"].notna().all()

    # Rows that ARE routine scheduled checks must have a real (non-NaN) value,
    # and it must reflect the fixed ~300-cycle grid, not the label.
    routine_rows = table[table["check_type"] == "scheduled_check"]
    assert routine_rows["cycles_since_last_check"].notna().all()
    # label=1 rows landing on a routine grid check (not an injected one) must
    # show the same ~300-cycle recency as label=0 routine rows -- i.e. no
    # residual gap between the classes once symptom-triggered rows are excluded.
    pos_routine = routine_rows[routine_rows["label"] == 1]["cycles_since_last_check"]
    neg_routine = routine_rows[routine_rows["label"] == 0]["cycles_since_last_check"]
    if len(pos_routine) > 0:
        assert abs(pos_routine.mean() - neg_routine.mean()) < 5.0, (
            "cycles_since_last_check still differs materially between positive and "
            "negative routine-check rows -- residual leakage"
        )


def test_cycles_since_last_scheduled_check_never_decreases_risk_monotonically():
    """Sanity/monotonicity check: for a fixed component and fixed other
    features, increasing cycles_since_last_check (time since the last
    *scheduled* check) must not, by itself, strictly decrease the model's
    predicted risk. Before the fix, this was violated dramatically (the
    reported bug: changing cycles_since_last_check from 7 to 400 for
    AC-019-CABIN_PRESS_CTRL moved risk 1.000 -> 0.000), because the model had
    learned "recently inspected -> about to fail" from the leaked feature."""
    aircraft, components, snapshots, faults, maint = generate(seed=42, n_aircraft=120)
    table = build_model_table(aircraft, components, snapshots, faults, maint)
    train_df, val_df, _test_df, _ = time_group_split(table)

    pipeline = fit_model(build_models(seed=42)["logistic_regression"], train_df)

    base_row = train_df[train_df["component_type"] == "CABIN_PRESS_CTRL"].iloc[[0]].copy()
    rows = pd.concat([base_row] * 5, ignore_index=True)
    rows["cycles_since_last_check"] = [7, 50, 150, 250, 400]

    scores = predict_scores(pipeline, rows)

    # Monotonicity is checked on average trend (Spearman-style: sorted by
    # cycles_since_last_check, risk should not be decreasing overall) rather
    # than pointwise, since other correlated features could add small local
    # noise -- but a >0.9 collapse in risk as in the reported bug must not
    # reproduce.
    assert scores[-1] >= scores[0] - 0.05, (
        f"risk collapsed as cycles_since_last_check grew from 7 to 400: "
        f"{scores[0]:.4f} -> {scores[-1]:.4f}; this is the reported leakage symptom"
    )
    assert not np.all(np.diff(scores) < -0.15), (
        "risk score drops sharply and monotonically as cycles_since_last_check "
        "increases -- suggests cycles_since_last_check is still acting as a "
        "leaked proxy for the label"
    )


def test_cycles_since_last_check_does_not_dominate_permutation_importance():
    """Regression guard for the second-order leak found while fixing the
    first: an earlier version of this fix filled injected rows'
    cycles_since_last_check with a NaN, which a NaN-native model
    (HistGradientBoostingClassifier) exploited as its own leaky split
    (permutation importance 0.75). cycles_since_last_check itself must not
    dominate once the fix (constant-fill, see features.py) is applied.

    check_count_last_1500cyc is deliberately NOT asserted here: it is
    computed the normal way (no special-casing for symptom-triggered rows)
    and legitimately correlates with component maturity/age -- components
    deeper into their observed life have accumulated more checks in a
    trailing 1500-cycle window, and the synthetic Weibull hazard (shape>1)
    makes older components genuinely more likely to be near failure. That is
    real signal available at prediction time, not label-window leakage (see
    docs/design-report.md section 7.1)."""
    from sklearn.inspection import permutation_importance

    aircraft, components, snapshots, faults, maint = generate(seed=42, n_aircraft=120)
    table = build_model_table(aircraft, components, snapshots, faults, maint)
    train_df, val_df, _test_df, _ = time_group_split(table)

    pipeline = fit_model(build_models(seed=42)["hist_gradient_boosting"], train_df)
    result = permutation_importance(
        pipeline, val_df[ALL_FEATURES], val_df["label"],
        scoring="average_precision", n_repeats=5, random_state=42,
    )
    importances = dict(zip(ALL_FEATURES, result.importances_mean))
    total = sum(max(v, 0.0) for v in importances.values()) or 1.0
    share = max(importances["cycles_since_last_check"], 0.0) / total
    assert share < 0.5, (
        f"cycles_since_last_check accounts for {share:.0%} of total permutation "
        "importance -- looks like a residual label leak"
    )


def test_maintenance_events_csv_distinguishes_scheduled_from_symptom_triggered():
    _aircraft, _components, _snapshots, _faults, maint = generate(seed=42, n_aircraft=40)
    event_types = set(maint["event_type"].unique())
    assert "scheduled_check" in event_types
    assert "unscheduled_check" in event_types
    assert event_types <= {
        "scheduled_check", "unscheduled_check", "unscheduled_removal", "scheduled_removal",
    }
