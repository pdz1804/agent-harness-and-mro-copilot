"""`get_service_status` tool: reads a real Postgres-backed service registry
(seeded from `data/seed/services.json`). Unknown service
names raise `ToolInputError` (never retried) naming the valid services;
"all" / "fleet" return every service in one call."""

from __future__ import annotations

from typing import Any, Literal, Optional

from pydantic import BaseModel, Field

from agent_harness import db
from agent_harness.exceptions import ToolInputError
from agent_harness.repos import incidents as incidents_repo
from agent_harness.tools.base import Tool

ServiceStatus = Literal["operational", "degraded", "down"]


class GetServiceStatusInput(BaseModel):
    service_name: str = Field(
        min_length=1,
        description="Registered service identifier, or 'all' (alias 'fleet') for every service.",
    )


FLEET_ALIASES = frozenset({"all", "fleet", "*"})
_SEVERITY_ORDER = {"operational": 0, "degraded": 1, "down": 2}


class OpenIncidentRef(BaseModel):
    id: str
    title: str
    severity: str
    status: str


class ServiceSummary(BaseModel):
    service_name: str
    status: ServiceStatus
    latency_ms: Optional[float] = None
    error_rate_pct: Optional[float] = None
    owner: Optional[str] = None
    open_incidents: list[OpenIncidentRef] = Field(default_factory=list)


class GetServiceStatusOutput(BaseModel):
    service_name: str
    status: ServiceStatus = Field(description="For 'all': the worst status across the fleet.")
    last_checked: str
    latency_ms: Optional[float] = Field(
        default=None, description="Request latency in milliseconds."
    )
    error_rate_pct: Optional[float] = Field(
        default=None,
        description="Error rate as a percentage (0-100), e.g. 4.1 means 4.1% of requests errored.",
    )
    owner: Optional[str] = None
    last_deploy: Optional[str] = None
    open_incidents: list[OpenIncidentRef] = Field(
        default_factory=list,
        description="Incidents already open or acknowledged for this service. If one exists, report it "
        "instead of opening a duplicate.",
    )
    services: list[ServiceSummary] = Field(
        default_factory=list, description="Only for 'all' / 'fleet': one entry per registered service."
    )


class GetServiceStatusTool(Tool[GetServiceStatusInput, GetServiceStatusOutput]):
    name = "get_service_status"
    description = (
        "Get the current operational status of a known service, including "
        "latency (ms), error rate (error_rate_pct, a percentage from 0-100), "
        "owning team, and last deploy time. Pass 'all' (or 'fleet') to get "
        "every service in one call, e.g. for a fleet health report."
    )
    input_model = GetServiceStatusInput
    output_model = GetServiceStatusOutput
    requires_approval = False

    def __init__(self) -> None:
        self._owner_id: Optional[str] = None
        self._owner_role: Optional[str] = None

    def bind_context(self, **context: Any) -> None:
        if context.get("owner_id"):
            self._owner_id = str(context["owner_id"])
        if context.get("owner_role"):
            self._owner_role = str(context["owner_role"])

    def run(self, args: GetServiceStatusInput) -> GetServiceStatusOutput:
        if args.service_name.strip().lower() in FLEET_ALIASES:
            return self._fleet()
        row = db.get_service(args.service_name)
        if row is None:
            # A validation-type failure: retrying the same name cannot help, so
            # the harness reports it straight back, naming the valid services.
            known = ", ".join(sorted(r["name"] for r in db.list_services()))
            raise ToolInputError(
                f"Unknown service '{args.service_name}'; not present in service registry. "
                f"Registered services: {known or 'none'}. Use one of these names, or 'all' for every service."
            )
        # Stored in `services.error_rate` as a 0-1 fraction; surfaced to the
        # LLM/tool caller as an unambiguous percentage (`error_rate_pct`) so
        # it isn't misread as an already-tiny percentage (see phase-06d fix:
        # a real run reported "error rate of 0.0008" for a 0.08% fraction).
        raw_error_rate = row["error_rate"]
        return GetServiceStatusOutput(
            service_name=row["name"],
            status=row["status"],
            last_checked=row["last_checked"] or "",
            latency_ms=row["latency_ms"],
            error_rate_pct=raw_error_rate * 100 if raw_error_rate is not None else None,
            owner=row["owner"],
            last_deploy=row["last_deploy"],
            open_incidents=self._open_incidents(row["name"]),
        )

    def _fleet(self) -> GetServiceStatusOutput:
        rows = sorted(db.list_services(), key=lambda r: r["name"])
        summaries = [
            ServiceSummary(
                service_name=row["name"],
                status=row["status"],
                latency_ms=row["latency_ms"],
                error_rate_pct=row["error_rate"] * 100 if row["error_rate"] is not None else None,
                owner=row["owner"],
                open_incidents=self._open_incidents(row["name"]),
            )
            for row in rows
        ]
        worst = max((s.status for s in summaries), key=_SEVERITY_ORDER.__getitem__, default="operational")
        checked = max((r["last_checked"] or "" for r in rows), default="")
        return GetServiceStatusOutput(service_name="all", status=worst, last_checked=checked, services=summaries)

    def _open_incidents(self, service_name: str) -> list[OpenIncidentRef]:
        scope = None if self._owner_role in (None, "admin") else self._owner_id
        found = incidents_repo.find_open_for_service(service_name, owner_id=scope)
        return [
            OpenIncidentRef(id=i["id"], title=i["title"], severity=i["severity"], status=i["status"])
            for i in found[:5]
        ]
