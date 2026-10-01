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

# Decision-window alert rate: how many days define one "window" when counting
# each component's latest snapshot for the component-window alert rate (see
# src/evaluation.py alerts_per_100_components). 30 days chosen to line up
# with PREDICTION_HORIZON_CYCLES at typical utilization -- both represent
# "how often would an ops team re-triage the fleet."
ALERT_WINDOW_DAYS = 30

# Illustrative cost defaults (USD) for the min_expected_cost threshold policy
# (src/evaluation.py). These are NOT calibrated against any real MRO's
# finance data -- there was none available for this take-home -- and are
# labelled "illustrative" everywhere they are surfaced (model card, dashboard)
# per an explicit coordinator decision (see plan.md unresolved questions).
# They only change WHICH threshold min_expected_cost recommends; they are
# not used anywhere else.
COST_MISSED_REMOVAL = 50_000.0  # unscheduled/AOG removal missed by the model (false negative)
COST_FALSE_ALERT = 1_500.0  # inspection + no-fault-found dispatched on a false alarm

# Default dataset generation seed. Passed explicitly everywhere rather than
# relying on global numpy RNG state, so generation is reproducible regardless
# of call order.
DEFAULT_SEED = 42

# Dataset generation profile. "v1" reproduces the originally-submitted,
# byte-identical dataset (kept as a regression fixture / parity target --
# see tests/test_realism_profile.py). "realistic" is the v3 headline profile:
# NFF removals, sensor faults/MNAR missingness, component replacement (second
# life), label noise, operator/climate effects, and an anti-leakage inspection
# balancer -- see data/generate_dataset.py module docstring "Realism profile
# (v3)". Chosen as the pipeline default because the coordinator decision is
# to report the realistic profile honestly as a stress test while v1 stays
# the reproducible headline result (see plan.md acceptance criteria #1-2).
DEFAULT_PROFILE = "realistic"

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
    # Realism-profile audit columns (data/generate_dataset.py "realistic"
    # profile): component-replacement provenance and NFF flag. Never fed to
    # a model -- "cycle" (age since the CURRENT install) already carries the
    # age-reset signal, so no new numeric feature is needed for replacement.
    "component_serial",
    "install_cycle",
    "is_nff",
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

# --------------------------------------------------------------------------
# Profile-separated artifact paths (phase-01b fix).
#
# `--profile v1` is the reproducible headline result AND the model actually
# served by src/service/ -- it writes to the canonical paths above (DATA_DIR,
# MODELS_DIR, REPORTS_DIR, MODEL_CARD_JSON) unchanged.
#
# `--profile realistic` is an honest stress test (coordinator decision, see
# plan.md) and must NEVER overwrite the v1 canonical artifacts. It writes
# every output -- raw/processed data, models, and reports (including its own
# model_card.json) -- under these `REALISTIC_*` paths instead. The dashboard
# build script reads both trees and shows v1 as the headline; the live
# scoring service only ever reads the canonical (v1) paths.
# --------------------------------------------------------------------------
REALISTIC_RAW_DIR = RAW_DIR / "realistic"
REALISTIC_PROCESSED_DIR = PROCESSED_DIR / "realistic"
REALISTIC_MODELS_DIR = MODELS_DIR / "realistic"
REALISTIC_REPORTS_DIR = REPORTS_DIR / "realistic"
REALISTIC_MODEL_CARD_JSON = REALISTIC_REPORTS_DIR / "model_card.json"
