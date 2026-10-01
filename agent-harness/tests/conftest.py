"""Shared pytest fixtures for the agent-harness test suite.

Database strategy: a single Postgres instance is shared for the whole test
session — by default a throwaway `testcontainers` container (no manual
`docker compose up` required), started once and torn down at session end;
Alembic's migrations are run against it once. Set
`AGENT_HARNESS_TEST_DATABASE_URL` to point at an already-running Postgres
instead (e.g. `docker compose up -d postgres`'s), which skips the
testcontainer entirely — useful offline or when Docker-in-Docker isn't
available. Either way, every test gets `TRUNCATE ... RESTART IDENTITY
CASCADE` before it runs, so tests never see another test's rows."""

from __future__ import annotations

import json
import os
from pathlib import Path
from urllib.parse import urlparse

import pytest

from agent_harness.config import HarnessConfig
from agent_harness.tools.registry import build_default_registry


def pytest_addoption(parser: pytest.Parser) -> None:
    """`--live`: opt-in flag (distinct from the `live` marker) that lets a
    single test file branch between a deterministic `TestModel` double and
    the real OpenAI API, without being skipped by `addopts`'s default `-m
    "not live"`. Used by `test_e2e_smoke.py` (marked `e2e`, not `live` —
    it's part of the default network-free suite; only its model backend
    changes with this flag)."""
    parser.addoption(
        "--live",
        action="store_true",
        default=False,
        help="Use the real OpenAI API (requires OPENAI_API_KEY) for tests that support both modes, e.g. test_e2e_smoke.py.",
    )


@pytest.fixture
def live(request: pytest.FixtureRequest) -> bool:
    return bool(request.config.getoption("--live"))

_TABLES_TO_TRUNCATE = (
    "events",
    "runs",
    "incidents",
    "services",
    "chat_sessions",
    "prompts",
    "prompt_versions",
    "integrations",
    "guardrails",
    "automations",
    "dashboard_tiles",
    "dashboard_widgets",
    "dashboards",
    "skills",
    "agents",
    "eval_results",
    "eval_runs",
    "kb_documents",
    "memories",
    "run_feedback",
)

# The database the dev server and `.env` point at. The per-test TRUNCATE below
# wipes every table, so it must never be aimed here.
DEV_DATABASE_NAME = "agent_harness"


def database_name(url: str) -> str:
    """The database name in a Postgres URL (the path without its leading slash)."""
    return urlparse(url).path.lstrip("/")


def assert_safe_to_truncate(url: str) -> None:
    """Refuse to wipe the dev database. Tests run against a throwaway container
    or an explicitly provided test database (e.g. `agent_harness_v3`), never the
    database named `agent_harness`."""
    if database_name(url) == DEV_DATABASE_NAME:
        raise RuntimeError(
            f"refusing to TRUNCATE the dev database '{DEV_DATABASE_NAME}'. Point DATABASE_URL / "
            "AGENT_HARNESS_TEST_DATABASE_URL at a different database (e.g. agent_harness_v3) or unset "
            "AGENT_HARNESS_TEST_DATABASE_URL to use a throwaway container."
        )


def _run_migrations(database_url: str) -> None:
    """Run `alembic upgrade head` programmatically against `database_url`."""
    from alembic.config import Config

    from alembic import command

    repo_root = Path(__file__).resolve().parents[1]
    cfg = Config(str(repo_root / "alembic.ini"))
    cfg.set_main_option("script_location", str(repo_root / "alembic"))
    db_url = database_url
    if db_url.startswith("postgresql://"):
        db_url = db_url.replace("postgresql://", "postgresql+psycopg://", 1)
    cfg.set_main_option("sqlalchemy.url", db_url)
    command.upgrade(cfg, "head")


