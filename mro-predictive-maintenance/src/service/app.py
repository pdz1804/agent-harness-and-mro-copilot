"""FastAPI scoring service for the MRO predictive-maintenance model.

Run (from the project root, with the venv active):
    uvicorn src.service.app:app --port 8100

Endpoints:
    GET  /health              liveness + whether artifacts loaded
    GET  /model-card          model id, threshold, metrics, training date, feature list
    POST /score                {feature payload} -> risk score, alert, live SHAP factors
    GET  /fleet/top-risk?n=    live-scored, ranked latest snapshot of every test-split component

CORS (not a Vite dev proxy) is how the dashboard reaches this service:
allowed origins are read from ``SERVICE_CORS_ORIGINS`` (comma-separated),
defaulting to the Vite dev (5173) and preview (4173) ports. CORS was chosen
over a Vite proxy because it works identically for `npm run dev`,
`npm run build && npm run preview`, and any future static host, with no
per-environment proxy config to keep in sync -- see README "Live scoring
service" for the full rationale.
"""

from __future__ import annotations

import os
from contextlib import asynccontextmanager

import pandas as pd
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from src import config, tracking
from src.calibration import predict_calibrated_scores
from src.copilot import tables as copilot_tables  # noqa: F401 -- registers copilot_guardrail_events/events/automations onto ops_db.metadata
from src.copilot import automations as copilot_automations
from src.copilot import hitl as copilot_hitl
from src.copilot.retrieval import KBIndex
from src.copilot.runs import RunManager
from src.explainability import shap_contributions_for_rows
from src.modeling import ALL_FEATURES, CATEGORICAL_FEATURES, NUMERIC_FEATURES, predict_scores
from src.ops import db as ops_db
from src.service.model_store import ModelNotLoadedError, feature_row_from_payload, store
from src.service.routers import copilot as copilot_router
from src.service.routers import kb as kb_router
from src.service.routers import monitoring as monitoring_router
from src.service.routers import ops as ops_router
from src.service.schemas import (
    FleetRiskItem,
    FleetRiskResponse,
    HealthResponse,
    ModelCardResponse,
    ScoreRequest,
    ScoreResponse,
    ShapFactor,
)

DEFAULT_CORS_ORIGINS = ["http://localhost:5173", "http://localhost:4173"]


@asynccontextmanager
async def lifespan(_app: FastAPI):
    tracking.init_tracking()  # no-op fallback if mlflow missing/unreachable
    try:
        store.load()
    except FileNotFoundError as exc:
        # Don't crash the process -- /health reports the problem clearly and
        # every other endpoint returns 503 until artifacts exist and the
        # service is restarted (no silent fallback to a stale/fake model).
        print(f"WARNING: model artifacts not loaded at startup: {exc}")

    ops_engine = ops_db.make_engine()
    ops_db.init_db(ops_engine)
    ops_router.init_engine(ops_engine)
    monitoring_router.init_engine(ops_engine)

    kb_index = KBIndex.build()
    kb_router.init_index(kb_index)

    copilot_automations.seed_default_automation(ops_engine)
    cleaned = copilot_hitl.cleanup_legacy_pending(ops_engine)
    if cleaned:
        print(f"INFO: cancelled {cleaned} pre-fix copilot pending card(s) with legacy raw args (stale -- cancelled)")
    run_manager = RunManager(ops_engine, kb_index, store)
    recovered = run_manager.recover_interrupted()
    if recovered:
        print(f"WARNING: {recovered} copilot run(s) left 'running' by a prior process were marked failed(interrupted)")
    copilot_router.init_manager(run_manager)

    yield


app = FastAPI(
    title="MRO Predictive Maintenance -- Scoring Service",
    description="Live risk scoring for the aircraft-component predictive-maintenance POC.",
    version="1.0.0",
    lifespan=lifespan,
)

_origins_env = os.environ.get("SERVICE_CORS_ORIGINS")
_origins = [o.strip() for o in _origins_env.split(",")] if _origins_env else DEFAULT_CORS_ORIGINS
app.add_middleware(
    CORSMiddleware,
    allow_origins=_origins,
    allow_methods=["GET", "POST", "PATCH"],
    allow_headers=["*"],
)

app.include_router(ops_router.router)
app.include_router(monitoring_router.router)
app.include_router(copilot_router.router)
app.include_router(kb_router.router)


def _require_model():
    try:
        store.require_loaded()
    except ModelNotLoadedError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@app.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    return HealthResponse(
        status="ok" if store.loaded else "model_not_loaded",
        model_id=store.model_card["model_id"] if store.loaded else None,
        model_loaded=store.loaded,
        model_version=store.model_version if store.loaded else None,
    )


@app.get("/model-card", response_model=ModelCardResponse)
def model_card() -> ModelCardResponse:
    _require_model()
    card = store.model_card
    return ModelCardResponse(
        model_id=card["model_id"],
        trained_at=card["trained_at"],
        seed=card["seed"],
        threshold=card["threshold"],
        threshold_status=card["threshold_status"],
        target=card["target"],
        val_metrics=card["val_metrics"],
        test_metrics=card["test_metrics"],
        test_at_threshold=card["test_at_threshold"],
        numeric_features=NUMERIC_FEATURES,
        categorical_features=CATEGORICAL_FEATURES,
        profile=card.get("profile"),
        val_status=card.get("val_status"),
        test_status=card.get("test_status"),
        served_policy=card.get("served_policy"),
        threshold_policies=card.get("threshold_policies"),
        calibration=card.get("calibration"),
        ci=card.get("ci"),
        alert_rate_definition=card.get("alert_rate_definition"),
        alert_rate=card.get("alert_rate"),
        baselines=card.get("baselines"),
        model_version=store.model_version,
    )


