"""`create_incident` tool: inserts a real row into the SQLite `incidents`
table. This is the only tool flagged `requires_approval = True` — the
harness's approval gate (approval.py) must grant explicit consent before
`run()` is ever invoked.

Idempotency: `bind_context(run_id=...)` is called by `AgentLoop` before
`run()`. If a `create_incident` call with the same `run_id` and `title`
already succeeded earlier in this run, `run()` returns the existing row
instead of inserting a duplicate (e.g. if the LLM re-proposes the same
incident after an unrelated later error)."""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any, Literal

from pydantic import BaseModel, Field

from agent_harness import db
from agent_harness.tools.base import Tool

Severity = Literal["low", "medium", "high", "critical"]


class CreateIncidentInput(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    description: str = Field(min_length=1)
    severity: Severity


class CreateIncidentOutput(BaseModel):
    incident_id: str
    status: Literal["created"]
    title: str
    severity: Severity
    created_at: str


class CreateIncidentTool(Tool[CreateIncidentInput, CreateIncidentOutput]):
    name = "create_incident"
    description = (
        "Create an incident ticket. Requires human approval before it takes "
        "effect. Only call this after checking service status and/or the "
        "knowledge base confirms escalation is warranted."
    )
    input_model = CreateIncidentInput
    output_model = CreateIncidentOutput
    requires_approval = True

    def __init__(self) -> None:
        self._run_id: str = ""

    def bind_context(self, **context: Any) -> None:
        run_id = context.get("run_id")
        if run_id:
            self._run_id = str(run_id)

    def run(self, args: CreateIncidentInput) -> CreateIncidentOutput:
        existing = db.find_incident(run_id=self._run_id, title=args.title)
        if existing is not None:
            return CreateIncidentOutput(
                incident_id=existing["id"],
                status="created",
                title=existing["title"],
                severity=existing["severity"],
                created_at=existing["created_at"],
            )

        incident_id = f"INC-{uuid.uuid4().hex[:8].upper()}"
        created_at = datetime.now(timezone.utc).isoformat()
        record = db.insert_incident(
            incident_id=incident_id,
            title=args.title,
            description=args.description,
            severity=args.severity,
            status="created",
            created_at=created_at,
            run_id=self._run_id,
        )
        return CreateIncidentOutput(
            incident_id=record["id"],
            status="created",
            title=record["title"],
            severity=record["severity"],
            created_at=record["created_at"],
        )
