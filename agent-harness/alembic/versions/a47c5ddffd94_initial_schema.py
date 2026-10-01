"""initial schema

Revision ID: a47c5ddffd94
Revises: 
Create Date: 2026-09-29 21:14:13.030852

"""
from typing import Sequence, Union

from alembic import op


# revision identifiers, used by Alembic.
revision: str = 'a47c5ddffd94'
down_revision: Union[str, Sequence[str], None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.execute(
        """
        CREATE TABLE services (
            name TEXT PRIMARY KEY,
            status TEXT NOT NULL,
            latency_ms DOUBLE PRECISION,
            error_rate DOUBLE PRECISION,
            last_deploy TEXT,
            owner TEXT,
            last_checked TEXT
        )
        """
    )

    op.execute(
        """
        CREATE TABLE incidents (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            description TEXT NOT NULL,
            severity TEXT NOT NULL,
            status TEXT NOT NULL,
            created_at TEXT NOT NULL,
            run_id TEXT
        )
        """
    )
    op.execute("CREATE INDEX idx_incidents_run_title ON incidents(run_id, title)")

    op.execute(
        """
        CREATE TABLE runs (
            run_id TEXT PRIMARY KEY,
            objective TEXT NOT NULL,
            status TEXT NOT NULL,
            started_at DOUBLE PRECISION NOT NULL,
            finished_at DOUBLE PRECISION,
            final_answer TEXT,
            steps_taken INTEGER DEFAULT 0,
            trace_path TEXT,
            error TEXT
        )
        """
    )

    op.execute(
        """
        CREATE TABLE events (
            id BIGSERIAL PRIMARY KEY,
            run_id TEXT NOT NULL,
            step INTEGER NOT NULL,
            event_type TEXT NOT NULL,
            timestamp DOUBLE PRECISION NOT NULL,
            latency_ms DOUBLE PRECISION,
            data TEXT NOT NULL
        )
        """
    )
    op.execute("CREATE INDEX idx_events_run_id ON events(run_id)")

    # Empty, unused until a later sub-phase (chat UI + prompt versioning).
    # Created now per the PRD so that sub-phase doesn't need another
    # migration.
    op.execute(
        """
        CREATE TABLE chat_sessions (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            created_at TEXT NOT NULL,
            last_active_at TEXT,
            status TEXT NOT NULL
        )
        """
    )

    op.execute(
        """
        CREATE TABLE prompt_versions (
            id TEXT PRIMARY KEY,
            content TEXT NOT NULL,
            is_active BOOLEAN NOT NULL DEFAULT FALSE,
            created_at TEXT NOT NULL
        )
        """
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.execute("DROP TABLE IF EXISTS prompt_versions")
    op.execute("DROP TABLE IF EXISTS chat_sessions")
    op.execute("DROP INDEX IF EXISTS idx_events_run_id")
    op.execute("DROP TABLE IF EXISTS events")
    op.execute("DROP TABLE IF EXISTS runs")
    op.execute("DROP INDEX IF EXISTS idx_incidents_run_title")
    op.execute("DROP TABLE IF EXISTS incidents")
    op.execute("DROP TABLE IF EXISTS services")
