"""Tool base class: pairs a pydantic input/output schema with an executor.

The harness (loop.py) is responsible for input validation (constructing
`input_model(**args)`, which raises `pydantic.ValidationError` on bad
input), timeout enforcement, and retries. A `Tool.run()` only needs to
implement business logic and may raise `ToolExecutionError` for simulated
external-system failures.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any, ClassVar, Generic, TypeVar

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

    def bind_context(self, **context: Any) -> None:
        """Optional per-run context hook, called by `AgentLoop` right before
        `run()` for the current step (e.g. `run_id=...`, so `create_incident`
        can scope its idempotency guard to the current run). No-op by
        default — tools that don't need it (and any test double defining
        `run()` without a matching `bind_context`) are unaffected."""
        return None

    @abstractmethod
    def run(self, args: InputT) -> OutputT:
        """Execute the tool. Raise ToolExecutionError for simulated failures."""
        raise NotImplementedError
