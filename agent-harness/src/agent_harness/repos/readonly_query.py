"""Least-privilege execution of user/agent-authored SELECTs (the `harness_reader` role)."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Optional

import psycopg
from psycopg.rows import dict_row

from agent_harness.repos.base import connect, get_dsn

READER_ROLE = "harness_reader"
READER_SCHEMA = "harness_ro"


@dataclass(frozen=True)
class QueryScope:
    """Whose rows a user/agent-authored query may see. The curated
    `harness_ro` views filter on these (`app.user_id` / `app.is_admin`), so
    a non-admin only ever reads rows belonging to their own runs/sessions."""

    user_id: str = ""
    is_admin: bool = False


def scope_for_user(user_id: str, dsn: Optional[str] = None) -> QueryScope:
    """Resolve a stored user id to a `QueryScope` (admin role -> unscoped).
    An unknown/missing user gets the empty scope: only globally visible
    views (e.g. `services`) return anything."""
    with connect(dsn) as conn:
        row = conn.execute("SELECT role FROM users WHERE id = %s", (user_id,)).fetchone()
    if row is None:
        return QueryScope()
    return QueryScope(user_id=user_id, is_admin=row["role"] == "admin")


def describe_query_error(exc: BaseException) -> str:
    """A short, client-safe description of a failed widget/preview query:
    the database's own primary message for user-fixable problems (bad
    column, bad syntax, wrong type), a fixed phrase for everything else —
    never the raw exception, which can carry connection details."""
    if isinstance(exc, psycopg.errors.QueryCanceled):
        return "query timed out (exceeded the statement timeout)"
    if isinstance(exc, psycopg.errors.InsufficientPrivilege):
        return "query is not permitted: only the curated read-only views may be queried"
    if isinstance(
        exc,
        (
            psycopg.errors.UndefinedTable,
            psycopg.errors.UndefinedColumn,
            psycopg.errors.UndefinedFunction,
            psycopg.errors.SyntaxError,
            psycopg.errors.DatatypeMismatch,
            psycopg.errors.InvalidTextRepresentation,
            psycopg.errors.AmbiguousColumn,
            psycopg.errors.GroupingError,
            psycopg.errors.DivisionByZero,
        ),
    ):
        message = getattr(getattr(exc, "diag", None), "message_primary", None)
        if message:
            return f"query failed: {message}"
    return "query failed (database error)"


def run_read_only_query(
    sql_query: str,
    dsn: Optional[str] = None,
    *,
    statement_timeout_ms: int = 5000,
    row_cap: int = 1000,
    scope: Optional[QueryScope] = None,
) -> dict[str, Any]:
    """Execute `sql_query` fresh against the real Postgres connection —
    never cached — as the least-privilege `harness_reader` role.

    This is the database-level boundary for user/agent-authored SQL (dashboard
    widgets, query preview, `create_dashboard`). The application role is a
    superuser, so a READ ONLY transaction alone would still allow reading
    server files and every table; instead, inside one always-rolled-back
    transaction this function (as the app role) sets the scope GUCs, the
    `search_path` and the statement timeout, then drops privileges with
    `SET LOCAL ROLE harness_reader` before running the query. That role owns
    nothing and can only SELECT the curated, owner-scoped views in the
    `harness_ro` schema; it cannot call `set_config` (revoked from PUBLIC) to
    undo any of this. The text/parse checks in `sql_guard` run before this
    and give friendlier errors; this layer holds even if they are bypassed.

    The transaction is explicitly `READ ONLY` and unconditionally rolled back
    in a `finally`, whether the query succeeded or raised. A plain
    connection is used (not `connect()`, which commits on success). Rows are
    capped (`row_cap + 1` fetched to detect truncation).

    `scope` selects whose rows the views return (default: nobody's — only
    the global views such as `services`).

    Returns `{"columns": [...], "rows": [...], "truncated": bool}`."""
    scope = scope or QueryScope()
    conn = psycopg.connect(dsn or get_dsn(), row_factory=dict_row)
    try:
        conn.execute("SET TRANSACTION READ ONLY")
        conn.execute(
            "SELECT set_config('app.user_id', %s, true), set_config('app.is_admin', %s, true), "
            "set_config('search_path', %s, true), set_config('statement_timeout', %s, true)",
            (scope.user_id, "on" if scope.is_admin else "off", READER_SCHEMA, str(int(statement_timeout_ms))),
        )
        conn.execute(f"SET LOCAL ROLE {READER_ROLE}")
        cur = conn.execute(sql_query)
        if cur.description is None:
            return {"columns": [], "rows": [], "truncated": False}
        columns = [d.name for d in cur.description]
        fetched = cur.fetchmany(row_cap + 1)
        truncated = len(fetched) > row_cap
        rows = [dict(r) for r in fetched[:row_cap]]
        return {"columns": columns, "rows": rows, "truncated": truncated}
    finally:
        conn.rollback()
        conn.close()
