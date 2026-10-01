"""`create_incident` tool: inserts a real row into the Postgres `incidents`
table. This is the only tool flagged `requires_approval = True` — the
harness's approval gate (approval.py) must grant explicit consent before
`run()` is ever invoked.

Idempotency: `bind_context(run_id=...)` is called by `AgentLoop` before
`run()`. If a `create_incident` call with the same `run_id` and `title`
already succeeded earlier in this run, `run()` returns the existing row
instead of inserting a duplicate (e.g. if the LLM re-proposes the same
incident after an unrelated later error).

Duplicate warning: when the call names a `service_name` and an open or
acknowledged incident already exists for that service (among the incidents the
run's owner may see), `precheck` rejects the call back to the LLM - before any
human approval is requested - with the existing incident's id and title, so the
agent reports it instead of opening a second one. `allow_duplicate=true` lets
the agent override that when it has judged the new problem to be separate."""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any, Literal, Optional

from pydantic import BaseModel, Field

from agent_harness import db
from agent_harness.exceptions import ToolPrecheckError
from agent_harness.repos import incidents as incidents_repo
from agent_harness.tools.base import Tool

Severity = Literal["low", "medium", "high", "critical"]


class CreateIncidentInput(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    description: str = Field(min_length=1)
    severity: Severity
    service_name: Optional[str] = Field(
        default=None,
        max_length=100,
        description="Name of the affected service, exactly as get_service_status knows it. Always give it "
        "when the incident is about one service: it is used to detect an already-open incident.",
    )
    allow_duplicate: bool = Field(
        default=False,
        description="Set true ONLY after a duplicate warning, when you are sure this is a separate problem.",
    )


class CreateIncidentOutput(BaseModel):
    incident_id: str
    status: Literal["created"]
    title: str
    severity: Severity
    created_at: str
    service_name: Optional[str] = None


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
        self._owner_id: Optional[str] = None
        self._owner_role: Optional[str] = None

    def bind_context(self, **context: Any) -> None:
        run_id = context.get("run_id")
        if run_id:
            self._run_id = str(run_id)
        if context.get("owner_id"):
            self._owner_id = str(context["owner_id"])
        if context.get("owner_role"):
            self._owner_role = str(context["owner_role"])

    def precheck(self, args: CreateIncidentInput) -> Optional[dict[str, Any]]:
        service = (args.service_name or "").strip()
        if not service or args.allow_duplicate:
            return None
        if db.find_incident(run_id=self._run_id, title=args.title) is not None:
            return None  # the same run re-proposing its own incident: `run()` is idempotent
        scope = None if self._owner_role in (None, "admin") else self._owner_id
        existing = incidents_repo.find_open_for_service(service, owner_id=scope)
        if not existing:
            return None
        listing = "; ".join(
            f"{i['id']} '{i['title']}' (severity {i['severity']}, {i['status']})" for i in existing[:3]
        )
        raise ToolPrecheckError(
            f"Duplicate warning: an open incident already exists for service '{service}': {listing}. "
            "Do not open another one. Tell the user about the existing incident, or call create_incident "
            "again with allow_duplicate=true only if this is clearly a different problem."
        )

    def run(self, args: CreateIncidentInput) -> CreateIncidentOutput:
        existing = db.find_incident(run_id=self._run_id, title=args.title)
        if existing is not None:
            return CreateIncidentOutput(
                incident_id=existing["id"],
                status="created",
                title=existing["title"],
                severity=existing["severity"],
                created_at=existing["created_at"],
                service_name=existing.get("service_name"),
            )

        incident_id = f"INC-{uuid.uuid4().hex[:8].upper()}"
        created_at = datetime.now(timezone.utc).isoformat()
        record = db.insert_incident(
            incident_id=incident_id,
            title=args.title,
            description=args.description,
            severity=args.severity,
            status="open",
            created_at=created_at,
            run_id=self._run_id,
            service_name=(args.service_name or "").strip() or None,
            created_by=self._owner_id,
        )
        return CreateIncidentOutput(
            incident_id=record["id"],
            status="created",
            title=record["title"],
            severity=record["severity"],
            created_at=record["created_at"],
            service_name=record["service_name"],
        )
