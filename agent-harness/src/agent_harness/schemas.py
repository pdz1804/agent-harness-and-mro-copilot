"""Cross-cutting pydantic models: LLM decisions, trace events, and run results.

Per-tool input/output schemas live in `agent_harness.tools.*` next to the
tool that owns them; these models are the harness-level contracts that are
independent of any specific tool.
"""

from __future__ import annotations

import time
import uuid
from typing import Any, Literal, Optional

from pydantic import BaseModel, Field, model_validator

DecisionAction = Literal["tool_call", "final_answer"]

RunStatus = Literal[
    "running",
    "completed",
    "step_limit_exceeded",
    "time_limit_exceeded",
    "llm_error_exceeded",
]

EventType = Literal[
    "llm_decision",
    "llm_malformed_response",
    "llm_retry_exhausted",
    "tool_validation_error",
    "tool_call_started",
    "tool_call_result",
    "tool_call_error",
    "tool_call_timeout",
    "tool_call_retry",
    "tool_call_retries_exhausted",
    "approval_requested",
    "approval_granted",
    "approval_denied",
    "final_answer",
    "step_limit_exceeded",
    "time_limit_exceeded",
]


class LLMDecision(BaseModel):
    """A validated decision produced by an LLM client for one loop step.

    Exactly one of (tool_name/tool_args) or (final_answer) must be set,
    matching `action`.
    """

    action: DecisionAction
    tool_name: Optional[str] = None
    tool_args: Optional[dict[str, Any]] = None
    final_answer: Optional[str] = None
    rationale: Optional[str] = None

    @model_validator(mode="after")
    def _check_shape(self) -> "LLMDecision":
        if self.action == "tool_call":
            if not self.tool_name:
                raise ValueError("tool_call decisions require a non-empty tool_name")
            if self.tool_args is None:
                raise ValueError("tool_call decisions require tool_args (use {} for none)")
        elif self.action == "final_answer":
            if not self.final_answer:
                raise ValueError("final_answer decisions require non-empty final_answer text")
        return self


class AgentEvent(BaseModel):
    """One structured trace event. Serialized as a single JSON line."""

    run_id: str
    step: int
    event_type: EventType
    timestamp: float = Field(default_factory=time.time)
    latency_ms: Optional[float] = None
    data: dict[str, Any] = Field(default_factory=dict)


class RunResult(BaseModel):
    """Final outcome of an AgentLoop.run() call."""

    run_id: str
    objective: str
    status: RunStatus
    final_answer: Optional[str] = None
    steps_taken: int
    elapsed_seconds: float
    history: list[AgentEvent]
    trace_path: Optional[str] = None


def new_run_id() -> str:
    return uuid.uuid4().hex[:12]
