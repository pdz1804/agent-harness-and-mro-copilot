"""Shared paths and constants for the MRO predictive-maintenance POC.

Centralizing paths here keeps `data/generate_dataset.py`, the `src/`
pipeline modules, and the test suite pointed at the same locations without
hard-coding strings in multiple places (DRY).
"""

from __future__ import annotations

from pathlib import Path

# Project root = the `mro-predictive-maintenance/` directory (parent of `src/`).
ROOT_DIR = Path(__file__).resolve().parent.parent

DATA_DIR = ROOT_DIR / "data"
RAW_DIR = DATA_DIR / "raw"
PROCESSED_DIR = DATA_DIR / "processed"
REPORTS_DIR = ROOT_DIR / "reports"
MODELS_DIR = ROOT_DIR / "models"
DOCS_DIR = ROOT_DIR / "docs"

# Raw table filenames (written by data/generate_dataset.py).
AIRCRAFT_CSV = RAW_DIR / "aircraft.csv"
COMPONENTS_CSV = RAW_DIR / "components.csv"
CYCLE_SNAPSHOTS_CSV = RAW_DIR / "cycle_snapshots.csv"
FAULT_CODES_CSV = RAW_DIR / "fault_codes.csv"
MAINTENANCE_EVENTS_CSV = RAW_DIR / "maintenance_events.csv"

# Model-ready table (written by src/features.py).
MODEL_TABLE_CSV = PROCESSED_DIR / "model_table.csv"

# Prediction horizon, in flight cycles, per the take-home spec.
PREDICTION_HORIZON_CYCLES = 30

# Routine scheduled-check interval, in flight cycles. Single source of truth
# shared by data/generate_dataset.py (grid spacing) and src/features.py
# (the non-informative recency default used for symptom-triggered snapshot
# rows -- see features.py's leakage-guard docstring).
ROUTINE_CHECK_INTERVAL_CYCLES = 300

# Operating-point targets the pipeline tries to hit on the held-out test split.
TARGET_RECALL = 0.80
TARGET_ALERTS_PER_100 = 5.0

# Default dataset generation seed. Passed explicitly everywhere rather than
# relying on global numpy RNG state, so generation is reproducible regardless
# of call order.
DEFAULT_SEED = 42

# Columns that must never be fed to a model: identifiers, raw dates, and any
# field derived from information that would not exist at prediction time in
# production (ground-truth removal bookkeeping used only to build labels).
NON_FEATURE_COLUMNS = [
    "component_id",
    "aircraft_id",
    "snapshot_date",
    "removal_date",
    "removal_type",
    "removal_cycle",
    "check_type",
    "label",
]

# Categorical columns one-hot encoded by src/modeling.py.
CATEGORICAL_COLUMNS = ["aircraft_type", "component_type", "region"]

# Model selected for deployment/serving. src/pipeline.py picks this same
# primary model for its explainability artifacts (see run()'s "both_met"
# selection logic in src/pipeline.py + docs/design-report.md section 4:
# post-leakage-fix, BOTH models meet the recall/alert-rate target on the
# held-out test split, and hist_gradient_boosting has the better precision,
# alert rate, and ROC/PR-AUC at that recall, so it is the deployed model).
# The live scoring service (src/service/) loads exactly this model.
PRIMARY_MODEL_ID = "hist_gradient_boosting"

# Written by src/pipeline.py on every run; read by src/service/ at startup
# so the serving threshold/metrics always match the artifacts on disk
# (retraining and restarting the service is the only way to change them).
MODEL_CARD_JSON = REPORTS_DIR / "model_card.json"
