"""Persistence for the agents entity (phase 04): a named, ownable binding of
a prompt (+ optional pinned version), a skill-routing mode, and a base tool
set. `agent_runtime.resolve_run_plan` is the only consumer of the shape
this repo returns — this module owns CRUD + validation, not run-time
resolution."""

from __future__ import annotations

import re
import uuid
from datetime import datetime, timezone
from typing import Any, Optional

from agent_harness import db
from agent_harness.repos import trash

_SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-]{1,40}$")
_SKILL_MODES = frozenset({"none", "assigned", "auto"})


class AgentValidationError(ValueError):
    """Raised for any 422-worthy input problem — the router translates this
    into an HTTP 422 with `str(exc)` as the detail."""


def validate_slug(slug: str) -> None:
    if not _SLUG_RE.match(slug):
        raise AgentValidationError(
            "slug must match ^[a-z0-9][a-z0-9-]{1,40}$ (lowercase, kebab-case, 2-41 chars)"
        )


def validate_skill_mode(skill_mode: str) -> None:
    if skill_mode not in _SKILL_MODES:
        raise AgentValidationError(f"skill_mode must be one of {sorted(_SKILL_MODES)}")


def validate_base_tools(base_tools: list[str]) -> None:
    from agent_harness.tools.registry import build_default_registry

    known = set(build_default_registry().keys())
    unknown = [t for t in base_tools if t not in known]
    if unknown:
        raise AgentValidationError(
            f"unknown tool(s) {sorted(unknown)} — must be a subset of {sorted(known)}"
        )


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _new_id() -> str:
    return f"agt-{uuid.uuid4().hex[:12]}"


def _row_to_agent(row: dict[str, Any]) -> dict[str, Any]:
    row = dict(row)
    row["skill_ids"] = list(row.get("skill_ids") or [])
    row["base_tools"] = list(row.get("base_tools") or [])
    return row


def list_agents(dsn: Optional[str] = None) -> list[dict[str, Any]]:
    with db.connect(dsn) as conn:
        rows = conn.execute("SELECT * FROM agents WHERE deleted_at IS NULL ORDER BY is_default DESC, updated_at DESC").fetchall()
        return [_row_to_agent(r) for r in rows]


def get_agent(
    agent_id: str, dsn: Optional[str] = None, *, include_deleted: bool = False
) -> Optional[dict[str, Any]]:
    suffix = "" if include_deleted else " AND deleted_at IS NULL"
    with db.connect(dsn) as conn:
        row = conn.execute("SELECT * FROM agents WHERE id = %s" + suffix, (agent_id,)).fetchone()
        return _row_to_agent(row) if row else None


def get_agent_by_slug(slug: str, dsn: Optional[str] = None) -> Optional[dict[str, Any]]:
    with db.connect(dsn) as conn:
        row = conn.execute("SELECT * FROM agents WHERE slug = %s AND deleted_at IS NULL", (slug,)).fetchone()
        return _row_to_agent(row) if row else None


def get_default_agent(dsn: Optional[str] = None) -> Optional[dict[str, Any]]:
    with db.connect(dsn) as conn:
        row = conn.execute("SELECT * FROM agents WHERE is_default AND deleted_at IS NULL LIMIT 1").fetchone()
        return _row_to_agent(row) if row else None


def create_agent(
    *,
    slug: str,
    name: str,
    description: str,
    avatar_color: str,
    prompt_id: str,
    prompt_version_id: Optional[str],
    skill_mode: str,
    skill_ids: list[str],
    base_tools: list[str],
    max_steps: Optional[int],
    owner_id: str,
    visibility: str,
    dsn: Optional[str] = None,
) -> dict[str, Any]:
    validate_slug(slug)
    validate_skill_mode(skill_mode)
    validate_base_tools(base_tools)
    now = _now()
    agent_id = _new_id()
    with db.connect(dsn) as conn:
        trash.release_slug(conn, "agents", slug)
        conn.execute(
            "INSERT INTO agents "
            "(id, slug, name, description, avatar_color, prompt_id, prompt_version_id, "
            " skill_mode, skill_ids, base_tools, max_steps, owner_id, visibility, "
            " is_default, created_at, updated_at) "
            "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, FALSE, %s, %s)",
            (
                agent_id,
                slug,
                name,
                description,
                avatar_color,
                prompt_id,
                prompt_version_id,
                skill_mode,
                skill_ids,
                base_tools,
                max_steps,
                owner_id,
                visibility,
                now,
                now,
            ),
        )
    return get_agent(agent_id, dsn)  # type: ignore[return-value]


