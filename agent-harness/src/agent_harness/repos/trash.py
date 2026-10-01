"""Soft-delete bookkeeping shared by the repos.

DELETE endpoints only stamp `deleted_at` (so the UI can offer Undo); reads hide
such rows. This module owns the other half: the retention purge that finally
hard-deletes old tombstones (with the cascade the old hard delete used), and the
slug-tombstone cleanup that lets a new row reuse a soft-deleted row's slug.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any, Optional

import psycopg

from agent_harness.repos.base import connect

RETENTION_DAYS = 7

# Tables whose rows can be soft-deleted, in the order the purge handles them.
SOFT_DELETE_TABLES = ("chat_sessions", "memories", "kb_documents", "dashboards", "skills", "agents", "prompts")


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def hard_delete_sessions(conn: psycopg.Connection[Any], ids: list[str]) -> None:
    """Sessions with their runs and events (run feedback and eval results
    cascade from `runs`)."""
    if not ids:
        return
    run_ids = [r["run_id"] for r in conn.execute("SELECT run_id FROM runs WHERE session_id = ANY(%s)", (ids,))]
    if run_ids:
        conn.execute("DELETE FROM events WHERE run_id = ANY(%s)", (run_ids,))
        conn.execute("DELETE FROM runs WHERE session_id = ANY(%s)", (ids,))
    conn.execute("DELETE FROM chat_sessions WHERE id = ANY(%s)", (ids,))


def hard_delete_agents(conn: psycopg.Connection[Any], ids: list[str]) -> None:
    """Agents; past runs and sessions keep existing, merely un-attributed."""
    if not ids:
        return
    conn.execute("UPDATE runs SET agent_id = NULL WHERE agent_id = ANY(%s)", (ids,))
    conn.execute("UPDATE chat_sessions SET agent_id = NULL WHERE agent_id = ANY(%s)", (ids,))
    conn.execute("DELETE FROM agents WHERE id = ANY(%s)", (ids,))


def _unreferenced_prompt_ids(conn: psycopg.Connection[Any], ids: list[str]) -> list[str]:
    """Of `ids`, the prompts nothing points at any more (no agent bound to the
    prompt or one of its versions, no run recorded against a version)."""
    rows = conn.execute(
        "SELECT p.id FROM prompts p WHERE p.id = ANY(%s) "
        "AND NOT EXISTS (SELECT 1 FROM agents a WHERE a.prompt_id = p.id "
        "  OR a.prompt_version_id IN (SELECT id FROM prompt_versions WHERE prompt_id = p.id)) "
        "AND NOT EXISTS (SELECT 1 FROM runs r WHERE r.prompt_version_id IN "
        "  (SELECT id FROM prompt_versions WHERE prompt_id = p.id))",
        (ids,),
    ).fetchall()
    return [r["id"] for r in rows]


def hard_delete_prompts(conn: psycopg.Connection[Any], ids: list[str]) -> list[str]:
    """Prompts (and their versions) that nothing references; returns the ids
    actually removed. Referenced ones stay as hidden tombstones."""
    free = _unreferenced_prompt_ids(conn, ids) if ids else []
    if free:
        conn.execute("UPDATE prompts SET active_version_id = NULL WHERE id = ANY(%s)", (free,))
        conn.execute("DELETE FROM prompt_versions WHERE prompt_id = ANY(%s)", (free,))
        conn.execute("DELETE FROM prompts WHERE id = ANY(%s)", (free,))
    return free


def release_slug(conn: psycopg.Connection[Any], table: str, slug: str) -> None:
    """Make `slug` free in `table` (skills, agents or prompts) when only a
    soft-deleted row holds it: that tombstone is hard-deleted. A prompt that
    past runs still reference cannot be removed, so its slug is renamed out of
    the way instead."""
    if table not in ("skills", "agents", "prompts"):
        raise ValueError(f"{table} has no slug")
    ids = [
        r["id"]
        for r in conn.execute(f"SELECT id FROM {table} WHERE slug = %s AND deleted_at IS NOT NULL", (slug,))
    ]
    if not ids:
        return
    if table == "skills":
        conn.execute("DELETE FROM skills WHERE id = ANY(%s)", (ids,))
    elif table == "agents":
        hard_delete_agents(conn, ids)
    else:
        removed = set(hard_delete_prompts(conn, ids))
        for stuck in (i for i in ids if i not in removed):
            conn.execute("UPDATE prompts SET slug = slug || '~deleted-' || id WHERE id = %s", (stuck,))


def purge_expired(dsn: Optional[str] = None, retention_days: int = RETENTION_DAYS) -> dict[str, int]:
    """Hard-delete every soft-deleted row older than the retention window.
    Returns how many rows were removed per table."""
    cutoff = (datetime.now(timezone.utc) - timedelta(days=retention_days)).isoformat()
    removed: dict[str, int] = {}

    def expired(conn: psycopg.Connection[Any], table: str) -> list[str]:
        rows = conn.execute(f"SELECT id FROM {table} WHERE deleted_at IS NOT NULL AND deleted_at < %s", (cutoff,))
        return [r["id"] for r in rows]

    with connect(dsn) as conn:
        ids = expired(conn, "chat_sessions")
        hard_delete_sessions(conn, ids)
        removed["chat_sessions"] = len(ids)
        for table in ("memories", "kb_documents", "dashboards", "skills"):
            ids = expired(conn, table)
            if ids:
                conn.execute(f"DELETE FROM {table} WHERE id = ANY(%s)", (ids,))
            removed[table] = len(ids)
        ids = expired(conn, "agents")
        hard_delete_agents(conn, ids)
        removed["agents"] = len(ids)
        removed["prompts"] = len(hard_delete_prompts(conn, expired(conn, "prompts")))
    return removed
