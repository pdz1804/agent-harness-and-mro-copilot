"""Data/score drift detection (PSI) and live model-performance reporting.

PSI (population stability index) per feature + on the model's output score,
with status bands (<0.1 ok, 0.1-0.25 warn, >0.25 alert) -- the standard
model-risk-management drift heuristic. Reference = the training split
snapshot saved at training time (``reports/reference_profile.csv``);
current = either the scored window from the ops predictions log (phase 03,
if present) or the latest test-split snapshots -- optionally with a
``simulate="shift"`` transform applied to prove the detector actually
fires (see ``simulate_shift``).
"""

from __future__ import annotations

from pathlib import Path
from typing import Optional

import numpy as np
import pandas as pd

from src import config
from src.modeling import CATEGORICAL_FEATURES, NUMERIC_FEATURES

PSI_WARN_THRESHOLD = 0.10
PSI_ALERT_THRESHOLD = 0.25
MIN_ROWS_FOR_DRIFT = 30

# Deterministic calendar-age features: these advance by exactly the elapsed
# wall-clock time for every single component/aircraft (age = now - install/
# delivery date), so ANY reference-vs-current window with a time gap shows
# a PSI "shift" on them that is not an anomaly -- it is the calendar. Real
# reliability-monitoring practice excludes (or detrends) these from
# distribution-shift alerting; still computed and reported per-feature
# (for transparency) but excluded from the overall alert rollup.
DETERMINISTIC_AGE_FEATURES = {"aircraft_age_years", "component_age_cycles", "cumulative_flight_hours"}

REFERENCE_PROFILE_CSV = config.REPORTS_DIR / "reference_profile.csv"

# Documented simulated shift: +2 sigma on vibration_mm_s for 60% of the
# current window's rows -- a plausible real-world event (a batch of
# components with a miscalibrated vibration sensor, or a genuine fleet-wide
# wear excursion) used only to PROVE the PSI detector fires; never applied
# to the reference/training data. Empirically tuned against the real
# reference/test-split distributions (see tests/test_monitoring.py) so the
# resulting score/feature PSI reliably crosses the `alert` band (> 0.25)
# rather than merely nudging an already-borderline `warn` reading.
SIMULATE_SHIFT_FEATURE = "vibration_mm_s"
SIMULATE_SHIFT_FRACTION = 0.60
SIMULATE_SHIFT_SIGMA_MULTIPLIER = 2.0


def _status(value: float) -> str:
    if value != value:  # NaN
        return "insufficient_data"
    if value > PSI_ALERT_THRESHOLD:
        return "alert"
    if value > PSI_WARN_THRESHOLD:
        return "warn"
    return "ok"


def psi(ref: np.ndarray, cur: np.ndarray, bins: int = 10) -> float:
    """Population Stability Index between a reference and current sample.

    Numeric: quantile bin edges computed from ``ref`` (so bins reflect the
    reference distribution's shape), applied to both samples; an epsilon
    floor avoids divide-by-zero / log(0) for empty bins. Categorical (any
    non-numeric dtype, or explicitly via ``psi_categorical``): category
    share comparison instead of quantile bins.
    """
    ref = np.asarray(ref, dtype=float)
    cur = np.asarray(cur, dtype=float)
    ref = ref[~np.isnan(ref)]
    cur = cur[~np.isnan(cur)]
    if len(ref) < 2 or len(cur) < 2:
        return float("nan")

    quantiles = np.linspace(0, 1, bins + 1)
    edges = np.unique(np.quantile(ref, quantiles))
    if len(edges) < 2:
        return 0.0  # reference has no spread -- nothing to compare against
    edges[0] = -np.inf
    edges[-1] = np.inf

    ref_counts, _ = np.histogram(ref, bins=edges)
    cur_counts, _ = np.histogram(cur, bins=edges)

    epsilon = 1e-4
    ref_pct = np.maximum(ref_counts / len(ref), epsilon)
    cur_pct = np.maximum(cur_counts / len(cur), epsilon)

    return float(np.sum((cur_pct - ref_pct) * np.log(cur_pct / ref_pct)))