def update_agent(
    agent_id: str,
    *,
    name: Optional[str] = None,
    description: Optional[str] = None,
    avatar_color: Optional[str] = None,
    prompt_id: Optional[str] = None,
    prompt_version_id: Any = "__unset__",
    skill_mode: Optional[str] = None,
    skill_ids: Optional[list[str]] = None,
    base_tools: Optional[list[str]] = None,
    max_steps: Any = "__unset__",
    visibility: Optional[str] = None,
    dsn: Optional[str] = None,
) -> Optional[dict[str, Any]]:
    """Patch mutable fields (slug is immutable once created). Only fields
    explicitly passed are updated; `prompt_version_id`/`max_steps` use a
    sentinel default so an explicit `None` (un-pin the version / clear the
    step override) is distinguishable from "not provided". Returns None if
    `agent_id` is unknown."""
    if skill_mode is not None:
        validate_skill_mode(skill_mode)
    if base_tools is not None:
        validate_base_tools(base_tools)

    fields: list[str] = []
    values: list[Any] = []
    if name is not None:
        fields.append("name = %s")
        values.append(name)
    if description is not None:
        fields.append("description = %s")
        values.append(description)
    if avatar_color is not None:
        fields.append("avatar_color = %s")
        values.append(avatar_color)
    if prompt_id is not None:
        fields.append("prompt_id = %s")
        values.append(prompt_id)
    if prompt_version_id != "__unset__":
        fields.append("prompt_version_id = %s")
        values.append(prompt_version_id)
    if skill_mode is not None:
        fields.append("skill_mode = %s")
        values.append(skill_mode)
    if skill_ids is not None:
        fields.append("skill_ids = %s")
        values.append(skill_ids)
    if base_tools is not None:
        fields.append("base_tools = %s")
        values.append(base_tools)
    if max_steps != "__unset__":
        fields.append("max_steps = %s")
        values.append(max_steps)
    if visibility is not None:
        fields.append("visibility = %s")
        values.append(visibility)
    if not fields:
        return get_agent(agent_id, dsn)
    fields.append("updated_at = %s")
    values.append(_now())
    values.append(agent_id)
    with db.connect(dsn) as conn:
        cur = conn.execute(f"UPDATE agents SET {', '.join(fields)} WHERE id = %s AND deleted_at IS NULL", tuple(values))
        if cur.rowcount == 0:
            return None
    return get_agent(agent_id, dsn)


def delete_agent(agent_id: str, dsn: Optional[str] = None) -> bool:
    """Soft-delete (restorable until purged). False if unknown or already
    deleted. The router refuses this (409) for the current default agent —
    checked by the caller, not here."""
    with db.connect(dsn) as conn:
        cur = conn.execute(
            "UPDATE agents SET deleted_at = %s WHERE id = %s AND deleted_at IS NULL", (trash.now_iso(), agent_id)
        )
        return cur.rowcount > 0


def restore_agent(agent_id: str, dsn: Optional[str] = None) -> bool:
    """Undo `delete_agent`. False if the id is unknown or not deleted."""
    with db.connect(dsn) as conn:
        cur = conn.execute("UPDATE agents SET deleted_at = NULL WHERE id = %s AND deleted_at IS NOT NULL", (agent_id,))
        return cur.rowcount > 0


def is_skill_bound_to_any_agent(skill_id: str, dsn: Optional[str] = None) -> bool:
    """Real implementation of the hook `skills_repo.is_bound_to_agent`
    (phase 03) stubbed as always-False: does any agent's `skill_ids` array
    currently contain this skill?"""
    with db.connect(dsn) as conn:
        row = conn.execute(
            "SELECT 1 FROM agents WHERE %s = ANY(skill_ids) AND deleted_at IS NULL LIMIT 1", (skill_id,)
        ).fetchone()
        return row is not None


def count_agents_bound_to_prompt(prompt_id: str, dsn: Optional[str] = None) -> int:
    """Number of agents currently bound to `prompt_id` — fills the
    `used_by_agents` gap phase 02 left open (`PromptSummary.used_by_agents`,
    always 0 until agents existed)."""
    with db.connect(dsn) as conn:
        row = conn.execute("SELECT COUNT(*) AS n FROM agents WHERE prompt_id = %s AND deleted_at IS NULL", (prompt_id,)).fetchone()
        return row["n"] if row else 0


def is_prompt_bound_to_any_agent(prompt_id: str, dsn: Optional[str] = None) -> bool:
    """Whether any agent binds `prompt_id` — used to 409 a prompt delete."""
    return count_agents_bound_to_prompt(prompt_id, dsn) > 0
