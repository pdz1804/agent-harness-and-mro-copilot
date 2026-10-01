"""Service registry routes: list services and flip a mock service's status."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Literal, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from agent_harness import db
from agent_harness.deps import CurrentUser, current_user, require
from agent_harness.routers.automations import trigger_automations

router = APIRouter()


class ServiceView(BaseModel):
    name: str
    status: Literal["operational", "degraded", "down"]
    latency_ms: Optional[float] = None
    error_rate: Optional[float] = None
    last_deploy: Optional[str] = None
    owner: Optional[str] = None
    last_checked: Optional[str] = None


class SetServiceStatusRequest(BaseModel):
    status: Literal["operational", "degraded", "down"]


@router.get("/services", response_model=list[ServiceView])
def list_services(user: CurrentUser = Depends(current_user)) -> list[ServiceView]:
    return [ServiceView(**row) for row in db.list_services()]


@router.post("/services/{service_name}/status", response_model=ServiceView)
def set_service_status(
    service_name: str,
    request: SetServiceStatusRequest,
    user: CurrentUser = Depends(require("mutate_services")),
) -> ServiceView:
    """Flip a mock service's status so a reviewer can create real
    degraded/down scenarios for the agent to investigate. Also the real
    trigger point for Automations (12d): after the status is persisted, any
    enabled automation matching this exact service+status starts a real new
    run (see `trigger_automations`)."""
    row = db.set_service_status(service_name, request.status, datetime.now(timezone.utc).isoformat())
    if row is None:
        raise HTTPException(status_code=404, detail=f"unknown service '{service_name}'")
    trigger_automations(service_name, request.status)
    return ServiceView(**row)
