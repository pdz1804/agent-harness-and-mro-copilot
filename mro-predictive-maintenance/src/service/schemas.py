"""Pydantic request/response models for the scoring service.

The feature fields are generated from ``src.modeling.NUMERIC_FEATURES`` /
``CATEGORICAL_FEATURES`` (``pydantic.create_model``) rather than hand-typed,
so the service's input contract can never drift from what the trained
pipeline actually expects -- adding/removing a feature in ``src/modeling.py``
automatically changes the API schema too (single source of truth, per
``.claude/rules/development-rules.md`` DRY).
"""

from __future__ import annotations

from typing import Optional

from pydantic import BaseModel, ConfigDict, create_model

from src.modeling import ALL_FEATURES, CATEGORICAL_FEATURES, NUMERIC_FEATURES

_numeric_fields = {name: (Optional[float], None) for name in NUMERIC_FEATURES}
_categorical_fields = {name: (str, ...) for name in CATEGORICAL_FEATURES}

# The raw model-ready feature payload for one component snapshot. Numeric
# fields are optional (missing -> NaN, handled exactly like training: median
# imputation for logistic_regression, native NaN routing for
# hist_gradient_boosting -- see src/modeling.py's ColumnTransformer).
ComponentFeatures = create_model(
    "ComponentFeatures",
    __config__=ConfigDict(extra="forbid"),
    **_numeric_fields,
    **_categorical_fields,
)

# POST /score body: the feature payload plus an optional caller-supplied
# component_id, echoed back in the response for traceability (not used by
# the model).
ScoreRequest = create_model(
    "ScoreRequest",
    __config__=ConfigDict(extra="forbid"),
    component_id=(Optional[str], None),
    **_numeric_fields,
    **_categorical_fields,
)


class ShapFactor(BaseModel):
    feature: str
    shap_value: float


class ScoreResponse(BaseModel):
    model_id: str
    component_id: Optional[str] = None
    risk_score: float
    threshold: float
    alert: bool
    explanation_method: str
    top_factors: list[ShapFactor]


class ModelCardResponse(BaseModel):
    model_id: str
    trained_at: str
    seed: int
    threshold: float
    threshold_status: str
    target: dict
    val_metrics: dict
    test_metrics: dict
    test_at_threshold: dict
    numeric_features: list[str]
    categorical_features: list[str]


class FleetRiskItem(BaseModel):
    component_id: str
    aircraft_id: str
    component_type: str
    cycle: float
    snapshot_date: str
    risk_score: float
    alert: bool
    true_label: int
    features: ComponentFeatures  # type: ignore[valid-type]


class FleetRiskResponse(BaseModel):
    model_id: str
    threshold: float
    split: str
    n_scored: int
    n_returned: int
    items: list[FleetRiskItem]


class HealthResponse(BaseModel):
    status: str
    model_id: Optional[str] = None
    model_loaded: bool
