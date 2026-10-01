"""``/monitoring`` and ``/models`` FastAPI routes: data/score drift, live
performance, and MLflow registry status.

Follows the same dependency-injection pattern as
``src/service/routers/ops.py`` (module-level engine set at startup via
``init_engine``, overridable per-test) so this router shares one ops
database with fleet-scan/alerts/work-orders without importing app.py.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Optional

import pandas as pd
from fastapi import APIRouter, Depends, Header, HTTPException, Query
from pydantic import BaseModel, ConfigDict
from sqlalchemy import Engine, select
from sqlalchemy.engine import Connection

from src import config, monitoring, tracking
from src.copilot import identity
from src.modeling import ALL_FEATURES, predict_scores
from src.ops import drift_history
from src.ops import kpis as ops_kpis
from src.ops.db import predictions
from src.service.retrain_jobs import RetrainBusyError, jobs as retrain_jobs

logger = logging.getLogger(__name__)

router = APIRouter(tags=["monitoring"])

_module_state: dict[str, object] = {"engine": None}


def init_engine(engine: Engine) -> None:
    _module_state["engine"] = engine


def get_engine() -> Engine:
    engine = _module_state.get("engine")
    if engine is None:
        raise HTTPException(status_code=503, detail="ops database not initialized")
    return engine


def get_conn(engine: Engine = Depends(get_engine)):
    with engine.connect() as conn:
        yield conn


def _current_store():
    # Lazy import -- see ops.py's identical rationale: this router must not
    # require a loaded model to be importable (drift can theoretically run
    # against logged predictions alone in the future).
    from src.service.model_store import store

    return store


def _predictions_window_df(conn: Connection, window_days: int) -> Optional[pd.DataFrame]:
    """Reconstruct a feature dataframe from the most recent `window_days`
    of the ops predictions log (phase 03), or None if empty/absent."""
    rows = conn.execute(
        select(predictions).order_by(predictions.c.scored_at.desc()).limit(5000)
    ).mappings().all()
    if not rows:
        return None

    import json as _json

    records = []
    for row in rows:
        record = _json.loads(row["features_json"])
        record["risk_score"] = row["risk_score"]
        records.append(record)
    return pd.DataFrame.from_records(records)


def _current_window_df(conn: Connection, window_days: int) -> tuple[pd.DataFrame, str]:
    """Current-window features: predictions log if any rows exist, else the
    latest test-split snapshot (guaranteed present once a model is loaded).
    Returns (dataframe, source_label) for the response to be honest about
    which source was used.
    """
    from_log = _predictions_window_df(conn, window_days)
    if from_log is not None and len(from_log) > 0:
        return from_log, "predictions_log"

    store = _current_store()
    if store.loaded and store.test_latest_df is not None:
        return store.test_latest_df.copy(), "test_split_fallback"

    return pd.DataFrame(columns=ALL_FEATURES), "no_data"


def compute_drift_report(conn: Connection, window_days: int, simulate: Optional[str] = None) -> dict:
    ref_df = monitoring.load_reference_profile()
    if ref_df is None:
        raise HTTPException(
            status_code=503,
            detail="no reference profile at reports/reference_profile.csv; run `python -m src.pipeline` first",
        )

    cur_df, source = _current_window_df(conn, window_days)
    scores_ref = None
    scores_cur = None
    store = _current_store()

    if simulate == "shift":
        cur_df = monitoring.simulate_shift(cur_df)

    if store.loaded and len(cur_df) > 0:
        try:
            scores_ref = predict_scores(store.pipeline, ref_df[ALL_FEATURES])
            scores_cur = predict_scores(store.pipeline, cur_df[ALL_FEATURES])
        except Exception:  # noqa: BLE001 - drift on features alone still works without scores
            scores_ref = None
            scores_cur = None

    report = monitoring.drift_report(ref_df, cur_df, scores_ref, scores_cur)
    report["current_source"] = source
    report["simulated_shift_applied"] = simulate == "shift"
    return report


def snapshot_drift(conn: Connection, trigger: str, window_days: int = 30) -> None:
    """Compute drift on the real current window and persist the PSI snapshot.
    Never raises: a missing reference profile or a failed write must not break
    the caller (e.g. a fleet scan)."""
    try:
        report = compute_drift_report(conn, window_days)
        drift_history.record_snapshot(conn, report, trigger)
    except Exception:  # noqa: BLE001 - snapshotting is best-effort telemetry
        logger.warning("drift snapshot (%s) failed", trigger, exc_info=True)


@router.get("/monitoring/drift")
def drift(
    window_days: int = 30,
    simulate: Optional[str] = None,
    conn: Connection = Depends(get_conn),
):
    report = compute_drift_report(conn, window_days, simulate)
    if simulate != "shift":  # a simulated shift is not a measurement; never persist it
        try:
            drift_history.record_snapshot(conn, report, "drift_call")
        except Exception:  # noqa: BLE001 - history write must not fail the live read
            logger.warning("drift snapshot write failed", exc_info=True)
    return report


@router.get("/monitoring/drift/history")
def drift_history_endpoint(
    window_days: int = Query(30, ge=1, le=3650),
    points: int = Query(50, ge=1, le=1000),
    conn: Connection = Depends(get_conn),
):
    return {"points": drift_history.list_snapshots(conn, window_days, points)}


@router.get("/monitoring/performance")
def performance(conn: Connection = Depends(get_conn)):
    if not config.COMPONENTS_CSV.exists() or not config.AIRCRAFT_CSV.exists():
        return {
            "available": False,
            "reason": "raw fleet tables not found; run data generation first",
            "live_outcomes": None,
        }
    live_outcomes = ops_kpis.live_precision_and_nff(conn)
    return {"available": True, "reason": None, "live_outcomes": live_outcomes}


@router.get("/models")
def models():
    if not tracking.init_tracking():
        return {"tracking_enabled": False, "registered_model": tracking.REGISTERED_MODEL_NAME, "versions": []}

    import mlflow

    try:
        client = mlflow.MlflowClient()
        versions = client.search_model_versions(f"name='{tracking.REGISTERED_MODEL_NAME}'")
        aliases_by_version: dict[str, list[str]] = {}
        try:
            model = client.get_registered_model(tracking.REGISTERED_MODEL_NAME)
            for alias, version in (model.aliases or {}).items():
                aliases_by_version.setdefault(str(version), []).append(alias)
        except Exception:  # noqa: BLE001 - model may not exist yet
            pass

        return {
            "tracking_enabled": True,
            "registered_model": tracking.REGISTERED_MODEL_NAME,
            "versions": [
                {
                    "version": v.version,
                    "run_id": v.run_id,
                    "status": v.status,
                    "aliases": aliases_by_version.get(str(v.version), []),
                }
                for v in versions
            ],
        }
    except Exception as exc:  # noqa: BLE001 - registry query failure is a normal empty state
        return {
            "tracking_enabled": True,
            "registered_model": tracking.REGISTERED_MODEL_NAME,
            "versions": [],
            "note": f"registry query failed or model not yet registered: {exc}",
        }


class RetrainRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    promote_if_better: bool = False
    seed: Optional[int] = None


@router.post("/models/retrain", status_code=202)
def start_retrain(body: RetrainRequest = RetrainRequest(), x_user: Optional[str] = Header(default=None)):
    """Lead engineer only. Runs the real challenger-vs-champion gate in the
    background; poll ``GET /models/retrain/{run_id}`` for the decision."""
    if not identity.can_retrain(x_user):
        raise HTTPException(status_code=403, detail="retrain requires the lead.engineer identity (X-User)")
    try:
        job = retrain_jobs.start(x_user, promote_if_better=body.promote_if_better, seed=body.seed)
    except RetrainBusyError as exc:
        raise HTTPException(
            status_code=409, detail={"message": str(exc), "run_id": exc.run_id},
        ) from exc
    return {"run_id": job["run_id"], "status": job["status"]}


@router.get("/models/retrain/{run_id}")
def get_retrain(run_id: str):
    job = retrain_jobs.get(run_id)
    if job is None:
        raise HTTPException(status_code=404, detail=f"retrain run {run_id} not found")
    return job


@router.get("/models/{version}/metrics")
def model_version_metrics(version: str):
    if not tracking.init_tracking():
        raise HTTPException(status_code=503, detail="MLflow tracking is not enabled; no registry metrics")

    import mlflow
    from mlflow.exceptions import MlflowException

    client = mlflow.MlflowClient()
    try:
        mv = client.get_model_version(tracking.REGISTERED_MODEL_NAME, version)
    except MlflowException as exc:
        raise HTTPException(status_code=404, detail=f"model version {version} not found") from exc

    aliases = list(getattr(mv, "aliases", None) or [])
    run = client.get_run(mv.run_id) if mv.run_id else None
    metrics = dict(run.data.metrics) if run else {}
    threshold = None
    if run and "threshold" in run.data.params:
        try:
            threshold = float(run.data.params["threshold"])
        except ValueError:
            threshold = None
    return {
        "version": str(mv.version),
        "aliases": aliases,
        "test_metrics": metrics,
        "threshold": threshold,
        "trained_at": datetime.fromtimestamp(mv.creation_timestamp / 1000, tz=timezone.utc).isoformat(),
        "run_id": mv.run_id,
    }
