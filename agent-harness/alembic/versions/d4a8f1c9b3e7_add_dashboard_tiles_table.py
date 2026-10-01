"""add dashboard_tiles table

Revision ID: d4a8f1c9b3e7
Revises: c3a9f5e1b7d2
Create Date: 2026-09-30 15:00:00.000000

"""
from typing import Sequence, Union

from alembic import op


# revision identifiers, used by Alembic.
revision: str = 'd4a8f1c9b3e7'
down_revision: Union[str, Sequence[str], None] = 'c3a9f5e1b7d2'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema.

    Backs the Artifacts tab (12e): each row is one saved dashboard tile —
    a name plus a user-authored SQL query. `sql_query` is validated
    read-only (see `agent_harness.sql_guard`) before a row is ever
    inserted, and every execution of it (`GET /artifacts/{id}/run`) runs
    inside a Postgres `READ ONLY` transaction that is always rolled back —
    see that module's docstring for the full two-layer defense and its
    honest limits.
    """
    op.execute(
        """
        CREATE TABLE dashboard_tiles (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            sql_query TEXT NOT NULL,
            created_at TEXT NOT NULL
        )
        """
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.execute("DROP TABLE IF EXISTS dashboard_tiles")
