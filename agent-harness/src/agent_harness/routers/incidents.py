"""Incident routes: owner-scoped list/detail and the open -> acknowledged -> resolved lifecycle.

An incident is visible to the owner of the run that raised it, and to admins
(an incident with no originating run is admin-only). Acknowledging and
resolving need the `mutate_incidents` action (admin, editor) and are recorded
with who and when; the detail view links back to the originating run.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from agent_harness import db
from agent_harness.deps import CurrentUser, current_user, require
from agent_harness.repos import incidents as incidents_repo
from agent_harness.repos import users as users_repo
from agent_harness.routers.runs import owner_scope

router = APIRouter()

Status = Literal["open", "acknowledged", "resolved"]


class IncidentView(BaseModel):
    id: str
    title: str
    description: str
    severity: Literal["low", "medium", "high", "critical"]
    status: str
    created_at: str
    run_id: Optional[str] = None
    service_name: Optional[str] = None
    created_by: Optional[str] = None
    acknowledged_by: Optional[str] = None
    acknowledged_at: Optional[str] = None
    resolved_by: Optional[str] = None
    resolved_at: Optional[str] = None
    resolution_note: Optional[str] = None


class TimelineEntry(BaseModel):
    event: Literal["opened", "acknowledged", "resolved"]
    at: str
    actor_id: Optional[str] = None
    actor_name: Optional[str] = None
    note: Optional[str] = None


class OriginRun(BaseModel):
    run_id: str
    objective: str
    status: str
    session_id: Optional[str] = None


class IncidentDetail(IncidentView):
    timeline: list[TimelineEntry]
    run: Optional[OriginRun] = Field(default=None, description="The run that raised the incident, if it still exists.")
    related_open: list[IncidentView] = Field(
        default_factory=list, description="Other open or acknowledged incidents for the same service."
    )


class ResolveRequest(BaseModel):
    note: str = Field(default="", max_length=1000, description="What fixed it, for the record.")


def _can_see(incident: dict[str, Any], user: CurrentUser) -> bool:
    if user.role == "admin":
        return True
    if not incident.get("run_id"):
        return False
    run = db.get_run(incident["run_id"])
    return run is not None and run.get("owner_id") == user.id


def _get_visible_or_404(incident_id: str, user: CurrentUser) -> dict[str, Any]:
    incident = incidents_repo.get_incident(incident_id)
    if incident is None or not _can_see(incident, user):
        raise HTTPException(status_code=404, detail=f"unknown incident '{incident_id}'")
    return incident


def _name(user_id: Optional[str]) -> Optional[str]:
    if not user_id:
        return None
    row = users_repo.get_user(user_id)
    return row["display_name"] if row else user_id


def _view(row: dict[str, Any]) -> IncidentView:
    return IncidentView.model_validate({k: row[k] for k in IncidentView.model_fields if k in row})


def _timeline(row: dict[str, Any]) -> list[TimelineEntry]:
    entries = [
        TimelineEntry(
            event="opened", at=row["created_at"], actor_id=row.get("created_by"), actor_name=_name(row.get("created_by"))
        )
    ]
    if row.get("acknowledged_at"):
        entries.append(
            TimelineEntry(
                event="acknowledged",
                at=row["acknowledged_at"],
                actor_id=row.get("acknowledged_by"),
                actor_name=_name(row.get("acknowledged_by")),
            )
        )
    if row.get("resolved_at"):
        entries.append(
            TimelineEntry(
                event="resolved",
                at=row["resolved_at"],
                actor_id=row.get("resolved_by"),
                actor_name=_name(row.get("resolved_by")),
                note=row.get("resolution_note") or None,
            )
        )
    return entries


@router.get("/incidents", response_model=list[IncidentView])
def list_incidents(
    status: Optional[Status] = Query(default=None),
    service: Optional[str] = Query(default=None, max_length=100),
    user: CurrentUser = Depends(current_user),
) -> list[IncidentView]:
    rows = db.list_incidents(owner_id=owner_scope(user), status=status, service_name=service)
    return [_view(r) for r in rows]


@router.get("/incidents/{incident_id}", response_model=IncidentDetail)
def get_incident(incident_id: str, user: CurrentUser = Depends(current_user)) -> IncidentDetail:
    row = _get_visible_or_404(incident_id, user)
    run = db.get_run(row["run_id"]) if row.get("run_id") else None
    related = []
    if row.get("service_name"):
        related = [
            _view(r)
            for r in incidents_repo.find_open_for_service(row["service_name"], owner_id=owner_scope(user))
            if r["id"] != row["id"]
        ]
    return IncidentDetail(
        **_view(row).model_dump(),
        timeline=_timeline(row),
        run=OriginRun(
            run_id=run["run_id"], objective=run["objective"], status=run["status"], session_id=run.get("session_id")
        )
        if run
        else None,
        related_open=related,
    )


def _transition(incident_id: str, new_status: str, user: CurrentUser, note: Optional[str] = None) -> IncidentView:
    _get_visible_or_404(incident_id, user)
    try:
        updated = incidents_repo.transition_incident(
            incident_id, new_status, user.id, datetime.now(timezone.utc).isoformat(), note
        )
    except incidents_repo.IncidentTransitionError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    if updated is None:
        raise HTTPException(status_code=404, detail=f"unknown incident '{incident_id}'")
    return _view(updated)


@router.post("/incidents/{incident_id}/acknowledge", response_model=IncidentView)
def acknowledge_incident(incident_id: str, user: CurrentUser = Depends(require("mutate_incidents"))) -> IncidentView:
    """open -> acknowledged, recording who and when. 409 if it is not open."""
    return _transition(incident_id, "acknowledged", user)


@router.post("/incidents/{incident_id}/resolve", response_model=IncidentView)
def resolve_incident(
    incident_id: str, request: ResolveRequest, user: CurrentUser = Depends(require("mutate_incidents"))
) -> IncidentView:
    """open|acknowledged -> resolved, recording who, when and an optional note."""
    return _transition(incident_id, "resolved", user, request.note.strip() or None)

