"""Integrations routes: every harness tool with its enabled flag, its JSON
schema, recent calls, error rate and latency, and per-tool timeout/retry settings.

Settings are real: `run_registry.RunRegistry.start_run` reads them fresh for
each new run and hands them to `AgentLoop`, whose retry loop uses a tool's own
timeout and retry count instead of the global `HarnessConfig` values. Toggling
or tuning needs `mutate_integrations` (admin only — a safety-posture control).
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from agent_harness import db
from agent_harness.config import HarnessConfig
from agent_harness.deps import CurrentUser, current_user, require
from agent_harness.repos import integrations as integrations_repo
from agent_harness.repos import runs as runs_repo
from agent_harness.routers.runs import owner_scope
from agent_harness.tools.registry import build_default_registry

router = APIRouter()

_GLOBAL_DEFAULTS = HarnessConfig()


class IntegrationView(BaseModel):
    tool_name: str
    enabled: bool
    updated_at: str
    timeout_seconds: Optional[float] = Field(default=None, description="Per-tool timeout override; null = global default.")
    max_retries: Optional[int] = Field(default=None, description="Per-tool retry override; null = global default.")


class UpdateIntegrationRequest(BaseModel):
    """Only fields present in the body change; send `null` for a limit to clear
    it back to the global default."""

    enabled: Optional[bool] = None
    timeout_seconds: Optional[float] = Field(default=None, ge=0.1, le=300)
    max_retries: Optional[int] = Field(default=None, ge=0, le=10)


class ToolCallRow(BaseModel):
    run_id: str
    step: int
    outcome: str
    timestamp: float
    latency_ms: Optional[float] = None
    attempt: Optional[int] = None
    args: Optional[dict[str, Any]] = None
    error: Optional[str] = None


class ToolStats(BaseModel):
    calls: int
    errors: int
    error_rate: Optional[float] = None
    avg_latency_ms: Optional[float] = None


class EffectiveLimits(BaseModel):
    timeout_seconds: float
    max_retries: int
    timeout_overridden: bool
    retries_overridden: bool


class IntegrationDetail(IntegrationView):
    description: str = ""
    requires_approval: bool = False
    input_schema: Optional[dict[str, Any]] = None
    output_schema: Optional[dict[str, Any]] = None
    effective: EffectiveLimits
    stats: ToolStats
    recent_calls: list[ToolCallRow]


def _view(row: dict[str, Any]) -> IntegrationView:
    return IntegrationView(
        tool_name=row["tool_name"],
        enabled=row["enabled"],
        updated_at=row["updated_at"],
        timeout_seconds=row.get("timeout_seconds"),
        max_retries=row.get("max_retries"),
    )


@router.get("/integrations", response_model=list[IntegrationView])
def list_integrations(user: CurrentUser = Depends(current_user)) -> list[IntegrationView]:
    """Every harness tool with its current enabled/disabled state, backing
    the Integrations tab. A disabled tool is genuinely absent from the tool
    list a *new* run's agent is built with (see
    `run_registry.py::RunRegistry._build_enabled_tool_registry`) — this
    endpoint just reflects the same `integrations` table that decision reads."""
    return [_view(row) for row in db.list_integrations()]


@router.get("/integrations/{tool_name}", response_model=IntegrationDetail)
def get_integration(tool_name: str, user: CurrentUser = Depends(current_user)) -> IntegrationDetail:
    """One tool in depth: its input/output JSON schema, the limits a new run
    will use, and — from the persisted traces of the caller's own runs (every
    run for an admin) — recent calls, error rate and average latency."""
    row = integrations_repo.get_integration(tool_name)
    if row is None:
        raise HTTPException(status_code=404, detail=f"unknown integration '{tool_name}'")
    tool = build_default_registry().get(tool_name)
    scope = owner_scope(user)
    return IntegrationDetail(
        **_view(row).model_dump(),
        description=tool.description if tool else "",
        requires_approval=tool.requires_approval if tool else False,
        input_schema=tool.input_model.model_json_schema() if tool else None,
        output_schema=tool.output_model.model_json_schema() if tool else None,
        effective=EffectiveLimits(
            timeout_seconds=row["timeout_seconds"] if row.get("timeout_seconds") is not None else _GLOBAL_DEFAULTS.tool_timeout_seconds,
            max_retries=row["max_retries"] if row.get("max_retries") is not None else _GLOBAL_DEFAULTS.max_tool_retries,
            timeout_overridden=row.get("timeout_seconds") is not None,
            retries_overridden=row.get("max_retries") is not None,
        ),
        stats=ToolStats(**runs_repo.tool_call_stats(tool_name, owner_id=scope)),
        recent_calls=[ToolCallRow(**c) for c in runs_repo.recent_tool_calls(tool_name, owner_id=scope)],
    )


@router.patch("/integrations/{tool_name}", response_model=IntegrationView)
def update_integration(
    tool_name: str,
    request: UpdateIntegrationRequest,
    user: CurrentUser = Depends(require("mutate_integrations")),
) -> IntegrationView:
    """Toggle one tool on/off and/or set its own timeout / retry count. Takes
    effect starting with the *next* run started after this call — a run already
    in flight keeps whichever tool list and limits it was built with. Admin-only."""
    fields = request.model_fields_set
    if not fields:
        raise HTTPException(status_code=422, detail="send enabled, timeout_seconds and/or max_retries")
    now = datetime.now(timezone.utc).isoformat()
    row = integrations_repo.get_integration(tool_name)
    if row is None:
        raise HTTPException(status_code=404, detail=f"unknown integration '{tool_name}'")
    if "enabled" in fields:
        if request.enabled is None:
            raise HTTPException(status_code=422, detail="enabled must be true or false")
        db.set_integration_enabled(tool_name, request.enabled, now)
    limits: dict[str, Any] = {}
    if "timeout_seconds" in fields:
        limits["timeout_seconds"] = request.timeout_seconds
    if "max_retries" in fields:
        limits["max_retries"] = request.max_retries
    if limits:
        integrations_repo.update_integration_settings(tool_name, now, **limits)
    updated = integrations_repo.get_integration(tool_name)
    assert updated is not None
    return _view(updated)
