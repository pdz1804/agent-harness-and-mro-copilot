"""Persistence for the prompt library (phase 02): `prompts` (named,
versioned library entries — system/skill_router/judge) and `prompt_versions`
(immutable content, now children of a `prompts` row via `prompt_id`).

Versions are never mutated or deleted once created; "editing" a prompt means
creating a new version and (optionally) activating it — `prompts.
active_version_id` is the only pointer that ever moves. `run_registry.py`
and `api.py`'s synchronous `/run` endpoint both resolve the *content* an
agent should be built with via `get_active_content('ops-system')` (and, from
phase 04/07 onward, `'skill-router'`/`'eval-judge'`), never a hardcoded
string — this repo is the single source of truth for those, matching
`agent_harness.loop.SYSTEM_PROMPT`'s value only as a migration-time seed."""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any, Optional

from psycopg.types.json import Jsonb

from agent_harness import db
from agent_harness.repos.base import require_row

# The 3 library entries seeded by the `add_prompt_library` migration. Used
# by the router to refuse deleting a prompt the harness itself depends on at
# runtime (`kind is seeded-system` in the phase 02 spec).
SEEDED_SLUGS = ("ops-system", "skill-router", "eval-judge")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _new_id(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:12]}"


def _row_to_prompt(row: dict[str, Any]) -> dict[str, Any]:
    row = dict(row)
    row["tags"] = list(row.get("tags") or [])
    return row


def list_prompts(
    kind: Optional[str] = None, q: Optional[str] = None, dsn: Optional[str] = None
) -> list[dict[str, Any]]:
    """Every non-archived prompt, each annotated with its active version
    summary and total version count. Filters: `kind` (exact match) and `q`
    (case-insensitive substring match against name/slug/description)."""
    with db.connect(dsn) as conn:
        rows = conn.execute(
            "SELECT p.*, "
            "  av.id AS av_id, av.version AS av_version, av.created_at AS av_created_at, "
            "  (SELECT COUNT(*) FROM prompt_versions pv WHERE pv.prompt_id = p.id) AS version_count "
            "FROM prompts p "
            "LEFT JOIN prompt_versions av ON av.id = p.active_version_id "
            "WHERE p.archived_at IS NULL "
            "ORDER BY p.updated_at DESC"
        ).fetchall()
        out = []
        for r in rows:
            row = dict(r)
            if kind is not None and row["kind"] != kind:
                continue
            if q:
                haystack = " ".join(
                    filter(None, [row["slug"], row["name"], row.get("description")])
                ).lower()
                if q.lower() not in haystack:
                    continue
            active_version = None
            if row["av_id"] is not None:
                active_version = {
                    "id": row["av_id"],
                    "version": row["av_version"],
                    "created_at": row["av_created_at"],
                }
            out.append(
                {
                    **_row_to_prompt(row),
                    "active_version": active_version,
                    "version_count": row["version_count"],
                }
            )
        return out


def get_prompt(prompt_id: str, dsn: Optional[str] = None) -> Optional[dict[str, Any]]:
    """Full detail: prompt metadata + every version (newest first)."""
    with db.connect(dsn) as conn:
        row = conn.execute("SELECT * FROM prompts WHERE id = %s", (prompt_id,)).fetchone()
        if row is None:
            return None
        versions = conn.execute(
            "SELECT pv.*, "
            "  (SELECT COUNT(*) FROM runs r WHERE r.prompt_version_id = pv.id) AS run_count, "
            "  (SELECT COUNT(*) FROM agents a WHERE a.prompt_version_id = pv.id) AS pinned_agents "
            "FROM prompt_versions pv WHERE pv.prompt_id = %s ORDER BY pv.version DESC",
            (prompt_id,),
        ).fetchall()
        return {**_row_to_prompt(row), "versions": [dict(v) for v in versions]}


def get_prompt_by_slug(slug: str, dsn: Optional[str] = None) -> Optional[dict[str, Any]]:
    with db.connect(dsn) as conn:
        row = conn.execute("SELECT * FROM prompts WHERE slug = %s", (slug,)).fetchone()
        return _row_to_prompt(row) if row else None


