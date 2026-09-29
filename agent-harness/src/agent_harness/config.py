"""Runtime configuration for a single AgentLoop run."""

from __future__ import annotations

from pydantic import BaseModel, Field


class HarnessConfig(BaseModel):
    """Tunable limits and retry/timeout policy for the execution loop.

    All values have safe defaults for interactive/demo use. Tests override
    them (small step counts, tiny timeouts) to exercise limit paths quickly.
    """

    max_steps: int = Field(default=12, gt=0, description="Max loop iterations before aborting.")
    max_wall_clock_seconds: float = Field(
        default=60.0, gt=0, description="Max total run duration before aborting."
    )
    tool_timeout_seconds: float = Field(
        default=10.0, gt=0, description="Max duration for a single tool execution."
    )
    max_tool_retries: int = Field(
        default=2, ge=0, description="Retries after the first failed tool attempt."
    )
    tool_retry_backoff_seconds: float = Field(
        default=0.05, ge=0, description="Sleep between tool retry attempts (linear backoff)."
    )
    max_llm_retries: int = Field(
        default=2, ge=0, description="Retries after a malformed/invalid LLM decision."
    )

    model_config = {"frozen": True}
