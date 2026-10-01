"""Process-wide runtime singletons shared by the API routers: the in-memory
`RunRegistry` and the LLM client factory.

The factory is read at call time (`new_llm_client()`), so a test can replace
`state.llm_client_factory` with a deterministic `TestModel`/`FunctionModel`
double and every router picks it up.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any, Optional

from fastapi import HTTPException
from pydantic_ai.models import Model

from agent_harness import settings
from agent_harness.config import HarnessConfig
from agent_harness.llm_client import build_openai_model
from agent_harness.run_registry import RunRegistry

registry = RunRegistry(default_runs_dir="runs")


def default_llm_client() -> Model:
    """Real demo path: requires OPENAI_API_KEY, no silent fallback to the
    deterministic test double. Tests replace `llm_client_factory` with a
    `TestModel`/`FunctionModel` (see `agent_harness.llm_client.build_test_model`/
    `build_scripted_model`), keeping the pytest suite deterministic and
    network-free."""
    if not settings.OPENAI_API_KEY:
        raise HTTPException(
            status_code=503,
            detail="LLM not configured: set OPENAI_API_KEY in agent-harness/.env "
            "(copy .env.example) and restart the server.",
        )
    return build_openai_model()


llm_client_factory: Callable[[], Model] = default_llm_client


def new_llm_client() -> Model:
    return llm_client_factory()


def build_config(max_steps: Optional[int], max_wall_clock_seconds: Optional[float]) -> HarnessConfig:
    config_kwargs: dict[str, Any] = {}
    if max_steps is not None:
        config_kwargs["max_steps"] = max_steps
    if max_wall_clock_seconds is not None:
        config_kwargs["max_wall_clock_seconds"] = max_wall_clock_seconds
    return HarnessConfig(**config_kwargs)
