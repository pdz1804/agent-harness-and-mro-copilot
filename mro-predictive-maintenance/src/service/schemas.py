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
    # "calibrated" if the isotonic/sigmoid-calibrated pipeline produced
    # risk_score (src/calibration.py), "raw" if the underlying model's
    # uncalibrated probability was used (no calibrated artifact available --
    # e.g. the v1 canonical model, which was never calibrated). Additive
    # field so older clients ignoring it still work (phase-02 requirement).
    scoring_mode: str = "raw"


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
    # v2 fields (phase-01 ML rigor): additive, all optional so the v1-shaped
    # model card (reports/model_card.json written with --profile v1) still
    # validates -- see src/pipeline.py _run_v1 vs _run_realistic.
    profile: Optional[str] = None
    val_status: Optional[str] = None
    test_status: Optional[str] = None
    served_policy: Optional[str] = None
    threshold_policies: Optional[dict] = None
    calibration: Optional[dict] = None
    ci: Optional[dict] = None
    alert_rate_definition: Optional[str] = None
    alert_rate: Optional[dict] = None
    baselines: Optional[dict] = None
    # phase-02: which registry version is actually being served -- None
    # means "local joblib artifact" (registry unreachable/empty).
    model_version: Optional[str] = None


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


class FleetListItem(BaseModel):
    """One row of the paginated fleet list (no feature payload)."""

    rank: int  # global risk rank, 1 = highest
    component_id: str
    aircraft_id: str
    aircraft_type: Optional[str] = None
    component_type: str
    cycle: float
    snapshot_date: str
    risk_score: float
    alert: bool
    band: str  # "alert" | "watch" | "normal"
    true_label: int


class FleetPageResponse(BaseModel):
    model_id: str
    threshold: float
    watch_floor: float
    n_scored: int
    total: int  # rows matching the filters, before paging
    offset: int
    limit: int
    counts: dict[str, int]  # whole fleet per band, independent of filters
    component_types: list[str]
    aircraft_types: list[str] = []  # distinct fleets (e.g. A321, ATR72) for the filter
    items: list[FleetListItem]


class HealthResponse(BaseModel):
    status: str
    model_id: Optional[str] = None
    model_loaded: bool
    model_version: Optional[str] = None
