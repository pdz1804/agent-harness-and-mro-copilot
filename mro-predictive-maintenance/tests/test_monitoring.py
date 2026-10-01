"""Tests for src/monitoring.py (phase-02 requirement #5) and the
/monitoring/drift, /monitoring/performance, /models endpoints.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402
import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from src import config, monitoring  # noqa: E402
from src.service.app import app  # noqa: E402


# --------------------------------------------------------------------------
# PSI: pure-function tests, no service/model needed.
# --------------------------------------------------------------------------

def test_psi_identical_distributions_near_zero():
    rng = np.random.default_rng(1)
    ref = rng.normal(0, 1, 2000)
    cur = rng.normal(0, 1, 2000)
    value = monitoring.psi(ref, cur)
    assert value < 0.02


def test_psi_shifted_normal_is_large():
    rng = np.random.default_rng(2)
    ref = rng.normal(0, 1, 2000)
    cur = rng.normal(3, 1, 2000)  # 3-sigma mean shift -- unmistakable drift
    value = monitoring.psi(ref, cur)
    assert value > 0.25


def test_psi_handles_insufficient_rows_as_nan():
    value = monitoring.psi(np.array([1.0]), np.array([1.0, 2.0]))
    assert value != value  # NaN


def test_psi_categorical_shift():
    ref = pd.Series(["A"] * 900 + ["B"] * 100)
    cur = pd.Series(["A"] * 100 + ["B"] * 900)  # majority category flipped
    value = monitoring.psi_categorical(ref, cur)
    assert value > 0.25


def test_psi_categorical_identical_near_zero():
    ref = pd.Series(["A"] * 500 + ["B"] * 500)
    cur = pd.Series(["A"] * 500 + ["B"] * 500)
    value = monitoring.psi_categorical(ref, cur)
    assert value < 0.02


def test_drift_report_insufficient_data_status():
    cols = {"vibration_mm_s": [1.0, 2.0], "aircraft_type": ["A", "B"]}
    ref_df = pd.DataFrame(cols)
    cur_df = pd.DataFrame(cols)
    report = monitoring.drift_report(ref_df, cur_df)
    assert report["status"] == "insufficient_data"


def test_drift_report_ok_on_identical_larger_sample():
    rng = np.random.default_rng(3)
    n = 200
    df = pd.DataFrame({
        "vibration_mm_s": rng.normal(0, 1, n),
        "temperature_delta_c": rng.normal(0, 1, n),
        "aircraft_type": rng.choice(["A", "B"], n),
        "component_type": rng.choice(["X", "Y"], n),
        "region": rng.choice(["north", "south"], n),
    })
    report = monitoring.drift_report(df, df.copy())
    assert report["status"] == "ok"
    assert report["features"]["vibration_mm_s"]["status"] == "ok"


def test_simulate_shift_moves_vibration_for_a_subset():
    rng = np.random.default_rng(4)
    n = 500
    df = pd.DataFrame({"vibration_mm_s": rng.normal(5, 1, n)})
    shifted = monitoring.simulate_shift(df, seed=7)
    assert not shifted["vibration_mm_s"].equals(df["vibration_mm_s"])
    # A shifted subset must have a strictly higher mean than the untouched original.
    assert shifted["vibration_mm_s"].mean() > df["vibration_mm_s"].mean()


# --------------------------------------------------------------------------
# Endpoint tests: exercise the real ASGI app + real artifacts on disk.
# --------------------------------------------------------------------------

@pytest.fixture
def client(tmp_path, monkeypatch):
    if not config.MODEL_CARD_JSON.exists():
        pytest.skip("reports/model_card.json missing -- run `python -m src.pipeline` first")
    if not monitoring.REFERENCE_PROFILE_CSV.exists():
        pytest.skip("reports/reference_profile.csv missing -- run `python -m src.pipeline --profile v1` first")
    db_url = f"sqlite:///{tmp_path / 'ops.db'}"
    monkeypatch.setenv("DATABASE_URL", db_url)
    with TestClient(app) as c:
        yield c


def test_drift_endpoint_quiet_on_unshifted_test_split(client):
    resp = client.get("/monitoring/drift?window_days=30")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] in {"ok", "warn", "insufficient_data"}
    # The unshifted test split must never spuriously reach `alert`.
    assert body["status"] != "alert"


def test_drift_endpoint_fires_on_simulated_shift(client):
    resp = client.get("/monitoring/drift?window_days=30&simulate=shift")
    assert resp.status_code == 200
    body = resp.json()
    assert body["simulated_shift_applied"] is True
    vibration = body["features"].get("vibration_mm_s")
    assert vibration is not None
    assert vibration["status"] == "alert"
    assert body["status"] == "alert"


def test_performance_endpoint_available_with_no_outcomes_yet(client):
    resp = client.get("/monitoring/performance")
    assert resp.status_code == 200
    body = resp.json()
    assert body["available"] is True
    assert body["live_outcomes"]["closed_with_outcome"] == 0


def test_models_endpoint_reports_tracking_state(client):
    resp = client.get("/models")
    assert resp.status_code == 200
    body = resp.json()
    assert "tracking_enabled" in body
    assert body["registered_model"] == "mro-failure-risk"


def test_health_and_model_card_expose_model_version_field(client):
    health = client.get("/health").json()
    assert "model_version" in health
    card = client.get("/model-card").json()
    assert "model_version" in card


# --------------------------------------------------------------------------
# MLflow tracking/registry smoke test (phase-02 requirement: "tracking: run
# with MLFLOW_TRACKING_URI=sqlite:///<tmp> -> registered version 1, alias
# champion"). Slow (a real, small pipeline run) -- explicitly opts into its
# own isolated tmp registry via monkeypatch, unlike every other test in this
# suite which runs with tracking disabled (see src/tracking.py's
# pytest-default-disabled rationale).
# --------------------------------------------------------------------------

@pytest.mark.slow
def test_mlflow_tracking_registers_and_aliases_champion(tmp_path, monkeypatch):
    pytest.importorskip("mlflow")
    from src import pipeline, tracking

    # Redirect EVERY artifact path this real pipeline run would otherwise
    # write to (models/, reports/, reference_profile.csv included) into
    # tmp_path -- matching tests/test_realism_profile.py's pattern. Without
    # this, a fixture-scale (n_aircraft=150) run silently overwrites the
    # real canonical reports/reference_profile.csv and models/*.joblib with
    # smaller-scale artifacts, corrupting both the drift-quiet-baseline
    # test and test_score_parity_with_offline_pipeline for any test run
    # after this one in the same session (root-caused via a full pytest
    # rerun during this phase's implementation -- see phase-02 report).
    from src import config

    monkeypatch.setattr(config, "RAW_DIR", tmp_path / "raw")
    monkeypatch.setattr(config, "PROCESSED_DIR", tmp_path / "processed")
    monkeypatch.setattr(config, "MODELS_DIR", tmp_path / "models")
    monkeypatch.setattr(config, "REPORTS_DIR", tmp_path / "reports")
    monkeypatch.setattr(config, "MODEL_CARD_JSON", tmp_path / "reports" / "model_card.json")
    monkeypatch.setattr(monitoring, "REFERENCE_PROFILE_CSV", tmp_path / "reports" / "reference_profile.csv")

    db_path = tmp_path / "mlflow.db"
    monkeypatch.setenv("MLFLOW_TRACKING_URI", f"sqlite:///{db_path.as_posix()}")
    tracking.init_tracking(force=True)
    try:
        result = pipeline.run(seed=42, profile="v1", n_aircraft=150)
        assert result["card"]["model_id"]

        import mlflow

        client = mlflow.MlflowClient()
        model = client.get_registered_model(tracking.REGISTERED_MODEL_NAME)
        assert "champion" in (model.aliases or {})
        champion_version = model.aliases["champion"]
        version_info = client.get_model_version(tracking.REGISTERED_MODEL_NAME, champion_version)
        assert version_info.status == "READY"
    finally:
        # Never leave this test's tmp registry as the process-wide tracking
        # target -- see tracking.reset_for_testing()'s docstring.
        tracking.reset_for_testing()
