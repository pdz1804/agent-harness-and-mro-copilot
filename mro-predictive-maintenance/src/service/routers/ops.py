"""``/ops`` FastAPI router: fleet-scan, alerts, work orders, aircraft status,
reliability KPIs.

Actor identity: this is a demo service with no auth. The acting user comes
from the ``X-User`` request header (default ``engineer.demo``) -- documented
limitation, not a real authorization boundary. Work-order creation and
aircraft-status changes are gated purely on a non-empty approver string
(``src.ops.service.create_work_order`` / ``set_aircraft_status``), which is
enough to prove "impossible without an approver" in tests but is NOT an
authentication system.
"""

from __future__ import annotations

import json
from typing import Optional

import pandas as pd
from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel, ConfigDict
from sqlalchemy import Engine, func, select
from sqlalchemy.engine import Connection

from src import config
from src.ops import kpis as ops_kpis
from src.ops import service as ops_service
from src.ops.db import alert_events, alerts, aircraft_status, predictions, work_orders
from src.service.routers import monitoring as monitoring_router

router = APIRouter(prefix="/ops", tags=["ops"])

# Set once at service startup (see app.py's lifespan handler). Tests override
# via `app.dependency_overrides[get_engine] = lambda: <tmp engine>` -- never
# touches this module state, so tests never share a database file.
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
    # Imported lazily so this module has no import-time dependency on the
    # ML model artifacts being present (ops tests that don't hit
    # /ops/fleet-scan never need a loaded model).
    from src.service.model_store import store

    return store


class FleetScanRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    window_days: int = 30


class AlertTransitionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    action: str
    note: Optional[str] = None


class WorkOrderCreateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    aircraft_id: str
    component_id: str
    approved_by: str
    alert_id: Optional[int] = None
    task_ref: Optional[str] = None
    priority: str = "routine"
    notes: Optional[str] = None


class WorkOrderCloseRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    outcome: str
    notes: Optional[str] = None


class AircraftStatusRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    status: str
    mel_item: Optional[str] = None
    reason: Optional[str] = None


@router.post("/fleet-scan")
def fleet_scan(
    body: FleetScanRequest = FleetScanRequest(), conn: Connection = Depends(get_conn),
):
    store = _current_store()
    if not store.loaded:
        raise HTTPException(status_code=503, detail="model not loaded; cannot fleet-scan")
    result = ops_service.fleet_scan(conn, store, window_days=body.window_days)
    # The scan just logged fresh predictions; persist the PSI snapshot for them.
    monitoring_router.snapshot_drift(conn, "fleet_scan", window_days=body.window_days)
    return result.as_dict()


@router.get("/alerts")
def list_alerts(
    status: Optional[str] = None, aircraft_id: Optional[str] = None,
    conn: Connection = Depends(get_conn),
):
    stmt = select(alerts)
    if status is not None:
        stmt = stmt.where(alerts.c.status == status)
    if aircraft_id is not None:
        stmt = stmt.where(alerts.c.aircraft_id == aircraft_id)
    rows = conn.execute(stmt.order_by(alerts.c.opened_at.desc())).mappings().all()
    return [dict(r) for r in rows]


def _alert_or_404(conn: Connection, alert_id: int) -> dict:
    row = conn.execute(select(alerts).where(alerts.c.id == alert_id)).mappings().first()
    if row is None:
        raise HTTPException(status_code=404, detail=f"alert {alert_id} not found")
    return dict(row)


def _full_alert(conn: Connection, alert_id: int) -> dict:
    alert = _alert_or_404(conn, alert_id)
    events = conn.execute(
        select(alert_events).where(alert_events.c.alert_id == alert_id).order_by(alert_events.c.at)
    ).mappings().all()
    wos = conn.execute(
        select(work_orders).where(work_orders.c.alert_id == alert_id)
    ).mappings().all()
    alert["events"] = [dict(e) for e in events]
    alert["work_orders"] = [dict(w) for w in wos]
    return alert


@router.get("/alerts/{alert_id}")
def get_alert(alert_id: int, conn: Connection = Depends(get_conn)):
    return _full_alert(conn, alert_id)


