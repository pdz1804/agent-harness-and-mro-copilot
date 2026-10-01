"""Persistence for the skills library (phase 03): a reusable capability
package — `instructions` (markdown appended to the system prompt when the
skill is active) + `allowed_tools` (a subset of the harness's tool registry,
scoping what the agent may call) + `description` (the routing signal shown
to phase 04's skill-router agent and to slash-command autocomplete).

Not versioned (YAGNI — prompts already carry versioning; see phase-03 spec's
"Unresolved" note, default no). `updated_at`/`updated_by` track the last
edit instead of a version history.
"""

from __future__ import annotations

import re
import uuid
from datetime import datetime, timezone
from typing import Any, Optional

from agent_harness import db
from agent_harness.repos import trash

# Slugs that collide with reserved chat/slash-command namespace (phase 04's
# `/slug` parsing) and so may never be used as a skill slug.
RESERVED_SLUGS = frozenset({"help", "clear"})

_SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-]{1,40}$")


class SkillValidationError(ValueError):
    """Raised for any 422-worthy input problem (bad slug, unknown tool,
    empty allowed_tools, reserved slug) — the router translates this into an
    HTTP 422 with `str(exc)` as the detail."""


def validate_slug(slug: str) -> None:
    if not _SLUG_RE.match(slug):
        raise SkillValidationError(
            "slug must match ^[a-z0-9][a-z0-9-]{1,40}$ (lowercase, kebab-case, 2-41 chars)"
        )
    if slug in RESERVED_SLUGS:
        raise SkillValidationError(f"'{slug}' is a reserved slug and cannot be used for a skill")


def validate_allowed_tools(allowed_tools: list[str]) -> None:
    from agent_harness.tools.registry import build_default_registry

    if not allowed_tools:
        raise SkillValidationError("allowed_tools must not be empty")
    known = set(build_default_registry().keys())
    unknown = [t for t in allowed_tools if t not in known]
    if unknown:
        raise SkillValidationError(
            f"unknown tool(s) {sorted(unknown)} — must be a subset of {sorted(known)}"
        )


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _new_id() -> str:
    return f"skl-{uuid.uuid4().hex[:12]}"


def _row_to_skill(row: dict[str, Any]) -> dict[str, Any]:
    row = dict(row)
    row["allowed_tools"] = list(row.get("allowed_tools") or [])
    row["examples"] = list(row.get("examples") or [])
    return row


def list_skills(
    q: Optional[str] = None, enabled: Optional[bool] = None, dsn: Optional[str] = None
) -> list[dict[str, Any]]:
    """Every skill, optionally filtered by `q` (substring match against
    slug/name/description) and `enabled` (exact match)."""
    with db.connect(dsn) as conn:
        rows = conn.execute("SELECT * FROM skills WHERE deleted_at IS NULL ORDER BY updated_at DESC").fetchall()
        out = []
        for r in rows:
            row = _row_to_skill(r)
            if enabled is not None and row["enabled"] != enabled:
                continue
            if q:
                haystack = " ".join(
                    filter(None, [row["slug"], row["name"], row.get("description")])
                ).lower()
                if q.lower() not in haystack:
                    continue
            out.append(row)
        return out


def get_skill(
    skill_id: str, dsn: Optional[str] = None, *, include_deleted: bool = False
) -> Optional[dict[str, Any]]:
    suffix = "" if include_deleted else " AND deleted_at IS NULL"
    with db.connect(dsn) as conn:
        row = conn.execute("SELECT * FROM skills WHERE id = %s" + suffix, (skill_id,)).fetchone()
        return _row_to_skill(row) if row else None


def get_skill_by_slug(slug: str, dsn: Optional[str] = None) -> Optional[dict[str, Any]]:
    with db.connect(dsn) as conn:
        row = conn.execute("SELECT * FROM skills WHERE slug = %s AND deleted_at IS NULL", (slug,)).fetchone()
        return _row_to_skill(row) if row else None


