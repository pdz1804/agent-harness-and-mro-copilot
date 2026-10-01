"""add guardrails table

Revision ID: 9b1e3f6c2a4d
Revises: 252e2db564a0
Create Date: 2026-09-30 12:00:00.000000

"""
from typing import Sequence, Union

from alembic import op


# revision identifiers, used by Alembic.
revision: str = '9b1e3f6c2a4d'
down_revision: Union[str, Sequence[str], None] = '252e2db564a0'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.execute(
        """
        CREATE TABLE guardrails (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            kind TEXT NOT NULL,
            config TEXT NOT NULL,
            enabled BOOLEAN NOT NULL DEFAULT TRUE,
            created_at TEXT NOT NULL
        )
        """
    )
    # Seed the severity-evidence-cap guardrail enabled by default (it is a
    # fixed, non-configurable safety rule — see agent_harness.loop::
    # AgentLoop._apply_severity_guardrail) so it protects real runs out of
    # the box, same posture as `integrations` defaulting every tool to
    # enabled. The input pattern-block guardrail is NOT seeded here: it only
    # does something once an operator configures real banned patterns via
    # `POST /guardrails`, so there is nothing useful to seed by default.
    op.execute(
        """
        INSERT INTO guardrails (id, name, kind, config, enabled, created_at) VALUES
            ('gr-severity-cap', 'Severity evidence cap', 'severity_upgrade_block', '{}', TRUE, now()::text)
        """
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.execute("DROP TABLE IF EXISTS guardrails")
