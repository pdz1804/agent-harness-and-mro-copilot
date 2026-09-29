"""Shared pytest fixtures for the agent-harness test suite."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from agent_harness.config import HarnessConfig
from agent_harness.tools.registry import build_default_registry

# Mirrors data/seed/services.json's first 3 rows exactly (name + status),
# so tests that assert on `auth-service` -> operational,
# `payments-api` -> degraded, `search-index` -> down keep passing against
# this isolated per-test database.
_SEED_SERVICES = [
    {
        "name": "auth-service",
        "status": "operational",
        "latency_ms": 48.0,
        "error_rate": 0.001,
        "last_deploy": "2026-09-18T09:12:00Z",
        "owner": "platform-auth",
    },
    {
        "name": "payments-api",
        "status": "degraded",
        "latency_ms": 812.0,
        "error_rate": 0.041,
        "last_deploy": "2026-09-24T14:05:00Z",
        "owner": "payments-platform",
    },
    {
        "name": "search-index",
        "status": "down",
        "latency_ms": 0.0,
        "error_rate": 1.0,
        "last_deploy": "2026-09-27T02:30:00Z",
        "owner": "search-platform",
    },
]

_KB_FIXTURE_DOCS = {
    "kb-001-payments-api-degraded-latency.md": (
        "# Runbook: payments-api degraded latency\n\n"
        "If payments-api reports degraded status, check the downstream "
        "card-processor webhook queue depth first before escalating.\n"
    ),
    "kb-002-auth-service-outage-checklist.md": (
        "# Runbook: auth-service outage checklist\n\n"
        "auth-service outages are usually caused by session-store "
        "connection exhaustion. Restart the connection pool before filing an incident.\n"
    ),
    "kb-003-search-index-rebuild-procedure.md": (
        "# Runbook: search-index rebuild procedure\n\n"
        "search-index down status typically means the nightly rebuild job "
        "failed. Re-trigger the rebuild pipeline and monitor for 15 minutes.\n"
    ),
    "kb-004-incident-creation-policy.md": (
        "# Policy: when to create an incident\n\n"
        "Create an incident only after a runbook has been attempted and the "
        "service remains degraded or down for more than 5 minutes.\n"
    ),
}


@pytest.fixture(autouse=True)
def _isolated_data_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """Point the SQLite DB, KB corpus, and service seed at an isolated tmp
    directory for every test, so the suite never reads/writes the real
    `agent-harness/data/` tree and every test starts from the same known
    service statuses used by the pre-existing test suite."""
    from agent_harness import retrieval, settings

    data_dir = tmp_path / "data"
    kb_dir = data_dir / "kb"
    kb_dir.mkdir(parents=True)
    seed_dir = data_dir / "seed"
    seed_dir.mkdir(parents=True)

    for filename, content in _KB_FIXTURE_DOCS.items():
        (kb_dir / filename).write_text(content, encoding="utf-8")

    seed_path = seed_dir / "services.json"
    seed_path.write_text(json.dumps(_SEED_SERVICES), encoding="utf-8")

    db_path = data_dir / "harness.db"

    monkeypatch.setattr(settings, "DB_PATH", db_path)
    monkeypatch.setattr(settings, "KB_DIR", kb_dir)
    monkeypatch.setattr(settings, "SEED_SERVICES_PATH", seed_path)
    # Force BM25-only retrieval for the non-live suite: the dense embedding
    # model requires a (possibly network) download/load on first use, which
    # would make step/latency-sensitive tests (e.g. test_limits.py) flaky
    # and would break entirely on a network-restricted CI runner. Hybrid
    # retrieval itself is covered by tests/test_retrieval.py, which sets
    # this back to "hybrid" explicitly where needed.
    monkeypatch.setattr(settings, "RETRIEVAL_MODE", "bm25")

    from agent_harness import db as db_module

    db_module.ensure_ready()
    retrieval.reset_index()
    yield
    retrieval.reset_index()


@pytest.fixture
def tools():
    """Fresh instance of the 3 default DB/retrieval-backed tools for each test."""
    return build_default_registry()


@pytest.fixture
def runs_dir(tmp_path: Path) -> Path:
    """Isolated trace-file directory per test (never writes to the repo's runs/)."""
    d = tmp_path / "runs"
    d.mkdir()
    return d


@pytest.fixture
def fast_config() -> HarnessConfig:
    """Generous limits but tiny retry backoff, so failure-path tests run fast."""
    return HarnessConfig(
        max_steps=10,
        max_wall_clock_seconds=10.0,
        tool_timeout_seconds=2.0,
        max_tool_retries=2,
        tool_retry_backoff_seconds=0.001,
        max_llm_retries=2,
    )
