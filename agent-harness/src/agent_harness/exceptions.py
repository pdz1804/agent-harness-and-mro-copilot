"""Exception hierarchy for tool execution and LLM decision failures."""

from __future__ import annotations


class ToolError(Exception):
    """Base class for all tool-related failures."""


class ToolValidationError(ToolError):
    """Raised when tool input args fail schema validation before execution."""


class ToolExecutionError(ToolError):
    """Raised when a tool runs but fails (simulated external-system failure)."""


class ToolPrecheckError(ToolError):
    """Raised by `Tool.precheck` to reject a call before the approval gate
    (permission denied, a dry run that cannot succeed). Never retried."""


class ToolTimeoutError(ToolError):
    """Raised when a tool execution exceeds the configured timeout."""


class ToolNotFoundError(ToolError):
    """Raised when the LLM selects a tool name that is not registered."""


class LLMDecisionError(Exception):
    """Raised when the raw LLM response cannot be parsed/validated as a decision."""


class ApprovalTimeout(Exception):
    """Raised by an approval callback when no human decision arrived within
    `HarnessConfig.approval_timeout_seconds`. The loop ends the run as
    `cancelled` with an `approval_timed_out` event rather than treating the
    silence as a denial."""

    def __init__(self, waited_seconds: float, timeout_seconds: float) -> None:
        super().__init__(f"no approval decision within {timeout_seconds:g}s")
        self.waited_seconds = waited_seconds
        self.timeout_seconds = timeout_seconds
