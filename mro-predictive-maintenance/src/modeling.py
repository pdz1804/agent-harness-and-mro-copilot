"""Preprocessing + the two compared models.

Model choice (per the original brief's design guidance -- avoid heavy/exotic
deps, keep everything pip-installable without GPU/CUDA):

- LogisticRegression: linear baseline, fully interpretable via
  coefficients, cheap to train. Needs imputed + scaled numeric inputs.
- HistGradientBoostingClassifier: scikit-learn's native gradient
  boosting implementation. Handles missing numeric values internally
  (no imputation needed for it -- NaNs are treated as their own
  split direction), captures non-linear/interaction effects the
  linear model cannot. Chosen over XGBoost to keep the dependency
  footprint inside plain scikit-learn (xgboost was available in this
  environment too; HGB was preferred so the POC runs anywhere
  scikit-learn runs, no extra wheel required).

Class imbalance: both models use ``class_weight="balanced"`` (inverse
frequency reweighting) rather than oversampling/SMOTE. With a group+time
split, synthetic oversampling before splitting would risk generating
neighbors that straddle the split boundary; reweighting is applied only
inside the training fold and has no such risk, and it lets the
probability outputs stay properly calibrated in rank order.
"""

from __future__ import annotations

import numpy as np
import pandas as pd
from sklearn.compose import ColumnTransformer
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.impute import SimpleImputer
from sklearn.linear_model import LogisticRegression
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import OneHotEncoder, StandardScaler

from . import config

NUMERIC_FEATURES = [
    "vibration_mm_s", "temperature_delta_c", "pressure_delta_psi",
    "current_draw_amp", "stroke_time_s", "airflow_cfm",
    "fault_count_last_500cyc", "fault_count_last_1500cyc", "max_severity_last_500cyc",
    "cycles_since_last_check", "check_count_last_1500cyc",
    "component_age_cycles", "cumulative_flight_hours", "aircraft_age_years",
    "cycles_per_day", "avg_flight_hours_per_cycle",
]
CATEGORICAL_FEATURES = config.CATEGORICAL_COLUMNS
ALL_FEATURES = NUMERIC_FEATURES + CATEGORICAL_FEATURES


def _make_preprocessor(impute_numeric: bool) -> ColumnTransformer:
    if impute_numeric:
        numeric_pipe = Pipeline([
            ("impute", SimpleImputer(strategy="median")),
            ("scale", StandardScaler()),
        ])
    else:
        # HistGradientBoostingClassifier handles NaN natively; passthrough keeps them.
        numeric_pipe = "passthrough"

    categorical_pipe = OneHotEncoder(handle_unknown="ignore")

    return ColumnTransformer([
        ("num", numeric_pipe, NUMERIC_FEATURES),
        ("cat", categorical_pipe, CATEGORICAL_FEATURES),
    ])


def build_models(seed: int = config.DEFAULT_SEED) -> dict[str, Pipeline]:
    logistic = Pipeline([
        ("preprocessor", _make_preprocessor(impute_numeric=True)),
        ("classifier", LogisticRegression(
            class_weight="balanced", max_iter=2000, random_state=seed,
        )),
    ])

    hgb = Pipeline([
        ("preprocessor", _make_preprocessor(impute_numeric=False)),
        ("classifier", HistGradientBoostingClassifier(
            class_weight="balanced", random_state=seed, max_depth=6,
            learning_rate=0.08, max_iter=200,
        )),
    ])

    return {"logistic_regression": logistic, "hist_gradient_boosting": hgb}


def fit_model(pipeline: Pipeline, train_df: pd.DataFrame) -> Pipeline:
    x_train = train_df[ALL_FEATURES]
    y_train = train_df["label"].to_numpy()
    pipeline.fit(x_train, y_train)
    return pipeline


def predict_scores(pipeline: Pipeline, df: pd.DataFrame) -> np.ndarray:
    x = df[ALL_FEATURES]
    return pipeline.predict_proba(x)[:, 1]
