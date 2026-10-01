"""Automation routes: event-driven rules that start a real run when a service flips status."""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from agent_harness import db, state
from agent_harness.deps import CurrentUser, current_user, require
from agent_harness.routers.runs import owner_scope
from agent_harness.routers.sessions import new_session_title

router = APIRouter()


class AutomationView(BaseModel):
    id: str
    name: str
    trigger_service_name: str = Field(
        description="A real service name (e.g. 'search-index'), or 'any' to match every service."
    )
    trigger_status: Literal["operational", "degraded", "down"]
    objective_template: str = Field(description="The objective text a triggered run is started with.")
    enabled: bool
    created_at: str
    owner_id: str = "u_admin"


class CreateAutomationRequest(BaseModel):
    name: str = Field(min_length=1)
    trigger_service_name: str = Field(min_length=1, description="A real service name, or 'any'.")
    trigger_status: Literal["operational", "degraded", "down"]
    objective_template: str = Field(min_length=1)
    enabled: bool = True


class SetAutomationEnabledRequest(BaseModel):
    enabled: bool


class AutomationTriggeredRunView(BaseModel):
    run_id: str
    objective: str
    status: str
    started_at: float
    triggered_by_automation_id: str


def trigger_automations(service_name: str, status: str) -> None:
    """Real event-driven trigger (12d): for every enabled automation whose
    trigger matches this exact service+status transition, start a real new
    run through the exact same code path a manual run uses
    (`RunRegistry.start_run`), just with `triggered_by_automation_id` set so it
    shows up tagged in Sessions/Logs and on the Automations tab. Never raises:
    a bug here must not break the service-status-flip endpoint itself."""
    try:
        matches = db.list_matching_enabled_automations(service_name, status)
    except Exception:  # noqa: BLE001 - a DB hiccup must not break the status flip itself
        return
    for automation in matches:
        try:
            now = datetime.now(timezone.utc).isoformat()
            session_id = uuid.uuid4().hex[:12]
            automation_owner_id = automation.get("owner_id", "u_admin")
            db.create_session(
                session_id,
                new_session_title(automation["objective_template"]),
                now,
                owner_id=automation_owner_id,
            )
            state.registry.start_run(
                objective=automation["objective_template"],
                model=state.new_llm_client(),
                config=state.build_config(None, None),
                session_id=session_id,
                triggered_by_automation_id=automation["id"],
                owner_id=automation_owner_id,
            )
            db.touch_session(session_id, now, "running")
        except Exception:  # noqa: BLE001 - one bad automation must not block the others
            continue


@router.get("/automations", response_model=list[AutomationView])
def list_automations(user: CurrentUser = Depends(current_user)) -> list[AutomationView]:
    """Every configured automation rule, backing the Automations tab."""
    return [AutomationView(**row) for row in db.list_automations()]


@router.post("/automations", response_model=AutomationView, status_code=201)
def create_automation(
    request: CreateAutomationRequest, user: CurrentUser = Depends(require("mutate_automations"))
) -> AutomationView:
    """Create a new automation rule: when `trigger_service_name` (or every
    service, if 'any') flips to `trigger_status`, a real new run is started
    with `objective_template` — see `trigger_automations`, the real
    enforcement point hit by `POST /services/{service_name}/status`.
    `trigger_service_name` must be a real known service name or 'any'. Owned
    by the caller (phase 01): any run it later triggers is stamped with the
    automation's owner, not `u_admin`."""
    if request.trigger_service_name != "any":
        known_names = {s["name"] for s in db.list_services()}
        if request.trigger_service_name not in known_names:
            raise HTTPException(
                status_code=422,
                detail=f"unknown service '{request.trigger_service_name}' — use a real service name or 'any'",
            )
    automation_id = f"auto-{uuid.uuid4().hex[:12]}"
    now = datetime.now(timezone.utc).isoformat()
    row = db.create_automation(
        automation_id,
        request.name,
        request.trigger_service_name,
        request.trigger_status,
        request.objective_template,
        request.enabled,
        now,
        owner_id=user.id,
    )
    return AutomationView(**row)


@router.patch("/automations/{automation_id}", response_model=AutomationView)
def set_automation_enabled(
    automation_id: str,
    request: SetAutomationEnabledRequest,
    user: CurrentUser = Depends(require("mutate_automations")),
) -> AutomationView:
    """Toggle one automation on/off. Takes effect starting with the very
    next matching service-status flip after this call — the trigger match
    query is read fresh every time, never cached."""
    row = db.set_automation_enabled(automation_id, request.enabled)
    if row is None:
        raise HTTPException(status_code=404, detail=f"unknown automation '{automation_id}'")
    return AutomationView(**row)


@router.get("/automations/runs", response_model=list[AutomationTriggeredRunView])
def list_automation_runs(user: CurrentUser = Depends(current_user)) -> list[AutomationTriggeredRunView]:
    """Most recent runs actually started by an automation (real Postgres
    query over `runs.triggered_by_automation_id`), most recent first — backs
    the Automations tab's "recent automation-triggered runs" list."""
    return [
        AutomationTriggeredRunView(**row)
        for row in db.list_automation_triggered_runs(owner_id=owner_scope(user))
    ]
