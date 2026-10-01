"""MLflow tracing for the copilot, adapted from
``agent-harness/src/agent_harness/observability.py:40-153`` (no import --
duplicated per the research report's decision D: no shared package across
apps). Experiment name ``mro-copilot``.

Same caveat documented there applies here: ``mlflow.pydantic_ai.autolog()``
is best-effort (pydantic-ai 2.51.0 is outside MLflow's documented
compatibility range for that integration) and spans may not nest under one
per-run trace on their own, so this module also wraps call sites with
``mlflow.start_span`` directly (see ``hitl.py``), and keeps the same
``flush()`` fix for MLflow's async trace-logging queue not flushing before a
short-lived process exits.
"""

from __future__ import annotations

import logging
import os
from contextlib import AbstractContextManager
from typing import Any, Optional

logger = logging.getLogger(__name__)

EXPERIMENT_NAME = "mro-copilot"

_initialized = False
_enabled = False


class _NullSpan:
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


def _tracking_uri() -> Optional[str]:
    return os.environ.get("MLFLOW_TRACKING_URI")


def init_tracing() -> bool:
    """Idempotent MLflow tracking setup for the copilot. Returns True if
    tracing is enabled (``MLFLOW_TRACKING_URI`` configured and ``mlflow``
    importable). Never raises -- tracing must never break a copilot run."""
    global _initialized, _enabled
    if _initialized:
        return _enabled
    _initialized = True

    if not _tracking_uri():
        logger.info("MLFLOW_TRACKING_URI not set; copilot MLflow tracing disabled.")
        return False

    try:
        import mlflow
    except ImportError:
        logger.warning("mlflow not installed; copilot MLflow tracing disabled.")
        return False

    try:
        mlflow.set_tracking_uri(_tracking_uri())
        mlflow.set_experiment(EXPERIMENT_NAME)
    except Exception:  # noqa: BLE001 - tracing setup must never break the app
        logger.warning("Failed to configure MLflow tracking URI/experiment for copilot.", exc_info=True)
        return False

    try:
        mlflow.pydantic_ai.autolog()
    except Exception:  # noqa: BLE001
        logger.warning("mlflow.pydantic_ai.autolog() failed to attach; continuing with manual spans only.", exc_info=True)

    _enabled = True
    return True


def is_enabled() -> bool:
    return _enabled


def flush() -> None:
    if not _enabled:
        return None
    import mlflow

    try:
        mlflow.flush_trace_async_logging()
    except Exception:  # noqa: BLE001
        logger.warning("mlflow.flush_trace_async_logging() failed.", exc_info=True)
    return None


def span(name: str, span_type: str = "UNKNOWN", attributes: Optional[dict[str, Any]] = None):
    if not _enabled:
        return _NullSpanContext()
    import mlflow

    return mlflow.start_span(name=name, span_type=span_type, attributes=attributes or {})


def current_trace_id() -> Optional[str]:
    """Best-effort current MLflow trace id, or None if tracing is off or
    no trace is active. Never raises."""
    if not _enabled:
        return None
    try:
        import mlflow

        ctx = mlflow.get_current_active_span()
        if ctx is not None:
            return ctx.trace_id
    except Exception:  # noqa: BLE001
        return None
    return None
