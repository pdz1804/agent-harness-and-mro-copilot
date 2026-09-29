"""Group + time leakage guarantees for src/splitting.py."""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pandas as pd  # noqa: E402
import pytest  # noqa: E402

from data.generate_dataset import generate  # noqa: E402
from src.features import build_model_table  # noqa: E402
from src.splitting import assert_no_leakage, time_group_split  # noqa: E402


@pytest.fixture(scope="module")
def model_table():
    aircraft, components, snapshots, faults, maint = generate(seed=42, n_aircraft=60)
    return build_model_table(aircraft, components, snapshots, faults, maint)


def test_no_aircraft_or_component_overlap_across_splits(model_table):
    train_df, val_df, test_df, _ = time_group_split(model_table)

    assert set(train_df["aircraft_id"]).isdisjoint(set(val_df["aircraft_id"]))
    assert set(train_df["aircraft_id"]).isdisjoint(set(test_df["aircraft_id"]))
    assert set(val_df["aircraft_id"]).isdisjoint(set(test_df["aircraft_id"]))

    assert set(train_df["component_id"]).isdisjoint(set(val_df["component_id"]))
    assert set(train_df["component_id"]).isdisjoint(set(test_df["component_id"]))
    assert set(val_df["component_id"]).isdisjoint(set(test_df["component_id"]))


def test_delivery_dates_are_chronologically_ordered_across_splits(model_table):
    train_df, val_df, test_df, _ = time_group_split(model_table)

    train_max = pd.to_datetime(train_df["delivery_date"]).max()
    val_min = pd.to_datetime(val_df["delivery_date"]).min()
    val_max = pd.to_datetime(val_df["delivery_date"]).max()
    test_min = pd.to_datetime(test_df["delivery_date"]).min()

    assert train_max <= val_min
    assert val_max <= test_min


def test_assert_no_leakage_passes_on_a_real_split(model_table):
    train_df, val_df, test_df, _ = time_group_split(model_table)
    assert_no_leakage(train_df, val_df, test_df)  # should not raise


def test_assert_no_leakage_catches_injected_group_overlap(model_table):
    train_df, val_df, test_df, _ = time_group_split(model_table)
    contaminated_val = pd.concat([val_df, train_df.iloc[[0]]], ignore_index=True)
    with pytest.raises(AssertionError):
        assert_no_leakage(train_df, contaminated_val, test_df)


def test_assert_no_leakage_catches_injected_time_order_violation(model_table):
    train_df, val_df, test_df, _ = time_group_split(model_table)
    train_max = pd.to_datetime(train_df["delivery_date"]).max()
    bad_val = val_df.copy()
    bad_val["delivery_date"] = train_max - pd.Timedelta(days=1)
    with pytest.raises(AssertionError):
        assert_no_leakage(train_df, bad_val, test_df)


def test_split_fractions_are_respected(model_table):
    train_df, val_df, test_df, boundaries = time_group_split(model_table)
    total_groups = (
        boundaries["n_train_groups"] + boundaries["n_val_groups"] + boundaries["n_test_groups"]
    )
    assert total_groups == model_table["aircraft_id"].nunique()
    assert boundaries["n_train_groups"] > boundaries["n_val_groups"]
    assert len(train_df) > 0 and len(val_df) > 0 and len(test_df) > 0
