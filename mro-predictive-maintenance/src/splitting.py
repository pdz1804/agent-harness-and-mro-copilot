"""Leakage-safe train/validation/test split.

Two leakage modes matter for this panel (repeated snapshots per
component over time), and this module defends against both:

1. Group leakage -- the same component (or, more conservatively, the
   same aircraft) appearing in both train and test. A model could
   otherwise memorize a specific component's sensor fingerprint from
   training rows and "recognize" it at test time, inflating scores
   without learning anything generalizable. Fix: every row belonging
   to a given ``aircraft_id`` is assigned to exactly one split (this
   also keeps sibling components of the same aircraft -- which share
   utilization intensity, region, aircraft type -- together, a
   stricter boundary than splitting by ``component_id`` alone; see
   the take-home spec, which explicitly allows either).

2. Time leakage -- training on aircraft that entered service (and so
   started accumulating cycles/history) LATER than the aircraft used
   for validation/testing. Fix: each aircraft is anchored by its
   ``delivery_date``. Aircraft are sorted by delivery date ascending
   and sliced into train (earliest-delivered 60%) / val (next 20%) /
   test (latest-delivered 20%). This guarantees every train aircraft
   was delivered no later than every val aircraft, which was
   delivered no later than every test aircraft -- a strict, testable,
   group-level chronological ordering, and a realistic deployment
   story: "trained on the existing fleet, deployed on newer aircraft
   entering service" (this also doubles as the cold-start scenario
   discussed in docs/design-report.md).

Why anchor on DELIVERY date rather than each component's LAST observed
date (the first design tried here): censoring correlates with recency
in this dataset -- a component that survives to the end of the study
window necessarily has its last observation right at the study end
date, while a component that was removed (scheduled OR unscheduled)
necessarily has its last observation strictly earlier. Anchoring the
split on "last observed date" therefore pushed almost every removal
(the entire positive class) into the earliest-finishing bucket
(train) and left validation/test starved of positives -- train ended
up with the overwhelming majority of the ~2% positives while test had
only a handful, an artifact of the split rule, not of the underlying
problem. Anchoring on delivery date instead is independent of whether
a component ever fails (failure timing is generated independently of
delivery cohort), so positives land proportionally across all three
splits. See docs/design-report.md, "Splitting rationale", for the
before/after numbers.
"""

from __future__ import annotations

import pandas as pd


def time_group_split(
    table: pd.DataFrame,
    train_frac: float = 0.6,
    val_frac: float = 0.2,
    anchor_date_col: str = "delivery_date",
    group_col: str = "aircraft_id",
):
    if not 0 < train_frac < 1 or not 0 < val_frac < 1 or train_frac + val_frac >= 1:
        raise ValueError("train_frac and val_frac must be in (0,1) and sum to < 1")

    table = table.copy()
    table[anchor_date_col] = pd.to_datetime(table[anchor_date_col])

    anchor = table.groupby(group_col)[anchor_date_col].first().sort_values()
    n = len(anchor)
    n_train = int(n * train_frac)
    n_val = int(n * val_frac)

    train_groups = anchor.index[:n_train]
    val_groups = anchor.index[n_train:n_train + n_val]
    test_groups = anchor.index[n_train + n_val:]

    train_df = table[table[group_col].isin(train_groups)].reset_index(drop=True)
    val_df = table[table[group_col].isin(val_groups)].reset_index(drop=True)
    test_df = table[table[group_col].isin(test_groups)].reset_index(drop=True)

    boundaries = {
        "train_delivery_max": anchor.loc[train_groups].max(),
        "val_delivery_min": anchor.loc[val_groups].min(),
        "val_delivery_max": anchor.loc[val_groups].max(),
        "test_delivery_min": anchor.loc[test_groups].min(),
        "n_train_groups": len(train_groups),
        "n_val_groups": len(val_groups),
        "n_test_groups": len(test_groups),
    }
    return train_df, val_df, test_df, boundaries


def assert_no_leakage(
    train_df: pd.DataFrame,
    val_df: pd.DataFrame,
    test_df: pd.DataFrame,
    group_col: str = "aircraft_id",
    component_col: str = "component_id",
    anchor_date_col: str = "delivery_date",
) -> None:
    """Raise AssertionError if group purity or chronological ordering is violated.

    Used by tests/test_splitting_leakage.py and safe to call from the
    training pipeline itself as a runtime guard.
    """
    for id_col in (group_col, component_col):
        train_ids = set(train_df[id_col])
        val_ids = set(val_df[id_col])
        test_ids = set(test_df[id_col])
        assert train_ids.isdisjoint(val_ids), f"{id_col} overlap between train and val"
        assert train_ids.isdisjoint(test_ids), f"{id_col} overlap between train and test"
        assert val_ids.isdisjoint(test_ids), f"{id_col} overlap between val and test"

    train_max = pd.to_datetime(train_df[anchor_date_col]).max()
    val_min = pd.to_datetime(val_df[anchor_date_col]).min()
    val_max = pd.to_datetime(val_df[anchor_date_col]).max()
    test_min = pd.to_datetime(test_df[anchor_date_col]).min()

    assert train_max <= val_min, (
        f"time leakage: latest train {anchor_date_col} ({train_max}) is after the "
        f"earliest val {anchor_date_col} ({val_min})"
    )
    assert val_max <= test_min, (
        f"time leakage: latest val {anchor_date_col} ({val_max}) is after the "
        f"earliest test {anchor_date_col} ({test_min})"
    )