def create_prompt(
    *,
    slug: str,
    name: str,
    description: Optional[str],
    kind: str,
    owner_id: str,
    visibility: str,
    tags: list[str],
    content: str,
    created_by: str,
    required_placeholders: Optional[list[str]] = None,
    verification: Optional[dict[str, Any]] = None,
    dsn: Optional[str] = None,
) -> dict[str, Any]:
    """Create a new library entry with an initial (v1, active) version, in
    one transaction — a prompt with zero versions is never observable. The
    caller has already verified `content` (and refused it if lint failed);
    `verification` is persisted on the version."""
    now = _now()
    prompt_id = _new_id("prm")
    version_id = _new_id("pv")
    with db.connect(dsn) as conn:
        conn.execute(
            "INSERT INTO prompts "
            "(id, slug, name, description, kind, owner_id, visibility, tags, "
            " required_placeholders, active_version_id, archived_at, created_at, updated_at) "
            "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, NULL, NULL, %s, %s)",
            (
                prompt_id, slug, name, description, kind, owner_id, visibility, tags,
                required_placeholders or [], now, now,
            ),
        )
        conn.execute(
            "INSERT INTO prompt_versions "
            "(id, prompt_id, version, content, change_note, created_by, is_active, created_at, verification) "
            "VALUES (%s, %s, 1, %s, %s, %s, FALSE, %s, %s)",
            (
                version_id, prompt_id, content, "Initial version", created_by, now,
                Jsonb(verification) if verification is not None else None,
            ),
        )
        conn.execute(
            "UPDATE prompts SET active_version_id = %s, updated_at = %s WHERE id = %s",
            (version_id, now, prompt_id),
        )
    return get_prompt(prompt_id, dsn)  # type: ignore[return-value]


def update_prompt_metadata(
    prompt_id: str,
    *,
    name: Optional[str] = None,
    description: Optional[str] = None,
    visibility: Optional[str] = None,
    tags: Optional[list[str]] = None,
    required_placeholders: Optional[list[str]] = None,
    dsn: Optional[str] = None,
) -> Optional[dict[str, Any]]:
    """Patch mutable metadata (slug/kind are immutable once created). Only
    fields explicitly passed are updated. Returns None if `prompt_id` is
    unknown."""
    fields: list[str] = []
    values: list[Any] = []
    if name is not None:
        fields.append("name = %s")
        values.append(name)
    if description is not None:
        fields.append("description = %s")
        values.append(description)
    if visibility is not None:
        fields.append("visibility = %s")
        values.append(visibility)
    if tags is not None:
        fields.append("tags = %s")
        values.append(tags)
    if required_placeholders is not None:
        fields.append("required_placeholders = %s")
        values.append(required_placeholders)
    if not fields:
        return get_prompt(prompt_id, dsn)
    fields.append("updated_at = %s")
    values.append(_now())
    values.append(prompt_id)
    with db.connect(dsn) as conn:
        cur = conn.execute(
            f"UPDATE prompts SET {', '.join(fields)} WHERE id = %s", tuple(values)
        )
        if cur.rowcount == 0:
            return None
    return get_prompt(prompt_id, dsn)


def archive_prompt(prompt_id: str, dsn: Optional[str] = None) -> Optional[dict[str, Any]]:
    """Soft-delete: versions are never hard-deleted (past runs keep their
    `prompt_version_id`), so "delete" just hides the prompt from the
    library. Returns the archived row, or None if unknown."""
    now = _now()
    with db.connect(dsn) as conn:
        cur = conn.execute(
            "UPDATE prompts SET archived_at = %s, updated_at = %s WHERE id = %s AND archived_at IS NULL",
            (now, now, prompt_id),
        )
        if cur.rowcount == 0:
            return None
        row = conn.execute("SELECT * FROM prompts WHERE id = %s", (prompt_id,)).fetchone()
        return _row_to_prompt(row) if row else None


