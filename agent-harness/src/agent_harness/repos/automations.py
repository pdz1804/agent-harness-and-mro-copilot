"""Persistence for `automations` and the runs they triggered."""

from __future__ import annotations

from typing import Any, Optional

from agent_harness.repos.base import connect, require_row


def list_automations(dsn: Optional[str] = None) -> list[dict[str, Any]]:
    with connect(dsn) as conn:
        rows = conn.execute("SELECT * FROM automations ORDER BY created_at DESC").fetchall()
        return [dict(r) for r in rows]


def create_automation(
    automation_id: str,
    name: str,
    trigger_service_name: str,
    trigger_status: str,
    objective_template: str,
    enabled: bool,
    created_at: str,
    owner_id: str = "u_admin",
    dsn: Optional[str] = None,
) -> dict[str, Any]:
    with connect(dsn) as conn:
        conn.execute(
            "INSERT INTO automations "
            "(id, name, trigger_service_name, trigger_status, objective_template, enabled, "
            "created_at, owner_id) "
            "VALUES (%s, %s, %s, %s, %s, %s, %s, %s)",
            (
                automation_id,
                name,
                trigger_service_name,
                trigger_status,
                objective_template,
                enabled,
                created_at,
                owner_id,
            ),
        )
    return {
        "id": automation_id,
        "name": name,
        "trigger_service_name": trigger_service_name,
        "trigger_status": trigger_status,
        "objective_template": objective_template,
        "enabled": enabled,
        "created_at": created_at,
        "owner_id": owner_id,
    }


def set_automation_enabled(automation_id: str, enabled: bool, dsn: Optional[str] = None) -> Optional[dict[str, Any]]:
    """Toggle one automation's enabled flag. Returns the updated row, or None
    if `automation_id` is not known."""
    with connect(dsn) as conn:
        cur = conn.execute("UPDATE automations SET enabled = %s WHERE id = %s", (enabled, automation_id))
        if cur.rowcount == 0:
            return None
        row = require_row(conn.execute("SELECT * FROM automations WHERE id = %s", (automation_id,)).fetchone())
        return dict(row)


def list_matching_enabled_automations(
    service_name: str, status: str, dsn: Optional[str] = None
) -> list[dict[str, Any]]:
    """Every enabled automation whose trigger matches this exact
    service+status transition — either scoped to `service_name` or the
    wildcard `"any"` service. Read fresh on every call (never cached), same
    pattern as `list_enabled_tool_names`/`list_enabled_guardrails`, so a rule
    created or toggled moments ago is genuinely honored by the very next
    status flip. This is the real match query `api.py::set_service_status`
    calls before starting any automation-triggered run."""
    with connect(dsn) as conn:
        rows = conn.execute(
            "SELECT * FROM automations WHERE enabled = TRUE AND trigger_status = %s "
            "AND (trigger_service_name = %s OR trigger_service_name = 'any')",
            (status, service_name),
        ).fetchall()
        return [dict(r) for r in rows]


def list_automation_triggered_runs(
    limit: int = 50, dsn: Optional[str] = None, owner_id: Optional[str] = None
) -> list[dict[str, Any]]:
    """Most recent runs that were started by an automation
    (`runs.triggered_by_automation_id IS NOT NULL`), most recent first —
    backs the Automations tab's "recent automation-triggered runs" view."""
    owner_clause = " AND owner_id = %s" if owner_id else ""
    with connect(dsn) as conn:
        rows = conn.execute(
            "SELECT run_id, objective, status, started_at, triggered_by_automation_id FROM runs "
            "WHERE triggered_by_automation_id IS NOT NULL" + owner_clause + " ORDER BY started_at DESC LIMIT %s",
            ((owner_id, limit) if owner_id else (limit,)),
        ).fetchall()
        return [dict(r) for r in rows]
