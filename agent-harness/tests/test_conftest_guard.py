"""The suite TRUNCATEs every table, so it must refuse to target the dev database."""

from __future__ import annotations

import pytest
from conftest import DEV_DATABASE_NAME, assert_safe_to_truncate, database_name


def test_database_name_is_the_url_path() -> None:
    assert database_name("postgresql://u:p@localhost:5433/agent_harness") == "agent_harness"
    assert database_name("postgresql://u:p@localhost:5433/agent_harness_v3") == "agent_harness_v3"
    assert database_name("postgresql://u:p@localhost/test?sslmode=disable") == "test"


@pytest.mark.parametrize(
    "url",
    [
        "postgresql://agent_harness:agent_harness@localhost:5433/agent_harness",
        "postgresql+psycopg://other:pw@db.example:5432/agent_harness",
        "postgresql://u:p@localhost:5433/agent_harness?sslmode=disable",
    ],
)
def test_the_dev_database_is_refused(url: str) -> None:
    with pytest.raises(RuntimeError, match="refusing to TRUNCATE"):
        assert_safe_to_truncate(url)


@pytest.mark.parametrize(
    "url",
    [
        "postgresql://agent_harness:agent_harness@localhost:5433/agent_harness_v3",
        "postgresql://test:test@localhost:49152/test",
        "postgresql://u:p@localhost/agent_harness_test",
    ],
)
def test_other_databases_are_allowed(url: str) -> None:
    assert_safe_to_truncate(url)


def test_the_guard_runs_for_every_test_against_the_active_database() -> None:
    from agent_harness import settings

    assert database_name(settings.DATABASE_URL) != DEV_DATABASE_NAME
