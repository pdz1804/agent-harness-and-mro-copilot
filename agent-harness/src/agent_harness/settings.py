"""Process-wide configuration loaded from environment variables / `.env`.

This is deliberately separate from `config.HarnessConfig` (which only holds
per-run loop tunables such as step/time limits and is a frozen pydantic
model passed explicitly into `AgentLoop`). `settings` holds *deployment*
configuration: where the SQLite DB and knowledge-base docs live, and
whether a real OpenAI key is available.

Values are read from `agent-harness/.env` via `python-dotenv` (never
committed — see `.gitignore`) plus the real process environment, which
always takes precedence over `.env`. Nothing here ever prints or logs the
API key itself.
"""

from __future__ import annotations

import os
from pathlib import Path

from dotenv import load_dotenv

# agent-harness/src/agent_harness/settings.py -> parents[2] == agent-harness/
PROJECT_ROOT = Path(__file__).resolve().parents[2]

# `override=False`: real environment variables (e.g. set by a shell or CI)
# always win over `.env`, matching standard dotenv semantics.
load_dotenv(PROJECT_ROOT / ".env", override=False)


def _env_path(name: str, default: Path) -> Path:
    raw = os.environ.get(name)
    return Path(raw) if raw else default


OPENAI_API_KEY: str | None = (os.environ.get("OPENAI_API_KEY") or "").strip() or None
OPENAI_MODEL: str = os.environ.get("OPENAI_MODEL", "gpt-4o-mini").strip() or "gpt-4o-mini"

# Postgres connection string for `agent_harness.db`. Defaults to the
# docker-compose `postgres` service on host port 5433 (see
# docker-compose.yml at the project root) so `docker compose up -d
# postgres` + the default `.env` "just work" together.
DATABASE_URL: str = (
    os.environ.get("DATABASE_URL")
    or "postgresql://agent_harness:agent_harness@localhost:5433/agent_harness"
).strip()

KB_DIR: Path = _env_path("AGENT_HARNESS_KB_DIR", PROJECT_ROOT / "data" / "kb")
SEED_SERVICES_PATH: Path = _env_path(
    "AGENT_HARNESS_SEED_SERVICES", PROJECT_ROOT / "data" / "seed" / "services.json"
)

# Retrieval backend for `agent_harness.retrieval`. "hybrid" (default) fuses
# BM25 + local dense embeddings via Reciprocal Rank Fusion; "bm25" disables
# the embedding model entirely (useful for offline CI that should never try
# to download a model); "dense" is embeddings-only (mainly for the eval
# script's bm25-vs-dense-vs-hybrid comparison). See docs/design-report.md.
RETRIEVAL_MODE: str = (os.environ.get("AGENT_HARNESS_RETRIEVAL_MODE", "hybrid").strip().lower() or "hybrid")

# Local sentence-transformers model for dense retrieval. Runs on CPU, no
# external API calls, no cost — see agent_harness.dense_embeddings.
EMBEDDING_MODEL_NAME: str = (
    os.environ.get("AGENT_HARNESS_EMBEDDING_MODEL", "BAAI/bge-small-en-v1.5").strip()
    or "BAAI/bge-small-en-v1.5"
)

# On-disk cache of chunk-text-hash -> embedding vector, so restarting the
# process never re-embeds unchanged KB content.
EMBEDDING_CACHE_DIR: Path = _env_path(
    "AGENT_HARNESS_EMBEDDING_CACHE_DIR", PROJECT_ROOT / "data" / "kb_cache"
)


# MLflow tracking backend for observability (phase 11c). Defaults to the
# docker-compose `mlflow` service (see docker-compose.yml) so `docker
# compose up -d` + the default `.env` "just work" together, matching the
# DATABASE_URL/KB_DIR pattern above. Empty string disables MLflow tracing
# entirely (unit tests keep it unset so they never require the server).
MLFLOW_TRACKING_URI: str = (os.environ.get("MLFLOW_TRACKING_URI") or "").strip()
MLFLOW_EXPERIMENT_NAME: str = (
    os.environ.get("MLFLOW_EXPERIMENT_NAME", "agent-harness").strip() or "agent-harness"
)

