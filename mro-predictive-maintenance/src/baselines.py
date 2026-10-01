"""Naive, non-ML operating-point baselines.

A senior review of any ML take-home asks "would a simple rule already used
by reliability programs today get you most of the way there?" These two
baselines are the rules an MRO reliability engineer could compute today
without a model, and are put through the exact same threshold-selection /
evaluation code path (src/evaluation.py) as the trained models so the
comparison table (reports/metrics_table.md) is apples-to-apples.

Both baselines only use columns already present in the model table (no
model fitting, no leakage risk beyond what src/features.py already guards).
"""

from __future__ import annotations

import numpy as np
import pandas as pd

# component_type -> Weibull scale (cycles), duplicated (not imported) from
# data/generate_dataset.py on purpose: the age-rule baseline models what a
# reliability engineer would use in practice -- a *published* MTBUR/mean-life
# figure per part number, not a peek at the generator's internal RNG
# parameters. Using the same numbers here is a modeling choice (the take-home
# has no independent real-world source), not a data leak: this baseline uses
# only `component_type` and `component_age_cycles`, both legitimately
# available at prediction time.
COMPONENT_TYPE_SCALE_CYCLES = {
    "HYD_PUMP": 7000,
    "APU_STARTER": 8500,
    "LG_ACTUATOR": 6500,
    "BLEED_VALVE": 6000,
    "AVIONICS_FAN": 9000,
    "CABIN_PRESS_CTRL": 7500,
}
DEFAULT_SCALE_CYCLES = 7500  # fallback for an unseen component_type


def age_rule_score(df: pd.DataFrame) -> np.ndarray:
    """score = component_age_cycles / published_scale_for_type, clipped to [0, 1].

    Purely a "how far through its expected life is this part" ratio -- no
    sensor, fault, or maintenance-history information at all.
    """
    scales = df["component_type"].map(COMPONENT_TYPE_SCALE_CYCLES).fillna(DEFAULT_SCALE_CYCLES)
    score = df["component_age_cycles"].to_numpy() / scales.to_numpy()
    return np.clip(score, 0.0, 1.0)


def fault_count_rule_score(
    df: pd.DataFrame, fault_weight: float = 0.15, severity_weight: float = 0.25,
) -> np.ndarray:
    """score = normalized(fault_count_last_500cyc + severity_weight * max_severity_last_500cyc).

    Models a simple "how many/how bad are the recent squawks" triage rule,
    normalized into [0, 1] by a fixed, documented denominator (not fit on
    data) so it is a genuine zero-training-data baseline.
    """
    raw = (
        fault_weight * df["fault_count_last_500cyc"].fillna(0).to_numpy()
        + severity_weight * df["max_severity_last_500cyc"].fillna(0).to_numpy()
    )
    # Denominator chosen so a "busy" component (5 faults, max severity 3 in
    # the trailing 500 cycles) lands near the top of the [0, 1] range;
    # documented constant, not fit on this dataset's distribution.
    denom = fault_weight * 5 + severity_weight * 3
    return np.clip(raw / denom, 0.0, 1.0)


BASELINE_SCORERS = {
    "baseline_age_rule": age_rule_score,
    "baseline_fault_count_rule": fault_count_rule_score,
}
