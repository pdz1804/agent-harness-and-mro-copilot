"""Persistence for the `incidents` table and its open -> acknowledged -> resolved lifecycle.

`status` values: `open`, `acknowledged`, `resolved`. Rows written before the
lifecycle existed carry the legacy status `created`; it is treated as `open`
everywhere (`normalize_status`) and rewritten by the migration.
"""

from __future__ import annotations

from typing import Any, Optional

from agent_harness.repos.base import connect, require_row

OPEN_STATUSES = ("open", "acknowledged", "created")
LIFECYCLE = ("open", "acknowledged", "resolved")

# Allowed transitions: an incident only moves forward, and may be resolved
# straight from `open` (nobody has to acknowledge a trivial one first).
_TRANSITIONS: dict[str, set[str]] = {
    "open": {"acknowledged", "resolved"},
    "acknowledged": {"resolved"},
    "resolved": set(),
}


class IncidentTransitionError(ValueError):
    """The requested lifecycle move is not allowed from the incident's current status."""


def normalize_status(status: str) -> str:
    return "open" if status == "created" else status


def _shape(row: dict[str, Any]) -> dict[str, Any]:
    out = dict(row)
    out["status"] = normalize_status(out["status"])
    return out


def find_incident(run_id: str, title: str, dsn: Optional[str] = None) -> Optional[dict[str, Any]]:
    """Idempotency lookup: has this exact run already created an incident
    with this title? Empty/blank `run_id` never matches (no idempotency
    scope outside a run)."""
    if not run_id:
        return None
    with connect(dsn) as conn:
        row = conn.execute("SELECT * FROM incidents WHERE run_id = %s AND title = %s", (run_id, title)).fetchone()
        return _shape(row) if row else None


def insert_incident(
    incident_id: str,
    title: str,
    description: str,
    severity: str,
    status: str,
    created_at: str,
    run_id: str,
    service_name: Optional[str] = None,
    created_by: Optional[str] = None,
    dsn: Optional[str] = None,
) -> dict[str, Any]:
    with connect(dsn) as conn:
        conn.execute(
            "INSERT INTO incidents (id, title, description, severity, status, created_at, run_id, "
            "service_name, created_by) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)",
            (incident_id, title, description, severity, status, created_at, run_id, service_name, created_by),
        )
    return {
        "id": incident_id,
        "title": title,
        "description": description,
        "severity": severity,
        "status": normalize_status(status),
        "created_at": created_at,
        "run_id": run_id,
        "service_name": service_name,
        "created_by": created_by,
    }


def get_incident(incident_id: str, dsn: Optional[str] = None) -> Optional[dict[str, Any]]:
    with connect(dsn) as conn:
        row = conn.execute("SELECT * FROM incidents WHERE id = %s", (incident_id,)).fetchone()
        return _shape(row) if row else None


def list_incidents(
    dsn: Optional[str] = None,
    owner_id: Optional[str] = None,
    status: Optional[str] = None,
    service_name: Optional[str] = None,
) -> list[dict[str, Any]]:
    """Every incident, or - when `owner_id` is given - only those raised by
    that user's own runs (an incident with no originating run belongs to
    nobody in particular and is admin-only). Optional `status` / `service_name`
    filters."""
    clauses: list[str] = []
    params: list[Any] = []
    if owner_id is not None:
        clauses.append("run_id IN (SELECT run_id FROM runs WHERE owner_id = %s)")
        params.append(owner_id)
    if status is not None:
        wanted = ("open", "created") if status == "open" else (status,)
        clauses.append("status = ANY(%s)")
        params.append(list(wanted))
    if service_name is not None:
        clauses.append("service_name = %s")
        params.append(service_name)
    where = f" WHERE {' AND '.join(clauses)}" if clauses else ""
    with connect(dsn) as conn:
        rows = conn.execute(f"SELECT * FROM incidents{where} ORDER BY created_at DESC", tuple(params)).fetchall()
        return [_shape(r) for r in rows]


def find_open_for_service(
    service_name: str, owner_id: Optional[str] = None, dsn: Optional[str] = None
) -> list[dict[str, Any]]:
    """Open or acknowledged incidents already raised for `service_name` — the
    duplicate check behind the agent warning. `owner_id` scopes it to the
    incidents the caller may see (None = everyone's)."""
    clauses = ["lower(service_name) = lower(%s)", "status = ANY(%s)"]
    params: list[Any] = [service_name, list(OPEN_STATUSES)]
    if owner_id is not None:
        clauses.append("run_id IN (SELECT run_id FROM runs WHERE owner_id = %s)")
        params.append(owner_id)
    with connect(dsn) as conn:
        rows = conn.execute(
            f"SELECT * FROM incidents WHERE {' AND '.join(clauses)} ORDER BY created_at DESC", tuple(params)
        ).fetchall()
        return [_shape(r) for r in rows]


def transition_incident(
    incident_id: str,
    new_status: str,
    actor_id: str,
    at: str,
    note: Optional[str] = None,
    dsn: Optional[str] = None,
) -> Optional[dict[str, Any]]:
    """Move an incident along its lifecycle, recording who and when. Returns
    the updated row, or None for an unknown id. Raises `IncidentTransitionError`
    for a move the lifecycle does not allow (e.g. re-acknowledging, or reopening
    a resolved incident)."""
    if new_status not in LIFECYCLE:
        raise IncidentTransitionError(f"unknown status '{new_status}'")
    with connect(dsn) as conn:
        row = conn.execute("SELECT * FROM incidents WHERE id = %s FOR UPDATE", (incident_id,)).fetchone()
        if row is None:
            return None
        current = normalize_status(row["status"])
        if new_status not in _TRANSITIONS[current]:
            raise IncidentTransitionError(f"cannot move an incident from '{current}' to '{new_status}'")
        if new_status == "acknowledged":
            conn.execute(
                "UPDATE incidents SET status = 'acknowledged', acknowledged_by = %s, acknowledged_at = %s WHERE id = %s",
                (actor_id, at, incident_id),
            )
        else:
            conn.execute(
                "UPDATE incidents SET status = 'resolved', resolved_by = %s, resolved_at = %s, "
                "resolution_note = %s WHERE id = %s",
                (actor_id, at, note, incident_id),
            )
        updated = require_row(conn.execute("SELECT * FROM incidents WHERE id = %s", (incident_id,)).fetchone())
        return _shape(updated)