@app.post("/score", response_model=ScoreResponse)
def score(request: ScoreRequest, use_calibrated: bool = True) -> ScoreResponse:  # type: ignore[valid-type]
    """``use_calibrated`` (default True) uses the isotonic/sigmoid-calibrated
    pipeline (``src/calibration.py``) when one is available for the
    currently-served model; falls back to the raw pipeline's probability
    otherwise. ``scoring_mode`` in the response always says which actually
    happened -- the v1 canonical model has no calibrated artifact, so it
    is always scored raw regardless of this flag.
    """
    _require_model()
    payload = request.model_dump()
    component_id = payload.pop("component_id", None)

    row_df = feature_row_from_payload(payload)
    use_calibrated_model = use_calibrated and store.calibrated_available
    try:
        if use_calibrated_model:
            risk_score = float(predict_calibrated_scores(store.calibrated_pipeline, row_df, ALL_FEATURES)[0])
            scoring_mode = "calibrated"
        else:
            risk_score = float(predict_scores(store.pipeline, row_df)[0])
            scoring_mode = "raw"
    except Exception as exc:
        raise HTTPException(status_code=422, detail=f"could not score payload: {exc}") from exc

    threshold = store.threshold
    alert = risk_score >= threshold

    try:
        contribs = shap_contributions_for_rows(
            store.pipeline, store.model_id, store.background_df, row_df, top_k_features=5,
        )[0]
        method = "shap"
    except Exception as exc:
        raise HTTPException(
            status_code=500, detail=f"SHAP explanation failed for a scoreable row: {exc}"
        ) from exc

    return ScoreResponse(
        model_id=store.model_id,
        component_id=component_id,
        risk_score=risk_score,
        threshold=threshold,
        alert=alert,
        explanation_method=method,
        top_factors=[ShapFactor(**f) for f in contribs],
        scoring_mode=scoring_mode,
    )


def _fleet_item(row: pd.Series, risk_score: float, threshold: float) -> FleetRiskItem:
    features = {f: (None if pd.isna(row[f]) else row[f]) for f in ALL_FEATURES}
    return FleetRiskItem(
        component_id=row["component_id"],
        aircraft_id=row["aircraft_id"],
        component_type=row["component_type"],
        cycle=float(row["cycle"]),
        snapshot_date=str(row["snapshot_date"]),
        risk_score=risk_score,
        alert=bool(risk_score >= threshold),
        true_label=int(row["label"]),
        features=features,
    )


@app.get("/fleet/top-risk", response_model=FleetRiskResponse)
def fleet_top_risk(n: int = 10) -> FleetRiskResponse:
    _require_model()
    if n < 1:
        raise HTTPException(status_code=422, detail="n must be >= 1")

    fleet_df = store.test_latest_df
    scores = predict_scores(store.pipeline, fleet_df)
    threshold = store.threshold

    # HGB saturates on the easy v1 data, so the top rows legitimately tie at
    # the same rounded risk score -- a plain `argsort` gives an arbitrary,
    # non-deterministic tie order (no stable secondary key). Deterministic
    # secondary sort: most-recent `snapshot_date` first (a real, meaningful
    # signal -- a more recently observed reading is more actionable than a
    # stale one at the same score), then `component_id` as a final total
    # tie-break so repeated calls always return the identical order. Not a
    # model change -- purely a display/ranking tie-break for ties the model
    # itself cannot resolve (no per-row margin/decision-function is exposed
    # by this classifier).
    snapshot_dates = pd.to_datetime(fleet_df["snapshot_date"])
    order = sorted(
        range(len(scores)),
        key=lambda i: (-float(scores[i]), -snapshot_dates.iloc[i].value, fleet_df.iloc[i]["component_id"]),
    )[:n]
    items = [_fleet_item(fleet_df.iloc[idx], float(scores[idx]), threshold) for idx in order]

    return FleetRiskResponse(
        model_id=store.model_id,
        threshold=threshold,
        split="test",
        n_scored=len(fleet_df),
        n_returned=len(items),
        items=items,
    )


@app.get("/fleet/components/{component_id}", response_model=FleetRiskItem)
def fleet_component(component_id: str) -> FleetRiskItem:
    """One component's live-scored latest snapshot (same shape as a
    ``/fleet/top-risk`` item, including ``features``)."""
    _require_model()
    fleet_df = store.test_latest_df
    matches = fleet_df.index[fleet_df["component_id"] == component_id]
    if len(matches) == 0:
        raise HTTPException(status_code=404, detail=f"component {component_id} not in the scored fleet")
    row_df = fleet_df.loc[matches[:1]]
    score = float(predict_scores(store.pipeline, row_df)[0])
    return _fleet_item(row_df.iloc[0], score, store.threshold)
