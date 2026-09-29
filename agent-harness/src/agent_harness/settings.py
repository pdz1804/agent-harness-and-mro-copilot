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

DB_PATH: Path = _env_path("AGENT_HARNESS_DB_PATH", PROJECT_ROOT / "data" / "harness.db")
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
