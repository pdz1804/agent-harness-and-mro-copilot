"""Dataset generation must be deterministic given a fixed seed."""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pandas as pd  # noqa: E402

from data.generate_dataset import generate  # noqa: E402


def test_generation_is_deterministic_for_fixed_seed():
    aircraft_a, components_a, snapshots_a, faults_a, maint_a = generate(seed=7, n_aircraft=20)
    aircraft_b, components_b, snapshots_b, faults_b, maint_b = generate(seed=7, n_aircraft=20)

    pd.testing.assert_frame_equal(aircraft_a, aircraft_b)
    pd.testing.assert_frame_equal(components_a, components_b)
    pd.testing.assert_frame_equal(snapshots_a, snapshots_b)
    pd.testing.assert_frame_equal(faults_a, faults_b)
    pd.testing.assert_frame_equal(maint_a, maint_b)


def test_different_seeds_produce_different_data():
    _, _, snapshots_a, _, _ = generate(seed=1, n_aircraft=20)
    _, _, snapshots_b, _, _ = generate(seed=2, n_aircraft=20)
    assert not snapshots_a["label"].equals(snapshots_b["label"])


def test_positive_rate_is_in_severe_imbalance_range():
    _, _, snapshots, _, _ = generate(seed=42, n_aircraft=120)
    positive_rate = snapshots["label"].mean()
    # "~2%" per the original brief; allow a documented band rather than
    # pinning an exact number that a parameter tweak would break.
    assert 0.005 <= positive_rate <= 0.08, f"positive rate {positive_rate:.4f} outside expected band"


def test_snapshot_scores_have_no_nan_labels_and_valid_cycles():
    _, _, snapshots, _, _ = generate(seed=42, n_aircraft=20)
    assert snapshots["label"].isin([0, 1]).all()
    assert (snapshots["cycle"] > 0).all()
    assert snapshots["component_id"].notna().all()


def test_components_removal_type_values_are_valid():
    _, components, _, _, _ = generate(seed=42, n_aircraft=20)
    assert set(components["removal_type"].unique()) <= {"unscheduled", "scheduled", "none"}
