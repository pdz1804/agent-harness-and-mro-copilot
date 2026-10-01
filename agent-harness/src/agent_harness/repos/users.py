"""Persistence for the `users` table (RBAC foundation, phase 01).

Seeded identities only — no password/credential storage of any kind. See
`agent_harness.rbac` for the honest "identity switcher, not authentication"
framing and `alembic/versions/e1a9c6f4b2d8_add_users_and_ownership.py` for
the seed data these functions read back."""

from __future__ import annotations

from typing import Any, Optional

from agent_harness import db


def get_user(user_id: str, dsn: Optional[str] = None) -> Optional[dict[str, Any]]:
    with db.connect(dsn) as conn:
        row = conn.execute("SELECT * FROM users WHERE id = %s", (user_id,)).fetchone()
        return dict(row) if row else None


def list_users(dsn: Optional[str] = None) -> list[dict[str, Any]]:
    with db.connect(dsn) as conn:
        rows = conn.execute("SELECT * FROM users ORDER BY created_at").fetchall()
        return [dict(r) for r in rows]
