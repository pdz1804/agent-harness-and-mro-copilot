"""`get_service_status` tool: reads a real SQLite-backed service registry
(`data/harness.db`, seeded from `data/seed/services.json`). Unknown service
names raise `ToolExecutionError`, the harness's built-in "tool-failure
path" scenario."""

from __future__ import annotations

from typing import Literal, Optional

from pydantic import BaseModel, Field

from agent_harness import db
from agent_harness.exceptions import ToolExecutionError
from agent_harness.tools.base import Tool

ServiceStatus = Literal["operational", "degraded", "down"]


class GetServiceStatusInput(BaseModel):
    service_name: str = Field(min_length=1, description="Registered service identifier.")


class GetServiceStatusOutput(BaseModel):
    service_name: str
    status: ServiceStatus
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


class GetServiceStatusTool(Tool[GetServiceStatusInput, GetServiceStatusOutput]):
    name = "get_service_status"
    description = (
        "Get the current operational status of a known service, including "
        "latency (ms), error rate (error_rate_pct, a percentage from 0-100), "
        "owning team, and last deploy time."
    )
    input_model = GetServiceStatusInput
    output_model = GetServiceStatusOutput
    requires_approval = False

    def run(self, args: GetServiceStatusInput) -> GetServiceStatusOutput:
        row = db.get_service(args.service_name)
        if row is None:
            raise ToolExecutionError(
                f"Unknown service '{args.service_name}'; not present in service registry."
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
        )
