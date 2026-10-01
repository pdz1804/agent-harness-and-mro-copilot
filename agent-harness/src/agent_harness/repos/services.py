"""Persistence for the `services` table (the mock service registry the agent inspects)."""

from __future__ import annotations

from typing import Any, Optional

from agent_harness.repos.base import connect, require_row


def get_service(name: str, dsn: Optional[str] = None) -> Optional[dict[str, Any]]:
    with connect(dsn) as conn:
        row = conn.execute("SELECT * FROM services WHERE name = %s", (name,)).fetchone()
        return dict(row) if row else None


def list_services(dsn: Optional[str] = None) -> list[dict[str, Any]]:
    with connect(dsn) as conn:
        rows = conn.execute("SELECT * FROM services ORDER BY name").fetchall()
        return [dict(r) for r in rows]


def set_service_status(
    name: str, status: str, checked_at: str, dsn: Optional[str] = None
) -> Optional[dict[str, Any]]:
    """Flip a service's status (used by the demo 'Services' UI page so a
    reviewer can create real degraded/down scenarios). Returns the updated
    row, or None if `name` is not a known service."""
    with connect(dsn) as conn:
        cur = conn.execute(
            "UPDATE services SET status = %s, last_checked = %s WHERE name = %s",
            (status, checked_at, name),
        )
        if cur.rowcount == 0:
            return None
        row = require_row(conn.execute("SELECT * FROM services WHERE name = %s", (name,)).fetchone())
        return dict(row)