# `mlflow.tracking.MlflowClient`'s REST layer defaults to a 120s
# per-request timeout with up to 7 retries (exponential backoff, factor 2)
# — against a genuinely unreachable host that's 120s x up to 7 attempts,
# i.e. minutes, not seconds, before it ever raises. That default is fine
# for a real MLflow server having a slow moment, but turns "the configured
# MLflow server is simply down" into an effectively-hung request for any
# caller expecting a prompt 502 (`GET /evals`, and the phase 07 online eval
# runner's MLflow logging). `setdefault` so a real deployment/CI that wants
# different values can still override via its own environment; only fills
# these in when unset. Read dynamically by `mlflow.environment_variables`
# on every call (not cached at mlflow's import time), so setting them here
# — as long as it happens before the first `MlflowClient`/`mlflow.*` REST
# call in this process — is sufficient; it does not need to run before
# `import mlflow` itself.
os.environ.setdefault("MLFLOW_HTTP_REQUEST_TIMEOUT", "5")
os.environ.setdefault("MLFLOW_HTTP_REQUEST_MAX_RETRIES", "1")

# `MlflowClient._log_url` (called on every `mlflow.start_run()`, e.g. phase
# 07's online eval runner) writes a "🏃 View run ..." banner straight to
# `sys.stdout` with no encoding guard. Under a bare `uvicorn` process whose
# stdout has no real console code page (e.g. redirected to a file on
# Windows), that raises `UnicodeEncodeError` on the emoji and would
# otherwise mark an entirely successful MLflow-logging step "failed" for a
# purely cosmetic banner. Same category of Windows-specific MLflow rough
# edge as the two timeout vars above; this is MLflow's own documented
# escape hatch for suppressing the banner (not the actual logging).
os.environ.setdefault("MLFLOW_SUPPRESS_PRINTING_URL_TO_STDOUT", "true")


def _env_int(name: str, default: int) -> int:
    raw = (os.environ.get(name) or "").strip()
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError:
        return default


# Phase 11d: token budget (in tiktoken-counted tokens over the flattened
# message history text) that triggers autocompaction of a run's older
# conversation turns before the next LLM call — see `loop.py`'s
# `_maybe_autocompact`. Generous default so interactive/demo runs rarely
# trigger it; tests override via `HarnessConfig.autocompact_token_budget`
# directly rather than this env var, so they stay deterministic regardless
# of the process environment.
AUTOCOMPACT_TOKEN_BUDGET: int = _env_int("AUTOCOMPACT_TOKEN_BUDGET", 6000)


def mlflow_configured() -> bool:
    """True if an MLflow tracking URI is configured for this process."""
    return bool(MLFLOW_TRACKING_URI)


def llm_configured() -> bool:
    """True if a real OpenAI key is available in this process's environment."""
    return bool(OPENAI_API_KEY)


# Process-wide "last provider call failed" state, set by
# `OpenAIChatLLMClient` on a provider-level failure (auth/quota/rate-limit/
# network) and cleared on the next successful call. Lets `GET /health`
# distinguish "not configured" (no API key) from "configured but the last
# real call failed" (e.g. insufficient_quota), each rendered differently by
# the UI's health indicator rather than a single generic "unhealthy" state.
_last_llm_error: str | None = None


def record_llm_error(message: str) -> None:
    global _last_llm_error
    _last_llm_error = message


def clear_llm_error() -> None:
    global _last_llm_error
    _last_llm_error = None


def last_llm_error() -> str | None:
    return _last_llm_error


def _env_float(name: str, default: float) -> float:
    raw = (os.environ.get(name) or "").strip()
    if not raw:
        return default
    try:
        value = float(raw)
    except ValueError:
        return default
    return value if value > 0 else default


# How long a run may wait for a human to approve or deny a gated tool call
# before it ends as an approval timeout. This wait is a human budget, kept
# separate from (and excluded from) the agent's own `max_wall_clock_seconds`
# compute budget, so a person has time to read the preview and decide.
APPROVAL_TIMEOUT_SECONDS: float = _env_float("APPROVAL_TIMEOUT_SECONDS", 900.0)
