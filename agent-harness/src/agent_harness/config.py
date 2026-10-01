"""Runtime configuration for a single AgentLoop run."""

from __future__ import annotations

from pydantic import BaseModel, Field

from agent_harness import settings


class HarnessConfig(BaseModel):
    """Tunable limits and retry/timeout policy for the execution loop.

    All values have safe defaults for interactive/demo use. Tests override
    them (small step counts, tiny timeouts) to exercise limit paths quickly.
    """

    max_steps: int = Field(default=12, gt=0, description="Max loop iterations before aborting.")
    max_wall_clock_seconds: float = Field(
        default=60.0,
        gt=0,
        description=(
            "Max agent compute time before aborting. Time spent waiting for a human "
            "approval decision is excluded (it has its own `approval_timeout_seconds`)."
        ),
    )
    approval_timeout_seconds: float = Field(
        default_factory=lambda: settings.APPROVAL_TIMEOUT_SECONDS,
        gt=0,
        description=(
            "Max time to wait for a human to approve/deny one gated tool call. On expiry "
            "the run ends as `cancelled` with an `approval_timed_out` event. Defaults from "
            "the APPROVAL_TIMEOUT_SECONDS env var (15 min)."
        ),
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
    autocompact_token_budget: int = Field(
        default_factory=lambda: settings.AUTOCOMPACT_TOKEN_BUDGET,
        gt=0,
        description=(
            "Token budget (tiktoken-counted over the flattened message history) that, "
            "once a run's accumulated history reaches or exceeds it, triggers "
            "autocompaction before the next LLM call. Defaults from the "
            "AUTOCOMPACT_TOKEN_BUDGET env var (see settings.py), so process-wide "
            "config still flows through without every caller re-reading the env."
        ),
    )
    autocompact_keep_recent_messages: int = Field(
        default=6,
        gt=0,
        description=(
            "Number of most-recent messages (pydantic_ai ModelMessage entries — "
            "roughly 3 request/response turns) kept verbatim after a compaction; "
            "everything older is folded into one summary message."
        ),
    )

    model_config = {"frozen": True}