@router.post("/alerts/{alert_id}/transition")
def transition_alert(
    alert_id: int, body: AlertTransitionRequest,
    x_user: str = Header(default="engineer.demo"),
    conn: Connection = Depends(get_conn),
):
    _alert_or_404(conn, alert_id)
    try:
        ops_service.transition_alert(conn, alert_id, body.action, actor=x_user, note=body.note)
    except ops_service.InvalidTransition as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return _full_alert(conn, alert_id)


@router.get("/work-orders")
def list_work_orders(
    status: Optional[str] = None, aircraft_id: Optional[str] = None,
    conn: Connection = Depends(get_conn),
):
    stmt = select(work_orders)
    if status is not None:
        stmt = stmt.where(work_orders.c.status == status)
    if aircraft_id is not None:
        stmt = stmt.where(work_orders.c.aircraft_id == aircraft_id)
    rows = conn.execute(stmt.order_by(work_orders.c.created_at.desc())).mappings().all()
    return [dict(r) for r in rows]


@router.post("/work-orders", status_code=201)
def create_work_order(
    body: WorkOrderCreateRequest, x_user: str = Header(default="engineer.demo"),
    conn: Connection = Depends(get_conn),
):
    try:
        return ops_service.create_work_order(
            conn,
            aircraft_id=body.aircraft_id,
            component_id=body.component_id,
            alert_id=body.alert_id,
            task_ref=body.task_ref,
            priority=body.priority,
            created_by=x_user,
            approved_by=body.approved_by,
            notes=body.notes,
        )
    except ops_service.ApprovalRequiredError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.post("/work-orders/{wo_id}/close")
def close_work_order(wo_id: str, body: WorkOrderCloseRequest, conn: Connection = Depends(get_conn)):
    try:
        return ops_service.close_work_order(conn, wo_id, body.outcome, body.notes)
    except ops_service.InvalidTransition as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.post("/aircraft/{aircraft_id}/status")
def set_aircraft_status(
    aircraft_id: str, body: AircraftStatusRequest, x_user: str = Header(default="engineer.demo"),
    conn: Connection = Depends(get_conn),
):
    try:
        return ops_service.set_aircraft_status(
            conn, aircraft_id, body.status, updated_by=x_user,
            mel_item=body.mel_item, reason=body.reason,
        )
    except ops_service.ApprovalRequiredError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


_EVENTS_CACHE: dict[str, object] = {"mtime": None, "df": None}


def _maintenance_events() -> pd.DataFrame:
    """maintenance_events.csv, re-read only when the file changes."""
    path = config.MAINTENANCE_EVENTS_CSV
    if not path.exists():
        return pd.DataFrame(columns=["component_id", "cycle_at_event", "event_date", "event_type"])
    mtime = path.stat().st_mtime
    if _EVENTS_CACHE["mtime"] != mtime:
        _EVENTS_CACHE["df"] = pd.read_csv(path)
        _EVENTS_CACHE["mtime"] = mtime
    return _EVENTS_CACHE["df"]  # type: ignore[return-value]


def _component_known(conn: Connection, component_id: str, events: pd.DataFrame) -> bool:
    if conn.execute(
        select(predictions.c.id).where(predictions.c.component_id == component_id).limit(1)
    ).first() is not None:
        return True
    if config.COMPONENTS_CSV.exists():
        ids = pd.read_csv(config.COMPONENTS_CSV, usecols=["component_id"])["component_id"]
        if (ids == component_id).any():
            return True
    return bool((events["component_id"] == component_id).any())


@router.get("/components/{component_id}/history")
def component_history(component_id: str, conn: Connection = Depends(get_conn)):
    events = _maintenance_events()
    if not _component_known(conn, component_id, events):
        raise HTTPException(status_code=404, detail=f"component {component_id} not found")

    pred_rows = conn.execute(
        select(predictions).where(predictions.c.component_id == component_id)
        .order_by(predictions.c.scored_at, predictions.c.id)
    ).mappings().all()
    event_rows = events[events["component_id"] == component_id].sort_values(["event_date", "cycle_at_event"])
    return {
        "component_id": component_id,
        "predictions": [
            {
                "scored_at": r["scored_at"], "snapshot_date": r["snapshot_date"],
                "cycle": r["cycle"], "risk_score": r["risk_score"], "threshold": r["threshold"],
                "alert": bool(r["alert"]), "model_version": r["model_version"],
            }
            for r in pred_rows
        ],
        # maintenance_events.csv carries no free-text column, so `note` is always null.
        "maintenance_events": [
            {
                "date": str(e.event_date), "cycle": float(e.cycle_at_event),
                "event_type": e.event_type, "note": None,
            }
            for e in event_rows.itertuples(index=False)
        ],
    }


