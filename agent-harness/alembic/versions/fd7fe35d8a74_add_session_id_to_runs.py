"""add session_id to runs

Revision ID: fd7fe35d8a74
Revises: a47c5ddffd94
Create Date: 2026-09-29 23:05:00.000000

"""
from typing import Sequence, Union

from alembic import op


# revision identifiers, used by Alembic.
revision: str = 'fd7fe35d8a74'
down_revision: Union[str, Sequence[str], None] = 'a47c5ddffd94'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    # Nullable: `POST /run` (the fully-synchronous convenience endpoint) and
    # any pre-existing run never had a session, and never will — sessions
    # are only created by the `POST /runs` async web-UI flow (phase 12a).
    op.execute("ALTER TABLE runs ADD COLUMN session_id TEXT REFERENCES chat_sessions(id)")
    op.execute("CREATE INDEX idx_runs_session_id ON runs(session_id)")


def downgrade() -> None:
    """Downgrade schema."""
    op.execute("DROP INDEX IF EXISTS idx_runs_session_id")
    op.execute("ALTER TABLE runs DROP COLUMN IF EXISTS session_id")
