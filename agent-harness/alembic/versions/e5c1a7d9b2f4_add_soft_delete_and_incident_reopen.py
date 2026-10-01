"""soft delete (deleted_at) for user-managed resources, incident reopen

Revision ID: e5c1a7d9b2f4
Revises: d7b3f1a8c6e2
Create Date: 2026-10-01 21:00:00.000000

* `deleted_at` on chat_sessions, memories, kb_documents, dashboards, skills,
  agents and prompts: DELETE endpoints now only stamp this column so the UI can
  offer "Undo" (`POST .../{id}/restore`). Every read path hides rows with a
  non-NULL value; rows older than the retention window are hard-deleted by a
  startup purge.
* `incidents.reopened_at` / `reopened_by`: who moved a resolved incident back
  to acknowledged, and when.
"""
from typing import Sequence, Union

from alembic import op

revision: str = "e5c1a7d9b2f4"
down_revision: Union[str, Sequence[str], None] = "d7b3f1a8c6e2"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_SOFT_DELETE_TABLES = ("chat_sessions", "memories", "kb_documents", "dashboards", "skills", "agents", "prompts")


def upgrade() -> None:
    for table in _SOFT_DELETE_TABLES:
        op.execute(f"ALTER TABLE {table} ADD COLUMN IF NOT EXISTS deleted_at TEXT")
    op.execute("ALTER TABLE incidents ADD COLUMN IF NOT EXISTS reopened_at TEXT")
    op.execute("ALTER TABLE incidents ADD COLUMN IF NOT EXISTS reopened_by TEXT REFERENCES users(id)")


def downgrade() -> None:
    op.execute("ALTER TABLE incidents DROP COLUMN IF EXISTS reopened_by")
    op.execute("ALTER TABLE incidents DROP COLUMN IF EXISTS reopened_at")
    for table in reversed(_SOFT_DELETE_TABLES):
        op.execute(f"ALTER TABLE {table} DROP COLUMN IF EXISTS deleted_at")
