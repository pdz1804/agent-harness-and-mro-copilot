"""MLflow tracking + model-registry setup for MRO training runs.

Copy-adapted (~60 lines, per ``reports/research-and-gap-analysis.md`` §5)
from ``agent-harness/src/agent_harness/observability.py:40-153``'s
null-span pattern: every call site can unconditionally call
``span.set_inputs(...)``/``span.set_outputs(...)`` without an
``if enabled:`` branch, and the whole module is a safe no-op when
``mlflow`` isn't installed or the tracking URI is unreachable -- training
and the scoring service must both keep working with zero MLflow present.

Store: **local, file-backed, inside this app** -- ``sqlite:///mlruns/mlflow.db``
with artifacts under ``mlruns/artifacts`` -- NOT the Docker MLflow on
:5001 used by ``agent-harness`` (Postgres-backed, a different app's
infra; reusing it would couple release cycles across apps, see gap
analysis D1/D8). Override via the ``MLFLOW_TRACKING_URI`` env var (e.g.
to point at the harness server for a single shared UI, at the operator's
discretion -- default is local).
"""

from __future__ import annotations

import logging
import os
from contextlib import AbstractContextManager
from pathlib import Path
from typing import Any, Optional

from src import config

logger = logging.getLogger(__name__)

EXPERIMENT_NAME = "mro-training"
REGISTERED_MODEL_NAME = "mro-failure-risk"

MLRUNS_DIR = config.ROOT_DIR / "mlruns"
DEFAULT_TRACKING_URI = f"sqlite:///{(MLRUNS_DIR / 'mlflow.db').as_posix()}"
DEFAULT_ARTIFACT_ROOT = (MLRUNS_DIR / "artifacts").as_posix()

_initialized = False
_enabled = False


class _NullSpan:
    """No-op stand-in for an MLflow span -- see module docstring."""

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
    """Resolve the tracking URI, or ``None`` to mean "tracking disabled".

    Under pytest (detected via the ``PYTEST_CURRENT_TEST`` env var pytest
    sets for every running test) tracking defaults to DISABLED unless a
    test explicitly sets ``MLFLOW_TRACKING_URI`` itself (e.g. via
    ``monkeypatch.setenv`` to its own tmp path).

    Root cause this guards against: several OTHER phases' tests call
    ``pipeline.run(...)`` for real, against small/fast fixture-scale
    synthetic data (not the full production dataset), purely to unit-test
    unrelated pipeline behavior. With tracking on by default, that also
    (correctly, per this module's own logic) registered a new MLflow model
    version and reassigned the shared `champion` alias -- against the REAL
    ``mlruns/mlflow.db`` at first, and even against a single process-wide
    temp registry in a later iteration of this fix -- so a fixture-scale
    test model could silently become what ``model_store.py`` serves,
    breaking ``test_score_parity_with_offline_pipeline`` (observed: service
    score 0.58 vs. the real joblib's 0.995 for the same row) and any manual
    verification on :8100 after running the test suite. Defaulting to
    disabled under pytest (mirroring agent-harness's
    ``settings.mlflow_configured()`` explicit-opt-in pattern) means every
    test gets the pre-phase-02 joblib-only behavior unless it deliberately
    opts into a registry of its own.
    """
    if "MLFLOW_TRACKING_URI" in os.environ:
        return os.environ["MLFLOW_TRACKING_URI"]
    if "PYTEST_CURRENT_TEST" in os.environ:
        return None
    return DEFAULT_TRACKING_URI


def init_tracking(force: bool = False) -> bool:
    """Idempotent MLflow tracking setup. Returns True if tracking is usable
    for this process. Safe to call repeatedly and safe when ``mlflow`` is
    importable but unreachable (falls back, never raises).

    ``force=True`` re-runs setup even if already initialized -- used by
    tests that set ``MLFLOW_TRACKING_URI`` to a fresh tmp dir per test.
    """
    global _initialized, _enabled
    if _initialized and not force:
        return _enabled
    _initialized = True

    try:
        import mlflow
    except ImportError:
        logger.info("mlflow is not installed; tracking disabled (joblib-only mode).")
        _enabled = False
        return False

    uri = _tracking_uri()
    if uri is None:
        logger.info("MLflow tracking disabled for this process (pytest, no explicit MLFLOW_TRACKING_URI).")
        _enabled = False
        return False

    try:
        if uri.startswith("sqlite:///"):
            db_path = Path(uri[len("sqlite:///"):])
            db_path.parent.mkdir(parents=True, exist_ok=True)
            Path(DEFAULT_ARTIFACT_ROOT).mkdir(parents=True, exist_ok=True)
        mlflow.set_tracking_uri(uri)
        mlflow.set_experiment(EXPERIMENT_NAME)
    except Exception:  # noqa: BLE001 - tracking setup must never break training
        logger.warning("Failed to configure MLflow tracking URI/experiment; tracking disabled.", exc_info=True)
        _enabled = False
        return False

    _enabled = True
    return True


def is_enabled() -> bool:
    return _enabled


