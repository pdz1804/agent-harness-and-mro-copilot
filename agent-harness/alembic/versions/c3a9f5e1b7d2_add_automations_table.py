"""add automations table + runs.triggered_by_automation_id

Revision ID: c3a9f5e1b7d2
Revises: 9b1e3f6c2a4d
Create Date: 2026-09-30 14:00:00.000000

"""
from typing import Sequence, Union

from alembic import op


# revision identifiers, used by Alembic.
revision: str = 'c3a9f5e1b7d2'
down_revision: Union[str, Sequence[str], None] = '9b1e3f6c2a4d'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.execute(
        """
        CREATE TABLE automations (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            trigger_service_name TEXT NOT NULL,
            trigger_status TEXT NOT NULL,
            objective_template TEXT NOT NULL,
            enabled BOOLEAN NOT NULL DEFAULT TRUE,
            created_at TEXT NOT NULL
        )
        """
    )
    # Nullable + no default: only runs started by the automation trigger
    # (see api.py::set_service_status -> _trigger_automations) ever set
    # this; every other run flow (POST /run, POST /runs from the UI) leaves
    # it NULL, same nullable-FK pattern as runs.session_id
    # (fd7fe35d8a74_add_session_id_to_runs.py).
    op.execute(
        "ALTER TABLE runs ADD COLUMN triggered_by_automation_id TEXT REFERENCES automations(id)"
    )
    op.execute(
        "CREATE INDEX idx_runs_triggered_by_automation_id ON runs(triggered_by_automation_id)"
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.execute("DROP INDEX IF EXISTS idx_runs_triggered_by_automation_id")
    op.execute("ALTER TABLE runs DROP COLUMN IF EXISTS triggered_by_automation_id")
    op.execute("DROP TABLE IF EXISTS automations")
