"""add integrations table

Revision ID: 8645d2ee0fbf
Revises: fd7fe35d8a74
Create Date: 2026-09-30 10:40:00.000000

"""
from typing import Sequence, Union

from alembic import op


# revision identifiers, used by Alembic.
revision: str = '8645d2ee0fbf'
down_revision: Union[str, Sequence[str], None] = 'fd7fe35d8a74'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.execute(
        """
        CREATE TABLE integrations (
            tool_name TEXT PRIMARY KEY,
            enabled BOOLEAN NOT NULL DEFAULT TRUE,
            updated_at TEXT NOT NULL
        )
        """
    )
    # Seed all 3 harness tools as enabled by default (see
    # agent_harness.tools.registry.build_default_registry). `db.ensure_ready`
    # also seeds defensively for a database created before this migration ran
    # on a copy that skipped seeding, but this is the source of truth for a
    # fresh database.
    op.execute(
        """
        INSERT INTO integrations (tool_name, enabled, updated_at) VALUES
            ('search_knowledge_base', TRUE, now()::text),
            ('get_service_status', TRUE, now()::text),
            ('create_incident', TRUE, now()::text)
        """
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.execute("DROP TABLE IF EXISTS integrations")
