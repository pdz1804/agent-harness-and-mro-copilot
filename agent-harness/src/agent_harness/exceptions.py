"""Exception hierarchy for tool execution and LLM decision failures."""

from __future__ import annotations


class ToolError(Exception):
    """Base class for all tool-related failures."""


class ToolValidationError(ToolError):
    """Raised when tool input args fail schema validation before execution."""


class ToolExecutionError(ToolError):
    """Raised when a tool runs but fails (simulated external-system failure)."""


class ToolTimeoutError(ToolError):
    """Raised when a tool execution exceeds the configured timeout."""


class ToolNotFoundError(ToolError):
    """Raised when the LLM selects a tool name that is not registered."""


class LLMDecisionError(Exception):
    """Raised when the raw LLM response cannot be parsed/validated as a decision."""
