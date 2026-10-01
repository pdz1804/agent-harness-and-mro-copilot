"""Guardrails routes: configure rules, list trigger history, and a test sandbox
that shows which rule fires on a typed input and why."""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any, Literal, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from agent_harness import db, guardrails
from agent_harness.deps import CurrentUser, current_user, require
from agent_harness.routers.runs import owner_scope

router = APIRouter()

GuardrailKind = Literal["objective_pattern_block", "severity_upgrade_block"]


class GuardrailView(BaseModel):
    id: str
    name: str
    kind: GuardrailKind
    config: dict[str, Any]
    enabled: bool
    created_at: str


class CreateGuardrailRequest(BaseModel):
    name: str = Field(min_length=1)
    kind: GuardrailKind
    config: dict[str, Any] = Field(
        default_factory=dict,
        description="For objective_pattern_block: {'patterns': [str, ...]}. Unused for "
        "severity_upgrade_block (that rule is fixed, non-configurable logic).",
    )
    enabled: bool = True


class SetGuardrailEnabledRequest(BaseModel):
    enabled: bool


class GuardrailTriggerView(BaseModel):
    run_id: str
    step: int
    event_type: str
    timestamp: float
    data: dict[str, Any]
    objective: Optional[str] = Field(default=None, description="The objective of the run the rule fired on.")


class GuardrailTestRequest(BaseModel):
    text: str = Field(min_length=1, max_length=4000, description="An objective to check against the input rules.")
    severity: Optional[Literal["low", "medium", "high", "critical"]] = Field(
        default=None, description="Optionally, an incident severity to check against the severity cap."
    )
    evidence_status: Optional[Literal["operational", "degraded", "down"]] = Field(
        default=None,
        description="The service status the agent would have seen last (omit for 'no service checked yet').",
    )


class RuleCheckView(BaseModel):
    guardrail_id: str
    name: str
    kind: GuardrailKind
    enabled: bool
    fired: bool
    reason: str
    matched_pattern: Optional[str] = None


class GuardrailTestResult(BaseModel):
    blocked: bool = Field(description="True when an enabled input rule would stop a run with this objective.")
    severity_downgraded_to: Optional[str] = Field(
        default=None, description="'high' when the severity cap would downgrade the proposed severity."
    )
    checks: list[RuleCheckView]


@router.get("/guardrails", response_model=list[GuardrailView])
def list_guardrails(user: CurrentUser = Depends(current_user)) -> list[GuardrailView]:
    """Every configured guardrail, backing the Guardrails tab — a
    real-enforced check (see `agent_harness.loop.AgentLoop`), not UI framing."""
    return [GuardrailView(**row) for row in db.list_guardrails()]


@router.post("/guardrails", response_model=GuardrailView, status_code=201)
def create_guardrail(
    request: CreateGuardrailRequest, user: CurrentUser = Depends(require("mutate_guardrails"))
) -> GuardrailView:
    """Create a new guardrail (e.g. an `objective_pattern_block` with real
    banned patterns). Takes effect starting with the very next run/tool
    call after creation — both enforcement points read the table fresh.
    Admin-only — a safety-posture control (phase 01)."""
    guardrail_id = f"gr-{uuid.uuid4().hex[:12]}"
    now = datetime.now(timezone.utc).isoformat()
    row = db.create_guardrail(guardrail_id, request.name, request.kind, request.config, request.enabled, now)
    return GuardrailView(**row)


@router.patch("/guardrails/{guardrail_id}", response_model=GuardrailView)
def set_guardrail_enabled(
    guardrail_id: str,
    request: SetGuardrailEnabledRequest,
    user: CurrentUser = Depends(require("mutate_guardrails")),
) -> GuardrailView:
    row = db.set_guardrail_enabled(guardrail_id, request.enabled)
    if row is None:
        raise HTTPException(status_code=404, detail=f"unknown guardrail '{guardrail_id}'")
    return GuardrailView(**row)


@router.get("/guardrails/triggers", response_model=list[GuardrailTriggerView])
def list_guardrail_triggers(user: CurrentUser = Depends(current_user)) -> list[GuardrailTriggerView]:
    """Most recent real guardrail firings across the caller's runs (both
    kinds), most recent first, each linked to its run — backs the Guardrails
    tab's trigger history."""
    rows = db.list_guardrail_triggers(owner_id=owner_scope(user))
    objectives: dict[str, Optional[str]] = {}
    out = []
    for row in rows:
        run_id = row["run_id"]
        if run_id not in objectives:
            run = db.get_run(run_id)
            objectives[run_id] = run["objective"] if run else None
        out.append(GuardrailTriggerView(**row, objective=objectives[run_id]))
    return out


@router.post("/guardrails/test", response_model=GuardrailTestResult)
def test_guardrails(request: GuardrailTestRequest, user: CurrentUser = Depends(current_user)) -> GuardrailTestResult:
    """The test sandbox: evaluate typed input against every configured rule
    with the exact logic the loop enforces, and say which rule fires and why.
    Read-only: nothing is run, recorded or persisted. Any role may use it."""
    checks = guardrails.evaluate_input(request.text, request.severity, request.evidence_status)
    blocked = any(c.fired and c.kind == "objective_pattern_block" for c in checks)
    downgraded = "high" if any(c.fired and c.kind == "severity_upgrade_block" for c in checks) else None
    return GuardrailTestResult(
        blocked=blocked,
        severity_downgraded_to=downgraded,
        checks=[RuleCheckView(**vars(c)) for c in checks],
    )
