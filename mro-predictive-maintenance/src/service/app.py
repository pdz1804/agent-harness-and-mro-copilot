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

from src import config
from src.explainability import shap_contributions_for_rows
from src.modeling import ALL_FEATURES, CATEGORICAL_FEATURES, NUMERIC_FEATURES, predict_scores
from src.service.model_store import ModelNotLoadedError, feature_row_from_payload, store
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
    try:
        store.load()
    except FileNotFoundError as exc:
        # Don't crash the process -- /health reports the problem clearly and
        # every other endpoint returns 503 until artifacts exist and the
        # service is restarted (no silent fallback to a stale/fake model).
        print(f"WARNING: model artifacts not loaded at startup: {exc}")
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
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)


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
    )


@app.post("/score", response_model=ScoreResponse)
def score(request: ScoreRequest) -> ScoreResponse:  # type: ignore[valid-type]
    _require_model()
    payload = request.model_dump()
    component_id = payload.pop("component_id", None)

    row_df = feature_row_from_payload(payload)
    try:
        risk_score = float(predict_scores(store.pipeline, row_df)[0])
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
    )


@app.get("/fleet/top-risk", response_model=FleetRiskResponse)
def fleet_top_risk(n: int = 10) -> FleetRiskResponse:
    _require_model()
    if n < 1:
        raise HTTPException(status_code=422, detail="n must be >= 1")

    fleet_df = store.test_latest_df
    scores = predict_scores(store.pipeline, fleet_df)
    threshold = store.threshold

    order = scores.argsort()[::-1][:n]
    items = []
    for idx in order:
        row = fleet_df.iloc[idx]
        features = {f: (None if pd.isna(row[f]) else row[f]) for f in ALL_FEATURES}
        items.append(
            FleetRiskItem(
                component_id=row["component_id"],
                aircraft_id=row["aircraft_id"],
                component_type=row["component_type"],
                cycle=float(row["cycle"]),
                snapshot_date=str(row["snapshot_date"]),
                risk_score=float(scores[idx]),
                alert=bool(scores[idx] >= threshold),
                true_label=int(row["label"]),
                features=features,
            )
        )

    return FleetRiskResponse(
        model_id=store.model_id,
        threshold=threshold,
        split="test",
        n_scored=len(fleet_df),
        n_returned=len(items),
        items=items,
    )

