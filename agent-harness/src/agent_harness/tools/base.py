"""Tool base class: pairs a pydantic input/output schema with an executor.

The harness (loop.py) is responsible for input validation (constructing
`input_model(**args)`, which raises `pydantic.ValidationError` on bad
input), timeout enforcement, and retries. A `Tool.run()` only needs to
implement business logic and may raise `ToolExecutionError` for simulated
external-system failures.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any, ClassVar, Generic, Optional, TypeVar

from pydantic import BaseModel

InputT = TypeVar("InputT", bound=BaseModel)
OutputT = TypeVar("OutputT", bound=BaseModel)


class Tool(ABC, Generic[InputT, OutputT]):
    """Base class for a single callable tool."""

    name: ClassVar[str]
    description: ClassVar[str]
    input_model: ClassVar[type[BaseModel]]
    output_model: ClassVar[type[BaseModel]]
    requires_approval: ClassVar[bool] = False
    # RBAC action (see `agent_harness.rbac.Action`) the run's owner must hold
    # for this tool to be offered to the LLM at all; `None` = any role.
    required_action: ClassVar[Optional[str]] = None

    def bind_context(self, **context: Any) -> None:
        """Optional per-run context hook, called by `AgentLoop` right before
        `run()` for the current step (e.g. `run_id=...`, so `create_incident`
        can scope its idempotency guard to the current run). No-op by
        default — tools that don't need it (and any test double defining
        `run()` without a matching `bind_context`) are unaffected."""
        return None

    def precheck(self, args: InputT) -> Optional[dict[str, Any]]:
        """Optional dry-run hook, called by `AgentLoop` after schema
        validation and BEFORE the approval gate. Return a JSON-able
        `preview` dict to show the approver what is about to happen (it is
        attached to the `approval_requested` event), or raise
        `ToolPrecheckError` to reject the call outright — the message goes
        back to the LLM as the tool failure so it can correct itself,
        and the human is never asked to approve something that cannot work.
        No side effects allowed here. Default: no preview."""
        return None

    @abstractmethod
    def run(self, args: InputT) -> OutputT:
        """Execute the tool. Raise ToolExecutionError for simulated failures."""
        raise NotImplementedError