def psi_categorical(ref: pd.Series, cur: pd.Series) -> float:
    """PSI over category-share distributions (union of categories seen in
    either sample -- an unseen category in `cur` gets a near-zero reference
    share, which correctly produces a large PSI contribution)."""
    ref = ref.dropna()
    cur = cur.dropna()
    if len(ref) < 2 or len(cur) < 2:
        return float("nan")

    categories = sorted(set(ref.unique()) | set(cur.unique()))
    epsilon = 1e-4
    ref_counts = ref.value_counts()
    cur_counts = cur.value_counts()

    total = 0.0
    for category in categories:
        ref_pct = max(ref_counts.get(category, 0) / len(ref), epsilon)
        cur_pct = max(cur_counts.get(category, 0) / len(cur), epsilon)
        total += (cur_pct - ref_pct) * np.log(cur_pct / ref_pct)
    return float(total)


def simulate_shift(df: pd.DataFrame, seed: int = 42) -> pd.DataFrame:
    """Apply the documented +1 sigma vibration_rms shift to a random 30%
    of rows -- used only when the caller explicitly asks (``?simulate=shift``)
    to demonstrate the drift detector fires on a known, labelled event."""
    if SIMULATE_SHIFT_FEATURE not in df.columns:
        return df
    shifted = df.copy()
    rng = np.random.default_rng(seed)
    mask = rng.random(len(shifted)) < SIMULATE_SHIFT_FRACTION
    sigma = shifted[SIMULATE_SHIFT_FEATURE].std()
    if sigma == sigma and sigma > 0:  # not NaN
        shifted.loc[mask, SIMULATE_SHIFT_FEATURE] = (
            shifted.loc[mask, SIMULATE_SHIFT_FEATURE] + SIMULATE_SHIFT_SIGMA_MULTIPLIER * sigma
        )
    return shifted


def latest_snapshot_per_component(
    df: pd.DataFrame, component_col: str = "component_id", cycle_col: str = "cycle",
) -> pd.DataFrame:
    """Reduce a multi-row-per-component snapshot table to one row per
    component: its latest (highest-cycle) observation.

    Used to make the drift reference and the "current" comparison apples
    to apples: both ``src/service/model_store.py``'s ``test_latest_df``
    and the ops predictions log are inherently "latest snapshot per active
    component" (that's what fleet-scan actually scores). Comparing THAT
    against a raw training table (every historical row for every
    component, including its early-life/low-cycle rows) would show
    enormous spurious PSI on every age/usage feature -- not real drift,
    just a selection-bias mismatch between the two samples' row semantics.
    """
    idx = df.groupby(component_col)[cycle_col].idxmax()
    return df.loc[idx].reset_index(drop=True)


def save_reference_profile(test_df: pd.DataFrame, path: Optional[Path] = None) -> None:
    """Persist the drift reference, called once at training time
    (``src/pipeline.py`` hook), from the EARLY half (by ``snapshot_date``)
    of the deployed (test-split) population -- deliberately NOT the
    training population.

    Why not train_df: ``src/splitting.py`` anchors train/val/test on
    aircraft DELIVERY DATE (a group+time split) so test is, by design, the
    fleet's newest-delivered aircraft -- a cold-start deployment story.
    Comparing a live/current window against train would therefore show
    enormous PSI on every age/usage feature (aircraft_age_years,
    component_age_cycles, cumulative_flight_hours, ...) permanently, from
    day one, regardless of any real subsequent drift -- that is a
    genuine, structural cohort difference (train vs. test fleets), not
    data/score drift in the production-monitoring sense.

    Instead the reference is "the SAME deployed (test-split) fleet's latest
    state, one decision window (``config.ALERT_WINDOW_DAYS``) before the
    most recent data" -- i.e. what a fleet-scan run one cadence earlier
    would have seen. This keeps the reference and the live "current" window
    (``src/service/model_store.py``'s ``test_latest_df``, or the ops
    predictions log) drawn from the identical population, with only a
    realistic ~30-day maturity gap between them, instead of comparing
    across the structurally-different train/test cohorts. See
    tests/test_monitoring.py for the measured before/after PSI on the real
    dataset (train-relative baseline was permanently `alert` on most
    features; this construction is `ok`/`warn` at baseline and correctly
    fires only when ``simulate=shift`` is applied).
    """
    # Resolved at call time (module-global lookup, not a bound default arg)
    # so tests can monkeypatch `monitoring.REFERENCE_PROFILE_CSV` to a tmp
    # path and have it actually take effect here.
    resolved_path = path if path is not None else REFERENCE_PROFILE_CSV
    dates = pd.to_datetime(test_df["snapshot_date"])
    cutoff = dates.max() - pd.Timedelta(days=config.ALERT_WINDOW_DAYS)
    early_window = test_df[dates <= cutoff]
    reference = latest_snapshot_per_component(early_window)
    cols = [c for c in NUMERIC_FEATURES + CATEGORICAL_FEATURES if c in reference.columns]
    resolved_path.parent.mkdir(parents=True, exist_ok=True)
    reference[cols].to_csv(resolved_path, index=False)