def reset_for_testing() -> None:
    """Clear the idempotency cache so the next ``init_tracking()`` call
    re-evaluates ``_tracking_uri()`` from scratch. Only meant to be called
    from test teardown (e.g. after a test that deliberately points
    ``MLFLOW_TRACKING_URI`` at its own tmp registry via monkeypatch) so a
    later test's tracking calls don't keep writing into that now-stale tmp
    registry -- see ``_tracking_uri()``'s pytest-default-disabled rationale.
    """
    global _initialized, _enabled
    _initialized = False
    _enabled = False


def span(name: str, attributes: Optional[dict[str, Any]] = None):
    """``mlflow.start_span`` if tracking is enabled, else a no-op context
    manager with the same surface -- call sites never branch on state."""
    if not _enabled:
        return _NullSpanContext()
    import mlflow

    return mlflow.start_span(name=name, attributes=attributes or {})


def log_training_run(
    *,
    profile: str,
    seed: int,
    served_policy: Optional[str],
    params: dict[str, Any],
    metrics: dict[str, float],
    artifact_paths: list[Path],
    sklearn_pipeline: Any,
    input_example: Any,
    signature: Any = None,
    register: bool = True,
    alias: Optional[str] = None,
) -> Optional[dict[str, Any]]:
    """Log one training run's params/metrics/artifacts to MLflow and, if
    ``register`` and this is the v1/served profile, register+alias the
    model. Returns a dict with ``run_id``/``model_version`` or ``None`` if
    tracking is disabled -- callers must treat ``None`` as "no MLflow
    metadata available" and fall back to the joblib artifact, never crash.
    """
    if not _enabled:
        return None

    import mlflow
    import mlflow.sklearn

    try:
        with mlflow.start_run() as run:
            mlflow.log_param("profile", profile)
            mlflow.log_param("seed", seed)
            if served_policy:
                mlflow.log_param("served_policy", served_policy)
            for key, value in params.items():
                try:
                    mlflow.log_param(key, value)
                except Exception:  # noqa: BLE001 - one bad param must not lose the run
                    logger.warning("mlflow.log_param(%s) failed", key, exc_info=True)

            for key, value in metrics.items():
                if value is None:
                    continue
                try:
                    mlflow.log_metric(key, float(value))
                except (TypeError, ValueError):
                    continue

            for path in artifact_paths:
                if path.exists():
                    mlflow.log_artifact(str(path))

            model_info = mlflow.sklearn.log_model(
                sklearn_pipeline,
                name="model",
                input_example=input_example,
                signature=signature,
                registered_model_name=REGISTERED_MODEL_NAME if register else None,
                # mlflow's sklearn flavor defaults to `skops` serialization,
                # which refuses to round-trip HistGradientBoostingClassifier
                # (flags its TreePredictor as untrusted -- a real concern
                # for a file from an untrusted source, but not relevant here
                # since we serialize and deserialize our own just-trained
                # model in the same process/trust boundary). `cloudpickle`
                # has no such restriction and is what `joblib.dump`
                # effectively uses elsewhere in this codebase already.
                serialization_format="cloudpickle",
            )

            result: dict[str, Any] = {"run_id": run.info.run_id, "model_version": None}
            if register and model_info.registered_model_version is not None:
                version = str(model_info.registered_model_version)
                result["model_version"] = version
                if alias:
                    client = mlflow.MlflowClient()
                    client.set_registered_model_alias(REGISTERED_MODEL_NAME, alias, version)
            return result
    except Exception:  # noqa: BLE001 - MLflow failures must never break training
        logger.warning("MLflow run logging failed; artifacts on disk are still authoritative.", exc_info=True)
        return None


def load_champion_pipeline() -> Optional[tuple[Any, str]]:
    """Load the ``champion``-aliased model from the registry, if tracking
    is reachable and the alias exists. Returns ``(pipeline, version)`` or
    ``None`` -- callers (``model_store.py``) must fall back to the local
    joblib artifact on ``None``, never raise.
    """
    if not init_tracking():
        return None
    import mlflow

    try:
        model_uri = f"models:/{REGISTERED_MODEL_NAME}@champion"
        pipeline = mlflow.sklearn.load_model(model_uri)
        client = mlflow.MlflowClient()
        version_info = client.get_model_version_by_alias(REGISTERED_MODEL_NAME, "champion")
        return pipeline, str(version_info.version)
    except Exception:  # noqa: BLE001 - registry unreachable/empty is a normal fallback path
        logger.info("No champion model in registry (or registry unreachable); using local joblib.", exc_info=True)
        return None


def set_alias(version: str, alias: str) -> bool:
    """Set a registry alias on an existing model version. Returns False
    (never raises) if tracking is unavailable."""
    if not init_tracking():
        return False
    import mlflow

    try:
        client = mlflow.MlflowClient()
        client.set_registered_model_alias(REGISTERED_MODEL_NAME, alias, version)
        return True
    except Exception:  # noqa: BLE001
        logger.warning("Failed to set alias %s -> version %s", alias, version, exc_info=True)
        return False