def create_version(
    prompt_id: str,
    *,
    content: str,
    change_note: Optional[str],
    created_by: str,
    activate: bool = False,
    verification: Optional[dict[str, Any]] = None,
    dsn: Optional[str] = None,
) -> Optional[dict[str, Any]]:
    """Insert the next version (max(version)+1) for `prompt_id`, optionally
    activating it immediately (the caller only passes `activate=True` for a
    version whose lint passed). Returns None if `prompt_id` is unknown."""
    now = _now()
    with db.connect(dsn) as conn:
        prompt_row = conn.execute("SELECT id FROM prompts WHERE id = %s", (prompt_id,)).fetchone()
        if prompt_row is None:
            return None
        next_version = require_row(
            conn.execute(
                "SELECT COALESCE(MAX(version), 0) + 1 AS n FROM prompt_versions WHERE prompt_id = %s",
                (prompt_id,),
            ).fetchone()
        )["n"]
        version_id = _new_id("pv")
        conn.execute(
            "INSERT INTO prompt_versions "
            "(id, prompt_id, version, content, change_note, created_by, is_active, created_at, verification) "
            "VALUES (%s, %s, %s, %s, %s, %s, FALSE, %s, %s)",
            (
                version_id, prompt_id, next_version, content, change_note, created_by, now,
                Jsonb(verification) if verification is not None else None,
            ),
        )
        if activate:
            conn.execute(
                "UPDATE prompts SET active_version_id = %s, updated_at = %s WHERE id = %s",
                (version_id, now, prompt_id),
            )
        row = require_row(conn.execute("SELECT * FROM prompt_versions WHERE id = %s", (version_id,)).fetchone())
        return dict(row)


def get_version(prompt_id: str, version_id: str, dsn: Optional[str] = None) -> Optional[dict[str, Any]]:
    with db.connect(dsn) as conn:
        row = conn.execute(
            "SELECT * FROM prompt_versions WHERE id = %s AND prompt_id = %s", (version_id, prompt_id)
        ).fetchone()
        return dict(row) if row else None


def set_verification(
    prompt_id: str, version_id: str, verification: dict[str, Any], dsn: Optional[str] = None
) -> Optional[dict[str, Any]]:
    """Persist (replace) a version's verification result. `None` if the
    version doesn't belong to `prompt_id`."""
    with db.connect(dsn) as conn:
        cur = conn.execute(
            "UPDATE prompt_versions SET verification = %s WHERE id = %s AND prompt_id = %s",
            (Jsonb(verification), version_id, prompt_id),
        )
        if cur.rowcount == 0:
            return None
    return get_version(prompt_id, version_id, dsn)


def activate_version(
    prompt_id: str, version_id: str, dsn: Optional[str] = None
) -> Optional[dict[str, Any]]:
    """Move `prompts.active_version_id` to `version_id` (must belong to
    `prompt_id`). Returns the updated prompt detail, or None if the prompt or
    that specific version is unknown."""
    now = _now()
    with db.connect(dsn) as conn:
        version_row = conn.execute(
            "SELECT id FROM prompt_versions WHERE id = %s AND prompt_id = %s",
            (version_id, prompt_id),
        ).fetchone()
        if version_row is None:
            return None
        cur = conn.execute(
            "UPDATE prompts SET active_version_id = %s, updated_at = %s WHERE id = %s",
            (version_id, now, prompt_id),
        )
        if cur.rowcount == 0:
            return None
    return get_prompt(prompt_id, dsn)


def get_pinned_content(
    prompt_id: str, version_id: str, dsn: Optional[str] = None
) -> tuple[Optional[str], Optional[str]]:
    """(content, version_id) of one specific version belonging to
    `prompt_id` — what an agent bound with a pinned `prompt_version_id`
    (phase 04) is built with, regardless of whichever version is currently
    active. `(None, None)` if `version_id` doesn't exist or doesn't belong to
    `prompt_id` (a pin left dangling by a since-deleted prompt, which cannot
    normally happen since prompts are only archived, never hard-deleted)."""
    with db.connect(dsn) as conn:
        row = conn.execute(
            "SELECT content, id FROM prompt_versions WHERE id = %s AND prompt_id = %s",
            (version_id, prompt_id),
        ).fetchone()
        if row is None:
            return None, None
        return row["content"], row["id"]


def get_active_content(slug: str, dsn: Optional[str] = None) -> tuple[Optional[str], Optional[str]]:
    """(content, version_id) of `slug`'s currently active version — what
    `run_registry.py::RunRegistry._active_prompt` (and the synchronous
    `POST /run`) build a new run's agent with. `(None, None)` only if the
    slug or its active version is missing (should not happen once
    `ensure_ready` has seeded the 3 library prompts)."""
    with db.connect(dsn) as conn:
        row = conn.execute(
            "SELECT pv.content, pv.id "
            "FROM prompts p JOIN prompt_versions pv ON pv.id = p.active_version_id "
            "WHERE p.slug = %s",
            (slug,),
        ).fetchone()
        if row is None:
            return None, None
        return row["content"], row["id"]