def create_skill(
    *,
    slug: str,
    name: str,
    description: str,
    instructions: str,
    allowed_tools: list[str],
    examples: list[str],
    owner_id: str,
    visibility: str,
    enabled: bool,
    updated_by: str,
    dsn: Optional[str] = None,
) -> dict[str, Any]:
    validate_slug(slug)
    validate_allowed_tools(allowed_tools)
    now = _now()
    skill_id = _new_id()
    with db.connect(dsn) as conn:
        trash.release_slug(conn, "skills", slug)
        conn.execute(
            "INSERT INTO skills "
            "(id, slug, name, description, instructions, allowed_tools, examples, "
            " owner_id, visibility, enabled, created_at, updated_at, updated_by) "
            "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)",
            (
                skill_id,
                slug,
                name,
                description,
                instructions,
                allowed_tools,
                examples,
                owner_id,
                visibility,
                enabled,
                now,
                now,
                updated_by,
            ),
        )
    return get_skill(skill_id, dsn)  # type: ignore[return-value]


def update_skill(
    skill_id: str,
    *,
    name: Optional[str] = None,
    description: Optional[str] = None,
    instructions: Optional[str] = None,
    allowed_tools: Optional[list[str]] = None,
    examples: Optional[list[str]] = None,
    visibility: Optional[str] = None,
    enabled: Optional[bool] = None,
    updated_by: str,
    dsn: Optional[str] = None,
) -> Optional[dict[str, Any]]:
    """Patch mutable fields (slug is immutable once created). Only fields
    explicitly passed are updated. Returns None if `skill_id` is unknown."""
    if allowed_tools is not None:
        validate_allowed_tools(allowed_tools)
    fields: list[str] = []
    values: list[Any] = []
    if name is not None:
        fields.append("name = %s")
        values.append(name)
    if description is not None:
        fields.append("description = %s")
        values.append(description)
    if instructions is not None:
        fields.append("instructions = %s")
        values.append(instructions)
    if allowed_tools is not None:
        fields.append("allowed_tools = %s")
        values.append(allowed_tools)
    if examples is not None:
        fields.append("examples = %s")
        values.append(examples)
    if visibility is not None:
        fields.append("visibility = %s")
        values.append(visibility)
    if enabled is not None:
        fields.append("enabled = %s")
        values.append(enabled)
    if not fields:
        return get_skill(skill_id, dsn)
    fields.append("updated_at = %s")
    values.append(_now())
    fields.append("updated_by = %s")
    values.append(updated_by)
    values.append(skill_id)
    with db.connect(dsn) as conn:
        cur = conn.execute(
            f"UPDATE skills SET {', '.join(fields)} WHERE id = %s AND deleted_at IS NULL", tuple(values)
        )
        if cur.rowcount == 0:
            return None
    return get_skill(skill_id, dsn)


def delete_skill(skill_id: str, dsn: Optional[str] = None) -> bool:
    """Soft-delete (restorable until purged). False if unknown or already deleted."""
    with db.connect(dsn) as conn:
        cur = conn.execute(
            "UPDATE skills SET deleted_at = %s WHERE id = %s AND deleted_at IS NULL", (trash.now_iso(), skill_id)
        )
        return cur.rowcount > 0


def restore_skill(skill_id: str, dsn: Optional[str] = None) -> bool:
    """Undo `delete_skill`. False if the id is unknown or not deleted."""
    with db.connect(dsn) as conn:
        cur = conn.execute("UPDATE skills SET deleted_at = NULL WHERE id = %s AND deleted_at IS NOT NULL", (skill_id,))
        return cur.rowcount > 0


def is_bound_to_agent(skill_id: str, dsn: Optional[str] = None) -> bool:
    """Whether any agent currently binds this skill (phase 04 fills in the
    real check via `repos.agents`, imported lazily to avoid a
    skills<->agents import cycle) — used by the router to 409 a delete
    instead of silently orphaning an agent's reference."""
    from agent_harness.repos import agents as agents_repo

    return agents_repo.is_skill_bound_to_any_agent(skill_id, dsn)
