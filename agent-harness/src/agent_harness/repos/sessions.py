"""Persistence for `chat_sessions` joined with each session's latest run."""

from __future__ import annotations

from typing import Any, Optional

from agent_harness.repos.base import connect
from agent_harness.repos.trash import hard_delete_sessions, now_iso


def create_session(
    session_id: str,
    title: str,
    created_at: str,
    owner_id: str = "u_admin",
    agent_id: Optional[str] = None,
    dsn: Optional[str] = None,
) -> dict[str, Any]:
    with connect(dsn) as conn:
        conn.execute(
            "INSERT INTO chat_sessions (id, title, created_at, last_active_at, status, owner_id, agent_id) "
            "VALUES (%s, %s, %s, %s, %s, %s, %s)",
            (session_id, title, created_at, created_at, "idle", owner_id, agent_id),
        )
    return {
        "id": session_id,
        "title": title,
        "created_at": created_at,
        "last_active_at": created_at,
        "status": "idle",
        "owner_id": owner_id,
        "agent_id": agent_id,
    }


def touch_session(session_id: str, last_active_at: str, status: str, dsn: Optional[str] = None) -> None:
    """Update a session's `last_active_at`/`status` bookkeeping columns.
    Best-effort: a session row created outside this module (should never
    happen, but defensive) means 0 rows updated, which is not an error here."""
    with connect(dsn) as conn:
        conn.execute(
            "UPDATE chat_sessions SET last_active_at = %s, status = %s WHERE id = %s",
            (last_active_at, status, session_id),
        )


def get_session(session_id: str, dsn: Optional[str] = None) -> Optional[dict[str, Any]]:
    with connect(dsn) as conn:
        row = conn.execute(
            "SELECT * FROM chat_sessions WHERE id = %s AND deleted_at IS NULL", (session_id,)
        ).fetchone()
        return dict(row) if row else None


_SESSION_LATEST_RUN_JOIN = """
    SELECT
        cs.id, cs.title, cs.created_at, cs.last_active_at, cs.status, cs.owner_id, cs.agent_id,
        cs.archived_at, cs.deleted_at,
        lr.run_id AS last_run_id, lr.status AS last_run_status,
        lr.started_at AS last_run_started_at
    FROM chat_sessions cs
    LEFT JOIN LATERAL (
        SELECT run_id, status, started_at FROM runs
        WHERE runs.session_id = cs.id
        ORDER BY started_at DESC
        LIMIT 1
    ) lr ON TRUE
"""


def list_sessions(
    dsn: Optional[str] = None,
    *,
    q: Optional[str] = None,
    agent_id: Optional[str] = None,
    since: Optional[str] = None,
    until: Optional[str] = None,
    archived: str = "exclude",
) -> list[dict[str, Any]]:
    """Every session with its most recently *persisted* run's status
    attached (id/status/started_at, or all-None for a session with no run
    yet). This is the Postgres-only half of live status — the sessions router
    overlays `RunRegistry`'s in-memory status on top for whichever run is still
    in-flight in this process, since a running/pending_approval run's
    terminal row is not written to Postgres until it finishes.

    Filters: `q` matches the title or the objective of any of the session's
    runs (case-insensitive substring); `agent_id`; `since`/`until` bound
    `last_active_at` (ISO timestamps compare lexically); `archived` is
    `exclude` (default), `include` or `only`."""
    clauses: list[str] = ["cs.deleted_at IS NULL"]
    params: list[Any] = []
    if q:
        escaped = q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        like = f"%{escaped}%"
        clauses.append(
            "(cs.title ILIKE %s OR EXISTS (SELECT 1 FROM runs rq WHERE rq.session_id = cs.id AND rq.objective ILIKE %s))"
        )
        params += [like, like]
    if agent_id:
        clauses.append("cs.agent_id = %s")
        params.append(agent_id)
    if since:
        clauses.append("cs.last_active_at >= %s")
        params.append(since)
    if until:
        clauses.append("cs.last_active_at <= %s")
        params.append(until)
    if archived == "exclude":
        clauses.append("cs.archived_at IS NULL")
    elif archived == "only":
        clauses.append("cs.archived_at IS NOT NULL")
    where = f" WHERE {' AND '.join(clauses)}" if clauses else ""
    with connect(dsn) as conn:
        rows = conn.execute(
            _SESSION_LATEST_RUN_JOIN + where + " ORDER BY cs.last_active_at DESC", tuple(params)
        ).fetchall()
        return [dict(r) for r in rows]


def get_session_with_latest_run(
    session_id: str, dsn: Optional[str] = None, *, include_deleted: bool = False
) -> Optional[dict[str, Any]]:
    suffix = "" if include_deleted else " AND cs.deleted_at IS NULL"
    with connect(dsn) as conn:
        row = conn.execute(_SESSION_LATEST_RUN_JOIN + " WHERE cs.id = %s" + suffix, (session_id,)).fetchone()
        return dict(row) if row else None


def rename_session(session_id: str, title: str, dsn: Optional[str] = None) -> bool:
    with connect(dsn) as conn:
        return (
            conn.execute(
                "UPDATE chat_sessions SET title = %s WHERE id = %s AND deleted_at IS NULL", (title, session_id)
            ).rowcount
            > 0
        )


def set_session_archived(session_id: str, archived_at: Optional[str], dsn: Optional[str] = None) -> bool:
    """Archive (`archived_at` = timestamp) or restore (`None`) a session."""
    with connect(dsn) as conn:
        return (
            conn.execute(
                "UPDATE chat_sessions SET archived_at = %s WHERE id = %s AND deleted_at IS NULL",
                (archived_at, session_id),
            ).rowcount
            > 0
        )


def delete_session(session_id: str, dsn: Optional[str] = None) -> bool:
    """Soft-delete: the session (and its runs) disappear from every read until
    restored or purged after the retention window. Returns False for an
    unknown or already-deleted id. The caller is responsible for refusing a
    session whose run is still live."""
    with connect(dsn) as conn:
        return (
            conn.execute(
                "UPDATE chat_sessions SET deleted_at = %s WHERE id = %s AND deleted_at IS NULL",
                (now_iso(), session_id),
            ).rowcount
            > 0
        )


def restore_session(session_id: str, dsn: Optional[str] = None) -> bool:
    """Undo `delete_session`. False if the id is unknown or not deleted."""
    with connect(dsn) as conn:
        return (
            conn.execute(
                "UPDATE chat_sessions SET deleted_at = NULL WHERE id = %s AND deleted_at IS NOT NULL", (session_id,)
            ).rowcount
            > 0
        )


def purge_session(session_id: str, dsn: Optional[str] = None) -> None:
    """Hard-delete a session with its runs and their events."""
    with connect(dsn) as conn:
        hard_delete_sessions(conn, [session_id])
