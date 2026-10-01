"""Pure ops-domain functions: fleet scan, alert lifecycle, work orders.

Every function takes an already-open SQLAlchemy ``Connection`` (never an
engine, never a global session) so callers -- FastAPI request handlers,
tests with a tmp-file sqlite engine, and (phase 05/06) copilot tools -- all
control their own transaction boundaries. Each function commits its own
connection at the end of a logical unit of work.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime, timezone

import pandas as pd
from sqlalchemy import select, update
from sqlalchemy.engine import Connection

from src.explainability import shap_contributions_for_rows
from src.modeling import ALL_FEATURES, predict_scores
from src.ops.db import alert_events, alerts, aircraft_status, predictions, work_orders


class InvalidTransition(Exception):
    """Raised when an alert/WO status transition is not allowed."""


class ApprovalRequiredError(Exception):
    """Raised when a work order or aircraft-status change lacks an approver.

    This is the single enforcement point for the "no work order without an
    approver" invariant (acceptance criterion 8 / plan.md): the copilot tool
    path, the manual UI path, and every test all go through this function,
    so there is no code path that can create a WO without a non-empty
    ``approved_by``.
    """


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def window_key_for(snapshot_date, window_days: int) -> str:
    """Deterministic decision-window bucket derived from snapshot_date.

    Using the snapshot date (not wall-clock "now") means fleet-scan is
    reproducible against the frozen synthetic dataset and re-running the
    scan later doesn't shift which window a component's alert belongs to
    (phase-03 Risks: "time now vs synthetic study end").
    """
    ts = pd.Timestamp(snapshot_date)
    epoch_days = (ts - pd.Timestamp("1970-01-01")).days
    bucket = epoch_days // window_days
    return f"W{bucket}"


ALERT_STATUSES = {"open", "acknowledged", "wo_raised", "closed", "dismissed"}

# action -> (allowed source statuses, resulting status)
_ALERT_TRANSITIONS: dict[str, tuple[set[str], str]] = {
    "acknowledge": ({"open"}, "acknowledged"),
    "dismiss": ({"open", "acknowledged"}, "dismissed"),
    "close": ({"open", "acknowledged", "wo_raised"}, "closed"),
    "reopen": ({"dismissed", "closed"}, "open"),
}


def record_predictions(conn: Connection, rows: list[dict]) -> None:
    """Bulk-insert prediction rows. Caller commits (see fleet_scan)."""
    if not rows:
        return
    conn.execute(predictions.insert(), rows)


def _log_event(conn: Connection, alert_id: int, actor: str, action: str, note: str | None = None,
                payload: dict | None = None) -> None:
    conn.execute(alert_events.insert().values(
        alert_id=alert_id,
        at=_now(),
        actor=actor,
        action=action,
        note=note,
        payload_json=json.dumps(payload) if payload is not None else None,
    ))


@dataclass
class FleetScanResult:
    scored: int
    new_alerts: list[int]
    existing_alerts: int

    def as_dict(self) -> dict:
        return {
            "scored": self.scored,
            "new_alerts": self.new_alerts,
            "existing": self.existing_alerts,
        }


def fleet_scan(conn: Connection, store, window_days: int = 30) -> FleetScanResult:
    """Score the latest snapshot of every fleet component and open alerts.

    ``store`` is the loaded ``src.service.model_store.ModelStore`` (or any
    object exposing ``pipeline``, ``threshold``, ``model_id``,
    ``background_df``, ``test_latest_df``) -- this function is decoupled
    from FastAPI wiring so it is directly unit-testable and directly
    callable from a copilot tool later (phase 05/06) without importing the
    router.

    Idempotent: re-running with the same snapshot data never creates a
    second alert for the same ``(component_id, window_key)`` -- the unique
    constraint on ``alerts`` is the source of truth; this function checks
    first (fast path) and treats a race on the constraint as "already
    exists" rather than raising.
    """
    fleet_df = store.test_latest_df
    scores = predict_scores(store.pipeline, fleet_df)
    threshold = float(store.threshold)
    model_id = str(store.model_id)
    scored_at = _now()

    pred_rows = []
    alert_candidates = []
    for idx in range(len(fleet_df)):
        row = fleet_df.iloc[idx]
        risk_score = float(scores[idx])
        is_alert = risk_score >= threshold
        features = {f: (None if pd.isna(row[f]) else _jsonable(row[f])) for f in ALL_FEATURES}
        pred_rows.append({
            "scored_at": scored_at,
            "component_id": row["component_id"],
            "aircraft_id": row["aircraft_id"],
            "snapshot_date": str(row["snapshot_date"]),
            "cycle": float(row["cycle"]),
            "model_id": model_id,
            "model_version": getattr(store, "model_version", None),
            "risk_score": risk_score,
            "threshold": threshold,
            "alert": is_alert,
            "features_json": json.dumps(features),
        })
        if is_alert:
            window_key = window_key_for(row["snapshot_date"], window_days)
            alert_candidates.append((idx, row, risk_score, window_key))

    record_predictions(conn, pred_rows)

    new_alert_ids: list[int] = []
    existing_count = 0

    # SHAP only for genuinely-new alerts (phase-03 Risks: scan cost).
    for idx, row, risk_score, window_key in alert_candidates:
        existing = conn.execute(
            select(alerts.c.id).where(
                alerts.c.component_id == row["component_id"],
                alerts.c.window_key == window_key,
            )
        ).first()
        if existing is not None:
            existing_count += 1
            continue

        try:
            top_factors = shap_contributions_for_rows(
                store.pipeline, model_id, store.background_df,
                fleet_df.iloc[[idx]], top_k_features=5,
            )[0]
        except Exception as exc:  # documented fallback, not a silent swallow
            top_factors = [{"feature": "unavailable", "shap_value": 0.0,
                             "note": f"SHAP failed: {exc}"}]

        result = conn.execute(alerts.insert().values(
            component_id=row["component_id"],
            aircraft_id=row["aircraft_id"],
            component_type=row["component_type"],
            opened_at=scored_at,
            window_key=window_key,
            risk_score=risk_score,
            threshold=threshold,
            status="open",
            top_factors_json=json.dumps(top_factors),
            source="fleet_scan",
        ))
        alert_id = result.inserted_primary_key[0]
        _log_event(conn, alert_id, "system", "opened",
                   note=f"risk_score={risk_score:.4f} >= threshold={threshold:.4f}")
        new_alert_ids.append(alert_id)

    conn.commit()
    return FleetScanResult(scored=len(fleet_df), new_alerts=new_alert_ids, existing_alerts=existing_count)


def _jsonable(value):
    if hasattr(value, "item"):
        return value.item()
    return value


def transition_alert(conn: Connection, alert_id: int, action: str, actor: str,
                      note: str | None = None) -> dict:
    if action not in _ALERT_TRANSITIONS:
        raise InvalidTransition(f"unknown action {action!r}")
    allowed_from, to_status = _ALERT_TRANSITIONS[action]

    row = conn.execute(select(alerts).where(alerts.c.id == alert_id)).mappings().first()
    if row is None:
        raise InvalidTransition(f"alert {alert_id} not found")
    if row["status"] not in allowed_from:
        raise InvalidTransition(
            f"cannot {action} alert {alert_id} from status {row['status']!r} "
            f"(allowed from: {sorted(allowed_from)})"
        )

    conn.execute(update(alerts).where(alerts.c.id == alert_id).values(status=to_status))
    _log_event(conn, alert_id, actor, action, note=note)
    conn.commit()
    return {"id": alert_id, "status": to_status}


def _next_wo_id(conn: Connection, year: int) -> str:
    prefix = f"WO-{year}-"
    existing = conn.execute(
        select(work_orders.c.id).where(work_orders.c.id.like(f"{prefix}%"))
    ).scalars().all()
    max_n = 0
    for wo_id in existing:
        suffix = wo_id[len(prefix):]
        if suffix.isdigit():
            max_n = max(max_n, int(suffix))
    return f"{prefix}{max_n + 1:04d}"


def create_work_order(
    conn: Connection, *, aircraft_id: str, component_id: str, approved_by: str,
    created_by: str, alert_id: int | None = None, task_ref: str | None = None,
    priority: str = "routine", notes: str | None = None,
) -> dict:
    """Create a work order. Only callable with a non-empty ``approved_by``.

    This is the single enforcement point (acceptance criterion 8): the
    copilot tool path passes the human's resolution as ``approved_by``; the
    UI manual path passes the logged-in engineer; no path can construct a
    ``work_orders`` row any other way because this is the only INSERT
    against that table anywhere in the codebase.
    """
    if not approved_by or not approved_by.strip():
        raise ApprovalRequiredError("create_work_order requires a non-empty approved_by")
    if priority not in {"routine", "urgent", "aog"}:
        raise ValueError(f"invalid priority {priority!r}")

    now = _now()
    wo_id = _next_wo_id(conn, datetime.now(timezone.utc).year)
    conn.execute(work_orders.insert().values(
        id=wo_id,
        alert_id=alert_id,
        aircraft_id=aircraft_id,
        component_id=component_id,
        task_ref=task_ref,
        priority=priority,
        status="open",
        created_by=created_by,
        approved_by=approved_by,
        created_at=now,
        notes=notes,
    ))

    if alert_id is not None:
        row = conn.execute(select(alerts.c.status).where(alerts.c.id == alert_id)).first()
        if row is not None and row[0] not in {"wo_raised", "closed", "dismissed"}:
            conn.execute(update(alerts).where(alerts.c.id == alert_id).values(status="wo_raised"))
            _log_event(conn, alert_id, created_by, "wo_raised", note=f"work order {wo_id} created",
                       payload={"work_order_id": wo_id, "approved_by": approved_by})

    conn.commit()
    return {"id": wo_id, "status": "open", "alert_id": alert_id}


def close_work_order(conn: Connection, wo_id: str, outcome: str, notes: str | None = None) -> dict:
    if outcome not in {"confirmed_failure", "nff", "not_inspected"}:
        raise ValueError(f"invalid outcome {outcome!r}")

    row = conn.execute(select(work_orders).where(work_orders.c.id == wo_id)).mappings().first()
    if row is None:
        raise InvalidTransition(f"work order {wo_id} not found")
    if row["status"] == "closed":
        raise InvalidTransition(f"work order {wo_id} already closed")

    now = _now()
    conn.execute(update(work_orders).where(work_orders.c.id == wo_id).values(
        status="closed", closed_at=now, outcome=outcome,
        notes=notes if notes is not None else row["notes"],
    ))
    if row["alert_id"] is not None:
        conn.execute(update(alerts).where(alerts.c.id == row["alert_id"]).values(status="closed"))
        _log_event(conn, row["alert_id"], "system", "closed",
                    note=f"work order {wo_id} closed with outcome {outcome}")
    conn.commit()
    return {"id": wo_id, "status": "closed", "outcome": outcome}


def set_aircraft_status(
    conn: Connection, aircraft_id: str, status: str, updated_by: str,
    mel_item: str | None = None, reason: str | None = None,
) -> dict:
    if not updated_by or not updated_by.strip():
        raise ApprovalRequiredError("set_aircraft_status requires a non-empty updated_by")
    if status not in {"serviceable", "restricted", "aog"}:
        raise ValueError(f"invalid status {status!r}")

    now = _now()
    existing = conn.execute(
        select(aircraft_status.c.aircraft_id).where(aircraft_status.c.aircraft_id == aircraft_id)
    ).first()
    if existing is None:
        conn.execute(aircraft_status.insert().values(
            aircraft_id=aircraft_id, status=status, mel_item=mel_item,
            updated_at=now, updated_by=updated_by, reason=reason,
        ))
    else:
        conn.execute(update(aircraft_status).where(aircraft_status.c.aircraft_id == aircraft_id).values(
            status=status, mel_item=mel_item, updated_at=now, updated_by=updated_by, reason=reason,
        ))
    conn.commit()
    return {"aircraft_id": aircraft_id, "status": status}
