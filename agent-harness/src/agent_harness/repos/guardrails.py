"""Persistence for `guardrails` and the trigger history read from `events`."""

from __future__ import annotations

import json
from typing import Any, Optional

from agent_harness.repos.base import connect, require_row


def list_guardrails(dsn: Optional[str] = None) -> list[dict[str, Any]]:
    with connect(dsn) as conn:
        rows = conn.execute("SELECT * FROM guardrails ORDER BY created_at DESC").fetchall()
        out = []
        for r in rows:
            row = dict(r)
            row["config"] = json.loads(row["config"])
            out.append(row)
        return out


def list_enabled_guardrails(kind: Optional[str] = None, dsn: Optional[str] = None) -> list[dict[str, Any]]:
    """Enabled guardrail rows, optionally filtered to one `kind` — the real
    enforcement read `loop.py` makes at the input-guardrail check and at the
    `create_incident` call site. Read fresh on every call (never cached), so
    a toggle flipped moments ago is genuinely reflected in the very next run
    or tool call, same pattern as `list_enabled_tool_names`."""
    query = "SELECT * FROM guardrails WHERE enabled = TRUE"
    params: tuple[Any, ...] = ()
    if kind is not None:
        query += " AND kind = %s"
        params = (kind,)
    with connect(dsn) as conn:
        rows = conn.execute(query, params).fetchall()
        out = []
        for r in rows:
            row = dict(r)
            row["config"] = json.loads(row["config"])
            out.append(row)
        return out


def create_guardrail(
    guardrail_id: str,
    name: str,
    kind: str,
    config: dict[str, Any],
    enabled: bool,
    created_at: str,
    dsn: Optional[str] = None,
) -> dict[str, Any]:
    with connect(dsn) as conn:
        conn.execute(
            "INSERT INTO guardrails (id, name, kind, config, enabled, created_at) "
            "VALUES (%s, %s, %s, %s, %s, %s)",
            (guardrail_id, name, kind, json.dumps(config), enabled, created_at),
        )
    return {
        "id": guardrail_id,
        "name": name,
        "kind": kind,
        "config": config,
        "enabled": enabled,
        "created_at": created_at,
    }


def set_guardrail_enabled(guardrail_id: str, enabled: bool, dsn: Optional[str] = None) -> Optional[dict[str, Any]]:
    """Toggle one guardrail's enabled flag. Returns the updated row (config
    parsed back to a dict), or None if `guardrail_id` is not known."""
    with connect(dsn) as conn:
        cur = conn.execute("UPDATE guardrails SET enabled = %s WHERE id = %s", (enabled, guardrail_id))
        if cur.rowcount == 0:
            return None
        row = require_row(conn.execute("SELECT * FROM guardrails WHERE id = %s", (guardrail_id,)).fetchone())
        out = dict(row)
        out["config"] = json.loads(out["config"])
        return out


def list_guardrail_triggers(
    limit: int = 50, dsn: Optional[str] = None, owner_id: Optional[str] = None
) -> list[dict[str, Any]]:
    """Most recent `guardrail_blocked`/`guardrail_severity_downgraded`
    events across every run, most recent first — backs the Guardrails tab's
    "recent triggers" view. Reuses the existing `events` table (the same
    real trace-event mechanism every other harness event goes through)
    rather than a second triggers table."""
    owner_clause = " AND run_id IN (SELECT run_id FROM runs WHERE owner_id = %s)" if owner_id else ""
    with connect(dsn) as conn:
        rows = conn.execute(
            "SELECT run_id, step, event_type, timestamp, data FROM events "
            "WHERE event_type IN ('guardrail_blocked', 'guardrail_severity_downgraded')" + owner_clause
            + " ORDER BY id DESC LIMIT %s",
            ((owner_id, limit) if owner_id else (limit,)),
        ).fetchall()
        return [
            {
                "run_id": r["run_id"],
                "step": r["step"],
                "event_type": r["event_type"],
                "timestamp": r["timestamp"],
                "data": json.loads(r["data"]),
            }
            for r in rows
        ]
