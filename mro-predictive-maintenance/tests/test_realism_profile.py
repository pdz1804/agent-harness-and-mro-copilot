"""v1 parity + realistic-profile regression tests (phase-01 requirement #1, #2).

v1 parity is the load-bearing guarantee here: --profile v1 must reproduce
the originally-submitted numbers exactly (threshold 0.9405, recall 0.8214),
because the coordinator decision is that v1 stays the reproducible headline
result while the realistic profile is reported as an honest stress test.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pandas as pd  # noqa: E402
import pytest  # noqa: E402

from data.generate_dataset import N_AIRCRAFT, generate  # noqa: E402
from src import pipeline  # noqa: E402


def test_v1_profile_generator_is_byte_identical_across_runs():
    a1 = generate(seed=42, n_aircraft=40, profile="v1")
    a2 = generate(seed=42, n_aircraft=40, profile="v1")
    for df1, df2 in zip(a1, a2):
        pd.testing.assert_frame_equal(df1, df2)


def test_v1_profile_matches_the_pre_existing_v1_determinism_fixture():
    """Same generator call the original tests/test_dataset_generation.py
    uses (no `profile` kwarg = default "v1"), confirming the new `profile`
    parameter did not change v1's RNG stream or output."""
    from data.generate_dataset import generate as generate_default

    with_default = generate_default(seed=7, n_aircraft=20)
    with_explicit_v1 = generate(seed=7, n_aircraft=20, profile="v1")
    for df1, df2 in zip(with_default, with_explicit_v1):
        pd.testing.assert_frame_equal(df1, df2)


@pytest.mark.slow
def test_pipeline_v1_reproduces_the_submitted_operating_point(tmp_path, monkeypatch):
    """Full pipeline run, profile=v1, must reproduce the originally-submitted
    hist_gradient_boosting operating point exactly: threshold 0.9405,
    test recall 0.8214 (23/28), 0 false positives -- see reports/model_card.json
    committed at the start of this phase."""
    from src import config

    monkeypatch.setattr(config, "RAW_DIR", tmp_path / "raw")
    monkeypatch.setattr(config, "PROCESSED_DIR", tmp_path / "processed")
    monkeypatch.setattr(config, "MODELS_DIR", tmp_path / "models")
    monkeypatch.setattr(config, "REPORTS_DIR", tmp_path / "reports")
    monkeypatch.setattr(config, "MODEL_CARD_JSON", tmp_path / "reports" / "model_card.json")

    result = pipeline.run(seed=42, profile="v1", n_aircraft=N_AIRCRAFT)

    hgb = result["results"]["hist_gradient_boosting"]
    assert hgb["chosen_threshold"]["threshold"] == pytest.approx(0.9405, abs=1e-6)
    assert hgb["test_at_threshold"]["recall"] == pytest.approx(0.8214285714285714, abs=1e-9)
    assert hgb["test_at_threshold"]["fp"] == 0
    assert hgb["test_at_threshold"]["tp"] == 23
    assert result["card"]["profile"] == "v1"


def test_realistic_profile_positive_rate_in_expected_band():
    _, components, snapshots, _, _ = generate(seed=42, n_aircraft=150, profile="realistic")
    positive_rate = snapshots["label"].mean()
    assert 0.005 <= positive_rate <= 0.08, f"positive rate {positive_rate:.4f} outside band"


def test_realistic_profile_nff_share_near_target():
    _, components, snapshots, _, _ = generate(seed=42, n_aircraft=200, profile="realistic")
    unscheduled = snapshots[(snapshots["label"] == 1)]
    nff_positive_components = snapshots.loc[
        (snapshots["label"] == 1) & (snapshots["is_nff"]), "component_id"
    ].unique()
    all_positive_components = snapshots.loc[snapshots["label"] == 1, "component_id"].unique()
    assert len(all_positive_components) > 0
    nff_share = len(nff_positive_components) / len(all_positive_components)
    assert 0.0 <= nff_share <= 0.35, f"NFF share {nff_share:.3f} far outside 15%±20pp band"
    assert len(unscheduled) > 0


