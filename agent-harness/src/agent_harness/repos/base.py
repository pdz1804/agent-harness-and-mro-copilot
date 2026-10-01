"""Connection plumbing shared by every repository module.

A short-lived connection is opened per call (`connect()` context manager)
rather than held open for the process lifetime. This keeps persistence
trivially thread-safe for the harness's threading model (each async run
executes on its own `threading.Thread` — see `run_registry.py`) without
needing an explicit connection pool for what is a low-throughput demo
backend; psycopg/libpq connection setup to a local/dev Postgres is cheap
enough that this remains the simplest correct option here.

All connections default to `agent_harness.settings.DATABASE_URL` (read at
call time, so tests can monkeypatch it) but accept an explicit `dsn`
override.
"""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any, Optional

import psycopg
from psycopg.rows import DictRow, dict_row

from agent_harness import settings


def get_dsn() -> str:
    return settings.DATABASE_URL


@contextmanager
def connect(dsn: Optional[str] = None) -> Iterator[psycopg.Connection[DictRow]]:
    conn = psycopg.connect(dsn or get_dsn(), row_factory=dict_row)
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def require_row(row: Optional[dict[str, Any]]) -> dict[str, Any]:
    """The row of a query that must return one (an aggregate, or a lookup of a
    row written moments ago in the same transaction); fails loudly otherwise."""
    if row is None:
        raise LookupError("expected the query to return a row")
    return row
