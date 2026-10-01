"""Persistence for long-term agent memories (`memories`).

Strictly per owner: every read/write takes the owner id, and the agent tools
only ever pass the run owner's id. `admin` oversight (listing everyone's
memories on the Memory page) is a router decision, not a repo one.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any, Optional

from agent_harness.repos.base import connect, require_row
from agent_harness.repos.trash import now_iso

MAX_MEMORIES_PER_OWNER = 500
MAX_FACT_CHARS = 1000
MAX_TAGS = 8
MAX_TAG_CHARS = 32


class MemoryLimitError(ValueError):
    """The owner already stores the maximum number of memories."""


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def normalize_tags(tags: list[str]) -> list[str]:
    """Lower-cased, trimmed, de-duplicated, length-capped tags (order kept)."""
    out: list[str] = []
    for tag in tags:
        cleaned = " ".join(str(tag).lower().split())[:MAX_TAG_CHARS]
        if cleaned and cleaned not in out:
            out.append(cleaned)
    return out[:MAX_TAGS]


def count_for_owner(owner_id: str, dsn: Optional[str] = None) -> int:
    with connect(dsn) as conn:
        return int(require_row(conn.execute("SELECT COUNT(*) AS n FROM memories WHERE owner_id = %s AND deleted_at IS NULL", (owner_id,)).fetchone())["n"])


def create_memory(
    owner_id: str,
    fact: str,
    tags: list[str],
    source_run_id: Optional[str] = None,
    dsn: Optional[str] = None,
) -> tuple[dict[str, Any], bool]:
    """Store a fact. Returns `(row, created)`: an owner who already stored
    the same fact (case-insensitive) gets the existing row back with the tags
    merged in, `created=False`, instead of a duplicate."""
    fact = fact.strip()
    tags = normalize_tags(tags)
    now = _now()
    with connect(dsn) as conn:
        existing = conn.execute(
            "SELECT * FROM memories WHERE owner_id = %s AND lower(fact) = lower(%s) AND deleted_at IS NULL",
            (owner_id, fact),
        ).fetchone()
        if existing is not None:
            merged = normalize_tags(list(existing["tags"]) + tags)
            conn.execute("UPDATE memories SET tags = %s, updated_at = %s WHERE id = %s", (merged, now, existing["id"]))
            row = require_row(conn.execute("SELECT * FROM memories WHERE id = %s", (existing["id"],)).fetchone())
            return dict(row), False
        count = require_row(conn.execute("SELECT COUNT(*) AS n FROM memories WHERE owner_id = %s AND deleted_at IS NULL", (owner_id,)).fetchone())["n"]
        if count >= MAX_MEMORIES_PER_OWNER:
            raise MemoryLimitError(
                f"memory is full ({MAX_MEMORIES_PER_OWNER} facts): delete some on the Memory page first"
            )
        memory_id = f"mem-{uuid.uuid4().hex[:12]}"
        conn.execute(
            "INSERT INTO memories (id, owner_id, fact, tags, source_run_id, created_at, updated_at) "
            "VALUES (%s, %s, %s, %s, %s, %s, %s)",
            (memory_id, owner_id, fact, tags, source_run_id, now, now),
        )
        row = require_row(conn.execute("SELECT * FROM memories WHERE id = %s", (memory_id,)).fetchone())
        return dict(row), True


def get_memory(
    memory_id: str, dsn: Optional[str] = None, *, include_deleted: bool = False
) -> Optional[dict[str, Any]]:
    suffix = "" if include_deleted else " AND deleted_at IS NULL"
    with connect(dsn) as conn:
        row = conn.execute("SELECT * FROM memories WHERE id = %s" + suffix, (memory_id,)).fetchone()
        return dict(row) if row else None


def list_memories(
    owner_id: Optional[str] = None, q: Optional[str] = None, dsn: Optional[str] = None
) -> list[dict[str, Any]]:
    """Newest first. `owner_id=None` lists every owner's memories (admin
    oversight). `q` is a case-insensitive substring match on the fact or a tag."""
    clauses: list[str] = ["deleted_at IS NULL"]
    params: list[Any] = []
    if owner_id is not None:
        clauses.append("owner_id = %s")
        params.append(owner_id)
    if q:
        escaped = q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        clauses.append("(fact ILIKE %s OR EXISTS (SELECT 1 FROM unnest(tags) t WHERE t ILIKE %s))")
        params += [f"%{escaped}%", f"%{escaped}%"]
    where = f" WHERE {' AND '.join(clauses)}" if clauses else ""
    with connect(dsn) as conn:
        rows = conn.execute(f"SELECT * FROM memories{where} ORDER BY created_at DESC", tuple(params)).fetchall()
        return [dict(r) for r in rows]


def update_memory(
    memory_id: str,
    fact: Optional[str] = None,
    tags: Optional[list[str]] = None,
    dsn: Optional[str] = None,
) -> Optional[dict[str, Any]]:
    sets: list[str] = ["updated_at = %s"]
    params: list[Any] = [_now()]
    if fact is not None:
        sets.append("fact = %s")
        params.append(fact.strip())
    if tags is not None:
        sets.append("tags = %s")
        params.append(normalize_tags(tags))
    params.append(memory_id)
    with connect(dsn) as conn:
        if conn.execute(f"UPDATE memories SET {', '.join(sets)} WHERE id = %s AND deleted_at IS NULL", tuple(params)).rowcount == 0:
            return None
        return dict(require_row(conn.execute("SELECT * FROM memories WHERE id = %s", (memory_id,)).fetchone()))


def delete_memory(memory_id: str, dsn: Optional[str] = None) -> bool:
    """Soft-delete (see `restore_memory`); False if unknown or already deleted."""
    with connect(dsn) as conn:
        return (
            conn.execute(
                "UPDATE memories SET deleted_at = %s WHERE id = %s AND deleted_at IS NULL", (now_iso(), memory_id)
            ).rowcount
            > 0
        )


def restore_memory(memory_id: str, dsn: Optional[str] = None) -> bool:
    """Undo `delete_memory`. False if the id is unknown or not deleted."""
    with connect(dsn) as conn:
        return (
            conn.execute(
                "UPDATE memories SET deleted_at = NULL WHERE id = %s AND deleted_at IS NOT NULL", (memory_id,)
            ).rowcount
            > 0
        )


def mark_used(memory_ids: list[str], dsn: Optional[str] = None) -> None:
    """Bump `use_count` / `last_used_at` for memories a `recall` just returned."""
    if not memory_ids:
        return
    with connect(dsn) as conn:
        conn.execute(
            "UPDATE memories SET use_count = use_count + 1, last_used_at = %s WHERE id = ANY(%s)",
            (_now(), memory_ids),
        )


def get_many(memory_ids: list[str], dsn: Optional[str] = None) -> list[dict[str, Any]]:
    if not memory_ids:
        return []
    with connect(dsn) as conn:
        rows = conn.execute("SELECT * FROM memories WHERE id = ANY(%s) AND deleted_at IS NULL", (memory_ids,)).fetchall()
        return [dict(r) for r in rows]
