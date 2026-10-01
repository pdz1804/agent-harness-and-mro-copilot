"""Loads the trained artifacts once and keeps them in memory for the API.

Everything here is read from disk, produced by a real ``python -m src.pipeline``
run: the fitted sklearn ``Pipeline`` (``models/<model_id>.joblib``), the
serving contract (``reports/model_card.json``: which model, what threshold,
what metrics), and the model-ready feature table (``data/processed/model_table.csv``)
used to (a) sample a SHAP background set from the training split and (b)
answer ``GET /fleet/top-risk`` by re-scoring the real held-out test split
live. No numbers are computed or invented here -- this module only loads
and re-derives (via the same ``src/splitting.py`` used at training time)
what training already produced.
"""

from __future__ import annotations

import json
import threading
from dataclasses import dataclass, field
from pathlib import Path

import joblib
import pandas as pd

from src import config, splitting, tracking
from src.modeling import ALL_FEATURES


class ModelNotLoadedError(RuntimeError):
    """Raised when an endpoint is called before/without a successful artifact load."""


@dataclass
class ModelStore:
    pipeline: object | None = None
    # Isotonic/sigmoid-calibrated wrapper around `pipeline`, produced by
    # src/pipeline.py's realistic-profile run (models/<id>_calibrated.joblib).
    # Loaded for its probability calibration; SHAP explanations still run
    # against the uncalibrated `pipeline` (calibration is a monotone
    # transform, so feature ranking/attribution is unchanged -- see
    # src/calibration.py module docstring and phase-01 requirement #8). Not
    # yet wired into the live /score response (app.py wiring is owned by a
    # later phase) -- `calibrated_available` documents that gap explicitly
    # rather than silently ignoring the artifact.
    calibrated_pipeline: object | None = None
    calibrated_available: bool = False
    model_card: dict | None = None
    background_df: pd.DataFrame | None = None
    test_latest_df: pd.DataFrame | None = None
    # Set when the model actually being served came from the MLflow
    # registry's `champion` alias rather than the local joblib artifact --
    # None means "local joblib" (registry unreachable/empty/not installed).
    # Exposed on /health, /model-card, /score (phase-02 requirement #4).
    model_version: str | None = None
    _lock: threading.Lock = field(default_factory=threading.Lock)

    @property
    def loaded(self) -> bool:
        return self.pipeline is not None and self.model_card is not None

    def load(self) -> None:
        with self._lock:
            model_id = config.PRIMARY_MODEL_ID
            model_path = config.MODELS_DIR / f"{model_id}.joblib"
            if not model_path.exists():
                raise FileNotFoundError(
                    f"No trained model at {model_path}. Run `python -m src.pipeline` "
                    "(or `python -m src.pipeline --retrain`) first."
                )
            if not config.MODEL_CARD_JSON.exists():
                raise FileNotFoundError(
                    f"No model card at {config.MODEL_CARD_JSON}. Run `python -m src.pipeline` first."
                )
            if not config.MODEL_TABLE_CSV.exists():
                raise FileNotFoundError(
                    f"No model table at {config.MODEL_TABLE_CSV}. Run `python -m src.features` "
                    "(or the full pipeline) first."
                )

            # Load order (phase-02 requirement #4): registry alias `champion`
            # if MLflow tracking is reachable and the alias exists, else the
            # local joblib artifact (current/original behaviour). A registry
            # load failure of ANY kind falls back silently to joblib -- the
            # service must never fail to start because MLflow is down.
            registry_result = tracking.load_champion_pipeline()
            if registry_result is not None:
                self.pipeline, self.model_version = registry_result
            else:
                self.pipeline = joblib.load(model_path)
                self.model_version = None

            self.model_card = json.loads(config.MODEL_CARD_JSON.read_text(encoding="utf-8"))

            calibrated_path = config.MODELS_DIR / f"{model_id}_calibrated.joblib"
            if calibrated_path.exists():
                self.calibrated_pipeline = joblib.load(calibrated_path)
                self.calibrated_available = True
            else:
                self.calibrated_pipeline = None
                self.calibrated_available = False

            table = pd.read_csv(
                config.MODEL_TABLE_CSV, parse_dates=["snapshot_date", "delivery_date"]
            )
            train_df, _val_df, test_df, _boundaries = splitting.time_group_split(table)
            self.background_df = train_df

            # "Latest snapshot of every active component in the test split":
            # one row per component_id, its most recent observed cycle.
            idx = test_df.groupby("component_id")["cycle"].idxmax()
            self.test_latest_df = test_df.loc[idx].reset_index(drop=True)

    def require_loaded(self) -> None:
        if not self.loaded:
            raise ModelNotLoadedError(
                "Model artifacts are not loaded. Check service startup logs / GET /health."
            )

    @property
    def threshold(self) -> float:
        self.require_loaded()
        return float(self.model_card["threshold"])

    @property
    def model_id(self) -> str:
        self.require_loaded()
        return str(self.model_card["model_id"])


# Process-wide singleton, populated at FastAPI startup (see app.py's lifespan
# handler) and read by every request handler. A single service process
# serves one model version at a time, by design (retrain + restart to roll
# a new one -- see README "Retraining").
store = ModelStore()


def feature_row_from_payload(payload: dict) -> pd.DataFrame:
    """Build the one-row DataFrame the pipeline expects from a validated payload dict."""
    row = {f: payload.get(f) for f in ALL_FEATURES}
    return pd.DataFrame([row])
