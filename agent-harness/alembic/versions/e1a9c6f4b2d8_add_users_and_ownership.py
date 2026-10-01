"""add users and ownership

Revision ID: e1a9c6f4b2d8
Revises: d4a8f1c9b3e7
Create Date: 2026-09-30 16:00:00.000000

"""
from typing import Sequence, Union

from alembic import op


# revision identifiers, used by Alembic.
revision: str = 'e1a9c6f4b2d8'
down_revision: Union[str, Sequence[str], None] = 'd4a8f1c9b3e7'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema.

    RBAC foundation (phase 01): a `users` table (seeded identities, no
    passwords — see `agent_harness.rbac` module docstring for the honest
    "identity switcher, not authentication" framing) plus `owner_id` on
    `chat_sessions`/`runs` so ownership-scoped read/write checks have
    something real to check against. Existing rows backfill to
    `u_admin` (the only role that could see everything pre-RBAC) before the
    column is made NOT NULL, so no historical row loses an owner.
    """
    op.execute(
        """
        CREATE TABLE users (
            id TEXT PRIMARY KEY,
            display_name TEXT NOT NULL,
            role TEXT NOT NULL CHECK (role IN ('admin', 'editor', 'viewer')),
            created_at TEXT NOT NULL
        )
        """
    )
    op.execute(
        """
        INSERT INTO users (id, display_name, role, created_at) VALUES
        ('u_admin', 'Alice Admin', 'admin', '2026-09-30T00:00:00+00:00'),
        ('u_editor', 'Evan Editor', 'editor', '2026-09-30T00:00:00+00:00'),
        ('u_viewer', 'Vera Viewer', 'viewer', '2026-09-30T00:00:00+00:00'),
        ('u_editor2', 'Erin Editor', 'editor', '2026-09-30T00:00:00+00:00')
        """
    )

    op.execute("ALTER TABLE chat_sessions ADD COLUMN owner_id TEXT REFERENCES users(id)")
    op.execute("UPDATE chat_sessions SET owner_id = 'u_admin' WHERE owner_id IS NULL")
    op.execute("ALTER TABLE chat_sessions ALTER COLUMN owner_id SET NOT NULL")

    op.execute("ALTER TABLE runs ADD COLUMN owner_id TEXT REFERENCES users(id)")
    op.execute("UPDATE runs SET owner_id = 'u_admin' WHERE owner_id IS NULL")
    op.execute("ALTER TABLE runs ALTER COLUMN owner_id SET NOT NULL")

    op.execute("ALTER TABLE automations ADD COLUMN owner_id TEXT REFERENCES users(id)")
    op.execute("UPDATE automations SET owner_id = 'u_admin' WHERE owner_id IS NULL")
    op.execute("ALTER TABLE automations ALTER COLUMN owner_id SET NOT NULL")

    op.execute(
        "CREATE INDEX ix_chat_sessions_owner_last_active "
        "ON chat_sessions (owner_id, last_active_at DESC)"
    )
    op.execute("CREATE INDEX ix_runs_owner_started ON runs (owner_id, started_at DESC)")


def downgrade() -> None:
    """Downgrade schema."""
    op.execute("DROP INDEX IF EXISTS ix_runs_owner_started")
    op.execute("DROP INDEX IF EXISTS ix_chat_sessions_owner_last_active")
    op.execute("ALTER TABLE automations DROP COLUMN IF EXISTS owner_id")
    op.execute("ALTER TABLE runs DROP COLUMN IF EXISTS owner_id")
    op.execute("ALTER TABLE chat_sessions DROP COLUMN IF EXISTS owner_id")
    op.execute("DROP TABLE IF EXISTS users")
