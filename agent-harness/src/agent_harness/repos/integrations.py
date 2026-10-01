"""Persistence for the `integrations` table: per-tool enabled flag and optional timeout/retry overrides."""

from __future__ import annotations

from typing import Any, Optional

from agent_harness.repos.base import connect, require_row


def list_integrations(dsn: Optional[str] = None) -> list[dict[str, Any]]:
    with connect(dsn) as conn:
        rows = conn.execute("SELECT * FROM integrations ORDER BY tool_name").fetchall()
        return [dict(r) for r in rows]


def set_integration_enabled(
    tool_name: str, enabled: bool, updated_at: str, dsn: Optional[str] = None
) -> Optional[dict[str, Any]]:
    """Toggle one tool's enabled flag. Returns the updated row, or None if
    `tool_name` is not a known integration."""
    with connect(dsn) as conn:
        cur = conn.execute(
            "UPDATE integrations SET enabled = %s, updated_at = %s WHERE tool_name = %s",
            (enabled, updated_at, tool_name),
        )
        if cur.rowcount == 0:
            return None
        row = require_row(conn.execute("SELECT * FROM integrations WHERE tool_name = %s", (tool_name,)).fetchone())
        return dict(row)


def list_enabled_tool_names(dsn: Optional[str] = None) -> set[str]:
    """Tool names currently enabled — what `run_registry.py` filters the
    default tool registry down to before building a new run's agent."""
    with connect(dsn) as conn:
        rows = conn.execute("SELECT tool_name FROM integrations WHERE enabled = TRUE").fetchall()
        return {r["tool_name"] for r in rows}


def get_integration(tool_name: str, dsn: Optional[str] = None) -> Optional[dict[str, Any]]:
    with connect(dsn) as conn:
        row = conn.execute("SELECT * FROM integrations WHERE tool_name = %s", (tool_name,)).fetchone()
        return dict(row) if row else None


_UNSET: Any = object()


def update_integration_settings(
    tool_name: str,
    updated_at: str,
    *,
    timeout_seconds: Any = _UNSET,
    max_retries: Any = _UNSET,
    dsn: Optional[str] = None,
) -> Optional[dict[str, Any]]:
    """Set (or, with `None`, clear back to the global default) a tool's own
    timeout and retry count. A parameter left at its default is untouched.
    Returns the updated row, or None for an unknown tool."""
    sets, params = ["updated_at = %s"], [updated_at]
    if timeout_seconds is not _UNSET:
        sets.append("timeout_seconds = %s")
        params.append(timeout_seconds)
    if max_retries is not _UNSET:
        sets.append("max_retries = %s")
        params.append(max_retries)
    params.append(tool_name)
    with connect(dsn) as conn:
        cur = conn.execute(f"UPDATE integrations SET {', '.join(sets)} WHERE tool_name = %s", tuple(params))
        if cur.rowcount == 0:
            return None
        row = require_row(conn.execute("SELECT * FROM integrations WHERE tool_name = %s", (tool_name,)).fetchone())
        return dict(row)


def tool_settings(dsn: Optional[str] = None) -> dict[str, dict[str, Any]]:
    """Per-tool overrides the loop applies: `{tool_name: {timeout_seconds, max_retries}}`
    for every tool that has at least one override set."""
    with connect(dsn) as conn:
        rows = conn.execute(
            "SELECT tool_name, timeout_seconds, max_retries FROM integrations "
            "WHERE timeout_seconds IS NOT NULL OR max_retries IS NOT NULL"
        ).fetchall()
        return {
            r["tool_name"]: {"timeout_seconds": r["timeout_seconds"], "max_retries": r["max_retries"]} for r in rows
        }