@router.get("/aircraft")
def list_aircraft(conn: Connection = Depends(get_conn)):
    """Aircraft index: every aircraft the ops store or the scored fleet knows."""
    status_by_ac = {
        r["aircraft_id"]: r["status"]
        for r in conn.execute(select(aircraft_status)).mappings().all()
    }
    open_alerts: dict[str, int] = {}
    for (ac,) in conn.execute(
        select(alerts.c.aircraft_id).where(alerts.c.status.in_(["open", "acknowledged", "wo_raised"]))
    ).all():
        open_alerts[ac] = open_alerts.get(ac, 0) + 1
    open_wos: dict[str, int] = {}
    for (ac,) in conn.execute(
        select(work_orders.c.aircraft_id).where(work_orders.c.status != "closed")
    ).all():
        open_wos[ac] = open_wos.get(ac, 0) + 1

    # Latest prediction per component (highest id = most recent scan), then max per aircraft.
    latest_ids = select(func.max(predictions.c.id)).group_by(predictions.c.component_id)
    max_risk: dict[str, float] = {}
    for ac, score in conn.execute(
        select(predictions.c.aircraft_id, predictions.c.risk_score).where(predictions.c.id.in_(latest_ids))
    ).all():
        max_risk[ac] = max(score, max_risk.get(ac, score))

    ids = set(status_by_ac) | set(open_alerts) | set(open_wos) | set(max_risk)
    store = _current_store()
    if store.loaded and store.test_latest_df is not None:
        ids |= set(store.test_latest_df["aircraft_id"])

    return [
        {
            "aircraft_id": ac,
            "status": status_by_ac.get(ac, "serviceable"),
            "n_open_alerts": open_alerts.get(ac, 0),
            "n_open_wos": open_wos.get(ac, 0),
            "max_risk": max_risk.get(ac),
        }
        for ac in sorted(ids)
    ]


@router.get("/aircraft/{aircraft_id}")
def get_aircraft(aircraft_id: str, conn: Connection = Depends(get_conn)):
    status_row = conn.execute(
        select(aircraft_status).where(aircraft_status.c.aircraft_id == aircraft_id)
    ).mappings().first()

    # Latest prediction per component for this aircraft (last scored_at per component_id).
    pred_rows = conn.execute(
        select(predictions).where(predictions.c.aircraft_id == aircraft_id)
        .order_by(predictions.c.component_id, predictions.c.scored_at.desc())
    ).mappings().all()
    latest_by_component: dict[str, dict] = {}
    for row in pred_rows:
        latest_by_component.setdefault(row["component_id"], dict(row))

    open_alerts = conn.execute(
        select(alerts).where(
            alerts.c.aircraft_id == aircraft_id, alerts.c.status.in_(["open", "acknowledged", "wo_raised"]),
        )
    ).mappings().all()
    open_wos = conn.execute(
        select(work_orders).where(
            work_orders.c.aircraft_id == aircraft_id, work_orders.c.status != "closed",
        )
    ).mappings().all()

    return {
        "aircraft_id": aircraft_id,
        "status": dict(status_row) if status_row is not None else {
            "aircraft_id": aircraft_id, "status": "serviceable", "mel_item": None,
            "updated_at": None, "updated_by": None, "reason": None,
        },
        "components": list(latest_by_component.values()),
        "open_alerts": [dict(a) for a in open_alerts],
        "open_work_orders": [dict(w) for w in open_wos],
    }


@router.get("/reliability")
def reliability(conn: Connection = Depends(get_conn)):
    if not config.COMPONENTS_CSV.exists() or not config.AIRCRAFT_CSV.exists():
        raise HTTPException(status_code=503, detail="raw fleet tables not found; run data generation first")
    components_df = pd.read_csv(config.COMPONENTS_CSV)
    aircraft_df = pd.read_csv(config.AIRCRAFT_CSV)
    return ops_kpis.reliability_kpis(conn, components_df, aircraft_df)