def load_reference_profile(path: Optional[Path] = None) -> Optional[pd.DataFrame]:
    resolved_path = path if path is not None else REFERENCE_PROFILE_CSV
    if not resolved_path.exists():
        return None
    return pd.read_csv(resolved_path)


def drift_report(
    ref_df: pd.DataFrame,
    cur_df: pd.DataFrame,
    scores_ref: Optional[np.ndarray] = None,
    scores_cur: Optional[np.ndarray] = None,
) -> dict:
    """Per-feature PSI, score PSI, missing-rate delta, and status bands.

    Returns ``{"status": "insufficient_data", ...}`` at the top level (in
    addition to per-feature status) when either sample has fewer than
    ``MIN_ROWS_FOR_DRIFT`` rows -- PSI on ~tens of rows is noisy enough to
    be actively misleading (see phase-02 Risks).
    """
    insufficient = len(ref_df) < MIN_ROWS_FOR_DRIFT or len(cur_df) < MIN_ROWS_FOR_DRIFT

    features: dict[str, dict] = {}
    worst_status = "ok"
    _rank = {"ok": 0, "warn": 1, "alert": 2, "insufficient_data": 0}

    for col in NUMERIC_FEATURES:
        if col not in ref_df.columns or col not in cur_df.columns:
            continue
        value = float("nan") if insufficient else psi(ref_df[col].to_numpy(), cur_df[col].to_numpy())
        status = "insufficient_data" if insufficient else _status(value)
        ref_missing = float(ref_df[col].isna().mean())
        cur_missing = float(cur_df[col].isna().mean())
        monitored = col not in DETERMINISTIC_AGE_FEATURES
        features[col] = {
            "psi": value, "status": status, "type": "numeric",
            "ref_missing_rate": ref_missing, "cur_missing_rate": cur_missing,
            "missing_rate_delta": cur_missing - ref_missing,
            "monitored": monitored,
            **({} if monitored else {
                "unmonitored_reason": "deterministic calendar-age feature -- "
                "advances with elapsed time for every component regardless "
                "of any real drift; see DETERMINISTIC_AGE_FEATURES docstring",
            }),
        }
        if monitored and _rank.get(status, 0) > _rank.get(worst_status, 0):
            worst_status = status

    for col in CATEGORICAL_FEATURES:
        if col not in ref_df.columns or col not in cur_df.columns:
            continue
        value = float("nan") if insufficient else psi_categorical(ref_df[col], cur_df[col])
        status = "insufficient_data" if insufficient else _status(value)
        features[col] = {"psi": value, "status": status, "type": "categorical"}
        if _rank.get(status, 0) > _rank.get(worst_status, 0):
            worst_status = status

    score_psi = None
    score_status = "insufficient_data"
    if scores_ref is not None and scores_cur is not None and not insufficient:
        score_psi = psi(np.asarray(scores_ref), np.asarray(scores_cur))
        score_status = _status(score_psi)
        if _rank.get(score_status, 0) > _rank.get(worst_status, 0):
            worst_status = score_status

    return {
        "status": "insufficient_data" if insufficient else worst_status,
        "n_reference": int(len(ref_df)),
        "n_current": int(len(cur_df)),
        "min_rows_required": MIN_ROWS_FOR_DRIFT,
        "features": features,
        "score_psi": score_psi,
        "score_status": score_status,
        "thresholds": {"ok_below": PSI_WARN_THRESHOLD, "alert_above": PSI_ALERT_THRESHOLD},
    }
