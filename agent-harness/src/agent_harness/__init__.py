"""Agent Harness: an LLM<->tool execution loop with state, validation,
retries, timeouts, an approval gate, and structured per-run tracing.

Public API surface is re-exported here so callers can do:

    from agent_harness import AgentLoop, HarnessConfig, build_default_registry
"""

from agent_harness.config import HarnessConfig
from agent_harness.exceptions import (
    ToolError,
    ToolExecutionError,
    ToolTimeoutError,
    ToolValidationError,
)
from agent_harness.loop import AgentLoop
from agent_harness.schemas import LLMDecision, RunResult
from agent_harness.tools.registry import ToolRegistry, build_default_registry

__all__ = [
    "AgentLoop",
    "HarnessConfig",
    "LLMDecision",
    "RunResult",
    "ToolRegistry",
    "build_default_registry",
    "ToolError",
    "ToolExecutionError",
    "ToolTimeoutError",
    "ToolValidationError",
]

__version__ = "0.1.0"