def test_realistic_profile_produces_component_replacement_rows():
    _, components, _, _, _ = generate(seed=42, n_aircraft=200, profile="realistic")
    assert (components["component_serial"] > 1).any(), "expected at least one second-life component"
    assert (components["install_cycle"] > 0).any()


def test_realistic_profile_leakage_tests_still_hold():
    """Re-run the two existing leakage regression checks against the
    realistic profile too -- realism must not reopen the label-window leak
    the generator's docstring documents."""
    from src.features import build_model_table
    from src.modeling import ALL_FEATURES
    from src import config as cfg

    aircraft, components, snapshots, faults, maint = generate(seed=42, n_aircraft=120, profile="realistic")
    table = build_model_table(aircraft, components, snapshots, faults, maint)
    assert "check_type" not in ALL_FEATURES
    assert set(ALL_FEATURES).isdisjoint(cfg.NON_FEATURE_COLUMNS)
    assert table["cycles_since_last_check"].notna().all()
    assert table["check_count_last_1500cyc"].notna().all()


@pytest.mark.slow
def test_realistic_profile_never_writes_canonical_v1_paths(tmp_path, monkeypatch):
    """Regression test for the phase-01b artifact-separation bug: a realistic
    run used to write to the same canonical models/*.joblib, reports/*.md,
    reports/model_card.json etc. as v1, silently overwriting the v1 headline
    artifacts on the last realistic run. Every realistic output must land
    under its own `realistic/` subtree; the canonical (v1) paths must stay
    untouched by a realistic-only run."""
    from src import config

    raw_dir = tmp_path / "raw"
    processed_dir = tmp_path / "processed"
    models_dir = tmp_path / "models"
    reports_dir = tmp_path / "reports"
    monkeypatch.setattr(config, "RAW_DIR", raw_dir)
    monkeypatch.setattr(config, "PROCESSED_DIR", processed_dir)
    monkeypatch.setattr(config, "MODELS_DIR", models_dir)
    monkeypatch.setattr(config, "REPORTS_DIR", reports_dir)
    monkeypatch.setattr(config, "MODEL_CARD_JSON", reports_dir / "model_card.json")
    monkeypatch.setattr(config, "REALISTIC_RAW_DIR", raw_dir / "realistic")
    monkeypatch.setattr(config, "REALISTIC_PROCESSED_DIR", processed_dir / "realistic")
    monkeypatch.setattr(config, "REALISTIC_MODELS_DIR", models_dir / "realistic")
    monkeypatch.setattr(config, "REALISTIC_REPORTS_DIR", reports_dir / "realistic")
    monkeypatch.setattr(
        config, "REALISTIC_MODEL_CARD_JSON", reports_dir / "realistic" / "model_card.json"
    )

    pipeline.run(seed=42, profile="realistic", n_aircraft=40)

    # Canonical (v1) paths must not exist at all -- nothing wrote there.
    assert not (reports_dir / "model_card.json").exists()
    assert not (reports_dir / "metrics_table.md").exists()
    assert not (reports_dir / "high_risk_examples.md").exists()
    assert not models_dir.exists() or not any(models_dir.glob("*.joblib"))
    assert not (raw_dir / "aircraft.csv").exists()
    assert not (processed_dir / "model_table.csv").exists()

    # Realistic outputs must exist under the parallel subtree.
    assert (reports_dir / "realistic" / "model_card.json").exists()
    assert (reports_dir / "realistic" / "metrics_table.md").exists()
    assert (reports_dir / "realistic" / "high_risk_examples.md").exists()
    assert any((models_dir / "realistic").glob("*.joblib"))
    assert (raw_dir / "realistic" / "aircraft.csv").exists()
    assert (processed_dir / "realistic" / "model_table.csv").exists()


def test_realistic_profile_component_group_key_is_still_aircraft_id():
    from src.features import build_model_table
    from src.splitting import assert_no_leakage, time_group_split

    aircraft, components, snapshots, faults, maint = generate(seed=42, n_aircraft=100, profile="realistic")
    table = build_model_table(aircraft, components, snapshots, faults, maint)
    train_df, val_df, test_df, _ = time_group_split(table)
    assert_no_leakage(train_df, val_df, test_df)  # must not raise even with second-life rows
