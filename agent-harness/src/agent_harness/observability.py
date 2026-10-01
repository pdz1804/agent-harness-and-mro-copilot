"""MLflow tracing setup for the agent loop (phase 11c).

Verified against the versions actually installed in this project
(`mlflow==3.16.1`, `pydantic-ai==2.51.0`) before writing this module:

- `mlflow.pydantic_ai.autolog()` exists and *runs* without error, and does
  capture real spans (`FunctionModel.request` / tool spans) for calls made
  through `pydantic_ai.Agent.iter()`. However MLflow's own compatibility
  matrix for this integration only covers pydantic-ai 0.2.19-1.94.0
  (https://mlflow.org/docs/latest/genai/tracing/integrations/listing/pydantic_ai/)
  — this project pins `pydantic-ai==2.51.0`, well outside that range — and
  empirically each autologged LLM/tool call landed as its own **top-level
  trace** with `parent_id=None` instead of being nested under one trace per
  agent run. That is real telemetry, but not a coherent per-run trace tree,
  so it does not satisfy "every real run produces a real MLflow trace" on
  its own.
- Falling back to the documented manual approach: this module wraps the
  loop's own call sites (`AgentLoop._run_async`/`_stream_model_request`/
  `_log_llm_decision`/`_execute_with_retries`) with `mlflow.start_span`,
  which reliably nests because those calls all happen on the same asyncio
  task/thread. `mlflow.pydantic_ai.autolog()` is still enabled underneath
  (best-effort, never fatal) since it adds extra granular LLM-request spans
  for real OpenAI calls at no cost when it does nest correctly.
"""

from __future__ import annotations

import logging
from contextlib import AbstractContextManager
from typing import Any, Optional

from agent_harness import settings

logger = logging.getLogger(__name__)

_initialized = False
_enabled = False


class _NullSpan:
    """No-op stand-in for `mlflow.entities.span.Span` when tracing is
    disabled, so call sites can unconditionally call `span.set_inputs(...)`/
    `span.set_outputs(...)` without an `if enabled:` branch at every site."""

    def set_inputs(self, *_args: Any, **_kwargs: Any) -> None:
        return None

    def set_outputs(self, *_args: Any, **_kwargs: Any) -> None:
        return None

    def set_attribute(self, *_args: Any, **_kwargs: Any) -> None:
        return None

    def set_attributes(self, *_args: Any, **_kwargs: Any) -> None:
        return None


class _NullSpanContext(AbstractContextManager):
    def __enter__(self) -> _NullSpan:
        return _NullSpan()

    def __exit__(self, *_exc: Any) -> None:
        return None


def init_mlflow() -> bool:
    """Idempotent MLflow tracking setup. Returns True if tracing is enabled
    for this process (i.e. `MLFLOW_TRACKING_URI` is configured). Safe to
    call repeatedly (e.g. once per `AgentLoop`) and safe when `mlflow` is
    importable but the tracking server is unreachable at call time — server
    connectivity is only needed when a trace is actually flushed, not here.
    """
    global _initialized, _enabled
    if _initialized:
        return _enabled
    _initialized = True

    if not settings.mlflow_configured():
        logger.info("MLFLOW_TRACKING_URI not set; MLflow tracing disabled.")
        return False

    try:
        import mlflow
    except ImportError:
        logger.warning("mlflow is not installed; MLflow tracing disabled.")
        return False

    try:
        mlflow.set_tracking_uri(settings.MLFLOW_TRACKING_URI)
        mlflow.set_experiment(settings.MLFLOW_EXPERIMENT_NAME)
    except Exception:  # noqa: BLE001 - tracing setup must never break the app
        logger.warning("Failed to configure MLflow tracking URI/experiment; tracing disabled.", exc_info=True)
        return False

    # Best-effort: adds extra granular LLM-call spans when it nests
    # correctly (see module docstring for the verified caveat that it does
    # not, by itself, group spans per agent run on this pydantic-ai
    # version). Never fatal if it fails to attach.
    try:
        mlflow.pydantic_ai.autolog()
    except Exception:  # noqa: BLE001
        logger.warning("mlflow.pydantic_ai.autolog() failed to attach; continuing with manual spans only.", exc_info=True)

    _enabled = True
    return True


def is_enabled() -> bool:
    return _enabled


def flush() -> None:
    """Force MLflow's async trace-logging queue to send any buffered spans
    to the tracking server right now. No-op if tracing is disabled.

    Root cause this exists for (phase 11c2): `mlflow.start_span()`'s context
    manager correctly calls `end_span()` on `__exit__` (success *and*
    exception paths alike) so every span, including the root `agent_run`
    span, is closed locally the moment the `with` block exits. But MLflow
    3.x's trace exporter (`mlflow.tracing.export.mlflow_v3`) logs spans
    through an **async** queue (`MLFLOW_ENABLE_ASYNC_LOGGING`, on by
    default) that batches and ships them to the tracking server on a
    background daemon thread. For a short-lived CLI process, the process
    exits (killing that daemon thread) before the queue's next batch flush,
    so the server never receives the final "span ended" update for the root
    span and the trace is stuck showing "In progress" forever, even though
    every child span (which happened to get flushed by an earlier batch)
    shows up correctly. Call this once after the top-level span's `with`
    block has exited (see `AgentLoop._run_async`) to force that pending
    batch out synchronously before the caller can exit."""
    if not _enabled:
        return None

    import mlflow

    try:
        mlflow.flush_trace_async_logging()
    except Exception:  # noqa: BLE001 - flushing must never break the run's result
        logger.warning("mlflow.flush_trace_async_logging() failed.", exc_info=True)
    return None


def span(name: str, span_type: str = "UNKNOWN", attributes: Optional[dict[str, Any]] = None):
    """Return an `mlflow.start_span` context manager if tracing is enabled,
    otherwise a no-op context manager with the same `set_inputs`/
    `set_outputs`/`set_attribute(s)` surface, so call sites never need to
    branch on whether tracing is on."""
    if not _enabled:
        return _NullSpanContext()

    import mlflow

    return mlflow.start_span(name=name, span_type=span_type, attributes=attributes or {})