@pytest.fixture(scope="session")
def _test_database_url() -> str:
    """Session-scoped Postgres DSN, migrated once. Prefers an externally
    provided `AGENT_HARNESS_TEST_DATABASE_URL` (e.g. `docker compose up -d
    postgres`); otherwise spins up a throwaway `testcontainers` Postgres."""
    external = os.environ.get("AGENT_HARNESS_TEST_DATABASE_URL")
    if external:
        assert_safe_to_truncate(external)
        _run_migrations(external)
        yield external
        return

    from testcontainers.postgres import PostgresContainer

    with PostgresContainer("postgres:16", driver=None) as pg:
        url = pg.get_connection_url(driver=None)
        _run_migrations(url)
        yield url

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
def _isolated_data_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, _test_database_url: str):
    """Point the Postgres DSN, KB corpus, and service seed at isolated
    per-test state, so the suite never reads/writes the real
    `agent-harness/data/` tree or a previous test's rows, and every test
    starts from the same known service statuses used by the pre-existing
    test suite."""
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

    monkeypatch.setattr(settings, "DATABASE_URL", _test_database_url)
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

    # Schema already exists (migrated once per session by
    # `_test_database_url`); truncate every table so this test starts from
    # an empty database regardless of what earlier tests inserted.
    assert_safe_to_truncate(settings.DATABASE_URL)
    with db_module.connect() as conn:
        conn.execute(f"TRUNCATE TABLE {', '.join(_TABLES_TO_TRUNCATE)} RESTART IDENTITY CASCADE")

    db_module.ensure_ready()
    retrieval.reset_index()
    yield
    _stop_leftover_live_runs()
    retrieval.reset_index()


def _stop_leftover_live_runs(timeout: float = 3.0) -> None:
    """Cancel any background run a test left in flight (typically one parked
    on an approval nobody answers). The human approval budget is 15 minutes,
    so such a run would otherwise stay `pending_approval` in the shared
    in-process registry and leak into later tests' "pending approvals"."""
    import time

    from agent_harness import state

    live = [r for r in state.registry.list_runs() if r.status in ("running", "pending_approval")]
    for record in live:
        state.registry.cancel_run(record.run_id)
    deadline = time.monotonic() + timeout
    while live and time.monotonic() < deadline:
        live = [r for r in live if r.status in ("running", "pending_approval")]
        time.sleep(0.02)


@pytest.fixture(autouse=True)
def _default_test_client_identity(monkeypatch: pytest.MonkeyPatch):
    """Every existing test in the suite predates RBAC (phase 01) and uses a
    bare `TestClient(app)` with no identity header — rather than touching
    every one of those files, patch `httpx.Client.request` (the transport
    `TestClient` is built on) to inject `X-User-Id: u_admin` whenever a test
    didn't already set one. `u_admin` sees/can-mutate everything, so this
    keeps the whole pre-RBAC suite green unmodified; `test_rbac.py` (and any
    test that wants a specific role) uses `client_as()` below or sets the
    header explicitly to opt out of this default."""
    from starlette.testclient import TestClient

    # Starlette's TestClient vendors its own httpx fork (`httpx2` as of the
    # version this repo pins) as its base class, so patching the public
    # `httpx.Client.request` never intercepts anything. `build_request` is
    # the one method every entry point funnels through — `.get`/`.post`/
    # `.patch`/`.request` (via `httpx2.Client.request`) *and* `.stream`
    # (used directly by the SSE tests, which never calls `.request` at
    # all) — so patch that instead of chasing every verb helper.
    original_build_request = TestClient.build_request

    def _patched_build_request(self, method, url, *args, **kwargs):
        headers = kwargs.get("headers")
        if headers is None:
            kwargs["headers"] = {"X-User-Id": "u_admin"}
        elif "X-User-Id" not in headers and "x-user-id" not in {k.lower() for k in headers}:
            headers = dict(headers)
            headers["X-User-Id"] = "u_admin"
            kwargs["headers"] = headers
        return original_build_request(self, method, url, *args, **kwargs)

    monkeypatch.setattr(TestClient, "build_request", _patched_build_request)


def client_as(client, user_id: str):
    """Return a thin wrapper around `client` (a `fastapi.testclient.TestClient`)
    whose requests always carry `X-User-Id: user_id`, overriding the
    `u_admin` default from `_default_test_client_identity` above."""

    class _ScopedClient:
        def __init__(self, inner, uid: str) -> None:
            self._inner = inner
            self._uid = uid

        def _merge(self, kwargs: dict) -> dict:
            headers = dict(kwargs.get("headers") or {})
            headers["X-User-Id"] = self._uid
            kwargs["headers"] = headers
            return kwargs

        def __getattr__(self, name: str):
            attr = getattr(self._inner, name)
            if name in ("get", "post", "patch", "put", "delete", "request"):

                def _wrapped(*args, **kwargs):
                    return attr(*args, **self._merge(kwargs))

                return _wrapped
            return attr

    return _ScopedClient(client, user_id)


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
